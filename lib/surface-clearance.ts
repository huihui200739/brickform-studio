/** Limits bound temporary broad-phase memory and exact collision work. Budget
 * exhaustion vetoes a candidate instead of silently skipping source surfaces. */
export const SURFACE_CLEARANCE_LIMITS = Object.freeze({
  maxFaces: 250_000,
  maxDisplacementStuds: 0.25,
  cellWidthStuds: 1,
  maxCellsPerFace: 1_024,
  maxBins: 131_072,
  maxCellEntries: 1_500_000,
  maxFacesPerBin: 8_192,
  maxPairVisits: 10_000_000,
  maxTestedPairs: 1_000_000,
});

export type SurfaceClearanceResult = {
  accepted: boolean;
  reason?:
    | 'invalid-input'
    | 'face-budget'
    | 'motion-limit'
    | 'spatial-budget'
    | 'pair-budget'
    | 'new-intersection';
  movedFaces: number;
  bins: number;
  cellEntries: number;
  pairVisits: number;
  testedPairs: number;
  firstFaces?: readonly [number, number];
};

type Vec = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Exact coordinate aliases are source incidence, independent of paint and of
 * candidate coordinates. Faces touching at a source vertex are already in
 * contact and are governed by the caller's local orientation check. */
function sourceIncident(positions: Float32Array, f: number, g: number) {
  for (let a = f * 9; a < f * 9 + 9; a += 3)
    for (let b = g * 9; b < g * 9 + 9; b += 3)
      if (
        positions[a] === positions[b] &&
        positions[a + 1] === positions[b + 1] &&
        positions[a + 2] === positions[b + 2]
      )
        return true;
  return false;
}

/** Triangle separating-axis test, including the extra in-plane axes needed
 * for coplanar triangles. Normalization and a local origin keep tolerances in
 * studs and avoid cancellation for meshes far from the world origin. */
function trianglesIntersect(
  positions: Float32Array,
  f: number,
  g: number,
  scale: number,
  toleranceStuds: number,
) {
  const origin = Array.from(positions.subarray(f * 9, f * 9 + 3)) as Vec;
  const points = [f, g].map((face) =>
    [0, 1, 2].map(
      (vertex) =>
        [0, 1, 2].map(
          (axis) =>
            (positions[face * 9 + vertex * 3 + axis] - origin[axis]) * scale,
        ) as Vec,
    ),
  );
  const edges = points.map((triangle) =>
    [0, 1, 2].map((i) => sub(triangle[(i + 1) % 3], triangle[i])),
  );
  const normals = edges.map((e) => cross(e[0], e[1]));
  // Zero-area source faces are not surface obstacles. The plane designer must
  // separately reject candidate face collapse through its orientation gate.
  if (normals.some((normal) => Math.hypot(...normal) === 0)) return false;
  const separated = (axis: Vec) => {
    const size = Math.hypot(...axis);
    if (!size) return false;
    const unit = axis.map((v) => v / size) as Vec;
    const ranges = points.map((triangle) => {
      const values = triangle.map((point) => dot(point, unit));
      return [Math.min(...values), Math.max(...values)];
    });
    return (
      ranges[0][1] < ranges[1][0] - toleranceStuds ||
      ranges[1][1] < ranges[0][0] - toleranceStuds
    );
  };
  if (normals.some(separated)) return false;
  for (const a of edges[0])
    for (const b of edges[1]) if (separated(cross(a, b))) return false;
  for (let triangle = 0; triangle < 2; triangle++)
    for (const edge of edges[triangle])
      if (separated(cross(normals[triangle], edge))) return false;
  return true;
}

function boundsOfFace(
  positions: Float32Array,
  face: number,
  out: Float32Array,
) {
  const offset = face * 9,
    at = face * 6;
  for (let axis = 0; axis < 3; axis++) {
    out[at + axis] = Math.min(
      positions[offset + axis],
      positions[offset + 3 + axis],
      positions[offset + 6 + axis],
    );
    out[at + 3 + axis] = Math.max(
      positions[offset + axis],
      positions[offset + 3 + axis],
      positions[offset + 6 + axis],
    );
  }
}

/** Veto new final-position intersections of nonincident source triangles.
 * Source and candidate must retain face order and source vertex aliases. This
 * is a conservative bounded gate, not continuous collision detection: it does
 * not establish a minimum gap, or prevent entire disconnected sheets swapping
 * order if their final triangles never intersect. Already intersecting source
 * pairs are excluded; their changed extent is not measured. No input is edited. */
