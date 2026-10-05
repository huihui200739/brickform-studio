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
  /** Default requires a single near-axis layer. The explicit compound mode
   * proves the union of clipped projected fragments, retains every depth layer,
   * and uses their outermost depth conservatively; it never fills a profile. */
  coverageMode?: 'near-axis-single-layer' | 'piecewise-exterior-envelope';
};
export type ExteriorVoidResult =
  | { status: 'unavailable'; reasons: string[] }
  | {
      status: 'candidate' | 'noop';
      scope: 'source-defined-exterior-only';
      coverageMode: 'near-axis-single-layer' | 'piecewise-exterior-envelope';
      /** Strict projected-cell coverage; default mode also rejects overlaps. */
      columns: {
        column: [number, number];
        sourceMaxSignedDepth: number;
        sourceFaceIds: number[];
        depthFragments?: {
          sourceFaceId: number;
          minSignedDepth: number;
          maxSignedDepth: number;
          projectedArea: number;
        }[];
      }[];
      emptyBodyCells: string[];
      rejectedColumns: { column: [number, number]; reason: string }[];
      reasons: string[];
      sourceTruthVerified: false;
      assemblyVerified: false;
    };
const EPS = 1e-8;
// A physical plate is exactly 2/5 stud. Multiplying by the rounded 0.4
// creates phantom bands at ordinary boundaries such as the third plate.
const cellBoundary = (axis: Axis, cell: number) =>
  axis === 1 ? (cell * 2) / 5 : cell;
const sub = (a: V3, b: V3): V3 => a.map((v, i) => v - b[i]) as V3;
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const floatBits = new DataView(new ArrayBuffer(8));
function dyadic(value: number) {
  floatBits.setFloat64(0, value, false);
  const hi = floatBits.getUint32(0, false),
    lo = floatBits.getUint32(4, false);
  const exponent = (hi >>> 20) & 2047;
  let numerator = (BigInt(hi & 0xfffff) << BigInt(32)) | BigInt(lo);
  if (exponent) numerator |= BigInt(1) << BigInt(52);
  if (hi >>> 31) numerator = -numerator;
  return { numerator, exponent: exponent ? exponent - 1075 : -1074 };
}
/** A cancelled determinant may mean an exact line or unresolved arithmetic.
 * Exact binary products distinguish those cases without welding coordinates. */
function projectedDeterminant(ax: number, ay: number, bx: number, by: number) {
  const first = ax * by,
    second = ay * bx;
  const value = first - second;
  if (!Number.isFinite(value)) throw Error('unresolved projected determinant');
  if (
    value === 0 ||
    Math.abs(value) <= Number.EPSILON * 8 * (Math.abs(first) + Math.abs(second))
  ) {
    if ((ax === 0 && bx === 0) || (ay === 0 && by === 0)) return 0;
    const a = dyadic(ax),
      b = dyadic(by),
      c = dyadic(ay),
      d = dyadic(bx);
    const e1 = a.exponent + b.exponent,
      e2 = c.exponent + d.exponent;
    const base = Math.min(e1, e2);
    const exact =
      ((a.numerator * b.numerator) << BigInt(e1 - base)) -
      ((c.numerator * d.numerator) << BigInt(e2 - base));
    if (exact === BigInt(0)) return 0;
    throw Error('unresolved near-degenerate projected determinant');
  }
  if (Math.abs(value) < Number.MIN_VALUE / Number.EPSILON)
    throw Error('unresolved underflowed projected determinant');
  return value;
}

