"""Fuse jointly estimated camera/depth maps. No single-image shape fallback."""
from pathlib import Path
import json
import numpy as np
from scipy import ndimage
from skimage.measure import marching_cubes
import trimesh


def foreground(rgb):
    rgb = np.asarray(rgb, dtype=np.float32)
    if rgb.max() <= 1.01: rgb = rgb * 255
    h, w = rgb.shape[:2]
    corners = rgb[[0, 0, h-1, h-1], [0, w-1, 0, w-1]]
    similar = np.min(np.linalg.norm(rgb[:, :, None] - corners, axis=-1), axis=-1) < 42
    seed = np.zeros((h, w), bool); seed[0] = similar[0]; seed[-1] = similar[-1]
    seed[:, 0] = similar[:, 0]; seed[:, -1] = similar[:, -1]
    return ~ndimage.binary_propagation(seed, mask=similar)


def depth_agreement(points, depths, masks, extrinsics, intrinsics, tolerance, background_masks):
    """Check surfaces against other cameras, excluding genuinely occluded points."""
    pairs = []
    for i in range(len(points)):
        source = points[i][masks[i]]
        source = source[::max(1, len(source)//20000)]
        for j in range(len(points)):
            if i == j: continue
            camera = source @ extrinsics[j, :3, :3].T + extrinsics[j, :3, 3]
            uvw = camera @ intrinsics[j].T
            uv = np.rint(uvw[:, :2] / np.maximum(uvw[:, 2:3], 1e-9)).astype(int)
            h, w = depths[j].shape
            valid = (camera[:, 2] > 0) & (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
            camera, uv = camera[valid], uv[valid]
            background = ndimage.binary_erosion(background_masks[j], iterations=2)[uv[:, 1], uv[:, 0]]
            silhouette_conflicts = int(background.sum())
            valid = masks[j, uv[:, 1], uv[:, 0]]
            camera, uv = camera[valid], uv[valid]
            error = camera[:, 2] - depths[j, uv[:, 1], uv[:, 0]]
            visible = error <= tolerance  # further points can be behind a nearer surface
            count = int(visible.sum()) + silhouette_conflicts
            pairs.append({'source': i, 'target': j, 'compared': count,
                          'conflictFraction': float((np.sum(error[visible] < -tolerance) + silhouette_conflicts)/count) if count else None})
    return pairs


def fuse_scene(scene, output, grid_size=128):
    images = np.asarray(scene['images'])
    points = np.asarray(scene['world_points'])
    depths = np.asarray(scene['depth'])
    masks = np.asarray(scene['masks'], bool).copy()
    confidence = np.asarray(scene['confidence'])
    cameras = np.asarray(scene['camera_poses'])
    extrinsics = np.asarray(scene['extrinsics'])
    intrinsics = np.asarray(scene['intrinsics'])
    if len(images) != 3 or points.shape != images.shape:
        raise ValueError('Expected three jointly reconstructed views')
    subject_masks = np.stack([foreground(image) for image in images])
    for i in range(3):
        masks[i] &= subject_masks[i] & np.isfinite(points[i]).all(-1) & (depths[i] > 0)
        if masks[i].sum() < 100: raise ValueError(f'View {i+1} has too little valid subject depth')
    all_points = points[masks]
    center = np.median(all_points, axis=0)
    # Find a shared vertical from surface normals near the camera-up consensus.
    up = -cameras[:, :3, 1].mean(0); up /= np.linalg.norm(up)
    candidates = []
    for i in range(3):
        p = points[i]; n = np.cross(p[1:, :-1]-p[:-1, :-1], p[:-1, 1:]-p[:-1, :-1])
        length = np.linalg.norm(n, axis=-1); n /= np.maximum(length[..., None], 1e-10)
        n[np.einsum('...i,i->...', n, up) < 0] *= -1
        valid = masks[i][:-1, :-1] & masks[i][1:, :-1] & masks[i][:-1, 1:]
        valid &= (length > 1e-10) & (np.einsum('...i,i->...', n, up) > .65)
        candidates.append(n[valid])
    candidates = np.concatenate(candidates)
    if len(candidates) > 100:
        normal = np.median(candidates, axis=0); up = normal / np.linalg.norm(normal)
    front = -cameras[0, :3, 2].copy()
    front -= up * np.dot(front, up); front /= np.linalg.norm(front)
    right = np.cross(up, front); basis = np.stack([right, up, front], axis=1)
    local = (all_points - center) @ basis
    lo, hi = np.quantile(local, [.002, .998], axis=0)
    span = hi-lo
    if np.any(span <= 1e-5): raise ValueError('Estimated geometry has no three-dimensional extent')
    step = max(span) / (grid_size-5)
    lo -= step*2; hi += step*2
    shape = np.ceil((hi-lo)/step).astype(int)+1
    indices = np.indices(shape).reshape(3, -1).T
    samples = lo + indices*step
    world = samples @ basis.T + center
    sums = np.zeros(len(world)); weights = np.zeros(len(world)); empty = np.zeros(len(world), bool)
    per_view = []
    trunc = step*4
    for i in range(3):
        camera = world @ extrinsics[i, :3, :3].T + extrinsics[i, :3, 3]
        uvw = camera @ intrinsics[i].T
        uv = np.rint(uvw[:, :2]/np.maximum(uvw[:, 2:3], 1e-9)).astype(int)
        h, w = depths[i].shape
        inside = (camera[:, 2] > 0) & (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
        ids = np.flatnonzero(inside); x, y = uv[ids].T
        subject = masks[i, y, x]
        # Background is empty space only where the image mask is confidently outside the object.
        bg = ~subject_masks[i, y, x]
        empty[ids[bg]] = True
        ids = ids[subject]; x, y = uv[ids].T
        diff = depths[i, y, x] - camera[ids, 2]
        # A depth map observes free space in front and a narrow surface band.
        # It says nothing about far occluded space. Integrating -1 all the way
        # behind a surface manufactured the old solid rear walls.
        observed = diff >= -trunc
        ids, x, y, diff = ids[observed], x[observed], y[observed], diff[observed]
        weight = np.clip(confidence[i, y, x], .1, 20)
        sums[ids] += np.clip(diff/trunc, -1, 1)*weight
        weights[ids] += weight
        per_view.append(int(masks[i].sum()))
    field = np.ones(len(world), np.float32)
    known = weights > 0
    field[known] = sums[known]/weights[known]
    field[empty] = 1
    field = field.reshape(shape)
    # Explicit closure at the inferred bounds; this is estimated unseen geometry.
    field[[0, -1], :, :] = 1; field[:, [0, -1], :] = 1; field[:, :, [0, -1]] = 1
    if field.min() >= 0: raise ValueError('Depth fusion produced no occupied volume')
    vertices, faces, _, _ = marching_cubes(field, 0, spacing=(step,)*3)
    vertices += lo
    mesh = trimesh.Trimesh(vertices, faces, process=True)
    pieces = mesh.split(only_watertight=False)
    if not pieces: raise ValueError('No fused surface')
    total_area = sum(p.area for p in pieces)
    # Retain separate semantic volumes such as foliage; report rather than erase them.
    mesh = trimesh.util.concatenate([p for p in pieces if p.area > total_area*.0002])
    if len(mesh.faces) > 180000: mesh = mesh.simplify_quadric_decimation(face_count=180000)
    world_vertices = mesh.vertices @ basis.T + center
    rgb = images[masks]
    if rgb.max() <= 1.01: rgb = rgb*255
    # Colour only surfaces that are actually at an observed depth. Unknown
    # closure uses the median material, never nearest front-image decoration.
    vertex_rgb = np.zeros((len(world_vertices), 3)); colour_weights = np.zeros(len(world_vertices))
    for i in range(3):
        camera = world_vertices @ extrinsics[i, :3, :3].T + extrinsics[i, :3, 3]
        uvw = camera @ intrinsics[i].T
        uv = np.rint(uvw[:, :2] / np.maximum(uvw[:, 2:3], 1e-9)).astype(int)
        h, w = depths[i].shape
        inside = (camera[:, 2] > 0) & (uv[:, 0] >= 0) & (uv[:, 0] < w) & (uv[:, 1] >= 0) & (uv[:, 1] < h)
        ids = np.flatnonzero(inside); x, y = uv[ids].T
        observed = masks[i, y, x] & (np.abs(depths[i, y, x] - camera[ids, 2]) <= step*2)
        ids, x, y = ids[observed], x[observed], y[observed]
        weight = np.clip(confidence[i, y, x], .1, 20)
        colours = images[i, y, x].astype(float)
        if images.max() <= 1.01: colours *= 255
        vertex_rgb[ids] += colours * weight[:, None]; colour_weights[ids] += weight
    observed = colour_weights > 0
    vertex_rgb[observed] /= colour_weights[observed, None]
    vertex_rgb[~observed] = np.median(rgb, axis=0)
    # glTF vertex COLOR_0 is linear; source images are sRGB.
    srgb = np.clip(vertex_rgb / 255, 0, 1)
    linear = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)
    mesh.visual.vertex_colors = np.column_stack([np.rint(linear * 255).astype(np.uint8), np.full(len(mesh.vertices), 255, np.uint8)])
    mesh.vertices[:, 1] -= mesh.vertices[:, 1].min()
    mesh.export(output)
    directions = cameras[:, :3, 2]
    angles = np.degrees(np.arccos(np.clip(directions @ directions[0], -1, 1)))
    failures = []
    agreement = depth_agreement(points, depths, masks, extrinsics, intrinsics, step*2, ~subject_masks)
    minimum_overlap = max(20, int(np.prod(depths.shape[1:])*.0004))
    contradictory = [pair for pair in agreement if pair['compared'] >= minimum_overlap and pair['conflictFraction'] > .25]
    if contradictory:
        failures.append('估计的相机与深度在重叠区域不一致，融合形状不可靠；视角差通过不代表三维校准成功。')
    if angles[1] < 20:
        failures.append(f'侧面与正面估计视角仅相差 {angles[1]:.1f}°，侧面相机匹配可能错误，不能可靠转换。')
    if angles[2] < 20:
        failures.append(f'俯视与正面估计视角仅相差 {angles[2]:.1f}°，俯视相机匹配可能错误，不能可靠转换。')
    if not mesh.is_watertight: failures.append('融合表面存在开放边界，不能可靠填充积木体积。')
    report = {'engine': 'MapAnything MLX', 'fusionVersion': 2, 'jointViews': 3, 'validSubjectPixels': per_view,
              'triangles': len(mesh.faces), 'watertight': bool(mesh.is_watertight),
              'components': len(pieces), 'inferredUnseenClosure': True,
              'cameraAngles': {'frontSide': float(angles[1]), 'frontTop': float(angles[2])},
              'depthAgreement': agreement, 'unobservedColourFraction': float(np.mean(~observed)),
              'conversionAllowed': not failures, 'failures': failures,
              'warnings': ['未被三张图覆盖的背面与内部体积仍为估计。', '相机与闭合检查通过仍不等于形状准确或实物稳定性验证。']}
    Path(output).with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report