export function validateSurfaceClearance(
  source: Float32Array,
  candidate: Float32Array,
  resolution: number,
): SurfaceClearanceResult {
  const result: SurfaceClearanceResult = {
    accepted: false,
    movedFaces: 0,
    bins: 0,
    cellEntries: 0,
    pairVisits: 0,
    testedPairs: 0,
  };
  const reject = (reason: SurfaceClearanceResult['reason']) => ({
    ...result,
    reason,
  });
  if (
    source.length !== candidate.length ||
    source.length % 9 !== 0 ||
    !Number.isFinite(resolution) ||
    resolution <= 0
  )
    return reject('invalid-input');
  const faceCount = source.length / 9;
  if (faceCount > SURFACE_CLEARANCE_LIMITS.maxFaces)
    return reject('face-budget');
  const sourceLo = [Infinity, Infinity, Infinity],
    sourceHi = [-Infinity, -Infinity, -Infinity],
    combinedLo = [Infinity, Infinity, Infinity],
    combinedHi = [-Infinity, -Infinity, -Infinity];
  let different = false;
  for (let i = 0; i < source.length; i++) {
    if (!Number.isFinite(source[i]) || !Number.isFinite(candidate[i]))
      return reject('invalid-input');
    const axis = i % 3;
    sourceLo[axis] = Math.min(sourceLo[axis], source[i]);
    sourceHi[axis] = Math.max(sourceHi[axis], source[i]);
    combinedLo[axis] = Math.min(combinedLo[axis], source[i], candidate[i]);
    combinedHi[axis] = Math.max(combinedHi[axis], source[i], candidate[i]);
    different ||= source[i] !== candidate[i];
  }
  if (!different) return { ...result, accepted: true };
  const span = Math.max(...sourceHi.map((v, axis) => v - sourceLo[axis])),
    scale = resolution / span;
  if (!Number.isFinite(scale) || scale <= 0) return reject('invalid-input');
  const moved = new Uint8Array(faceCount),
    sweptBounds = new Float32Array(faceCount * 6),
    candidateBounds = new Float32Array(faceCount * 6);
  for (let face = 0; face < faceCount; face++) {
    boundsOfFace(source, face, sweptBounds);
    boundsOfFace(candidate, face, candidateBounds);
    for (let axis = 0; axis < 3; axis++) {
      const at = face * 6;
      sweptBounds[at + axis] = Math.min(
        sweptBounds[at + axis],
        candidateBounds[at + axis],
      );
      sweptBounds[at + 3 + axis] = Math.max(
        sweptBounds[at + 3 + axis],
        candidateBounds[at + 3 + axis],
      );
    }
    for (let at = face * 9; at < face * 9 + 9; at += 3) {
      const motion =
        Math.hypot(
          candidate[at] - source[at],
          candidate[at + 1] - source[at + 1],
          candidate[at + 2] - source[at + 2],
        ) * scale;
      if (motion > SURFACE_CLEARANCE_LIMITS.maxDisplacementStuds + 1e-6)
        return reject('motion-limit');
      if (motion > 0) moved[face] = 1;
    }
    result.movedFaces += moved[face];
  }
  const cellScale = scale / SURFACE_CLEARANCE_LIMITS.cellWidthStuds;
  const dimensions = combinedHi.map(
    (hi, axis) => Math.floor((hi - combinedLo[axis]) * cellScale) + 1,
  );
  if (!Number.isSafeInteger(dimensions[0] * dimensions[1] * dimensions[2]))
    return reject('spatial-budget');
  const grid = new Map<number, number[]>();
  const cellRange = new Float64Array(6);
  const range = (face: number) => {
    for (let i = 0; i < 6; i++)
      cellRange[i] = Math.floor(
        (sweptBounds[face * 6 + i] - combinedLo[i % 3]) * cellScale,
      );
  };
  const cellKey = (x: number, y: number, z: number) =>
    (z * dimensions[1] + y) * dimensions[0] + x;
  for (let face = 0; face < faceCount; face++) {
    range(face);
    const x0 = cellRange[0],
      y0 = cellRange[1],
      z0 = cellRange[2],
      x1 = cellRange[3],
      y1 = cellRange[4],
      z1 = cellRange[5];
    const cells = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    if (cells > SURFACE_CLEARANCE_LIMITS.maxCellsPerFace)
      return reject('spatial-budget');
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const key = cellKey(x, y, z);
          let bin = grid.get(key);
          if (!bin) {
            if (grid.size >= SURFACE_CLEARANCE_LIMITS.maxBins)
              return reject('spatial-budget');
            bin = [];
            grid.set(key, bin);
            result.bins++;
          }
          if (
            bin.length >= SURFACE_CLEARANCE_LIMITS.maxFacesPerBin ||
            result.cellEntries >= SURFACE_CLEARANCE_LIMITS.maxCellEntries
          )
            return reject('spatial-budget');
          bin.push(face);
          result.cellEntries++;
        }
  }
  const visited = new Set<number>();
  for (let face = 0; face < faceCount; face++) {
    if (!moved[face]) continue;
    visited.clear();
    range(face);
    const x0 = cellRange[0],
      y0 = cellRange[1],
      z0 = cellRange[2],
      x1 = cellRange[3],
      y1 = cellRange[4],
      z1 = cellRange[5];
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++)
          for (const other of grid.get(cellKey(x, y, z)) ?? []) {
            if (++result.pairVisits > SURFACE_CLEARANCE_LIMITS.maxPairVisits)
              return reject('pair-budget');
            if (
              other === face ||
              (moved[other] && other < face) ||
              visited.has(other)
            )
              continue;
            visited.add(other);
            const a = face * 6,
              b = other * 6;
            let separated = false;
            for (let axis = 0; axis < 3; axis++)
              if (
                candidateBounds[a + 3 + axis] < candidateBounds[b + axis] ||
                candidateBounds[b + 3 + axis] < candidateBounds[a + axis]
              ) {
                separated = true;
                break;
              }
            if (separated || sourceIncident(source, face, other)) continue;
            if (++result.testedPairs > SURFACE_CLEARANCE_LIMITS.maxTestedPairs)
              return reject('pair-budget');
            if (
              trianglesIntersect(candidate, face, other, scale, 1e-9) &&
              // A positive raw source gap cannot be erased by the candidate's
              // conservative contact tolerance and called an old intersection.
              !trianglesIntersect(source, face, other, scale, 0)
            )
              return {
                ...reject('new-intersection'),
                firstFaces: [face, other],
              };
          }
  }
  return { ...result, accepted: true };
}
