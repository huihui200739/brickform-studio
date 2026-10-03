import { PALETTE, type Raster } from './brick-engine.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import { rgb } from './material-color-space.ts';
import { referenceMaterials } from './reference-materials.ts';
import { surfaceMaterials } from './surface-materials.ts';
import { referenceVisibility } from './reference-visibility.ts';
import { createSceneSurfaceGraph } from './scene-surface-graph.ts';

const SIZE = 96;
// Olive foliage is warm and desaturated: its green channel barely beats red but
// clearly beats blue, while sand, brick, timber and grey all keep red well above
// green. Recognising it here, on the picture, is what keeps a tree from being
// lost when the nearest brick colour happens to be the sand around it.
function isFoliage(r: number, g: number, b: number) {
  const value = Math.max(r, g, b);
  return r - g <= 10 && g - b >= 12 && value >= 30 && value <= 210;
}
// Foreground transparency is preferred; opaque references use a conservative
// edge-connected background flood, never a luminance-derived depth map.
export function referenceMask(image: Raster) {
  const { width: w, height: h, data } = image;
  if (!w || !h || data.length !== w * h * 4) throw Error('参考图数据无效。');
  const mask = new Uint8Array(w * h);
  let transparent = 0;
  for (let i = 0; i < mask.length; i++) {
    mask[i] = data[i * 4 + 3] > 100 ? 1 : 0;
    if (!mask[i]) transparent++;
  }
  if (transparent < mask.length * 0.01) {
    const corners = [0, w - 1, (h - 1) * w, w * h - 1].map((i) => [
      data[i * 4],
      data[i * 4 + 1],
      data[i * 4 + 2],
    ]);
    const distance = (i: number, c: number[]) =>
      Math.abs(data[i * 4] - c[0]) +
      Math.abs(data[i * 4 + 1] - c[1]) +
      Math.abs(data[i * 4 + 2] - c[2]);
    // Grow the background from the border with a *local* tolerance, so a soft
    // studio gradient or a vignette is followed to its end, while the step onto
    // a differently coloured object is far too large to cross. A global test
    // against the corner colours alone stops at the first gradient step and
    // leaves half the backdrop inside the silhouette.
    const seen = new Uint8Array(w * h),
      queue: number[] = [];
    for (let x = 0; x < w; x++) queue.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) queue.push(y * w, y * w + w - 1);
    for (let at = 0; at < queue.length; at++) {
      const i = queue[at];
      if (seen[i]) continue;
      seen[i] = 1;
      const corner = corners.some((c) => distance(i, c) < 84);
      let neighbour = false;
      const x = i % w,
        y = Math.floor(i / w);
      for (const j of [
        x ? i - 1 : -1,
        x + 1 < w ? i + 1 : -1,
        y ? i - w : -1,
        y + 1 < h ? i + w : -1,
      ])
        if (
          j >= 0 &&
          !mask[j] &&
          distance(i, [data[j * 4], data[j * 4 + 1], data[j * 4 + 2]]) < 30
        )
          neighbour = true;
      if (!corner && !neighbour) continue;
      mask[i] = 0;
      if (x) queue.push(i - 1);
      if (x + 1 < w) queue.push(i + 1);
      if (y) queue.push(i - w);
      if (y + 1 < h) queue.push(i + w);
    }
  }
  let left = w,
    right = 0,
    top = h,
    bottom = 0;
  mask.forEach((v, i) => {
    if (v) {
      left = Math.min(left, i % w);
      right = Math.max(right, i % w);
      top = Math.min(top, Math.floor(i / w));
      bottom = Math.max(bottom, Math.floor(i / w));
    }
  });
  if (right <= left || bottom <= top)
    throw Error('参考图中没有清晰主体，请换一张背景干净的图片。');
  return { mask, left, right, top, bottom };
}

