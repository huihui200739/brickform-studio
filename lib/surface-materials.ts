import { rgb } from './material-color-space.ts';

export type SurfaceMaterialRegion = {
  id: number;
  faces: number;
  area: number;
  normal: number[];
  center: number[];
  observedFaces: number;
  inferredFaces: number;
  observedPixels: number;
  materialPixels: number[];
  // Suggested color for inferred members; observed members retain their paint.
  color: number;
  source: 'local-observation' | 'compatible-surface' | 'reference-default';
  donorRegionIds: number[];
};
export type SurfaceMaterialDesign = {
  method: 'connected-surface-materials';
  regions: SurfaceMaterialRegion[];
  inferredFaces: number;
  defaultFaces: number;
};

/** Infer missing paint from connected, similarly oriented surface regions.
 * Never alter an observed face. Neither geometric proximity nor a shared
 * normal proves material identity on an unseen side; record every inference. */
export function surfaceMaterials(
  p: Float32Array,
  observed: Int16Array,
  pixels: { face: number; color: number }[],
  fallback: number,
) {
  const n = p.length / 9;
  const normals = new Float64Array(n * 3),
    centers = new Float64Array(n * 3),
    areas = new Float64Array(n),
    labels = new Int32Array(n).fill(-1);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  const extent = Math.max(...hi.map((v, a) => v - lo[a]));
  // Weld only coincident source vertices; do not connect across cracks, holes
  // or merely nearby surfaces. Non-manifold edges have no reliable continuation.
  const vertices = new Map<string, number>(),
    edges = new Map<string, number[]>();
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < n; t++) {
    const i = t * 9,
      ids: number[] = [];
    for (let v = 0; v < 3; v++) {
      const key = [0, 1, 2].map((a) => p[i + v * 3 + a]).join(',');
      if (!vertices.has(key)) vertices.set(key, vertices.size);
      ids.push(vertices.get(key)!);
      for (let a = 0; a < 3; a++) centers[t * 3 + a] += p[i + v * 3 + a] / 3;
    }
    const a = [0, 1, 2].map((k) => p[i + 3 + k] - p[i + k]);
    const b = [0, 1, 2].map((k) => p[i + 6 + k] - p[i + k]);
    const cross = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const length = Math.hypot(...cross);
    areas[t] = length / 2;
    if (length > 0)
      for (let k = 0; k < 3; k++) normals[t * 3 + k] = cross[k] / length;
    for (let e = 0; e < 3; e++) {
      const a = ids[e],
        b = ids[(e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  for (const faces of edges.values())
    if (faces.length === 2) {
      neighbours[faces[0]].push(faces[1]);
      neighbours[faces[1]].push(faces[0]);
    }
  const dot = (a: number, b: number) =>
    [0, 1, 2].reduce((s, k) => s + normals[a * 3 + k] * normals[b * 3 + k], 0);
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => areas[b] - areas[a] || a - b,
  );
  const regions: SurfaceMaterialRegion[] = [];
  for (const seed of order) {
    if (labels[seed] >= 0) continue;
    const id = regions.length,
      queue = [seed];
    labels[seed] = id;
    let paint = observed[seed];
    const r: SurfaceMaterialRegion = {
      id,
      faces: 0,
      area: 0,
      normal: [0, 0, 0],
      center: [0, 0, 0],
      observedFaces: 0,
      inferredFaces: 0,
      observedPixels: 0,
      materialPixels: Array(rgb.length).fill(0),
      color: fallback,
      source: 'reference-default',
      donorRegionIds: [],
    };
    for (let head = 0; head < queue.length; head++) {
      const t = queue[head];
      r.faces++;
      r.area += areas[t];
      if (observed[t] >= 0) r.observedFaces++;
      else r.inferredFaces++;
      for (let k = 0; k < 3; k++) {
        r.normal[k] += normals[t * 3 + k] * areas[t];
        r.center[k] += centers[t * 3 + k] * areas[t];
      }
      for (const next of neighbours[t]) {
        if (labels[next] >= 0 || dot(seed, next) < 0.9 || dot(t, next) < 0.8)
          continue;
        // An unobserved detour cannot merge two observed paints into one patch.
        if (observed[next] >= 0 && paint >= 0 && observed[next] !== paint)
          continue;
        if (paint < 0 && observed[next] >= 0) paint = observed[next];
        labels[next] = id;
        queue.push(next);
      }
    }
    if (r.area > 0) for (let k = 0; k < 3; k++) r.center[k] /= r.area;
    const length = Math.hypot(...r.normal);
    if (length) r.normal = r.normal.map((v) => v / length);
    regions.push(r);
  }
  for (const { face, color } of pixels)
    if (face >= 0 && labels[face] >= 0) {
      const r = regions[labels[face]];
      r.materialPixels[color]++;
      r.observedPixels++;
    }
  const darkNeutral = (color: number) => {
    const max = Math.max(...rgb[color]),
      min = Math.min(...rgb[color]);
    return max < 120 && (max === 0 || (max - min) / max < 0.15);
  };
  const allowed = (color: number) =>
    darkNeutral(fallback) || !darkNeutral(color);
  const choose = (votes: number[]) => {
    let best = -1;
    for (let c = 0; c < votes.length; c++)
      if (allowed(c) && votes[c] > 0 && (best < 0 || votes[c] > votes[best]))
        best = c;
    return best;
  };
  // Only real projected pixels vote. A dense patch gets no advantage from its
  // triangle count, and a one-pixel speck cannot paint an entire unseen region.
  const donors = regions.filter(
    // A flame, badge or tiny painted trim can keep its own material, but its
    // small geometric footprint is not evidence for paint on other surfaces.
    (r) =>
      r.observedPixels >= 8 &&
      r.area >= extent * extent * 0.001 &&
      choose(r.materialPixels) >= 0,
  );
  for (const r of regions) {
    const local = choose(r.materialPixels);
    if (local >= 0 && r.observedPixels >= 8) {
      r.color = local;
      r.source = 'local-observation';
      continue;
    }
    const candidates = donors
      .map((d) => {
        const inclination = Math.abs(
          Math.abs(d.normal[1]) - Math.abs(r.normal[1]),
        );
        const distance = Math.hypot(
          ...r.center.map((v, k) => (v - d.center[k]) / extent),
        );
        // Same-height roofs and walls have different inclinations. Top and
        // underside do not imply the same material even when they are parallel.
        const compatible =
          inclination <= 0.12 && !(d.normal[1] * r.normal[1] < -0.1);
        return { d, distance, inclination, compatible };
      })
      .filter((c) => c.compatible && c.distance < 0.8)
      .sort((a, b) => a.distance - b.distance || a.d.id - b.d.id)
      .slice(0, 4);
    if (candidates.length) {
      const votes = Array(rgb.length).fill(0);
      for (const { d, distance, inclination } of candidates)
        for (let c = 0; c < votes.length; c++)
          if (allowed(c))
            votes[c] +=
              d.materialPixels[c] / (0.02 + distance * distance + inclination);
      const color = choose(votes);
      if (color >= 0) {
        r.color = color;
        r.source = 'compatible-surface';
        r.donorRegionIds = candidates.map(({ d }) => d.id);
      }
    }
  }
  const colors = observed.slice();
  for (let t = 0; t < n; t++)
    if (colors[t] < 0) colors[t] = regions[labels[t]].color;
  return {
    colors,
    regionIds: labels,
    design: {
      method: 'connected-surface-materials' as const,
      regions,
      inferredFaces: regions.reduce((s, r) => s + r.inferredFaces, 0),
      defaultFaces: regions
        .filter((r) => r.source === 'reference-default')
        .reduce((s, r) => s + r.inferredFaces, 0),
    },
  };
}
