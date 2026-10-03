import type { TriangleMesh } from '../../lib/mesh-types.ts';
import type { referenceAlignment } from '../../lib/reference-colors.ts';
import { referenceVisibility } from '../../lib/reference-visibility.ts';

export type ContourSample = {
  x: number;
  y: number;
  tx: number;
  ty: number;
  weight: number;
  group: number;
  /** Optional complete landmark component; a directional chain is not one. */
  component?: number;
};
export type ContourSegment = {
  a: [number, number];
  b: [number, number];
  kind: 'crease' | 'boundary';
  group: number;
};

const LIMITS = {
  faces: 250_000,
  rasterPixels: 1024 * 1024,
  visibilityBinEntries: 2_000_000,
  visibilityPixelVisits: 16_000_000,
  queryFaceVisits: 25_000_000,
  samples: 80_000,
  segments: 20_000,
} as const;
const SIZE = 192;
const COS_COPLANAR = Math.cos((12 * Math.PI) / 180);
const COS_STABLE = Math.cos((8 * Math.PI) / 180);
const COS_CREASE = Math.cos((35 * Math.PI) / 180);

export type MeshContourSummary = {
  method: 'visible-geometric-contours';
  status: 'ok' | 'rejected';
  reasons: string[];
  rasterSize: [number, number] | null;
  sourceFaces: number;
  validFaces: number;
  invalidFaces: number;
  exactEdges: number;
  nonManifoldEdges: number;
  stablePatches: number;
  creaseCandidates: number;
  unsupportedCreases: number;
  occludedSamples: number;
  exteriorSamples: number;
  visibleSegments: number;
  internalSamples: number;
  limits: typeof LIMITS;
};

/** Experimental correspondence evidence, not a camera or material correction.
 * Exact topology and geometry alone form patches. Small or incoherent patches
 * cannot supply a crease; RGB, palette IDs and inferred paint are never read.
 * Boundaries of an open reconstruction are hypotheses, not proof of an opening.
 * rasterSize is needed because referenceAlignment does not record mask stride. */
