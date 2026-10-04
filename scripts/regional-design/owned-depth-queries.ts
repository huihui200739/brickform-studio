import {
  classifySurfaceOwnership,
  type MeshSurfaceOwnership,
} from '../../lib/mesh-surface-ownership.ts';
import { triangleStudArea } from '../../lib/voxel-materials.ts';

type Point = [number, number, number];
export type OwnedDepthQuery = {
  cellKey: string;
  sourceFaceId: number;
  column: [number, number];
  samplePoint: [number, number];
  surfaceDepth: number;
  areaStudsSquared: number;
};
const LIMITS = Object.freeze({
  cells: 8192,
  queries: 8192,
  contributorsPerCell: 128,
  contributorTests: 32768,
  clipEdgeTests: 500000,
});
type Limits = typeof LIMITS;
export type OwnedDepthQueryResult = {
  status: 'collected' | 'unavailable';
  queries: OwnedDepthQuery[];
  unresolvedCells: { cellKey: string; reasons: string[] }[];
  reason?: string;
  stats: { cells: number; contributorTests: number; clipEdgeTests: number };
  scope: 'sampled-owned-source-face-queries';
};

/** Sample a positive-area fragment of the ORIGINAL face inside each owned cell.
 * No design displacement, interpolated thickness or cell-center assumption.
 * Duplicate points keep their face/cell associations; the ray caller deduplicates
 * queries without losing these associations. This is not whole-cell solid proof. */
