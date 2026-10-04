import { readFileSync } from 'node:fs';
import type { Brick, Model } from '../../lib/brick-engine.ts';
import type { V3 } from '../../lib/assembly-catalog.ts';

/** Offline directional exterior comparison. This is not an assembly, material,
 * procurement, camera-correspondence or continuous Hausdorff certificate. */
export type CatalogGeometry = Record<string, { positions: ArrayLike<number> }>;
export type SurfaceScoreInput = {
  source: {
    /** Non-indexed, outward-wound triangles in physical model studs (Y included). */
    positions: ArrayLike<number>;
    /** Owned target faces; all source faces remain available as occluders. */
    faceIds?: readonly number[];
    /** Caller has supplied all possible source occluders for these views. */
    completeOcclusionGeometry: boolean;
  };
  model: Pick<Model, 'width' | 'depth' | 'bricks'>;
  /** Surrounding final-model parts; normally used only for occlusion. */
  contextBricks?: readonly Brick[];
  /** Complete final-scene comparison only where the original first visible
   * source face belongs to the target. Retained pieces may represent that area.
   * Missing surfaces and depth errors still count. Requires projection scope. */
  comparison?: 'regional-parts' | 'final-scene-owned-projection';
  completeCandidateOcclusionGeometry: boolean;
  /** Exact conservative lateral projection culling, never a distance crop. */
  cullDisjointContext?: boolean;
  /** Only for a boundary band whose outside volume/material/interfaces are
   * separately frozen. This cannot certify extra geometry outside that band. */
  partScoringFootprint?: 'all-regional-parts' | 'owned-source-projection';
  /** Unit directions from the model toward each observer. No camera refitting. */
  views: readonly V3[];
  catalog?: CatalogGeometry;
  sampleSpacingStuds?: number;
  maxRayDistanceStuds?: number;
  limits?: { triangles?: number; samples?: number; rayTriangleTests?: number };
};
type Triangle = {
  a: V3;
  b: V3;
  c: V3;
  n: V3;
  area: number;
  face: number;
  scored: boolean;
};
type Sample = { p: V3; weight: number; n: V3 };
type Node = { lo: V3; hi: V3; children?: [Node, Node]; items?: Triangle[] };
export type DirectionalMetrics = {
  visibleSamples: number;
  visibleAreaStudsSquared: number;
  matchedAreaStudsSquared: number;
  unmatchedAreaStudsSquared: number;
  coverage: number;
  rmsStuds: number;
  p95Studs: number;
  maxStuds: number;
  normalAgreement: number;
};
export type SurfaceScore =
  | { status: 'unavailable'; reasons: string[] }
  | {
      status: 'scored';
      scope:
        | 'sampled-visible-surface-only'
        | 'sampled-owned-projection-only'
        | 'sampled-final-scene-owned-projection-only';
      contextCulling?: {
        inputParts: number;
        retainedParts: number;
        inputSourceTriangles: number;
        retainedSourceTriangles: number;
      };
      sourceToParts: DirectionalMetrics;
      partsToSource: DirectionalMetrics;
      symmetricRmsStuds: number;
      symmetricP95Studs: number;
      symmetricMaxStuds: number;
      missingOrExtraArea: boolean;
      samples: number;
      rayTriangleTests: number;
    };
const add = (a: V3, b: V3): V3 => a.map((v, i) => v + b[i]) as V3;
const sub = (a: V3, b: V3): V3 => a.map((v, i) => v - b[i]) as V3;
const mul = (a: V3, s: number): V3 => a.map((v) => v * s) as V3;
const dot = (a: V3, b: V3) => a.reduce((n, v, i) => n + v * b[i], 0);
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const finite = (a: ArrayLike<number>) => Array.from(a).every(Number.isFinite);

/** Current buildMeshVolume min/scale and +[1,2,1] grid offsets. Returns a new
 * array; original input positions and observation arrays are never changed. */
