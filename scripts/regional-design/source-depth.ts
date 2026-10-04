import type { TriangleMesh } from '../../lib/mesh-types.ts';
import type { MeshSurfaceOwnershipNormalization } from '../../lib/mesh-surface-ownership.ts';
export type { MeshSurfaceOwnershipNormalization } from '../../lib/mesh-surface-ownership.ts';

type Axis = 0 | 1 | 2;
type Sign = -1 | 0 | 1;
type Column = readonly [number, number];
export type SourceDepthLimits = {
  faces: number;
  columns: number;
  bboxColumnTests: number;
  rayTriangleTests: number;
  rawCrossings: number;
};
export const SOURCE_DEPTH_LIMITS: Readonly<SourceDepthLimits> = Object.freeze({
  faces: 250000,
  columns: 65536,
  bboxColumnTests: 2000000,
  rayTriangleTests: 2000000,
  rawCrossings: 500000,
});
export type SourceDepthCrossing = {
  depth: number;
  faceIds: number[];
  /** Per-face outward-normal signs along the positive query axis. */
  signs: Sign[];
  selectedFaceIds: number[];
  direction: Sign;
};
export type SourceDepthColumn = {
  column: [number, number];
  crossings: SourceDepthCrossing[];
  intervals: {
    min: number;
    max: number;
    entryFaceIds: number[];
    exitFaceIds: number[];
  }[];
  ambiguous: boolean;
  reasons: string[];
};
type Stats = SourceDepthLimits;
export type SourceDepthResult =
  | { status: 'unavailable'; reason: string }
  | {
      status: 'collected';
      axis: Axis;
      columnAxes: [Axis, Axis];
      columns: SourceDepthColumn[];
      stats: Stats;
    };
