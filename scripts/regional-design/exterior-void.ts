import type { Model } from '../../lib/brick-engine.ts';
import type { V3 } from '../../lib/assembly-catalog.ts';

type Axis = 0 | 1 | 2;
type Polygon = V3[];
export type ExteriorVoidInput = {
  /** Complete ORIGINAL source in physical studs; never a fitted/colored mesh. */
  source: {
    positions: ArrayLike<number>;
    faceIds: readonly number[];
    complete: boolean;
  };
  model: Pick<Model, 'width' | 'height' | 'depth' | 'bricks'>;
  axis: Axis;
  direction: -1 | 1;
};
export type ExteriorVoidResult =
  | { status: 'unavailable'; reasons: string[] }
  | {
      status: 'candidate' | 'noop';
      scope: 'source-defined-exterior-only';
      /** Exact projected-cell coverage; overlapping target triangles fail. */
      columns: {
        column: [number, number];
        sourceMaxSignedDepth: number;
        sourceFaceIds: number[];
      }[];
      emptyBodyCells: string[];
      rejectedColumns: { column: [number, number]; reason: string }[];
      reasons: string[];
      sourceTruthVerified: false;
      assemblyVerified: false;
    };
const EPS = 1e-8;
const sub = (a: V3, b: V3): V3 => a.map((v, i) => v - b[i]) as V3;
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

function clip(polygon: Polygon, distance: (p: V3) => number): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const da = distance(a),
      db = distance(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      const t = da / (da - db);
      out.push(a.map((v, k) => v + (b[k] - v) * t) as V3);
    }
  }
  return out;
}
function area(p: Polygon, u: Axis, v: Axis) {
  return (
    Math.abs(
      p.reduce((n, a, i) => {
        const b = p[(i + 1) % p.length];
        return n + a[u] * b[v] - b[u] * a[v];
      }, 0),
    ) / 2
  );
}
function overlap(a: Polygon, b: Polygon, u: Axis, v: Axis) {
  let p = a;
  const signed = b.reduce((n, a, i) => {
    const next = b[(i + 1) % b.length];
    return n + a[u] * next[v] - next[u] * a[v];
  }, 0);
  const sign = signed >= 0 ? 1 : -1;
  for (let i = 0; i < b.length && p.length; i++) {
    const a = b[i],
      next = b[(i + 1) % b.length];
    p = clip(
      p,
      (q) =>
        sign *
        ((next[u] - a[u]) * (q[v] - a[v]) - (next[v] - a[v]) * (q[u] - a[u])),
    );
  }
  return area(p, u, v);
}

/** Negative construction target, not silhouette filling. A body cell may be
 * proposed empty only if its ENTIRE lateral footprint is covered once by the
 * selected near-axis source, and lies strictly outside the maximum depth of
 * EVERY source fragment over that footprint. Holes, thin foreground objects,
 * partial coverage, target overlaps and folds cannot authorize a deletion.
 * Source geometry itself can be wrong: this does not prove photo truth. */