export function normalizeSourceMesh(
  positions: ArrayLike<number>,
  min: V3,
  scale: number,
) {
  if (
    !positions.length ||
    positions.length % 3 ||
    !finite(positions) ||
    !finite(min) ||
    !Number.isFinite(scale) ||
    scale <= 0
  )
    throw Error('invalid source frame');
  return Float64Array.from(
    positions,
    (v, i) => (v - min[i % 3]) * scale + [1, 0.8, 1][i % 3],
  );
}
export function loadCatalogGeometry(): CatalogGeometry {
  return JSON.parse(
    readFileSync(
      new URL('../../public/parts/geometry.json', import.meta.url),
      'utf8',
    ),
  );
}
function triangle(
  a: V3,
  b: V3,
  c: V3,
  face: number,
  scored = true,
): Triangle | undefined {
  if (!finite(a) || !finite(b) || !finite(c))
    throw Error('unresolved transformed triangle coordinates');
  const n = cross(sub(b, a), sub(c, a)),
    length = Math.hypot(...n);
  if (!Number.isFinite(length)) throw Error('unresolved triangle area');
  if (length < 1e-12) return undefined;
  return { a, b, c, n: mul(n, 1 / length), area: length / 2, face, scored };
}
function sourceTriangles(input: SurfaceScoreInput['source']) {
  const p = input.positions;
  if (!p.length || p.length % 9 || !finite(p))
    throw Error('invalid source triangles');
  const target =
    input.faceIds === undefined ? undefined : new Set(input.faceIds);
  if (
    target &&
    (!target.size ||
      target.size !== input.faceIds!.length ||
      [...target].some(
        (i) => !Number.isInteger(i) || i < 0 || i >= p.length / 9,
      ))
  )
    throw Error('unresolved source face coverage');
  const out: Triangle[] = [];
  for (let i = 0; i < p.length; i += 9) {
    const t = triangle(
      [p[i], p[i + 1], p[i + 2]],
      [p[i + 3], p[i + 4], p[i + 5]],
      [p[i + 6], p[i + 7], p[i + 8]],
      i / 9,
      !target || target.has(i / 9),
    );
    if (t) out.push(t);
  }
  return out;
}
function rigidRows(b: Brick): V3[] {
  const pose = b.pose;
  if (
    !pose ||
    pose.matrix.length !== 9 ||
    pose.position.length !== 3 ||
    !finite(pose.matrix) ||
    !finite(pose.position)
  )
    throw Error(`unresolved part pose: ${b.id}`);
  const r = pose!.matrix;
  const rows = [r.slice(0, 3), r.slice(3, 6), r.slice(6, 9)] as V3[];
  if (
    rows.some((row, i) =>
      rows.some(
        (other, j) => Math.abs(dot(row, other) - (i === j ? 1 : 0)) > 1e-6,
      ),
    ) ||
    Math.abs(dot(rows[0], cross(rows[1], rows[2])) - 1) > 1e-6
  )
    throw Error(`non-rigid or reflected part pose: ${b.id}`);
  return rows;
}
function partTriangles(
  bricks: readonly Brick[],
  model: SurfaceScoreInput['model'],
  catalog: CatalogGeometry,
  scored: boolean,
  frames?: LateralFrame[],
  maxOutput = 300000,
) {
  const out: Triangle[] = [];
  const validated = new Set<string>();
  let transformed = 0;
  for (const b of bricks) {
    const raw = catalog[b.part]?.positions,
      pose = b.pose;
    if (
      !raw ||
      !raw.length ||
      raw.length % 9 ||
      (!validated.has(b.part) && !finite(raw))
    )
      throw Error(`unavailable catalog triangles: ${b.part}`);
    validated.add(b.part);
    const rows = rigidRows(b);
    const point = (at: number): V3 => {
      const local: V3 = [raw[at], raw[at + 1], raw[at + 2]];
      const world = rows.map((row, i) => dot(row, local) + pose!.position[i]);
      return [
        world[0] / 20 + model.width / 2,
        -world[1] / 20,
        world[2] / 20 + model.depth / 2,
      ];
    };
    for (let i = 0; i < raw.length; i += 9) {
      if (++transformed > 2000000)
        throw Error('part projection work budget exceeded');
      const a = point(i),
        bPoint = point(i + 6),
        c = point(i + 3);
      if (
        frames &&
        !frames.some((frame) => overlapsProjection([a, bPoint, c], frame))
      )
        continue;
      // Y reflection changes handedness, as in viewerGeometry: reverse winding.
      const t = triangle(a, bPoint, c, b.id, scored);
      if (t) out.push(t);
      if (out.length > maxOutput) throw Error('triangle work budget exceeded');
    }
  }
  return out;
}
/** All possible query rays start on a scored source/proposed surface and are
 * parallel to a supplied view. A context AABB disjoint in a perpendicular
 * coordinate can never meet one of these rays, however far along the view. */