export type SourceDepthInput = {
  source: TriangleMesh;
  normalization: MeshSurfaceOwnershipNormalization;
  axis: Axis;
  columns: readonly Column[];
  /** Relevance annotation only: all source faces still participate. */
  selectedSourceFaceIds?: readonly number[];
  limits?: Partial<SourceDepthLimits>;
};
type Hit = { depth: number; faceId: number; sign: Sign; edge: boolean };
const lowerBound = (values: number[], value: number) => {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** Whole-source positive-axis crossings in brick-grid units (Y in plates).
 * Paired crossings are local ray evidence, not a global watertightness proof.
 * The sparse column index bounds work without a faces × columns scan. */
export function collectSourceDepth(input: SourceDepthInput): SourceDepthResult {
  try {
    const { source, normalization: frame, axis } = input;
    const p = source.positions,
      faceCount = p.length / 9;
    const limits = { ...SOURCE_DEPTH_LIMITS, ...input.limits };
    for (const [key, value] of Object.entries(limits))
      if (
        !(key in SOURCE_DEPTH_LIMITS) ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > SOURCE_DEPTH_LIMITS[key as keyof SourceDepthLimits]
      )
        throw Error('Invalid bounded source-depth limits.');
    if (
      ![0, 1, 2].includes(axis) ||
      !Number.isInteger(faceCount) ||
      faceCount < 1 ||
      faceCount > limits.faces ||
      source.colors.length !== faceCount * 3
    )
      throw Error('Invalid or over-budget raw source mesh.');
    if (
      !frame ||
      frame.min.length !== 3 ||
      frame.gridSize.length !== 3 ||
      frame.gridOffset.join(',') !== '1,2,1' ||
      frame.plateHeight !== 0.4 ||
      !Number.isFinite(frame.scale) ||
      frame.scale <= 0 ||
      frame.min.some((v) => !Number.isFinite(v)) ||
      frame.gridSize.some((v) => !Number.isInteger(v) || v < 1)
    )
      throw Error('Invalid source normalization.');
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i++) {
      if (!Number.isFinite(p[i]))
        throw Error('Non-finite raw source geometry.');
      min[i % 3] = Math.min(min[i % 3], p[i]);
      max[i % 3] = Math.max(max[i % 3], p[i]);
    }
    if (
      min.some((v, a) => v !== frame.min[a]) ||
      max.some(
        (v, a) =>
          Math.ceil(
            ((v - min[a]) * frame.scale) / (a === 1 ? frame.plateHeight : 1),
          ) !== frame.gridSize[a],
      )
    )
      throw Error('Raw source geometry does not match the original frame.');
    const snapshot = source.sourceObservations?.sourcePositions;
    if (
      snapshot &&
      (snapshot.length !== p.length || snapshot.some((v, i) => v !== p[i]))
    )
      throw Error('Source differs from its original observation geometry.');
    if (
      !Array.isArray(input.columns) ||
      !input.columns.length ||
      input.columns.length > limits.columns
    )
      throw Error('Invalid or over-budget source-depth columns.');
    const columnAxes = [0, 1, 2].filter((a) => a !== axis) as [Axis, Axis];
    const [uAxis, vAxis] = columnAxes;
    const selected = new Set<number>();
    for (const id of input.selectedSourceFaceIds ?? []) {
      if (
        !Number.isInteger(id) ||
        id < 0 ||
        id >= faceCount ||
        selected.has(id)
      )
        throw Error('Invalid selected source face IDs.');
      selected.add(id);
    }
    const hits: Hit[][] = input.columns.map(() => []),
      tangent = new Set<number>();
    const seen = new Set<string>();
    const rows = new Map<
      number,
      { values: number[]; ids: Map<number, number> }
    >();
    input.columns.forEach((column: Column, id: number) => {
      if (
        column.length !== 2 ||
        column.some(
          (v, i) =>
            !Number.isInteger(v) ||
            v < frame.gridOffset[columnAxes[i]] ||
            v >=
              frame.gridOffset[columnAxes[i]] + frame.gridSize[columnAxes[i]],
        )
      )
        throw Error('Source-depth column lies outside the source grid.');
      const key = column.join(',');
      if (seen.has(key)) throw Error('Duplicate source-depth column.');
      seen.add(key);
      let row = rows.get(column[0]);
      if (!row) rows.set(column[0], (row = { values: [], ids: new Map() }));
      row.values.push(column[1]);
      row.ids.set(column[1], id);
    });
    const us = [...rows.keys()].sort((a, b) => a - b);
    for (const row of rows.values()) row.values.sort((a, b) => a - b);
    const stats: Stats = {
      faces: faceCount,
      columns: input.columns.length,
      bboxColumnTests: 0,
      rayTriangleTests: 0,
      rawCrossings: 0,
    };
    const charge = (
      kind: 'bboxColumnTests' | 'rayTriangleTests' | 'rawCrossings',
    ) => {
      if (++stats[kind] > limits[kind])
        throw Error(`Source-depth ${kind} workload limit exceeded.`);
    };
    const depthTolerance = Math.max(1e-8, frame.gridSize[axis] * 1e-9);
    const coincidentTolerance = Math.max(
      1e-12,
      frame.gridSize[axis] * Number.EPSILON * 64,
    );
    for (let faceId = 0; faceId < faceCount; faceId++) {
      const verts = [0, 1, 2].map((j) =>
        [0, 1, 2].map(
          (a) =>
            ((p[faceId * 9 + j * 3 + a] - frame.min[a]) * frame.scale) /
              (a === 1 ? frame.plateHeight : 1) +
            frame.gridOffset[a],
        ),
      );
      const [a, b, c] = verts;
      const e = b.map((v, i) => v - a[i]),
        f = c.map((v, i) => v - a[i]);
      const normal = [
        e[1] * f[2] - e[2] * f[1],
        e[2] * f[0] - e[0] * f[2],
        e[0] * f[1] - e[1] * f[0],
      ];
      if (Math.hypot(...normal) === 0)
        throw Error('Degenerate raw source triangle.');
      const den =
        (b[vAxis] - c[vAxis]) * (a[uAxis] - c[uAxis]) +
        (c[uAxis] - b[uAxis]) * (a[vAxis] - c[vAxis]);
      const u0 = Math.min(...verts.map((v) => v[uAxis])) - 0.500013 - 1e-9;
      const u1 = Math.max(...verts.map((v) => v[uAxis])) - 0.500013 + 1e-9;
      const v0 = Math.min(...verts.map((v) => v[vAxis])) - 0.500027 - 1e-9;
      const v1 = Math.max(...verts.map((v) => v[vAxis])) - 0.500027 + 1e-9;
      for (let at = lowerBound(us, u0); at < us.length && us[at] <= u1; at++) {
        charge('bboxColumnTests');
        const row = rows.get(us[at])!;
        for (
          let vt = lowerBound(row.values, v0);
          vt < row.values.length && row.values[vt] <= v1;
          vt++
        ) {
          charge('bboxColumnTests');
          charge('rayTriangleTests');
          const id = row.ids.get(row.values[vt])!,
            u = us[at] + 0.500013,
            v = row.values[vt] + 0.500027;
          if (Math.abs(den) <= Math.hypot(...normal) * 1e-12) {
            // A ray on a projected line may lie within a source side face.
            for (let j = 0; j < 3; j++) {
              const start = verts[j],
                end = verts[(j + 1) % 3];
              const du = end[uAxis] - start[uAxis],
                dv = end[vAxis] - start[vAxis],
                length2 = du * du + dv * dv;
              const t = length2
                ? Math.max(
                    0,
                    Math.min(
                      1,
                      ((u - start[uAxis]) * du + (v - start[vAxis]) * dv) /
                        length2,
                    ),
                  )
                : 0;
              if (
                Math.hypot(
                  u - start[uAxis] - t * du,
                  v - start[vAxis] - t * dv,
                ) <= 1e-8
              )
                tangent.add(id);
            }
            continue;
          }
          const ba =
            ((b[vAxis] - c[vAxis]) * (u - c[uAxis]) +
              (c[uAxis] - b[uAxis]) * (v - c[vAxis])) /
            den;
          const bb =
            ((c[vAxis] - a[vAxis]) * (u - c[uAxis]) +
              (a[uAxis] - c[uAxis]) * (v - c[vAxis])) /
            den;
          const bc = 1 - ba - bb;
          if (Math.min(ba, bb, bc) < -1e-9) continue;
          // Local affine form retains exact constant-axis planes and avoids
          // unnecessary cancellation from distant absolute coordinates.
          const depth =
            a[axis] + bb * (b[axis] - a[axis]) + bc * (c[axis] - a[axis]);
          if (!Number.isFinite(depth))
            throw Error('Non-finite source-depth crossing.');
          charge('rawCrossings');
          hits[id].push({
            depth,
            faceId,
            sign: normal[axis] < 0 ? -1 : 1,
            edge: Math.min(ba, bb, bc) <= 1e-9,
          });
        }
      }
    }
    const columns: SourceDepthColumn[] = hits.map((raw, id) => {
      raw.sort((a, b) => a.depth - b.depth || a.faceId - b.faceId);
      const crossings: SourceDepthCrossing[] = [],
        reasons: string[] = [];
      for (let at = 0; at < raw.length;) {
        const group = [raw[at++]];
        while (
          at < raw.length &&
          raw[at].depth - group[0].depth <= coincidentTolerance
        )
          group.push(raw[at++]);
        const sameSign = group.every((h) => h.sign === group[0].sign);
        const faceIds = group.map((h) => h.faceId),
          signs = group.map((h) => h.sign);
        crossings.push({
          depth: group[0].depth,
          faceIds,
          signs,
          selectedFaceIds: faceIds.filter((f) => selected.has(f)),
          direction: sameSign ? group[0].sign : 0,
        });
        if (!sameSign) reasons.push('Opposing source normals at equal depth.');
        if (group.length === 1 && group[0].edge)
          reasons.push('Unresolved source edge crossing.');
      }
      // Close surfaces are not proven duplicates: preserve both depths and
      // all contributors, but leave their tiny interval unresolved.
      if (
        crossings.some(
          (c, i) => i > 0 && c.depth - crossings[i - 1].depth <= depthTolerance,
        )
      )
        reasons.push('Distinct source crossings within depth tolerance.');
      if (tangent.has(id))
        reasons.push('Source face tangent to the query ray.');
      if (crossings.length % 2) reasons.push('Odd source crossing count.');
      if (
        crossings.some((crossing, i) => crossing.direction !== (i % 2 ? 1 : -1))
      )
        reasons.push(
          'Source crossings do not alternate outward entry and exit.',
        );
      const ambiguous = reasons.length > 0;
      const intervals: SourceDepthColumn['intervals'] = [];
      if (!ambiguous)
        for (let i = 0; i < crossings.length; i += 2)
          intervals.push({
            min: crossings[i].depth,
            max: crossings[i + 1].depth,
            entryFaceIds: [...crossings[i].faceIds],
            exitFaceIds: [...crossings[i + 1].faceIds],
          });
      return {
        column: [...input.columns[id]],
        crossings,
        intervals,
        ambiguous,
        reasons: [...new Set(reasons)],
      };
    });
    return { status: 'collected', axis, columnAxes, columns, stats };
  } catch (error) {
    return {
      status: 'unavailable',
      reason:
        error instanceof Error ? error.message : 'Invalid source-depth input.',
    };
  }
}
