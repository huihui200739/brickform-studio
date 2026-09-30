"""Fuse jointly estimated camera/depth maps. No single-image shape fallback."""
from pathlib import Path
import json
import numpy as np
from scipy import ndimage
from scipy.spatial import cKDTree
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
    for i in range(3):
        masks[i] &= foreground(images[i]) & np.isfinite(points[i]).all(-1) & (depths[i] > 0)
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
        bg = ~foreground(images[i])[y, x]
        empty[ids[bg]] = True
        ids = ids[subject]; x, y = uv[ids].T
        diff = depths[i, y, x] - camera[ids, 2]
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
    _, nearest = cKDTree(all_points).query(world_vertices)
    rgb = images[masks]
    if rgb.max() <= 1.01: rgb = rgb*255
    # glTF vertex COLOR_0 is linear; source images are sRGB.
    srgb = np.clip(rgb[nearest] / 255, 0, 1)
    linear = np.where(srgb <= .04045, srgb / 12.92, ((srgb + .055) / 1.055) ** 2.4)
    mesh.visual.vertex_colors = np.column_stack([np.rint(linear * 255).astype(np.uint8), np.full(len(nearest), 255, np.uint8)])
    mesh.vertices[:, 1] -= mesh.vertices[:, 1].min()
    mesh.export(output)
    directions = cameras[:, :3, 2]
    angles = np.degrees(np.arccos(np.clip(directions @ directions[0], -1, 1)))
    failures = []
    if angles[1] < 20:
        failures.append(f'侧面与正面估计视角仅相差 {angles[1]:.1f}°，侧面相机匹配可能错误，不能可靠转换。')
    if angles[2] < 20:
        failures.append(f'俯视与正面估计视角仅相差 {angles[2]:.1f}°，俯视相机匹配可能错误，不能可靠转换。')
    if not mesh.is_watertight: failures.append('融合表面存在开放边界，不能可靠填充积木体积。')
    report = {'engine': 'MapAnything MLX', 'jointViews': 3, 'validSubjectPixels': per_view,
              'triangles': len(mesh.faces), 'watertight': bool(mesh.is_watertight),
              'components': len(pieces), 'inferredUnseenClosure': True,
              'cameraAngles': {'frontSide': float(angles[1]), 'frontTop': float(angles[2])},
              'conversionAllowed': not failures, 'failures': failures,
              'warnings': ['未被三张图覆盖的背面与内部体积仍为估计。', '相机与闭合检查通过仍不等于形状准确或实物稳定性验证。']}
    Path(output).with_suffix('.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report