type LateralFrame = { u: V3; v: V3; lo: number[]; hi: number[] };
function lateralFrames(
  views: readonly V3[],
  source: Triangle[],
  proposed: Triangle[],
): LateralFrame[] {
  const coordinates = views.map((view) => {
    const axis = view.map(Math.abs).indexOf(Math.min(...view.map(Math.abs)));
    const seed: V3 = [0, 0, 0];
    seed[axis] = 1;
    const u0 = cross(view, seed),
      u = mul(u0, 1 / Math.hypot(...u0)),
      v = cross(view, u);
    return { u, v, lo: [Infinity, Infinity], hi: [-Infinity, -Infinity] };
  });
  for (const t of [...source.filter((t) => t.scored), ...proposed])
    for (const p of [t.a, t.b, t.c])
      for (const frame of coordinates)
        for (const [axis, basis] of [frame.u, frame.v].entries()) {
          const value = dot(p, basis);
          frame.lo[axis] = Math.min(frame.lo[axis], value);
          frame.hi[axis] = Math.max(frame.hi[axis], value);
        }
  return coordinates;
}
function overlapsProjection(points: V3[], frame: LateralFrame) {
  return [frame.u, frame.v].every((basis, axis) => {
    const values = points.map((p) => dot(p, basis));
    return (
      Math.max(...values) >= frame.lo[axis] - 1e-7 &&
      Math.min(...values) <= frame.hi[axis] + 1e-7
    );
  });
}
type P2 = [number, number];
type ProjectedFace = { points: P2[]; lo: P2; hi: P2 };
type ProjectionNode = {
  lo: P2;
  hi: P2;
  children?: [ProjectionNode, ProjectionNode];
  items?: ProjectedFace[];
};
function projectFace(t: Triangle, frame: LateralFrame): ProjectedFace {
  const points = [t.a, t.b, t.c].map(
    (p) => [dot(p, frame.u), dot(p, frame.v)] as P2,
  );
  return {
    points,
    lo: [0, 1].map((i) => Math.min(...points.map((p) => p[i]))) as P2,
    hi: [0, 1].map((i) => Math.max(...points.map((p) => p[i]))) as P2,
  };
}
function projectionTree(items: ProjectedFace[]): ProjectionNode {
  const lo: P2 = [Infinity, Infinity],
    hi: P2 = [-Infinity, -Infinity];
  for (const item of items)
    for (let i = 0; i < 2; i++) {
      lo[i] = Math.min(lo[i], item.lo[i]);
      hi[i] = Math.max(hi[i], item.hi[i]);
    }
  if (items.length <= 8) return { lo, hi, items };
  const axis = hi[0] - lo[0] >= hi[1] - lo[1] ? 0 : 1;
  const sorted = [...items].sort(
    (a, b) => a.lo[axis] + a.hi[axis] - b.lo[axis] - b.hi[axis],
  );
  const middle = Math.floor(items.length / 2);
  return {
    lo,
    hi,
    children: [
      projectionTree(sorted.slice(0, middle)),
      projectionTree(sorted.slice(middle)),
    ],
  };
}
/** Conservative separating-axis rejection only. The margin exceeds the ray
 * barycentric tolerance; edge/degenerate contacts stay eligible. This avoids
 * generating samples in large holes between disconnected owned source faces,
 * without changing the sample locations or removing any scene occluder. */