export function buildOwnedDepthQueries(input: {
  ownership: MeshSurfaceOwnership;
  regionId: string;
  editableCellKeys: readonly string[];
  axis: 0 | 1 | 2;
  limits?: Partial<Record<keyof Limits, number>>;
}): OwnedDepthQueryResult {
  const stats = { cells: 0, contributorTests: 0, clipEdgeTests: 0 };
  const scope = 'sampled-owned-source-face-queries' as const;
  try {
    const { ownership: ledger, axis } = input;
    const limits = { ...LIMITS, ...input.limits };
    for (const [name, value] of Object.entries(limits))
      if (
        !(name in LIMITS) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > LIMITS[name as keyof Limits]
      )
        throw Error('Invalid bounded owned-depth query limits.');
    const region = ledger.regions.find((r) => r.regionId === input.regionId);
    if (!region || ![0, 1, 2].includes(axis))
      throw Error('Unknown source region or depth axis.');
    const keys = input.editableCellKeys;
    if (
      !Array.isArray(keys) ||
      keys.length > limits.cells ||
      new Set(keys).size !== keys.length
    )
      throw Error('Invalid or over-budget owned cell selection.');
    const frame = ledger.normalization,
      source = ledger.sourceMesh.positions;
    if (
      !source.length ||
      source.length % 9 ||
      source.length / 9 > 250000 ||
      frame.plateHeight !== 0.4 ||
      frame.gridOffset.join(',') !== '1,2,1' ||
      !Number.isFinite(frame.scale) ||
      frame.scale <= 0 ||
      frame.min.some((v) => !Number.isFinite(v))
    )
      throw Error('Invalid original source frame.');
    const selected = new Set(region.sourceFaceIds);
    const axes = [0, 1, 2].filter((a) => a !== axis);
    const queries: OwnedDepthQuery[] = [],
      unresolvedCells: OwnedDepthQueryResult['unresolvedCells'] = [];
    const charge = () => {
      if (++stats.clipEdgeTests > limits.clipEdgeTests)
        throw Error('Owned-depth clipping workload exceeded.');
    };
    for (const cellKey of keys) {
      stats.cells++;
      const cell = cellKey.split(',').map(Number) as Point;
      if (
        cell.length !== 3 ||
        cell.some(
          (v, a) =>
            !Number.isSafeInteger(v) ||
            v < frame.gridOffset[a] ||
            v >= frame.gridOffset[a] + frame.gridSize[a],
        ) ||
        cell.join(',') !== cellKey
      )
        throw Error('Owned cell is outside the source grid.');
      const reasons = new Set<string>();
      const record = ledger.cells.get(cellKey);
      if (
        classifySurfaceOwnership(ledger, cellKey, input.regionId) !==
          'editable' ||
        !record
      ) {
        unresolvedCells.push({
          cellKey,
          reasons: ['cell-does-not-have-sole-selected-area-ownership'],
        });
        continue;
      }
      if (record.contributors.length > limits.contributorsPerCell)
        throw Error('Owned-depth contributors per cell exceeded.');
      const faceIds = [
        ...new Set(
          record.contributors
            .filter(
              (c) => selected.has(c.sourceFaceId) && c.areaStudsSquared > 0,
            )
            .map((c) => c.sourceFaceId),
        ),
      ];
      if (!faceIds.length) reasons.add('no-positive-selected-area-contributor');
      for (const sourceFaceId of faceIds) {
        if (++stats.contributorTests > limits.contributorTests)
          throw Error('Owned-depth contributor workload exceeded.');
        if (
          !Number.isSafeInteger(sourceFaceId) ||
          sourceFaceId < 0 ||
          sourceFaceId >= source.length / 9
        )
          throw Error('Invalid captured source face identity.');
        let polygon = [0, 1, 2].map(
          (j) =>
            [0, 1, 2].map(
              (a) =>
                ((source[sourceFaceId * 9 + j * 3 + a] - frame.min[a]) *
                  frame.scale) /
                  (a === 1 ? frame.plateHeight : 1) +
                frame.gridOffset[a],
            ) as Point,
        );
        if (polygon.some((p) => p.some((v) => !Number.isFinite(v))))
          throw Error('Non-finite original source face.');
        for (let a = 0; a < 3; a++)
          for (const side of [0, 1]) {
            if (polygon.length < 3) break;
            const boundary = cell[a] + side,
              output: Point[] = [];
            const inside = (p: Point) =>
              side ? p[a] <= boundary : p[a] >= boundary;
            for (let j = 0; j < polygon.length; j++) {
              charge();
              const p = polygon[j],
                q = polygon[(j + 1) % polygon.length];
              const pi = inside(p),
                qi = inside(q);
              if (pi) output.push(p);
              if (pi !== qi) {
                const t = (boundary - p[a]) / (q[a] - p[a]);
                output.push(p.map((v, k) => v + (q[k] - v) * t) as Point);
              }
            }
            polygon = output;
          }
        let area = 0,
          projectedArea = 0;
        const sum: Point = [0, 0, 0];
        for (let j = 1; j + 1 < polygon.length; j++) {
          const [p, q, r] = [polygon[0], polygon[j], polygon[j + 1]];
          const weight = triangleStudArea(p, q, r);
          area += weight;
          projectedArea +=
            Math.abs(
              (q[axes[0]] - p[axes[0]]) * (r[axes[1]] - p[axes[1]]) -
                (q[axes[1]] - p[axes[1]]) * (r[axes[0]] - p[axes[0]]),
            ) / 2;
          for (let a = 0; a < 3; a++)
            sum[a] += (weight * (p[a] + q[a] + r[a])) / 3;
        }
        if (area <= 1e-12) {
          reasons.add(
            'original-source-face-has-no-positive-area-in-designed-cell',
          );
          continue;
        }
        if (projectedArea <= 1e-12) {
          reasons.add('original-source-face-tangent-to-depth-axis');
          continue;
        }
        const centroid = sum.map((v) => v / area) as Point;
        const column = axes.map((a) => cell[a]) as [number, number];
        const samplePoint = axes.map((a) => centroid[a]) as [number, number];
        if (samplePoint.some((v, a) => v <= column[a] || v >= column[a] + 1)) {
          reasons.add('source-fragment-centroid-not-strictly-inside-column');
          continue;
        }
        if (queries.length >= limits.queries)
          throw Error('Owned-depth query count exceeded.');
        queries.push({
          cellKey,
          sourceFaceId,
          column,
          samplePoint,
          surfaceDepth: centroid[axis],
          areaStudsSquared: area,
        });
      }
      if (reasons.size)
        unresolvedCells.push({ cellKey, reasons: [...reasons] });
    }
    return { status: 'collected', queries, unresolvedCells, stats, scope };
  } catch (error) {
    return {
      status: 'unavailable',
      queries: [],
      unresolvedCells: [],
      reason: error instanceof Error ? error.message : String(error),
      stats,
      scope,
    };
  }
}
