import { PALETTE, type Raster } from './brick-engine.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import { rgb } from './material-color-space.ts';
import { referenceMaterials } from './reference-materials.ts';
import { surfaceMaterials } from './surface-materials.ts';

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
  const samples: number[][] = [];
  const stride = Math.max(3, Math.floor(p.length / 3 / 14000) * 3);
  for (let i = 0; i < p.length; i += stride)
    samples.push([p[i], p[i + 1], p[i + 2]]);
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
  const score = (camera: Camera) => {
    const view = project(camera),
      m = new Uint8Array(SIZE * SIZE);
    for (const v of view.projected) {
      const x = Math.round(
          ((v[0] - view.minX) / (view.maxX - view.minX)) * (SIZE - 1),
        ),
        y = Math.round(
          ((view.maxY - v[1]) / (view.maxY - view.minY)) * (SIZE - 1),
        );
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (x + dx >= 0 && x + dx < SIZE && y + dy >= 0 && y + dy < SIZE)
            m[(y + dy) * SIZE + x + dx] = 1;
    }
    let intersection = 0,
      union = 0;
    for (let i = 0; i < m.length; i++) {
      if (m[i] && target[i]) intersection++;
      if (m[i] || target[i]) union++;
    }
    const aspect = (view.maxX - view.minX) / (view.maxY - view.minY),
      targetAspect = (right - left) / (bottom - top);
    return (
      intersection / Math.max(1, union) -
      0.25 * Math.abs(Math.log(aspect / targetAspect))
    );
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
    const coarse = { ...camera };
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
  const view = project(camera);
  return {
    camera,
    confidence: Math.max(0, Math.min(1, score(camera))),
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
  const { camera, view, mask, left, right, top, bottom, extent } =
    referenceAlignment(mesh, image, override);
  const materials = referenceMaterials(image, mask, softenShadows);
  const p = mesh.positions;
  const N = 192,
    depth = new Float32Array(N * N).fill(-Infinity),
    pixelFace = new Int32Array(N * N).fill(-1),
    coords = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const v = view.point(p[i], p[i + 1], p[i + 2]);
    coords[i] = ((v[0] - view.minX) / (view.maxX - view.minX)) * (N - 1);
    coords[i + 1] = ((view.maxY - v[1]) / (view.maxY - view.minY)) * (N - 1);
    coords[i + 2] = v[2];
  }
  for (let i = 0; i < coords.length; i += 9) {
    const ax = coords[i],
      ay = coords[i + 1],
      bx = coords[i + 3],
      by = coords[i + 4],
      cx = coords[i + 6],
      cy = coords[i + 7],
      den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-8) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))),
      x1 = Math.min(N - 1, Math.ceil(Math.max(ax, bx, cx))),
      y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))),
      y1 = Math.min(N - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const a =
            ((by - cy) * (x + 0.5 - cx) + (cx - bx) * (y + 0.5 - cy)) / den,
          b = ((cy - ay) * (x + 0.5 - cx) + (ax - cx) * (y + 0.5 - cy)) / den;
        if (a < 0 || b < 0 || a + b > 1) continue;
        const z =
          a * coords[i + 2] + b * coords[i + 5] + (1 - a - b) * coords[i + 8];
        if (z > depth[y * N + x]) {
          depth[y * N + x] = z;
          pixelFace[y * N + x] = i / 9;
        }
      }
  }
  const faceColors = new Int16Array(p.length / 9).fill(-1),
    features = new Uint8Array(p.length / 9),
    counts = new Float64Array(PALETTE.length);
  let observed = 0;
  for (let i = 0; i < p.length; i += 9) {
    const x = (coords[i] + coords[i + 3] + coords[i + 6]) / 3,
      y = (coords[i + 1] + coords[i + 4] + coords[i + 7]) / 3,
      z = (coords[i + 2] + coords[i + 5] + coords[i + 8]) / 3;
    const ix = Math.min(N - 1, Math.max(0, Math.floor(x))),
      iy = Math.min(N - 1, Math.max(0, Math.floor(y)));
    if (
      !Number.isFinite(depth[iy * N + ix]) ||
      z < depth[iy * N + ix] - extent * 0.012
    )
      continue;
    const px = Math.round(left + (x / (N - 1)) * (right - left)),
      py = Math.round(top + (y / (N - 1)) * (bottom - top));
    if (
      px < 0 ||
      px >= image.width ||
      py < 0 ||
      py >= image.height ||
      !mask[py * image.width + px]
    )
      continue;
    const colorVotes = new Uint8Array(PALETTE.length);
    let sampled = 0,
      foliage = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = px + dx,
          yy = py + dy;
        if (xx < 0 || xx >= image.width || yy < 0 || yy >= image.height)
          continue;
        const k = yy * image.width + xx;
        if (mask[k]) {
          const r = image.data[k * 4],
            g = image.data[k * 4 + 1],
            b = image.data[k * 4 + 2];
          colorVotes[materials.palette[k]]++;
          sampled++;
          if (isFoliage(r, g, b)) foliage++;
        }
      }
    let c = 0;
    for (let j = 1; j < colorVotes.length; j++)
      if (colorVotes[j] > colorVotes[c]) c = j;
    faceColors[i / 9] = c;
    // A leaf's own brick colour is a detour: only the picture can say whether
    // this face is canopy. Half of a small window is enough, so a leaf piece
    // the size of a couple of pixels still counts.
    if (foliage >= 2 && foliage * 2 >= sampled)
      features[i / 9] |= MESH_FEATURE.foliage;
    observed++;
  }
  if (observed < Math.min(10, Math.max(1, faceColors.length * 0.1)))
    throw Error('参考图与网格未能对齐，请调整配色视角或更换图片。');
  // Vote once per visible projected pixel. Dense tessellation and tiny relief
  // triangles must not dominate the inferred material of unseen surfaces.
  const visiblePixels: { face: number; color: number }[] = [];
  let projectedPixels = 0;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const k = y * N + x;
      if (!Number.isFinite(depth[k])) continue;
      const px = Math.round(left + ((x + 0.5) / (N - 1)) * (right - left));
      const py = Math.round(top + ((y + 0.5) / (N - 1)) * (bottom - top));
      if (
        px < 0 ||
        px >= image.width ||
        py < 0 ||
        py >= image.height ||
        !mask[py * image.width + px]
      )
        continue;
      const color = materials.palette[py * image.width + px];
      counts[color]++;
      visiblePixels.push({ face: pixelFace[k], color });
      projectedPixels++;
    }
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
    materialEvidence: {
      regionIds: surfaces.regionIds,
      observed: Uint8Array.from(faceColors, (color) => (color >= 0 ? 1 : 0)),
    },
    materialDesign: {
      ...materials.design,
      surfaces: surfaces.design,
      warnings: [
        ...materials.design.warnings,
        'Unobserved faces use geometric surface material hypotheses. Compatible inclination and proximity do not prove unseen paint; regions without compatible observations use the reference default.',
      ],
      projection: {
        voteUnit: 'visible-reference-pixel',
        projectedPixels,
        observedFaces: observed,
        inferredFaces: faceColors.length - observed,
        materialPixels: Array.from(counts),
      },
    },
    coloring: {
      method: 'reference-projection',
      ...camera,
      observedFraction: observed / faceColors.length,
    },
  };
}