export type ReferenceCamera = {
  yaw: number;
  pitch: number;
  perspective: number;
};
type Camera = ReferenceCamera;
export function referenceAlignment(
  mesh: TriangleMesh,
  image: Raster,
  override?: Camera,
) {
  const { mask, left, right, top, bottom } = referenceMask(image),
    p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const a = i % 3;
    lo[a] = Math.min(lo[a], p[i]);
    hi[a] = Math.max(hi[a], p[i]);
  }
  const center = lo.map((v, i) => (v + hi[i]) / 2),
    extent = Math.max(...hi.map((v, i) => v - lo[i]));
  if (!Number.isFinite(extent) || extent <= 0)
    throw Error('网格没有有效体积。');
  const target = new Uint8Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++)
      target[y * SIZE + x] =
        mask[
          Math.min(
            image.height - 1,
            Math.round(top + (y / (SIZE - 1)) * (bottom - top)),
          ) *
            image.width +
            Math.min(
              image.width - 1,
              Math.round(left + (x / (SIZE - 1)) * (right - left)),
            )
        ];
  // Use all distinct source vertices for bounds. A sampling stride can skip
  // small extrema and change the fitted camera when a surface is subdivided.
  const samples: number[][] = [],
    vertexIds = new Int32Array(p.length / 3);
  const ids = new Map<string, number>();
  for (let i = 0; i < p.length; i += 3) {
    const key = `${p[i]},${p[i + 1]},${p[i + 2]}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = samples.length;
      ids.set(key, id);
      samples.push([p[i], p[i + 1], p[i + 2]]);
    }
    vertexIds[i / 3] = id;
  }
  const project = (camera: Camera) => {
    const yaw = (camera.yaw * Math.PI) / 180,
      pitch = (camera.pitch * Math.PI) / 180;
    const cy = Math.cos(yaw),
      sy = Math.sin(yaw),
      cp = Math.cos(pitch),
      sp = Math.sin(pitch);
    const point = (x: number, y: number, z: number) => {
      x -= center[0];
      y -= center[1];
      z -= center[2];
      const depth = sy * cp * x + sp * y + cy * cp * z,
        scale = 1 / (1 - (camera.perspective * depth) / extent);
      return [
        (cy * x - sy * z) * scale,
        (-sy * sp * x + cp * y - cy * sp * z) * scale,
        depth,
      ];
    };
    const projected = samples.map((v) => point(v[0], v[1], v[2]));
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    projected.forEach((v) => {
      minX = Math.min(minX, v[0]);
      maxX = Math.max(maxX, v[0]);
      minY = Math.min(minY, v[1]);
      maxY = Math.max(maxY, v[1]);
    });
    return { point, minX, maxX, minY, maxY, projected };
  };
  const assess = (camera: Camera) => {
    const view = project(camera),
      m = new Uint8Array(SIZE * SIZE);
    // Fill the actual projected triangles. Vertex splats measure tessellation
    // density, leave sparse faces hollow and can choose a different pose for
    // geometrically identical coarse and subdivided meshes.
    const sx = (SIZE - 1) / (view.maxX - view.minX),
      sy = (SIZE - 1) / (view.maxY - view.minY);
    const xy = view.projected.map((v) => [
      (v[0] - view.minX) * sx,
      (view.maxY - v[1]) * sy,
    ]);
    for (let i = 0; i < vertexIds.length; i += 3) {
      const [ax, ay] = xy[vertexIds[i]],
        [bx, by] = xy[vertexIds[i + 1]],
        [cx, cy] = xy[vertexIds[i + 2]];
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-8) continue;
      const minX = Math.max(0, Math.ceil(Math.min(ax, bx, cx))),
        maxX = Math.min(SIZE - 1, Math.floor(Math.max(ax, bx, cx))),
        minY = Math.max(0, Math.ceil(Math.min(ay, by, cy))),
        maxY = Math.min(SIZE - 1, Math.floor(Math.max(ay, by, cy)));
      for (let y = minY; y <= maxY; y++)
        for (let x = minX; x <= maxX; x++) {
          if (m[y * SIZE + x]) continue;
          const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den,
            b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
          if (a >= -1e-5 && b >= -1e-5 && a + b <= 1 + 1e-5)
            m[y * SIZE + x] = 1;
        }
    }
    let intersection = 0,
      union = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i] && target[i]) intersection++;
      if (m[i] || target[i]) union++;
    }
    const aspect = (view.maxX - view.minX) / (view.maxY - view.minY),
      targetAspect = (right - left) / (bottom - top),
      silhouetteIoU = intersection / Math.max(1, union),
      aspectPenalty = 0.25 * Math.abs(Math.log(aspect / targetAspect));
    return {
      score: silhouetteIoU - aspectPenalty,
      silhouetteIoU,
      aspectPenalty,
    };
  };
  const assessments = new Map<string, ReturnType<typeof assess>>();
  const evaluated: { camera: Camera; score: number }[] = [];
  const score = (camera: Camera) => {
    const key = `${camera.yaw},${camera.pitch},${camera.perspective}`;
    let result = assessments.get(key);
    if (!result) {
      result = assess(camera);
      assessments.set(key, result);
      evaluated.push({ camera: { ...camera }, score: result.score });
    }
    return result.score;
  };
  let camera: Camera = { yaw: 0, pitch: 20, perspective: 0.25 },
    best = -Infinity;
  if (override) camera = override;
  else {
    for (let yaw = -180; yaw < 180; yaw += 30)
      for (const pitch of [10, 25, 40]) {
        const c = { yaw, pitch, perspective: 0.25 },
          s = score(c);
        if (s > best) {
          best = s;
          camera = c;
        }
      }
    // Refine distinct coarse poses, not only the first winner. Symmetric
    // silhouettes can have equally plausible front/back or side cameras.
    const seeds: Camera[] = [];
    for (const candidate of [...evaluated].sort((a, b) => b.score - a.score)) {
      if (candidate.score < best - 0.12) continue;
      if (
        seeds.every(
          (c) =>
            Math.abs(((c.yaw - candidate.camera.yaw + 540) % 360) - 180) >= 45,
        )
      )
        seeds.push(candidate.camera);
      if (seeds.length === 4) break;
    }
    for (const coarse of seeds)
      for (let yaw = coarse.yaw - 15; yaw <= coarse.yaw + 15; yaw += 5)
        for (
          let pitch = Math.max(0, coarse.pitch - 10);
          pitch <= coarse.pitch + 10;
          pitch += 5
        )
          for (const perspective of [0, 0.25, 0.5]) {
            const c = { yaw, pitch, perspective },
              s = score(c);
            if (s > best) {
              best = s;
              camera = c;
            }
          }
  }
  const view = project(camera),
    fit = assess(camera);
  const yawDistance = (a: number, b: number) =>
    Math.abs(((a - b + 540) % 360) - 180);
  const alternative = evaluated
    .filter(
      (c) =>
        yawDistance(c.camera.yaw, camera.yaw) >= 45 ||
        Math.abs(c.camera.pitch - camera.pitch) >= 30,
    )
    .sort((a, b) => b.score - a.score)[0];
  const evidence = {
    method: 'filled-triangle-silhouette' as const,
    camera: { ...camera },
    source: override
      ? ('explicit-camera' as const)
      : ('estimated-camera' as const),
    silhouetteIoU: fit.silhouetteIoU,
    aspectPenalty: fit.aspectPenalty,
    alternative: alternative
      ? { ...alternative, scoreGap: fit.score - alternative.score }
      : undefined,
    ambiguous:
      !override && !!alternative && fit.score - alternative.score < 0.025,
    limitations:
      'Silhouette fit does not verify interior pixel correspondence, material identity or hidden geometry. Competing poses can share the same outline.',
  };
  return {
    camera,
    confidence: Math.max(0, Math.min(1, fit.score)),
    evidence,
    view,
    mask,
    left,
    right,
    top,
    bottom,
    lo,
    hi,
    center,
    extent,
  };
}
export function estimateReferenceCamera(
  mesh: TriangleMesh,
  image: Raster,
): ReferenceCamera {
  return referenceAlignment(mesh, image).camera;
}
export function colorFromReference(
  mesh: TriangleMesh,
  image: Raster,
  override?: ReferenceCamera,
  softenShadows = true,
): TriangleMesh {
  const {
    camera,
    view,
    mask,
    left,
    right,
    top,
    bottom,
    extent,
    evidence,
    center,
  } = referenceAlignment(mesh, image, override);
  const materials = referenceMaterials(image, mask, softenShadows);
  const p = mesh.positions;
  const N = 192,
    coords = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const v = view.point(p[i], p[i + 1], p[i + 2]);
    coords[i] = ((v[0] - view.minX) / (view.maxX - view.minX)) * (N - 1);
    coords[i + 1] = ((view.maxY - v[1]) / (view.maxY - view.minY)) * (N - 1);
    coords[i + 2] = v[2];
  }
  const visibility = referenceVisibility(coords, extent, camera.perspective, N);
  const observations = createSceneSurfaceGraph({
    positions: p,
    image,
    mask,
    rawRegionIds: materials.labels,
    camera,
    alignment: evidence,
    projectionSize: N,
    pixelFaces: visibility.pixelFace,
    imageBounds: [left, right, top, bottom],
    viewBounds: [view.minX, view.maxX, view.minY, view.maxY],
    meshCenter: center as [number, number, number],
    extent,
    depthTolerance: visibility.tolerance,
  });
  const faces = p.length / 9;
  const faceColors = new Int16Array(faces).fill(-1),
    features = new Uint8Array(faces),
    counts = new Float64Array(PALETTE.length),
    votes = new Uint32Array(faces * PALETTE.length),
    samples = new Uint32Array(faces),
    foliage = new Uint32Array(faces);
  const imagePixel = (x: number, y: number) => {
    const px = Math.round(left + (x / (N - 1)) * (right - left));
    const py = Math.round(top + (y / (N - 1)) * (bottom - top));
    if (px < 0 || px >= image.width || py < 0 || py >= image.height) return -1;
    const k = py * image.width + px;
    return mask[k] ? k : -1;
  };
  const sample = (face: number, k: number) => {
    votes[face * PALETTE.length + materials.palette[k]]++;
    samples[face]++;
    if (
      isFoliage(image.data[k * 4], image.data[k * 4 + 1], image.data[k * 4 + 2])
    )
      foliage[face]++;
  };
  // Every pixel belongs only to its nearest source surface. A partly occluded
  // face can still provide paint from its visible portion, away from its center.
  const visiblePixels: { face: number; color: number }[] = [];
  let projectedPixels = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const face = visibility.pixelFace[y * N + x];
      if (face < 0) continue;
      const k = imagePixel(x + 0.5, y + 0.5);
      if (k < 0) continue;
      observations?.recordPixel(y * N + x, k);
      const color = materials.palette[k];
      sample(face, k);
      counts[color]++;
      visiblePixels.push({ face, color });
      projectedPixels++;
    }
  let observed = 0,
    pixelObservedFaces = 0,
    centroidObservedFaces = 0,
    occludedCentroids = 0;
  for (let t = 0; t < faces; t++) {
    if (samples[t]) pixelObservedFaces++;
    else {
      // Microtriangles need an exact query at their own sample position, not
      // the depth at a neighboring raster pixel plus a broad distance allowance.
      const i = t * 9;
      const x = (coords[i] + coords[i + 3] + coords[i + 6]) / 3;
      const y = (coords[i + 1] + coords[i + 4] + coords[i + 7]) / 3;
      const z = visibility.depthAt(t, x, y);
      if (!Number.isFinite(z)) continue;
      const nearest = visibility.frontAt(x, y);
      if (z < nearest.depth - visibility.tolerance) {
        occludedCentroids++;
        continue;
      }
      const k = imagePixel(x, y);
      if (k < 0) continue;
      observations?.recordCentroid(t, x, y, k, z, nearest);
      sample(t, k);
      centroidObservedFaces++;
    }
    let color = 0;
    for (let c = 1; c < PALETTE.length; c++)
      if (votes[t * PALETTE.length + c] > votes[t * PALETTE.length + color])
        color = c;
    faceColors[t] = color;
    if (foliage[t] * 2 >= samples[t]) features[t] |= MESH_FEATURE.foliage;
    observed++;
  }
  if (observed < Math.min(10, Math.max(1, faces * 0.1)))
    throw Error('参考图与网格未能对齐，请调整配色视角或更换图片。');
  const dominant = counts.indexOf(Math.max(...counts));
  const surfaces = surfaceMaterials(p, faceColors, visiblePixels, dominant);
  const out = new Uint8Array(mesh.colors.length);
  for (let t = 0; t < faceColors.length; t++) {
    const c = surfaces.colors[t];
    out.set(rgb[Math.max(0, c)], t * 3);
  }
  return {
    ...mesh,
    colors: out,
    features,
    sourceObservations: observations?.finish(),
    materialHypothesis: undefined,
    materialEvidence: {
      regionIds: surfaces.regionIds,
      observed: Uint8Array.from(faceColors, (color) => (color >= 0 ? 1 : 0)),
    },
    materialDesign: {
      ...materials.design,
      alignment: evidence,
      surfaces: surfaces.design,
      warnings: [
        ...materials.design.warnings,
        'Unobserved faces use geometric surface material hypotheses. Compatible inclination and proximity do not prove unseen paint; regions without compatible observations use the reference default.',
      ],
      projection: {
        voteUnit: 'visible-reference-pixel',
        visibilityMethod: 'perspective-depth-tested-surfaces',
        pixelObservedFaces,
        centroidObservedFaces,
        occludedCentroids,
        depthTolerance: visibility.tolerance,
        projectedPixels,
        observedFaces: observed,
        inferredFaces: faceColors.length - observed,
        materialPixels: Array.from(counts),
      },
    },
    coloring: {
      method: 'reference-projection',
      alignment: evidence,
      ...camera,
      observedFraction: observed / faceColors.length,
      softenShadows,
    },
  };
}