export function extractMeshContours(
  mesh: TriangleMesh,
  alignment: ReturnType<typeof referenceAlignment>,
  rasterSize?: [number, number],
): {
  samples: ContourSample[];
  segments: ContourSegment[];
  summary: MeshContourSummary;
} {
  const p = mesh.positions;
  const n = p.length / 9;
  const recorded = mesh.sourceObservations?.raster;
  const size =
    rasterSize ??
    (recorded && recorded.width * recorded.height === alignment.mask.length
      ? ([recorded.width, recorded.height] as [number, number])
      : undefined);
  const summary: MeshContourSummary = {
    method: 'visible-geometric-contours',
    status: 'ok',
    reasons: [],
    rasterSize: size ? [...size] : null,
    sourceFaces: n,
    validFaces: 0,
    invalidFaces: 0,
    exactEdges: 0,
    nonManifoldEdges: 0,
    stablePatches: 0,
    creaseCandidates: 0,
    unsupportedCreases: 0,
    occludedSamples: 0,
    exteriorSamples: 0,
    visibleSegments: 0,
    internalSamples: 0,
    limits: LIMITS,
  };
  const reject = (reason: string) => {
    summary.status = 'rejected';
    summary.reasons.push(reason);
    summary.visibleSegments = 0;
    summary.internalSamples = 0;
    return { samples: [], segments: [], summary };
  };
  if (!Number.isInteger(n) || n < 1 || n > LIMITS.faces)
    return reject('Source face count is outside the bounded extractor limit.');
  if (
    !size ||
    !size.every((v) => Number.isInteger(v) && v > 0) ||
    size[0] * size[1] !== alignment.mask.length ||
    alignment.mask.length > LIMITS.rasterPixels
  )
    return reject('Original raster dimensions are unavailable or invalid.');
  const { view, extent, left, right, top, bottom, camera } = alignment;
  const spanX = view.maxX - view.minX,
    spanY = view.maxY - view.minY;
  if (
    ![extent, spanX, spanY, left, right, top, bottom, camera.perspective].every(
      Number.isFinite,
    ) ||
    extent <= 0 ||
    spanX <= 0 ||
    spanY <= 0 ||
    right <= left ||
    bottom <= top ||
    left < 0 ||
    top < 0 ||
    right >= size[0] ||
    bottom >= size[1]
  )
    return reject(
      'Source projection is non-finite or outside the original raster.',
    );

  const coords = new Float64Array(p.length);
  const normals = new Float64Array(n * 3),
    centers = new Float64Array(n * 3);
  const areas = new Float64Array(n),
    screenAreas = new Float64Array(n);
  const valid = new Uint8Array(n),
    vertexIds = new Int32Array(p.length / 3);
  const vertices = new Map<string, number>();
  const minArea = extent * extent * 1e-14;
  const toPixel = (x: number, y: number): [number, number] => [
    left + (x / (SIZE - 1)) * (right - left),
    top + (y / (SIZE - 1)) * (bottom - top),
  ];
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    for (let j = 0; j < 3; j++) {
      const at = i + j * 3;
      if (![p[at], p[at + 1], p[at + 2]].every(Number.isFinite))
        return reject('Non-finite source geometry cannot establish contours.');
      const key = `${p[at]},${p[at + 1]},${p[at + 2]}`;
      let id = vertices.get(key);
      if (id === undefined) {
        id = vertices.size;
        vertices.set(key, id);
      }
      vertexIds[at / 3] = id;
      const v = view.point(p[at], p[at + 1], p[at + 2]);
      if (
        !v.every(Number.isFinite) ||
        1 - (camera.perspective * v[2]) / extent <= 0
      )
        return reject(
          'A source vertex is behind or on the projection singularity.',
        );
      coords[at] = ((v[0] - view.minX) / spanX) * (SIZE - 1);
      coords[at + 1] = ((view.maxY - v[1]) / spanY) * (SIZE - 1);
      coords[at + 2] = v[2];
      for (let k = 0; k < 3; k++) centers[t * 3 + k] += p[at + k] / 3;
    }
    const ab = [0, 1, 2].map((k) => p[i + 3 + k] - p[i + k]);
    const ac = [0, 1, 2].map((k) => p[i + 6 + k] - p[i + k]);
    const cross = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const length = Math.hypot(...cross);
    if (length / 2 > minArea) {
      valid[t] = 1;
      areas[t] = length / 2;
      summary.validFaces++;
      for (let k = 0; k < 3; k++) normals[t * 3 + k] = cross[k] / length;
      const [a, b, c] = [0, 1, 2].map((j) =>
        toPixel(coords[i + j * 3], coords[i + j * 3 + 1]),
      );
      screenAreas[t] =
        Math.abs(
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ) / 2;
    } else summary.invalidFaces++;
  }

  // Compact incidence records retain the first two faces and a saturated
  // count. Every edge with >2 incidents (or a repeated face) is rejected.
  const edgeMap = new Map<number, number>(),
    maxEdges = n * 3;
  const edgeA = new Uint32Array(maxEdges),
    edgeB = new Uint32Array(maxEdges);
  const first = new Int32Array(maxEdges).fill(-1),
    second = new Int32Array(maxEdges).fill(-1);
  const counts = new Uint8Array(maxEdges),
    bad = new Uint8Array(maxEdges);
  const representatives = new Int32Array(vertices.size).fill(-1);
  const base = vertexIds.length;
  for (let at = 0; at < vertexIds.length; at++)
    if (representatives[vertexIds[at]] < 0)
      representatives[vertexIds[at]] = at * 3;
  for (let t = 0; t < n; t++)
    for (let e = 0; e < 3; e++) {
      const a = vertexIds[t * 3 + e],
        b = vertexIds[t * 3 + ((e + 1) % 3)];
      if (a === b) continue;
      const low = Math.min(a, b),
        high = Math.max(a, b),
        key = low * base + high;
      let id = edgeMap.get(key);
      if (id === undefined) {
        id = edgeMap.size;
        edgeMap.set(key, id);
        edgeA[id] = low;
        edgeB[id] = high;
      }
      if (!valid[t] || first[id] === t) bad[id] = 1;
      if (counts[id] === 0) first[id] = t;
      else if (counts[id] === 1) second[id] = t;
      counts[id] = Math.min(3, counts[id] + 1);
    }
  const edgeCount = edgeMap.size;
  summary.exactEdges = edgeCount;
  const parents = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    let root = a;
    while (parents[root] !== root) root = parents[root];
    while (parents[a] !== a) {
      const next = parents[a];
      parents[a] = root;
      a = next;
    }
    return root;
  };
  const normalDot = (a: number, b: number) =>
    [0, 1, 2].reduce((s, k) => s + normals[a * 3 + k] * normals[b * 3 + k], 0);
  for (let e = 0; e < edgeCount; e++) {
    if (counts[e] > 2 || bad[e]) {
      if (counts[e] > 2) summary.nonManifoldEdges++;
      continue;
    }
    if (counts[e] !== 2 || normalDot(first[e], second[e]) < COS_COPLANAR)
      continue;
    const a = find(first[e]),
      b = find(second[e]);
    if (a !== b) parents[Math.max(a, b)] = Math.min(a, b);
  }
  const patchFaces = new Uint32Array(n),
    patchArea = new Float64Array(n);
  const patchScreen = new Float64Array(n),
    sums = new Float64Array(n * 3);
  const patchCenters = new Float64Array(n * 3),
    deviation = new Float64Array(n);
  const x0 = new Float64Array(n).fill(Infinity),
    y0 = x0.slice();
  const x1 = new Float64Array(n).fill(-Infinity),
    y1 = x1.slice();
  for (let t = 0; t < n; t++)
    if (valid[t]) {
      const r = find(t);
      patchFaces[r]++;
      patchArea[r] += areas[t];
      patchScreen[r] += screenAreas[t];
      for (let k = 0; k < 3; k++) {
        sums[r * 3 + k] += normals[t * 3 + k] * areas[t];
        patchCenters[r * 3 + k] += centers[t * 3 + k] * areas[t];
      }
      for (let j = 0; j < 3; j++) {
        const at = t * 9 + j * 3,
          v = toPixel(coords[at], coords[at + 1]);
        x0[r] = Math.min(x0[r], v[0]);
        y0[r] = Math.min(y0[r], v[1]);
        x1[r] = Math.max(x1[r], v[0]);
        y1[r] = Math.max(y1[r], v[1]);
      }
    }
  const supported = new Uint8Array(n);
  for (let r = 0; r < n; r++)
    if (patchArea[r]) {
      const length = Math.hypot(sums[r * 3], sums[r * 3 + 1], sums[r * 3 + 2]);
      const span = Math.hypot(x1[r] - x0[r], y1[r] - y0[r]);
      if (
        patchFaces[r] >= 2 &&
        length / patchArea[r] >= COS_STABLE &&
        patchArea[r] >= extent * extent * 0.0002 &&
        patchScreen[r] >= 16 &&
        span >= 6 &&
        patchScreen[r] / span >= 3
      )
        supported[r] = 1;
      for (let k = 0; k < 3; k++) {
        sums[r * 3 + k] = length ? sums[r * 3 + k] / length : 0;
        patchCenters[r * 3 + k] /= patchArea[r];
      }
    }
  // Pairwise small angles alone can walk around a curved/noisy surface. Require
  // the whole connected patch to fit its own area-weighted plane as well.
  // Screen area / span also requires support across the plane, rejecting long
  // one-pixel corrugation strips that have coherent normals but no broad face.
  for (let t = 0; t < n; t++)
    if (valid[t]) {
      const r = find(t);
      for (let j = 0; j < 3; j++) {
        let distance = 0;
        for (let k = 0; k < 3; k++)
          distance +=
            (p[t * 9 + j * 3 + k] - patchCenters[r * 3 + k]) * sums[r * 3 + k];
        deviation[r] = Math.max(deviation[r], Math.abs(distance));
      }
    }
  for (let r = 0; r < n; r++)
    if (supported[r]) {
      if (deviation[r] > extent * 0.003) supported[r] = 0;
      else summary.stablePatches++;
    }

  // Source-stable groups precede every screen-space/visibility filter. The
  // minimum exact edge ID identifies a connected patch-pair component, even
  // when another camera makes some of its faces grazing or occluded.
  const groupParents = Int32Array.from({ length: edgeCount }, (_, e) => e);
  const endpointGroups = new Map<string, number>();
  const groupRoot = (e: number): number => {
    let root = e;
    while (groupParents[root] !== root) root = groupParents[root];
    while (groupParents[e] !== e) {
      const next = groupParents[e];
      groupParents[e] = root;
      e = next;
    }
    return root;
  };
  for (let e = 0; e < edgeCount; e++) {
    if (bad[e] || counts[e] > 2) continue;
    const boundary = counts[e] === 1;
    if (!boundary && Math.abs(normalDot(first[e], second[e])) > COS_CREASE)
      continue;
    const a = find(first[e]),
      b = boundary ? -1 : find(second[e]);
    const patchKey = boundary
      ? `b:${a}`
      : `c:${Math.min(a, b)}:${Math.max(a, b)}`;
    for (const vertex of [edgeA[e], edgeB[e]]) {
      const key = `${patchKey}:${vertex}`,
        old = endpointGroups.get(key);
      if (old !== undefined) {
        const aRoot = groupRoot(e),
          bRoot = groupRoot(old);
        groupParents[Math.max(aRoot, bRoot)] = Math.min(aRoot, bRoot);
      }
      endpointGroups.set(key, e);
    }
  }

  // Preflight the existing rasterizer's two independent loops before calling
  // it; large overlapping triangles otherwise create unbounded bin/query work.
  const binCounts = new Uint32Array(32 * 32);
  const bin = (v: number) =>
    Math.max(0, Math.min(31, Math.floor((v / SIZE) * 32)));
  let binEntries = 0,
    pixelVisits = 0;
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const xs = [coords[i], coords[i + 3], coords[i + 6]],
      ys = [coords[i + 1], coords[i + 4], coords[i + 7]];
    const den =
      (ys[1] - ys[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (ys[0] - ys[2]);
    if (Math.abs(den) < 1e-10) continue;
    const loX = Math.min(...xs),
      hiX = Math.max(...xs),
      loY = Math.min(...ys),
      hiY = Math.max(...ys);
    binEntries += (bin(hiX) - bin(loX) + 1) * (bin(hiY) - bin(loY) + 1);
    pixelVisits +=
      Math.max(
        0,
        Math.min(SIZE - 1, Math.ceil(hiX)) - Math.max(0, Math.floor(loX)) + 1,
      ) *
      Math.max(
        0,
        Math.min(SIZE - 1, Math.ceil(hiY)) - Math.max(0, Math.floor(loY)) + 1,
      );
    if (
      binEntries > LIMITS.visibilityBinEntries ||
      pixelVisits > LIMITS.visibilityPixelVisits
    )
      return reject('Visibility preflight exceeds the bounded work limit.');
    for (let y = bin(loY); y <= bin(hiY); y++)
      for (let x = bin(loX); x <= bin(hiX); x++) binCounts[y * 32 + x]++;
  }
  const visibility = referenceVisibility(
    coords,
    extent,
    camera.perspective,
    SIZE,
  );
  const samples: ContourSample[] = [],
    segments: ContourSegment[] = [];
  let queryVisits = 0;
  const interior = (x: number, y: number) => {
    const [width, height] = size;
    // Conservative Euclidean distance from original background pixel centres.
    if (x < 3 || y < 3 || x > width - 4 || y > height - 4) return false;
    for (let py = Math.floor(y - 3); py <= Math.ceil(y + 3); py++)
      for (let px = Math.floor(x - 3); px <= Math.ceil(x + 3); px++)
        if (
          (px - x) ** 2 + (py - y) ** 2 < 9 &&
          !alignment.mask[py * width + px]
        )
          return false;
    return !!alignment.mask[Math.round(y) * width + Math.round(x)];
  };
  for (let e = 0; e < edgeCount; e++) {
    if (bad[e] || counts[e] > 2) continue;
    const aFace = first[e],
      bFace = second[e],
      aPatch = find(aFace);
    const boundary = counts[e] === 1;
    const bPatch = boundary ? -1 : find(bFace);
    if (!boundary && Math.abs(normalDot(aFace, bFace)) > COS_CREASE) continue;
    if (!boundary) summary.creaseCandidates++;
    const patchDot = boundary
      ? 0
      : [0, 1, 2].reduce(
          (s, k) => s + sums[aPatch * 3 + k] * sums[bPatch * 3 + k],
          0,
        );
    if (
      !supported[aPatch] ||
      (!boundary &&
        (!supported[bPatch] ||
          aPatch === bPatch ||
          Math.abs(patchDot) > COS_CREASE))
    ) {
      if (!boundary) summary.unsupportedCreases++;
      continue;
    }
    const pa = representatives[edgeA[e]],
      pb = representatives[edgeB[e]];
    const a = toPixel(coords[pa], coords[pa + 1]),
      b = toPixel(coords[pb], coords[pb + 1]);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < 0.5) continue;
    const group = groupRoot(e);
    const steps = Math.ceil(length / 0.75),
      tx = (b[0] - a[0]) / length,
      ty = (b[1] - a[1]) / length;
    const point = (u: number): [number, number] => [
      a[0] + (b[0] - a[0]) * u,
      a[1] + (b[1] - a[1]) * u,
    ];
    let runStart = -1;
    for (let j = 0; j <= steps; j++) {
      let visible = false;
      if (j < steps) {
        const u = (j + 0.5) / steps,
          [x, y] = point(u);
        const gx = coords[pa] + (coords[pb] - coords[pa]) * u,
          gy = coords[pa + 1] + (coords[pb + 1] - coords[pa + 1]) * u;
        queryVisits += binCounts[bin(gy) * 32 + bin(gx)];
        if (queryVisits > LIMITS.queryFaceVisits)
          return reject(
            'Exact visibility queries exceed the bounded work limit.',
          );
        const front = visibility.frontAt(gx, gy);
        const wa = 1 - (camera.perspective * coords[pa + 2]) / extent,
          wb = 1 - (camera.perspective * coords[pb + 2]) / extent;
        const depth =
          (((1 - u) * coords[pa + 2]) / wa + (u * coords[pb + 2]) / wb) /
          ((1 - u) / wa + u / wb);
        visible =
          front.face >= 0 &&
          Math.abs(front.depth - depth) <= visibility.tolerance &&
          (find(front.face) === aPatch ||
            (!boundary && find(front.face) === bPatch));
        if (!visible) summary.occludedSamples++;
        else if (!interior(x, y)) summary.exteriorSamples++;
        else {
          samples.push({ x, y, tx, ty, weight: length / steps, group });
          if (samples.length > LIMITS.samples)
            return reject('Contour samples exceed the bounded output limit.');
        }
      }
      if (visible && runStart < 0) runStart = j;
      if (!visible && runStart >= 0) {
        // Use actually queried visible points as display endpoints, rather
        // than extending a half sample interval into an occluded portion.
        if (j - runStart >= 2)
          segments.push({
            a: point((runStart + 0.5) / steps),
            b: point((j - 0.5) / steps),
            kind: boundary ? 'boundary' : 'crease',
            group,
          });
        runStart = -1;
        if (segments.length > LIMITS.segments)
          return reject('Visible segments exceed the bounded output limit.');
      }
    }
  }
  summary.visibleSegments = segments.length;
  summary.internalSamples = samples.length;
  return { samples, segments, summary };
}