function clip(
  polygon: Polygon,
  distance: (p: V3) => number,
  boundary?: { axis: Axis; value: number },
): Polygon {
  const out: Polygon = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i],
      b = polygon[(i + 1) % polygon.length];
    const da = distance(a),
      db = distance(b);
    if (da >= 0) out.push(a);
    if (da >= 0 !== db >= 0) {
      // Canonical endpoint order gives shared edges the same arithmetic in
      // either winding. Only computed axis-plane intersections are snapped;
      // original source coordinates are never welded or adjusted.
      const ordered = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
      const start = ordered <= 0 ? a : b;
      const end = ordered <= 0 ? b : a;
      const ds = ordered <= 0 ? da : db;
      const de = ordered <= 0 ? db : da;
      const t = ds / (ds - de);
      const point = start.map((v, k) => v + (end[k] - v) * t) as V3;
      if (boundary) point[boundary.axis] = boundary.value;
      if (point.some((v) => !Number.isFinite(v)))
        throw Error('unresolved clipping arithmetic');
      out.push(point);
    }
  }
  return out;
}
function signedArea(p: Polygon, u: Axis, v: Axis) {
  if (p.length < 3) return 0;
  const origin = p[0];
  let twice = 0;
  for (let i = 1; i + 1 < p.length; i++) {
    const a = p[i],
      b = p[i + 1];
    const ax = a[u] - origin[u],
      ay = a[v] - origin[v];
    const bx = b[u] - origin[u],
      by = b[v] - origin[v];
    const determinant = projectedDeterminant(ax, ay, bx, by);
    twice += determinant;
  }
  if (!Number.isFinite(twice)) throw Error('unresolved projected area');
  return twice / 2;
}
function area(p: Polygon, u: Axis, v: Axis) {
  return Math.abs(signedArea(p, u, v));
}
function overlap(a: Polygon, b: Polygon, u: Axis, v: Axis) {
  let p = a;
  const signed = signedArea(b, u, v);
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

/** Vertical arrangement of convex clipped triangle projections. Coverage is
 * proved separately in every event band; a small missing area never counts as
 * complete. Under exact arithmetic, interval order is fixed inside each band,
 * so a strictly complete interior slice proves that whole band. */
function unionCoverage(
  polygons: Polygon[],
  u: Axis,
  v: Axis,
  bounds: { min: [number, number]; max: [number, number] },
  charge: () => void,
) {
  type P = [number, number];
  type SliceEnd = { value: number; line: [P, P] };
  const sameLine = (a: [P, P], b: [P, P]) =>
    b.every(
      (q) =>
        projectedDeterminant(
          a[1][0] - a[0][0],
          a[1][1] - a[0][1],
          q[0] - a[0][0],
          q[1] - a[0][1],
        ) === 0,
    );
  const onBoundary = (end: SliceEnd, value: number) =>
    end.line.every((p) => p[1] === value);
  const ps = polygons.map((p) => p.map((q) => [q[u], q[v]] as P));
  const comparePoint = (a: P, b: P) => a[0] - b[0] || a[1] - b[1];
  const uniqueEdges = new Map<string, [P, P]>();
  for (const p of ps)
    for (let i = 0; i < p.length; i++) {
      const first = p[i],
        second = p[(i + 1) % p.length];
      if (comparePoint(first, second) === 0) continue;
      const edge: [P, P] =
        comparePoint(first, second) < 0 ? [first, second] : [second, first];
      uniqueEdges.set(`${edge[0].join(',')}|${edge[1].join(',')}`, edge);
    }
  // The same exact projected source edge can occur in several fragments and
  // windings. Canonical edge AND pair order computes its crossing once, rather
  // than creating different floating events from a+t*(b-a) and b+(1-t)*(a-b).
  // This deduplicates arrangement work only; source/depth contributors remain.
  const edges = [...uniqueEdges.values()].sort(
    (a, b) => comparePoint(a[0], b[0]) || comparePoint(a[1], b[1]),
  );
  const events = new Set([
    bounds.min[0],
    bounds.max[0],
    ...ps.flatMap((p) => p.map((q) => q[0])),
  ]);
  if (
    ps.some((p) =>
      p.some(
        (q) =>
          !q.every(Number.isFinite) ||
          q[0] < bounds.min[0] ||
          q[0] > bounds.max[0] ||
          q[1] < bounds.min[1] ||
          q[1] > bounds.max[1],
      ),
    )
  )
    throw Error('unresolved projected coverage bounds');
  // A projected-axis gap is already a strict proof of incomplete coverage,
  // including bands too narrow to have a representable double midpoint.
  const ranges = ps
    .map((p) => [
      Math.min(...p.map((q) => q[0])),
      Math.max(...p.map((q) => q[0])),
    ])
    .sort((a, b) => a[0] - b[0]);
  let reach = bounds.min[0];
  for (const [low, high] of ranges) {
    if (low > reach) return { area: 0, complete: false };
    reach = Math.max(reach, high);
  }
  if (reach !== bounds.max[0]) return { area: 0, complete: false };
  for (let i = 0; i < edges.length; i++)
    for (let j = i + 1; j < edges.length; j++) {
      charge();
      const [a, b] = edges[i],
        [c, d] = edges[j];
      // Shared endpoints are existing vertex events. Re-solving the same
      // intersection can manufacture a neighboring floating event or a
      // near-zero determinant; two straight segments have no other proper
      // crossing when they share an endpoint.
      if (
        [a, b].some((p) => [c, d].some((q) => p[0] === q[0] && p[1] === q[1]))
      )
        continue;
      if (
        Math.max(a[0], b[0]) <= Math.min(c[0], d[0]) ||
        Math.max(c[0], d[0]) <= Math.min(a[0], b[0]) ||
        Math.max(a[1], b[1]) <= Math.min(c[1], d[1]) ||
        Math.max(c[1], d[1]) <= Math.min(a[1], b[1])
      )
        continue;
      const ab: P = [b[0] - a[0], b[1] - a[1]];
      const cd: P = [d[0] - c[0], d[1] - c[1]];
      const determinant = projectedDeterminant(ab[0], ab[1], cd[0], cd[1]);
      if (determinant === 0) continue;
      const ca: P = [c[0] - a[0], c[1] - a[1]];
      const t = (ca[0] * cd[1] - ca[1] * cd[0]) / determinant;
      const s = (ca[0] * ab[1] - ca[1] * ab[0]) / determinant;
      if (!Number.isFinite(t) || !Number.isFinite(s))
        throw Error('unresolved projected crossing');
      if (t > 0 && t < 1 && s > 0 && s < 1) {
        const x = a[0] + t * ab[0];
        if (x < bounds.min[0] || x > bounds.max[0])
          throw Error('unresolved projected crossing bounds');
        events.add(x);
      }
    }
  const sorted = [...events].sort((a, b) => a - b);
  let area = 0;
  let complete = sorted[0] === bounds.min[0] && sorted.at(-1) === bounds.max[0];
  for (let at = 1; at < sorted.length; at++) {
    const left = sorted[at - 1],
      right = sorted[at];
    if (right <= left) continue;
    const x = left + (right - left) / 2;
    if (!(x > left && x < right))
      throw Error('unresolved projected event band');
    const intervals: [SliceEnd, SliceEnd][] = [];
    for (const p of ps) {
      const ys: SliceEnd[] = [];
      for (let i = 0; i < p.length; i++) {
        charge();
        const first = p[i],
          second = p[(i + 1) % p.length];
        const [a, b] =
          first[0] <= second[0] ? [first, second] : [second, first];
        if (x > Math.min(a[0], b[0]) && x < Math.max(a[0], b[0]))
          ys.push({
            value: a[1] + ((x - a[0]) * (b[1] - a[1])) / (b[0] - a[0]),
            line: [a, b],
          });
      }
      if (
        ys.some(
          ({ value }) =>
            !Number.isFinite(value) ||
            value < bounds.min[1] ||
            value > bounds.max[1],
        )
      )
        throw Error('unresolved projected slice arithmetic');
      ys.sort((a, b) => a.value - b.value);
      if (ys.length >= 2) intervals.push([ys[0], ys[ys.length - 1]]);
    }
    intervals.sort(
      (a, b) => a[0].value - b[0].value || a[1].value - b[1].value,
    );
    let low = Infinity,
      high = -Infinity,
      length = 0;
    let gaps = false;
    let lowEnd: SliceEnd | undefined, highEnd: SliceEnd | undefined;
    for (const [a, b] of intervals) {
      if (a.value > high) {
        if (high >= low) {
          length += high - low;
          gaps = true;
        }
        low = a.value;
        high = b.value;
        lowEnd = a;
        highEnd = b;
      } else {
        // Rounding must not close a real gap between distinct boundary lines.
        // Identical shared lines prove contact; other nearly equal slices are
        // unresolved, rather than being joined by a coordinate tolerance.
        if (
          highEnd &&
          high - a.value <=
            Number.EPSILON *
              16 *
              Math.max(
                Math.abs(high),
                Math.abs(a.value),
                bounds.max[1] - bounds.min[1],
              ) &&
          !sameLine(a.line, highEnd.line)
        )
          throw Error('unresolved near-contact projected slices');
        if (
          b.value > high ||
          (b.value === high && onBoundary(b, bounds.max[1]))
        ) {
          high = b.value;
          highEnd = b;
        }
      }
    }
    if (high >= low) length += high - low;
    if (
      gaps ||
      low !== bounds.min[1] ||
      high !== bounds.max[1] ||
      !lowEnd ||
      !highEnd ||
      !onBoundary(lowEnd, bounds.min[1]) ||
      !onBoundary(highEnd, bounds.max[1])
    )
      complete = false;
    area += (right - left) * length;
  }
  if (!Number.isFinite(area)) throw Error('unresolved projected union area');
  return { area, complete };
}

/** Negative construction target, not silhouette filling. A body cell may be
 * proposed empty only if its ENTIRE lateral footprint is covered by the
 * selected source, and lies strictly outside the maximum depth of
 * EVERY source fragment over that footprint. Holes, thin foreground objects,
 * partial coverage, target overlaps and folds cannot authorize a deletion.
 * Source geometry itself can be wrong: this does not prove photo truth. */
export function proposeExteriorVoid(
  input: ExteriorVoidInput,
): ExteriorVoidResult {
  try {
    const { source, model, axis, direction } = input;
    const coverageMode = input.coverageMode ?? 'near-axis-single-layer';
    const compound = coverageMode === 'piecewise-exterior-envelope';
    if (
      !['near-axis-single-layer', 'piecewise-exterior-envelope'].includes(
        coverageMode,
      )
    )
      throw Error('invalid projected coverage mode');
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
    let projectionQueries = 0,
      pairs = 0;
    const chargeProjection = () => {
      if (++projectionQueries > 2000000)
        throw Error('exterior projection work budget exceeded');
    };
    const clipped = (tri: Polygon, x: number, y: number) => {
      let out = tri;
      for (const [a, low] of [
        [u, x],
        [v, y],
      ] as [Axis, number][]) {
        const min = cellBoundary(a, low),
          max = cellBoundary(a, low + 1);
        out = clip(out, (p) => p[a] - min, { axis: a, value: min });
        out = clip(out, (p) => max - p[a], { axis: a, value: max });
      }
      return out;
    };
    for (const id of ids) {
      const tri = face(id),
        n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]));
      const normalLength = Math.hypot(...n);
      if (!Number.isFinite(normalLength) || normalLength === 0)
        throw Error('unresolved degenerate selected source geometry');
      if (!compound && (direction * n[axis]) / normalLength < 0.98)
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
          chargeProjection();
          const fragment = clipped(tri, x, y);
          if (area(fragment, u, v) === 0) continue;
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
          // Empty bbox lookups consume the same finite projection budget.
          chargeProjection();
          const c = columns.get(`${x},${y}`);
          if (!c) continue;
          const fragment = clipped(tri, x, y);
          if (area(fragment, u, v) === 0) continue;
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
      for (let i = 0; !compound && i < c.fragments.length; i++)
        for (let j = i + 1; j < c.fragments.length; j++) {
          if (++pairs > 2000000)
            throw Error('exterior overlap work budget exceeded');
          if (overlap(c.fragments[i].polygon, c.fragments[j].polygon, u, v) > 0)
            overlaps = true;
        }
      const coverage = unionCoverage(
        c.fragments.map((f) => f.polygon),
        u,
        v,
        {
          min: [cellBoundary(u, c.column[0]), cellBoundary(v, c.column[1])],
          max: [
            cellBoundary(u, c.column[0] + 1),
            cellBoundary(v, c.column[1] + 1),
          ],
        },
        () => {
          if (++pairs > 2000000)
            throw Error('exterior arrangement work budget exceeded');
        },
      );
      const reason = overlaps
        ? 'overlapping target projections'
        : !coverage.complete
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
          ...(compound
            ? {
                depthFragments: c.fragments.map((f) => ({
                  sourceFaceId: f.id,
                  minSignedDepth: Math.min(
                    ...f.polygon.map((q) => direction * q[axis]),
                  ),
                  maxSignedDepth: Math.max(
                    ...f.polygon.map((q) => direction * q[axis]),
                  ),
                  projectedArea: area(f.polygon, u, v),
                })),
              }
            : {}),
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
                ? cellBoundary(axis, q[axis])
                : -cellBoundary(axis, q[axis] + 1);
            if (near > c.sourceMaxSignedDepth + EPS) empty.add(q.join(','));
          }
    }
    return {
      status: empty.size ? 'candidate' : 'noop',
      scope: 'source-defined-exterior-only',
      coverageMode,
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
