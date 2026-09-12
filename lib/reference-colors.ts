import { PALETTE, type Raster } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';

const SIZE = 96;
function lab(r: number, g: number, b: number) {
  const f = (v: number) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const x = f(r),
    y = f(g),
    z = f(b);
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const a = t((0.4124 * x + 0.3576 * y + 0.1805 * z) / 0.95047),
    c = t(0.2126 * x + 0.7152 * y + 0.0722 * z),
    d = t((0.0193 * x + 0.1192 * y + 0.9505 * z) / 1.08883);
  return [116 * c - 16, 500 * (a - c), 200 * (c - d)];
}
const rgb = PALETTE.map((c) =>
  [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16)),
);
const colors = rgb.map((c) => lab(c[0], c[1], c[2]));
function match(r: number, g: number, b: number) {
  const p = lab(r, g, b);
  let index = 0,
    best = Infinity;
  colors.forEach((c, i) => {
    const dist =
      0.5 * (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
    if (dist < best) {
      best = dist;
      index = i;
    }
  });
  return index;
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
    const seen = new Uint8Array(w * h),
      queue: number[] = [];
    for (let x = 0; x < w; x++) queue.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) queue.push(y * w, y * w + w - 1);
    for (let at = 0; at < queue.length; at++) {
      const i = queue[at];
      if (seen[i]) continue;
      seen[i] = 1;
      if (
        !corners.some(
          (c) =>
            Math.hypot(
              data[i * 4] - c[0],
              data[i * 4 + 1] - c[1],
              data[i * 4 + 2] - c[2],
            ) < 48,
        )
      )
        continue;
      mask[i] = 0;
      const x = i % w,
        y = Math.floor(i / w);
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

type Camera = { yaw: number; pitch: number; perspective: number };
export function colorFromReference(
  mesh: TriangleMesh,
  image: Raster,
  override?: Camera,
  softenShadows = true,
): TriangleMesh {
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
  const view = project(camera),
    N = 192,
    depth = new Float32Array(N * N).fill(-Infinity),
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
        depth[y * N + x] = Math.max(depth[y * N + x], z);
      }
  }
  const faceColors = new Int16Array(p.length / 9).fill(-1),
    counts = new Uint32Array(PALETTE.length);
  const G = 24,
    votes = new Map<number, Uint32Array>();
  const cell = (x: number, y: number, z: number) =>
    Math.min(
      G - 1,
      Math.max(0, Math.floor(((x - lo[0]) / (hi[0] - lo[0])) * G)),
    ) +
    G *
      Math.min(
        G - 1,
        Math.max(0, Math.floor(((y - lo[1]) / (hi[1] - lo[1])) * G)),
      ) +
    G *
      G *
      Math.min(
        G - 1,
        Math.max(0, Math.floor(((z - lo[2]) / (hi[2] - lo[2])) * G)),
      );
  let observed = 0;
  for (let i = 0; i < p.length; i += 9) {
    const x = (coords[i] + coords[i + 3] + coords[i + 6]) / 3,
      y = (coords[i + 1] + coords[i + 4] + coords[i + 7]) / 3,
      z = (coords[i + 2] + coords[i + 5] + coords[i + 8]) / 3;
    const ix = Math.min(N - 1, Math.max(0, Math.floor(x))),
      iy = Math.min(N - 1, Math.max(0, Math.floor(y)));
    if (z < depth[iy * N + ix] - extent * 0.012) continue;
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
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = px + dx,
          yy = py + dy;
        if (xx < 0 || xx >= image.width || yy < 0 || yy >= image.height)
          continue;
        const k = yy * image.width + xx;
        if (mask[k])
          colorVotes[
            match(
              image.data[k * 4],
              image.data[k * 4 + 1],
              image.data[k * 4 + 2],
            )
          ]++;
      }
    let c = 0;
    for (let j = 1; j < colorVotes.length; j++)
      if (colorVotes[j] > colorVotes[c]) c = j;
    faceColors[i / 9] = c;
    counts[c]++;
    observed++;
    const k = cell(
      (p[i] + p[i + 3] + p[i + 6]) / 3,
      (p[i + 1] + p[i + 4] + p[i + 7]) / 3,
      (p[i + 2] + p[i + 5] + p[i + 8]) / 3,
    );
    let v = votes.get(k);
    if (!v) {
      v = new Uint32Array(PALETTE.length);
      votes.set(k, v);
    }
    v[c]++;
  }
  if (observed < Math.min(10, Math.max(1, faceColors.length * 0.1)))
    throw Error('参考图与网格未能对齐，请调整配色视角或更换图片。');
  // Unseen surfaces inherit the nearest observed 3D region. This is explicitly
  // estimated color, not a recovered back-side texture.
  const labels = new Int16Array(G ** 3).fill(-1),
    queue: number[] = [];
  votes.forEach((v, k) => {
    let c = 0;
    for (let i = 1; i < v.length; i++) if (v[i] > v[c]) c = i;
    labels[k] = c;
    queue.push(k);
  });
  for (let at = 0; at < queue.length; at++) {
    const k = queue[at],
      x = k % G,
      y = Math.floor(k / G) % G,
      z = Math.floor(k / G / G);
    for (const next of [
      x ? k - 1 : -1,
      x + 1 < G ? k + 1 : -1,
      y ? k - G : -1,
      y + 1 < G ? k + G : -1,
      z ? k - G * G : -1,
      z + 1 < G ? k + G * G : -1,
    ])
      if (next >= 0 && labels[next] < 0) {
        labels[next] = labels[k];
        queue.push(next);
      }
  }
  // Reduce illumination-induced color changes within the dominant material's
  // hue family. Red/green accents and neutral dark openings remain separate.
  // This is optional because a photograph cannot distinguish paint from shadow.
  const dominant = counts.indexOf(Math.max(...counts));
  const base = colors[dominant];
  const remap = colors.map((c, index) => {
    const chroma = Math.hypot(c[1], c[2]),
      baseChroma = Math.hypot(base[1], base[2]);
    const hueSimilarity =
      (c[1] * base[1] + c[2] * base[2]) / Math.max(1, chroma * baseChroma);
    if (
      !softenShadows ||
      base[0] < 65 ||
      c[0] > base[0] - 18 ||
      chroma < 15 ||
      hueSimilarity < 0.91
    )
      return index;
    const target = c.map((value, axis) => value * 0.35 + base[axis] * 0.65);
    let best = index,
      distance = Infinity;
    colors.forEach((candidate, i) => {
      const d = candidate.reduce((sum, v, a) => sum + (v - target[a]) ** 2, 0);
      if (d < distance) {
        distance = d;
        best = i;
      }
    });
    return best;
  });
  const out = new Uint8Array(mesh.colors.length);
  for (let t = 0; t < faceColors.length; t++) {
    const i = t * 9,
      k = cell(
        (p[i] + p[i + 3] + p[i + 6]) / 3,
        (p[i + 1] + p[i + 4] + p[i + 7]) / 3,
        (p[i + 2] + p[i + 5] + p[i + 8]) / 3,
      ),
      c = faceColors[t] >= 0 ? faceColors[t] : labels[k];
    out.set(rgb[remap[Math.max(0, c)]], t * 3);
  }
  return {
    ...mesh,
    colors: out,
    coloring: {
      method: 'reference-projection',
      ...camera,
      observedFraction: observed / faceColors.length,
    },
  };
}