function overlapsOwnedProjection(
  face: ProjectedFace,
  root: ProjectionNode,
  charge: () => void,
) {
  const margin =
    1e-7 *
    (1 +
      Math.max(
        ...face.lo.map(Math.abs),
        ...face.hi.map(Math.abs),
        ...root.lo.map(Math.abs),
        ...root.hi.map(Math.abs),
      ));
  const visit = (node: ProjectionNode): boolean => {
    charge();
    if (
      [0, 1].some(
        (i) =>
          face.hi[i] < node.lo[i] - margin || face.lo[i] > node.hi[i] + margin,
      )
    )
      return false;
    if (node.children) return node.children.some(visit);
    return node.items!.some((other) => {
      charge();
      if (
        [0, 1].some(
          (i) =>
            face.hi[i] < other.lo[i] - margin ||
            face.lo[i] > other.hi[i] + margin,
        )
      )
        return false;
      for (const polygon of [face.points, other.points])
        for (let i = 0; i < 3; i++) {
          const a = polygon[i],
            b = polygon[(i + 1) % 3];
          const axis: P2 = [a[1] - b[1], b[0] - a[0]];
          const project = (p: P2) => p[0] * axis[0] + p[1] * axis[1];
          const left = face.points.map(project),
            right = other.points.map(project);
          const tolerance = margin * Math.hypot(...axis);
          if (
            Math.max(...left) < Math.min(...right) - tolerance ||
            Math.max(...right) < Math.min(...left) - tolerance
          )
            return false;
        }
      return true;
    });
  };
  return visit(root);
}
function cullContext(
  input: SurfaceScoreInput,
  catalog: CatalogGeometry,
  coordinates: LateralFrame[],
) {
  const bounds = new Map<string, { lo: V3; hi: V3 }>();
  return (input.contextBricks ?? []).filter((b) => {
    let bound = bounds.get(b.part);
    if (!bound) {
      const raw = catalog[b.part]?.positions;
      if (!raw?.length || raw.length % 9 || !finite(raw))
        throw Error(`unavailable catalog triangles: ${b.part}`);
      const lo: V3 = [Infinity, Infinity, Infinity],
        hi: V3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < raw.length; i++) {
        lo[i % 3] = Math.min(lo[i % 3], raw[i]);
        hi[i % 3] = Math.max(hi[i % 3], raw[i]);
      }
      bound = { lo, hi };
      bounds.set(b.part, bound);
    }
    const rows = rigidRows(b),
      corners: V3[] = [];
    for (const x of [bound.lo[0], bound.hi[0]])
      for (const y of [bound.lo[1], bound.hi[1]])
        for (const z of [bound.lo[2], bound.hi[2]]) {
          const local: V3 = [x, y, z];
          const world = rows.map(
            (row, i) => dot(row, local) + b.pose!.position[i],
          );
          corners.push([
            world[0] / 20 + input.model.width / 2,
            -world[1] / 20,
            world[2] / 20 + input.model.depth / 2,
          ]);
        }
    return coordinates.some((frame) => overlapsProjection(corners, frame));
  });
}
function tree(items: Triangle[]): Node {
  const lo: V3 = [Infinity, Infinity, Infinity],
    hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const t of items)
    for (const p of [t.a, t.b, t.c])
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a], p[a]);
        hi[a] = Math.max(hi[a], p[a]);
      }
  if (items.length <= 8) return { lo, hi, items };
  const axis = hi
    .map((v, a) => v - lo[a])
    .indexOf(Math.max(...hi.map((v, a) => v - lo[a])));
  const sorted = [...items].sort(
    (a, b) =>
      a.a[axis] + a.b[axis] + a.c[axis] - (b.a[axis] + b.b[axis] + b.c[axis]),
  );
  const m = Math.floor(sorted.length / 2);
  return {
    lo,
    hi,
    children: [tree(sorted.slice(0, m)), tree(sorted.slice(m))],
  };
}
function boxHit(node: Node, o: V3, d: V3, distance: number) {
  let low = 0,
    high = distance;
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < node.lo[a] - 1e-9 || o[a] > node.hi[a] + 1e-9) return false;
    } else {
      const x = (node.lo[a] - o[a]) / d[a],
        y = (node.hi[a] - o[a]) / d[a];
      low = Math.max(low, Math.min(x, y));
      high = Math.min(high, Math.max(x, y));
      if (high < low) return false;
    }
  }
  return true;
}
function intersect(t: Triangle, o: V3, d: V3) {
  const e1 = sub(t.b, t.a),
    e2 = sub(t.c, t.a),
    h = cross(d, e2),
    determinant = dot(e1, h);
  if (Math.abs(determinant) < 1e-12) return undefined;
  const s = sub(o, t.a),
    u = dot(s, h) / determinant;
  if (u < -1e-9 || u > 1 + 1e-9) return undefined;
  const q = cross(s, e1),
    v = dot(d, q) / determinant;
  if (v < -1e-9 || u + v > 1 + 1e-9) return undefined;
  const distance = dot(e2, q) / determinant;
  return distance > 1e-8 ? distance : undefined;
}
function samples(t: Triangle, spacing: number): Sample[] {
  const count = Math.max(1, Math.ceil(t.area / (spacing * spacing)));
  return Array.from({ length: count }, (_, i) => {
    // Deterministic area-uniform square-to-triangle map with base-2 sequence.
    let bits = i + 1,
      radical = 0,
      unit = 0.5;
    while (bits) {
      radical += (bits % 2) * unit;
      bits = Math.floor(bits / 2);
      unit /= 2;
    }
    const root = Math.sqrt((i + 0.5) / count),
      u = 1 - root,
      v = root * radical;
    return {
      p: add(add(mul(t.a, u), mul(t.b, v)), mul(t.c, 1 - u - v)),
      n: t.n,
      weight: t.area / count,
    };
  });
}
type ErrorSample = {
  error: number;
  weight: number;
  matched: boolean;
  normal: number;
};
function metrics(errors: ErrorSample[]): DirectionalMetrics {
  const area = errors.reduce((n, e) => n + e.weight, 0),
    matched = errors.reduce((n, e) => n + (e.matched ? e.weight : 0), 0);
  let weight = 0,
    p95 = 0;
  for (const e of [...errors].sort((a, b) => a.error - b.error)) {
    weight += e.weight;
    p95 = e.error;
    if (weight >= area * 0.95) break;
  }
  return {
    visibleSamples: errors.length,
    visibleAreaStudsSquared: area,
    matchedAreaStudsSquared: matched,
    unmatchedAreaStudsSquared: area - matched,
    coverage: area ? matched / area : 0,
    rmsStuds: area
      ? Math.sqrt(
          errors.reduce((n, e) => n + e.weight * e.error ** 2, 0) / area,
        )
      : 0,
    p95Studs: p95,
    maxStuds: errors.reduce((n, e) => Math.max(n, e.error), 0),
    normalAgreement: matched
      ? errors.reduce((n, e) => n + (e.matched ? e.normal * e.weight : 0), 0) /
        matched
      : 0,
  };
}
export function scoreCatalogSurface(input: SurfaceScoreInput): SurfaceScore {
  try {
    if (
      !input.source.completeOcclusionGeometry ||
      !input.completeCandidateOcclusionGeometry
    )
      throw Error('source or candidate occlusion coverage unresolved');
    if (
      !Number.isFinite(input.model.width) ||
      !Number.isFinite(input.model.depth) ||
      input.model.width <= 0 ||
      input.model.depth <= 0
    )
      throw Error('invalid model normalization');
    if (
      !input.views.length ||
      input.views.length > 8 ||
      input.views.some(
        (v) =>
          v.length !== 3 || !finite(v) || Math.abs(Math.hypot(...v) - 1) > 1e-6,
      )
    )
      throw Error('invalid or excessive view directions');
    const spacing = input.sampleSpacingStuds ?? 0.15,
      range = input.maxRayDistanceStuds ?? 20;
    if (
      !Number.isFinite(spacing) ||
      spacing <= 0 ||
      !Number.isFinite(range) ||
      range <= 0
    )
      throw Error('invalid sampling/ray bound');
    const maxTriangles = input.limits?.triangles ?? 300000,
      maxSamples = input.limits?.samples ?? 100000,
      maxTests = input.limits?.rayTriangleTests ?? 20000000;
    if (
      [maxTriangles, maxSamples, maxTests].some(
        (v) => !Number.isSafeInteger(v) || v < 1,
      )
    )
      throw Error('invalid work budget');
    if (maxTriangles > 300000 || maxSamples > 100000 || maxTests > 20000000)
      throw Error('work budgets may only tighten the bounded offline limits');
    const catalog = input.catalog ?? loadCatalogGeometry();
    // The raw source remains bounded and completely validated, even if the
    // safe lateral crop removes triangles from the ray acceleration structure.
    if (input.source.positions.length / 9 > 300000)
      throw Error('triangle work budget exceeded');
    const allSource = sourceTriangles(input.source);
    let triangleCount = 0;
    for (const b of input.model.bricks) {
      const raw = catalog[b.part]?.positions;
      if (!raw) throw Error(`unavailable catalog triangles: ${b.part}`);
      triangleCount += raw.length / 9;
      if (triangleCount > maxTriangles)
        throw Error('triangle work budget exceeded');
    }
    const proposed = partTriangles(
      input.model.bricks,
      input.model,
      catalog,
      true,
    );
    const frames = lateralFrames(input.views, allSource, proposed);
    // The same query domain bounds source and part rays. Source triangles far
    // along a view must remain; only lateral disjointness proves irrelevance.
    const source = input.cullDisjointContext
      ? allSource.filter((t) =>
          frames.some((frame) => overlapsProjection([t.a, t.b, t.c], frame)),
        )
      : allSource;
    triangleCount += source.length;
    if (triangleCount > maxTriangles)
      throw Error('triangle work budget exceeded');
    const context = input.cullDisjointContext
      ? cullContext(input, catalog, frames)
      : (input.contextBricks ?? []);
    const finalScene = input.comparison === 'final-scene-owned-projection';
    if (
      input.comparison !== undefined &&
      !['regional-parts', 'final-scene-owned-projection'].includes(
        input.comparison,
      )
    )
      throw Error('invalid surface comparison');
    if (finalScene && input.partScoringFootprint !== 'owned-source-projection')
      throw Error(
        'final-scene regional comparison requires explicit projection scope',
      );
    const parts = [
      ...proposed,
      ...partTriangles(
        context,
        input.model,
        catalog,
        finalScene,
        input.cullDisjointContext ? frames : undefined,
        maxTriangles - triangleCount,
      ),
    ];
    if (
      input.partScoringFootprint !== undefined &&
      !['all-regional-parts', 'owned-source-projection'].includes(
        input.partScoringFootprint,
      )
    )
      throw Error('invalid regional scoring footprint');
    if (!source.some((t) => t.scored))
      throw Error('empty source surface coverage');
    // The bound must reach beyond both scenes in every evaluated direction.
    for (const view of input.views) {
      let lo = Infinity,
        hi = -Infinity;
      for (const t of [...source, ...parts])
        for (const p of [t.a, t.b, t.c]) {
          const d = dot(p, view);
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      if (hi - lo >= range - 1e-6)
        throw Error(
          'ray distance does not cover source and candidate depth extent',
        );
    }
    const sourceTree = tree(source),
      partTree = parts.length ? tree(parts) : undefined;
    const ownedProjectionTree =
      input.partScoringFootprint === 'owned-source-projection'
        ? tree(source.filter((t) => t.scored))
        : undefined;
    const ownedFrames = lateralFrames(input.views, source, []);
    const projectedFootprints =
      ownedProjectionTree && input.cullDisjointContext
        ? ownedFrames.map((frame) =>
            projectionTree(
              source.filter((t) => t.scored).map((t) => projectFace(t, frame)),
            ),
          )
        : undefined;
    let rayTests = 0,
      sampleCount = 0,
      projectionTests = 0;
    const hit = (
      root: Node | undefined,
      origin: V3,
      direction: V3,
      maxDistance: number,
    ) => {
      let best: { distance: number; t: Triangle } | undefined;
      const visit = (node: Node) => {
        if (!boxHit(node, origin, direction, best?.distance ?? maxDistance))
          return;
        if (node.children) {
          visit(node.children[0]);
          visit(node.children[1]);
        } else
          for (const t of node.items!) {
            if (++rayTests > maxTests)
              throw Error('ray intersection work budget exceeded');
            const distance = intersect(t, origin, direction);
            if (
              distance !== undefined &&
              distance <= maxDistance &&
              (!best || distance < best.distance)
            )
              best = { distance, t };
          }
      };
      if (root) visit(root);
      return best;
    };
    const evaluate = (
      triangles: Triangle[],
      own: Node | undefined,
      other: Node | undefined,
      projectedDomain?: Node,
      visibleOwnedProjection = false,
    ) => {
      const errors: ErrorSample[] = [];
      for (const [viewIndex, view] of input.views.entries())
        for (const t of triangles) {
          if (!t.scored || dot(t.n, view) <= 1e-8) continue;
          if (
            projectedDomain &&
            !overlapsProjection([t.a, t.b, t.c], ownedFrames[viewIndex])
          )
            continue;
          if (
            projectedDomain &&
            projectedFootprints &&
            !overlapsOwnedProjection(
              projectFace(t, ownedFrames[viewIndex]),
              projectedFootprints[viewIndex],
              () => {
                if (++projectionTests > 2000000)
                  throw Error('owned projection work budget exceeded');
              },
            )
          )
            continue;
          const count = Math.max(1, Math.ceil(t.area / spacing ** 2));
          if (sampleCount + count > maxSamples)
            throw Error('surface sample work budget exceeded');
          const sampled = samples(t, spacing);
          sampleCount += sampled.length;
          for (const s of sampled) {
            const projectedHit = projectedDomain
              ? hit(
                  projectedDomain,
                  add(s.p, mul(view, range)),
                  mul(view, -1),
                  range * 2,
                )
              : undefined;
            if (projectedDomain && !projectedHit) continue;
            // A hidden target cannot authorize scoring the surface of another
            // original object which occludes it. Keep original scene ownership.
            if (
              visibleOwnedProjection &&
              !hit(
                sourceTree,
                add(s.p, mul(view, range)),
                mul(view, -1),
                range * 2,
              )?.t.scored
            )
              continue;
            // Occluded source/part surfaces never supply exterior fit samples.
            if (hit(own, add(s.p, mul(view, 1e-6)), view, range)) continue;
            const nearest = hit(
              other,
              add(s.p, mul(view, range)),
              mul(view, -1),
              range * 2,
            );
            const matched = !!nearest?.t.scored;
            errors.push({
              error: matched ? Math.abs(range - nearest!.distance) : range,
              weight: s.weight,
              matched,
              normal: matched
                ? Math.max(-1, Math.min(1, dot(s.n, nearest!.t.n)))
                : 0,
            });
          }
        }
      return errors;
    };
    const forward = evaluate(source, sourceTree, partTree),
      reverse = evaluate(
        parts,
        partTree,
        sourceTree,
        ownedProjectionTree,
        finalScene,
      );
    if (!forward.length)
      throw Error('no observable owned source area in supplied views');
    const a = metrics(forward),
      b = metrics(reverse),
      combined = metrics([...forward, ...reverse]);
    return {
      status: 'scored',
      scope: finalScene
        ? 'sampled-final-scene-owned-projection-only'
        : ownedProjectionTree
          ? 'sampled-owned-projection-only'
          : 'sampled-visible-surface-only',
      ...(input.cullDisjointContext
        ? {
            contextCulling: {
              inputParts: input.contextBricks?.length ?? 0,
              retainedParts: context.length,
              inputSourceTriangles: allSource.length,
              retainedSourceTriangles: source.length,
            },
          }
        : {}),
      sourceToParts: a,
      partsToSource: b,
      symmetricRmsStuds: combined.rmsStuds,
      symmetricP95Studs: combined.p95Studs,
      symmetricMaxStuds: combined.maxStuds,
      missingOrExtraArea:
        a.unmatchedAreaStudsSquared > 1e-9 ||
        b.unmatchedAreaStudsSquared > 1e-9,
      samples: sampleCount,
      rayTriangleTests: rayTests,
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reasons: [error instanceof Error ? error.message : String(error)],
    };
  }
}