export function proposeExteriorVoid(
  input: ExteriorVoidInput,
): ExteriorVoidResult {
  try {
    const { source, model, axis, direction } = input;
    const p = source.positions;
    if (
      !source.complete ||
      ![0, 1, 2].includes(axis) ||
      ![-1, 1].includes(direction) ||
      !p.length ||
      p.length % 9 ||
      p.length / 9 > 250000 ||
      Array.from(p).some((v) => !Number.isFinite(v)) ||
      ![model.width, model.height, model.depth].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      )
    )
      throw Error('invalid or incomplete bounded source/model');
    const ids = new Set(source.faceIds);
    if (
      !ids.size ||
      ids.size > 4096 ||
      ids.size !== source.faceIds.length ||
      [...ids].some(
        (f) => !Number.isSafeInteger(f) || f < 0 || f >= p.length / 9,
      )
    )
      throw Error('invalid source face selection');
    const [u, v] = [0, 1, 2].filter((a) => a !== axis) as [Axis, Axis];
    const size = [model.width, model.height, model.depth];
    const step = [1, 0.4, 1];
    const face = (id: number): Polygon =>
      [0, 1, 2].map((j) => [
        p[id * 9 + j * 3],
        p[id * 9 + j * 3 + 1],
        p[id * 9 + j * 3 + 2],
      ]);
    const columns = new Map<
      string,
      {
        column: [number, number];
        fragments: { id: number; polygon: Polygon }[];
        max: number;
        otherMax: number;
      }
    >();
    let clips = 0,
      pairs = 0;
    const clipped = (tri: Polygon, x: number, y: number) => {
      if (++clips > 2000000)
        throw Error('exterior projection work budget exceeded');
      let out = tri;
      for (const [a, low] of [
        [u, x],
        [v, y],
      ] as [Axis, number][]) {
        out = clip(out, (p) => p[a] - low * step[a]);
        out = clip(out, (p) => (low + 1) * step[a] - p[a]);
      }
      return out;
    };
    for (const id of ids) {
      const tri = face(id),
        n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
      if (
        (direction * n[axis]) / Math.hypot(...n) < 0.98 ||
        !Number.isFinite(Math.hypot(...n)) ||
        Math.hypot(...n) < EPS
      )
        throw Error(
          'steep, folded or wrong-facing target requires another construction',
        );
      const lo = [u, v].map((a) =>
        Math.max(0, Math.floor(Math.min(...tri.map((q) => q[a])) / step[a])),
      );
      const hi = [u, v].map((a) =>
        Math.min(
          size[a] - 1,
          Math.floor(Math.max(...tri.map((q) => q[a])) / step[a]),
        ),
      );
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++) {
          const fragment = clipped(tri, x, y);
          if (area(fragment, u, v) <= EPS) continue;
          const k = `${x},${y}`;
          let c = columns.get(k);
          if (!c) {
            if (columns.size >= 4096)
              throw Error('exterior column work budget exceeded');
            c = {
              column: [x, y],
              fragments: [],
              max: -Infinity,
              otherMax: -Infinity,
            };
            columns.set(k, c);
          }
          c.fragments.push({ id, polygon: fragment });
          c.max = Math.max(c.max, ...fragment.map((q) => direction * q[axis]));
        }
    }
    // Full source participates, including small unselected foreground objects.
    for (let id = 0; id < p.length / 9; id++) {
      if (ids.has(id)) continue;
      const tri = face(id);
      const lo = [u, v].map((a) =>
        Math.max(0, Math.floor(Math.min(...tri.map((q) => q[a])) / step[a])),
      );
      const hi = [u, v].map((a) =>
        Math.min(
          size[a] - 1,
          Math.floor(Math.max(...tri.map((q) => q[a])) / step[a]),
        ),
      );
      for (let x = lo[0]; x <= hi[0]; x++)
        for (let y = lo[1]; y <= hi[1]; y++) {
          const c = columns.get(`${x},${y}`);
          if (!c) continue;
          const fragment = clipped(tri, x, y);
          if (area(fragment, u, v) <= EPS) continue;
          c.otherMax = Math.max(
            c.otherMax,
            ...fragment.map((q) => direction * q[axis]),
          );
        }
    }
    const accepted: Extract<
      ExteriorVoidResult,
      { columns: unknown }
    >['columns'] = [];
    const rejected: Extract<
      ExteriorVoidResult,
      { rejectedColumns: unknown }
    >['rejectedColumns'] = [];
    for (const c of columns.values()) {
      let overlaps = false;
      for (let i = 0; i < c.fragments.length; i++)
        for (let j = i + 1; j < c.fragments.length; j++) {
          if (++pairs > 2000000)
            throw Error('exterior overlap work budget exceeded');
          if (
            overlap(c.fragments[i].polygon, c.fragments[j].polygon, u, v) > EPS
          )
            overlaps = true;
        }
      const sum = c.fragments.reduce((n, f) => n + area(f.polygon, u, v), 0);
      const reason = overlaps
        ? 'overlapping target projections'
        : Math.abs(sum - step[u] * step[v]) > EPS
          ? 'partial target footprint or hole'
          : c.otherMax > c.max + EPS
            ? 'another original surface occupies the foreground'
            : undefined;
      if (reason) rejected.push({ column: c.column, reason });
      else
        accepted.push({
          column: c.column,
          sourceMaxSignedDepth: c.max,
          sourceFaceIds: [...new Set(c.fragments.map((f) => f.id))].sort(
            (a, b) => a - b,
          ),
        });
    }
    const empty = new Set<string>();
    const byColumn = new Map(accepted.map((c) => [c.column.join(','), c]));
    let bodies = 0;
    for (const b of model.bricks) {
      if (
        ![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isFinite) ||
        b.w <= 0 ||
        b.h <= 0 ||
        b.d <= 0
      )
        throw Error('invalid part envelope');
      for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
        for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
          for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++) {
            if (++bodies > 2000000)
              throw Error('exterior body work budget exceeded');
            const q = [x, y, z];
            const c = byColumn.get(`${q[u]},${q[v]}`);
            if (!c || q.some((v, a) => v < 0 || v >= size[a])) continue;
            const near =
              direction > 0
                ? q[axis] * step[axis]
                : -(q[axis] + 1) * step[axis];
            if (near > c.sourceMaxSignedDepth + EPS) empty.add(q.join(','));
          }
    }
    return {
      status: empty.size ? 'candidate' : 'noop',
      scope: 'source-defined-exterior-only',
      columns: accepted,
      emptyBodyCells: [...empty].sort(),
      rejectedColumns: rejected,
      reasons: [],
      sourceTruthVerified: false,
      assemblyVerified: false,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}
