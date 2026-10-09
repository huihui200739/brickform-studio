type V3 = [number, number, number];
type Axis = 0 | 1 | 2;
type V2 = [number, number];
type R = { n: bigint; d: bigint };
type RP = [R, R];
export type SourceSectionsInput = {
  /** Complete ORIGINAL normalized triangle soup, including unselected faces. */
  positions: ArrayLike<number>;
  faceIds: readonly number[];
  complete?: boolean;
  sweepAxis: Axis;
  stations: readonly number[];
  limits?: {
    originalFaces?: number;
    selectedFaces?: number;
    stations?: number;
    faceStationTests?: number;
    segments?: number;
    topologyTests?: number;
  };
};
export type SourceEdgeReference = {
  sourceFaceId: number;
  localVertices: [number, number];
  positionOffsets: [number, number];
};
export type SourceSectionPoint = {
  id: string;
  position: V3;
  point: V2;
  /** Exact binary-source/rational intersection; decimal display is approximate. */
  exactPoint: [string, string];
  originalEdges: {
    id: string;
    vertices: [V3, V3];
    references: SourceEdgeReference[];
  }[];
  sourceFaceIds: number[];
  externalSourceInterface: boolean;
};
export type SourceSectionPath = {
  id: string;
  pointIds: string[];
  segmentIds: number[];
  sourceFaceIds: number[];
  corners: { pointId: string; sourceEdgeIds: string[] }[];
  bounds: { min: V2; max: V2 };
  /** Present only for an observed closed loop with resolved containment/winding. */
  loopKind?: 'solid-boundary' | 'hole-boundary';
  nestingDepth?: number;
  parentLoopId?: string;
  signedAreaStudsSquared?: number;
  exactSignedArea?: string;
};
export type SourceSectionStation = {
  coordinate: number;
  status: 'diagnosed' | 'unresolved';
  points: SourceSectionPoint[];
  segments: { id: number; from: string; to: string; sourceFaceIds: number[] }[];
  /** Zero-dimensional source contacts are retained, never converted into edges. */
  isolatedPointIds: string[];
  /** A coplanar triangle intersects in an area, not only a guessed perimeter. */
  coplanarFaces: {
    sourceFaceId: number;
    pointIds: [string, string, string];
    sourceEdgeIds: string[];
  }[];
  loops: SourceSectionPath[];
  openChains: SourceSectionPath[];
  untracedSegmentIds: number[];
  solidHoleStatus:
    | 'classified'
    | 'unavailable-open-profile'
    | 'unavailable-source-closure'
    | 'unavailable-coplanar-section'
    | 'unresolved';
  solidRegions: {
    outerLoopId: string;
    holeLoopIds: string[];
    areaStudsSquared: number;
    exactAreaStudsSquared: string;
  }[];
  sourceClosureVerified: boolean;
  bounds?: { min: V2; max: V2 };
  reasons: string[];
};
export type SourceSectionsResult = {
  status: 'diagnosed' | 'unresolved';
  sweepAxis: Axis;
  /** Cyclic basis: U cross V points along the positive sweep axis. */
  planeAxes: [Axis, Axis];
  stations: SourceSectionStation[];
  /** Same complete source reference supplied by the caller; never rewritten. */
  originalPositions: ArrayLike<number>;
  selectedSourceFaceIds: readonly number[];
  sourceTopology: {
    selectedFaces: number;
    originalFaces: number;
    boundaryEdges: number;
    externalInterfaceEdges: number;
    nonmanifoldEdges: number;
    inconsistentWindingEdges: number;
    sourceClosureVerified: boolean;
    /** All selected edges, with full supplied-source incidence (also outside selection). */
    edges: {
      id: string;
      vertices: [V3, V3];
      selectedSourceFaceIds: number[];
      references: SourceEdgeReference[];
      externalSourceInterface: boolean;
    }[];
  };
  comparison: {
    status: 'comparable' | 'unavailable';
    reasons: string[];
    pairs: {
      fromStation: number;
      toStation: number;
      paths: {
        fromPath: string;
        toPath: string;
        sharedSourceFaceIds: number[];
        cornerOffsets: {
          fromPoint: string;
          toPoint: string;
          delta: V2;
          distanceStuds: number;
        }[];
        maxCornerOffsetStuds: number;
        boundsDelta: { min: V2; max: V2 };
        areaDeltaStudsSquared?: number;
      }[];
    }[];
    /** Independent station differences remain available without guessed matches. */
    independentShapeDeltas: {
      fromStation: number;
      toStation: number;
      loopCountDelta: number;
      openChainCountDelta: number;
      boundsDelta?: { min: V2; max: V2 };
    }[];
  };
  arithmetic: 'exact-rational-intersections-and-topology';
  numericCoordinatesAreApproximate: true;
  sourceTruthVerified: false;
  constructionTargetVerified: false;
  work: { faceStationTests: number; segments: number; topologyTests: number };
  reasons: string[];
};
export const SOURCE_SECTION_LIMITS = Object.freeze({
  originalFaces: 250000,
  selectedFaces: 50000,
  stations: 32,
  faceStationTests: 1600000,
  segments: 200000,
  topologyTests: 1000000,
});
const MAX = SOURCE_SECTION_LIMITS;
const MAX_BITS = 16384;
const abs = (x: bigint) => (x < BigInt(0) ? -x : x);
function gcd(a: bigint, b: bigint) {
  while (b) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}
function rat(n: bigint, d = BigInt(1)): R {
  if (!d) throw Error('exact intersection has zero denominator');
  if (d < BigInt(0)) {
    n = -n;
    d = -d;
  }
  if (!n) return { n: BigInt(0), d: BigInt(1) };
  const g = gcd(abs(n), d);
  n /= g;
  d /= g;
  if (abs(n).toString(2).length > MAX_BITS || d.toString(2).length > MAX_BITS)
    throw Error('exact arithmetic bit budget exceeded');
  return { n, d };
}
const add = (a: R, b: R) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: R, b: R) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: R, b: R) => rat(a.n * b.n, a.d * b.d);
const div = (a: R, b: R) => rat(a.n * b.d, a.d * b.n);
const cmp = (a: R, b: R) => {
  const n = a.n * b.d - b.n * a.d;
  return n < BigInt(0) ? -1 : n > BigInt(0) ? 1 : 0;
};
const repr = (a: R) => `${a.n}/${a.d}`;
const ZERO: R = { n: BigInt(0), d: BigInt(1) };
function numberR(value: number): R {
  if (!Number.isFinite(value)) throw Error('nonfinite original coordinate');
  if (!value) return ZERO;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0),
    exponent = Number((bits >> BigInt(52)) & BigInt(2047));
  let n =
    (bits & ((BigInt(1) << BigInt(52)) - BigInt(1))) |
    (exponent ? BigInt(1) << BigInt(52) : BigInt(0));
  if (bits >> BigInt(63)) n = -n;
  const power = exponent ? exponent - 1023 - 52 : -1074;
  return power >= 0
    ? rat(n << BigInt(power))
    : rat(n, BigInt(1) << BigInt(-power));
}
function display(a: R): number {
  if (!a.n) return 0;
  const n = abs(a.n),
    ns = Math.max(0, n.toString(2).length - 53),
    ds = Math.max(0, a.d.toString(2).length - 53);
  const value =
    (Number(n >> BigInt(ns)) / Number(a.d >> BigInt(ds))) *
    2 ** (ns - ds) *
    (a.n < BigInt(0) ? -1 : 1);
  if (!Number.isFinite(value))
    throw Error('exact intersection cannot be displayed finitely');
  return value;
}
function orient(a: RP, b: RP, c: RP) {
  return cmp(
    sub(
      mul(sub(b[0], a[0]), sub(c[1], a[1])),
      mul(sub(b[1], a[1]), sub(c[0], a[0])),
    ),
    ZERO,
  );
}
function between(x: R, a: R, b: R) {
  return (
    cmp(x, cmp(a, b) < 0 ? a : b) >= 0 && cmp(x, cmp(a, b) > 0 ? a : b) <= 0
  );
}
function onSegment(p: RP, a: RP, b: RP) {
  return (
    orient(a, b, p) === 0 &&
    between(p[0], a[0], b[0]) &&
    between(p[1], a[1], b[1])
  );
}
function contains(points: RP[], p: RP) {
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i],
      b = points[(i + 1) % points.length];
    if (cmp(a[1], p[1]) > 0 !== cmp(b[1], p[1]) > 0)
      if (orient(a, b, p) > 0 === cmp(b[1], a[1]) > 0) inside = !inside;
  }
  return inside;
}
const exactAreaSign = (path: SourceSectionPath) => {
  const numerator = BigInt(path.exactSignedArea!.split('/')[0]);
  return numerator < BigInt(0) ? -1 : numerator > BigInt(0) ? 1 : 0;
};
const parseR = (value: string): R => {
  const [n, d] = value.split('/');
  return { n: BigInt(n), d: BigInt(d) };
};
const absoluteR = (value: R): R => ({ n: abs(value.n), d: value.d });
function boundsFor(points: readonly V2[]): { min: V2; max: V2 } {
  const min: V2 = [Infinity, Infinity],
    max: V2 = [-Infinity, -Infinity];
  for (const point of points)
    for (const axis of [0, 1]) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  return { min, max };
}
const coordinateKey = (p: V3) =>
  p.map((v) => (v === 0 ? '0' : String(v))).join(',');
type Vertex = { key: string; p: V3; r: [R, R, R] };
type Edge = {
  id: string;
  a: Vertex;
  b: Vertex;
  refs: SourceEdgeReference[];
  selectedRefs: number;
  directions: number[];
};
type Face = {
  id: number;
  v: [Vertex, Vertex, Vertex];
  edges: Edge[];
  normal: [R, R, R];
};

/** Exact section diagnostics for the ORIGINAL, unmodified triangle soup.
 *
 * faceIds index the full supplied positions (nine coordinates per face).
 * Adjacency requires identical complete source edges; there is no tolerance
 * welding, partial-edge joining, convex hull, inferred closure or mesh repair.
 * Stations are sorted, never sampled or trimmed. Work limits can only be lowered.
 * A budget failure retains all computed evidence and explicitly marks later
 * stations uncomputed. Numeric displays are approximate; rational strings carry
 * the exact binary-input geometry, including areas smaller than Number can hold.
 *
 * Coplanar faces retain their complete 2D triangles and exact source perimeter,
 * with no 1D solid/hole classification. A closed trace alone never proves source
 * closure. This module does not verify semantic source truth or a build target.
 */
export function diagnoseSourceSections(
  input: SourceSectionsInput,
): SourceSectionsResult {
  const axes: [Axis, Axis] = [
    ((input.sweepAxis + 1) % 3) as Axis,
    ((input.sweepAxis + 2) % 3) as Axis,
  ];
  const result: SourceSectionsResult = {
    status: 'unresolved',
    sweepAxis: input.sweepAxis,
    planeAxes: axes,
    stations: [],
    originalPositions: input.positions,
    selectedSourceFaceIds: [...input.faceIds],
    sourceTopology: {
      selectedFaces: input.faceIds.length,
      originalFaces: input.positions.length / 9,
      boundaryEdges: 0,
      externalInterfaceEdges: 0,
      nonmanifoldEdges: 0,
      inconsistentWindingEdges: 0,
      sourceClosureVerified: false,
      edges: [],
    },
    comparison: {
      status: 'unavailable',
      reasons: [],
      pairs: [],
      independentShapeDeltas: [],
    },
    arithmetic: 'exact-rational-intersections-and-topology',
    numericCoordinatesAreApproximate: true,
    sourceTruthVerified: false,
    constructionTargetVerified: false,
    work: { faceStationTests: 0, segments: 0, topologyTests: 0 },
    reasons: [],
  };
  try {
    const limits: Record<keyof typeof MAX, number> = { ...MAX };
    for (const k of Object.keys(MAX) as (keyof typeof MAX)[]) {
      const value = input.limits?.[k] ?? MAX[k];
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX[k])
        throw Error(`invalid ${k} work limit`);
      limits[k] = value;
    }
    if (
      ![0, 1, 2].includes(input.sweepAxis) ||
      !input.positions.length ||
      input.positions.length % 9 ||
      input.positions.length / 9 > limits.originalFaces
    )
      throw Error('invalid or over-budget original triangle soup');
    for (let i = 0; i < input.positions.length; i++)
      if (!Number.isFinite(input.positions[i]))
        throw Error('nonfinite original coordinate');
    const selected = new Set(input.faceIds);
    if (
      !selected.size ||
      selected.size !== input.faceIds.length ||
      selected.size > limits.selectedFaces ||
      [...selected].some(
        (f) =>
          !Number.isSafeInteger(f) || f < 0 || f >= input.positions.length / 9,
      )
    )
      throw Error('invalid or over-budget complete face selection');
    const coordinates = [...input.stations].sort((a, b) => a - b);
    if (
      coordinates.length < 1 ||
      coordinates.length > limits.stations ||
      coordinates.some((x) => !Number.isFinite(x)) ||
      new Set(coordinates).size !== coordinates.length
    )
      throw Error('one to 32 distinct finite bounded stations are required');
    if (coordinates.length * selected.size > limits.faceStationTests)
      throw Error(
        'face/station work budget exceeded; no stations were trimmed',
      );
    const vertices = new Map<string, Vertex>(),
      edges = new Map<string, Edge>(),
      faces: Face[] = [];
    const originalVertex = (id: number, j: number): V3 => [
      input.positions[id * 9 + j * 3],
      input.positions[id * 9 + j * 3 + 1],
      input.positions[id * 9 + j * 3 + 2],
    ];
    const vertex = (p: V3): Vertex => {
      const key = coordinateKey(p),
        known = vertices.get(key);
      if (known) return known;
      const v = { key, p, r: p.map(numberR) as [R, R, R] };
      vertices.set(key, v);
      return v;
    };
    const edgeKey = (a: string, b: string) =>
      a < b ? `${a}|${b}` : `${b}|${a}`;
    const faceSignatures = new Set<string>();
    for (const id of [...selected].sort((a, b) => a - b)) {
      const v = [0, 1, 2].map((j) => vertex(originalVertex(id, j))) as [
        Vertex,
        Vertex,
        Vertex,
      ];
      const signature = v
        .map((p) => p.key)
        .sort()
        .join('|');
      if (faceSignatures.has(signature))
        throw Error(`overlapping duplicate source triangle: ${id}`);
      faceSignatures.add(signature);
      const ab = v[1].r.map((r, i) => sub(r, v[0].r[i])),
        ac = v[2].r.map((r, i) => sub(r, v[0].r[i]));
      const normal = [
        sub(mul(ab[1], ac[2]), mul(ab[2], ac[1])),
        sub(mul(ab[2], ac[0]), mul(ab[0], ac[2])),
        sub(mul(ab[0], ac[1]), mul(ab[1], ac[0])),
      ] as [R, R, R];
      if (normal.every((n) => n.n === BigInt(0)))
        throw Error(`degenerate original triangle: ${id}`);
      const faceEdges: Edge[] = [];
      for (let j = 0; j < 3; j++) {
        const next = (j + 1) % 3,
          a = v[j],
          b = v[next],
          key = edgeKey(a.key, b.key);
        let e = edges.get(key);
        if (!e) {
          e = {
            id: key,
            a: a.key < b.key ? a : b,
            b: a.key < b.key ? b : a,
            refs: [],
            selectedRefs: 0,
            directions: [],
          };
          edges.set(key, e);
        }
        e.refs.push({
          sourceFaceId: id,
          localVertices: [j, next],
          positionOffsets: [id * 9 + j * 3, id * 9 + next * 3],
        });
        e.selectedRefs++;
        e.directions.push(a.key < b.key ? 1 : -1);
        faceEdges.push(e);
      }
      faces.push({ id, v, edges: faceEdges, normal });
    }
    // The full supplied source participates in edge incidence. A local pair
    // must not hide an unselected third face or an external source interface.
    for (let id = 0; id < input.positions.length / 9; id++) {
      if (selected.has(id)) continue;
      const keys = [0, 1, 2].map((j) => coordinateKey(originalVertex(id, j)));
      for (let j = 0; j < 3; j++) {
        const next = (j + 1) % 3,
          e = edges.get(edgeKey(keys[j], keys[next]));
        if (e) {
          e.refs.push({
            sourceFaceId: id,
            localVertices: [j, next],
            positionOffsets: [id * 9 + j * 3, id * 9 + next * 3],
          });
          e.directions.push(keys[j] < keys[next] ? 1 : -1);
        }
      }
    }
    for (const e of edges.values()) {
      result.sourceTopology.edges.push({
        id: e.id,
        vertices: [e.a.p.slice() as V3, e.b.p.slice() as V3],
        selectedSourceFaceIds: e.refs
          .filter((ref) => selected.has(ref.sourceFaceId))
          .map((ref) => ref.sourceFaceId),
        references: e.refs.map((ref) => ({
          ...ref,
          localVertices: [...ref.localVertices],
          positionOffsets: [...ref.positionOffsets],
        })),
        externalSourceInterface: e.refs.length > e.selectedRefs,
      });
      if (e.selectedRefs === 1) result.sourceTopology.boundaryEdges++;
      if (e.refs.length > e.selectedRefs)
        result.sourceTopology.externalInterfaceEdges++;
      if (e.refs.length > 2) result.sourceTopology.nonmanifoldEdges++;
      if (e.refs.length === 2 && e.directions[0] === e.directions[1])
        result.sourceTopology.inconsistentWindingEdges++;
    }
    if (result.sourceTopology.nonmanifoldEdges)
      result.reasons.push(
        'selected original edges have nonmanifold full-source incidence',
      );
    if (result.sourceTopology.inconsistentWindingEdges)
      result.reasons.push('original shared-edge winding is inconsistent');
    result.sourceTopology.sourceClosureVerified =
      !!input.complete &&
      !result.sourceTopology.boundaryEdges &&
      !result.sourceTopology.externalInterfaceEdges &&
      !result.reasons.length;
    // At a vertex, connect only the face fan reached through full exact source
    // edges. Merely equal cut coordinates never establish mesh adjacency.
    const fanParent = new Map<string, string>();
    const fanKey = (vertex: Vertex, face: number) => `${vertex.key}@${face}`;
    const fanRoot = (key: string): string => {
      let root = key;
      while (fanParent.has(root)) root = fanParent.get(root)!;
      while (key !== root && fanParent.has(key)) {
        const next = fanParent.get(key)!;
        fanParent.set(key, root);
        key = next;
      }
      return root;
    };
    for (const edge of edges.values()) {
      const refs = edge.refs.filter((ref) => selected.has(ref.sourceFaceId));
      for (const vertex of [edge.a, edge.b])
        for (let i = 1; i < refs.length; i++) {
          const a = fanRoot(fanKey(vertex, refs[0].sourceFaceId));
          const b = fanRoot(fanKey(vertex, refs[i].sourceFaceId));
          if (a !== b) fanParent.set(a < b ? b : a, a < b ? a : b);
        }
    }
    const tick = () => {
      if (++result.work.topologyTests > limits.topologyTests)
        throw Error('section topology work budget exceeded');
    };
    let budgetExhausted = false;
    for (const coordinate of coordinates) {
      const station: SourceSectionStation = {
        coordinate,
        status: 'unresolved',
        points: [],
        segments: [],
        isolatedPointIds: [],
        coplanarFaces: [],
        loops: [],
        openChains: [],
        untracedSegmentIds: [],
        solidHoleStatus: 'unresolved',
        solidRegions: [],
        sourceClosureVerified: false,
        reasons: [],
      };
      result.stations.push(station);
      if (budgetExhausted) {
        station.reasons.push(
          'station not computed after the shared work budget was exhausted',
        );
        continue;
      }
      try {
        const s = numberR(coordinate),
          pointMap = new Map<string, SourceSectionPoint>(),
          exact = new Map<string, RP>();
        const provenance = new Map<
          string,
          { faces: Set<number>; edges: Set<string> }
        >();
        const point = (
          xyz: [R, R, R],
          face: Face,
          e: Edge,
          vertex?: Vertex,
        ) => {
          const p = [xyz[axes[0]], xyz[axes[1]]] as RP;
          const key = vertex
            ? `vertex:${fanRoot(fanKey(vertex, face.id))}`
            : `edge:${e.id}`;
          let record = pointMap.get(key);
          if (!record) {
            const position = xyz.map(display) as V3;
            record = {
              id: key,
              position,
              point: [position[axes[0]], position[axes[1]]],
              exactPoint: p.map(repr) as [string, string],
              originalEdges: [],
              sourceFaceIds: [],
              externalSourceInterface: false,
            };
            pointMap.set(key, record);
            provenance.set(key, { faces: new Set(), edges: new Set() });
            station.points.push(record);
            exact.set(key, p);
          }
          const known = provenance.get(key)!;
          if (!known.faces.has(face.id)) {
            known.faces.add(face.id);
            record.sourceFaceIds.push(face.id);
          }
          if (!known.edges.has(e.id)) {
            known.edges.add(e.id);
            record.originalEdges.push({
              id: e.id,
              vertices: [e.a.p.slice() as V3, e.b.p.slice() as V3],
              references: e.refs.map((r) => ({
                ...r,
                localVertices: [...r.localVertices],
                positionOffsets: [...r.positionOffsets],
              })),
            });
          }
          record.externalSourceInterface ||= e.refs.length > e.selectedRefs;
          return record;
        };
        const segmentMap = new Map<string, number>();
        const segmentFaces = new Map<number, Set<number>>();
        const directed = new Set<number>();
        const uncertainDirection = new Set<number>();
        const emit = (
          a: SourceSectionPoint,
          b: SourceSectionPoint,
          face: Face,
          cutEdge?: Edge,
          coplanar = false,
        ) => {
          const ar = exact.get(a.id)!,
            br = exact.get(b.id)!;
          const direction = add(
            mul(sub(br[0], ar[0]), sub(ZERO, face.normal[axes[1]])),
            mul(sub(br[1], ar[1]), face.normal[axes[0]]),
          );
          const from = !coplanar && direction.n < BigInt(0) ? b.id : a.id;
          const to = from === a.id ? b.id : a.id;
          // Only a full original edge can be represented by multiple triangles.
          // Unrelated coincident line segments remain distinct evidence.
          const key = cutEdge ? `edge:${cutEdge.id}` : `face:${face.id}`;
          const previous = segmentMap.get(key);
          if (previous !== undefined) {
            const seg = station.segments[previous];
            const knownFaces = segmentFaces.get(previous)!;
            if (!knownFaces.has(face.id)) {
              knownFaces.add(face.id);
              seg.sourceFaceIds.push(face.id);
            }
            if (!coplanar) {
              if (directed.has(previous) && seg.from !== from) {
                directed.delete(previous);
                uncertainDirection.add(previous);
              } else if (!uncertainDirection.has(previous)) {
                seg.from = from;
                seg.to = to;
                directed.add(previous);
              }
            }
            return;
          }
          if (++result.work.segments > limits.segments)
            throw Error(
              'section segment work budget exceeded; no profile was trimmed',
            );
          const id = station.segments.length;
          segmentMap.set(key, id);
          segmentFaces.set(id, new Set([face.id]));
          station.segments.push({ id, from, to, sourceFaceIds: [face.id] });
          if (!coplanar && direction.n) directed.add(id);
        };
        const coplanar = new Map<number, Face>();
        const edgeCuts: {
          a: SourceSectionPoint;
          b: SourceSectionPoint;
          face: Face;
          edge: Edge;
        }[] = [];
        for (const face of faces) {
          if (++result.work.faceStationTests > limits.faceStationTests)
            throw Error('face/station work budget exceeded');
          const signs = face.v.map((v) => cmp(v.r[input.sweepAxis], s));
          const zeros = signs.filter((v) => v === 0).length;
          if (!zeros && (!signs.includes(-1) || !signs.includes(1))) continue;
          const hits = new Map<string, SourceSectionPoint>();
          for (let j = 0; j < 3; j++) {
            const next = (j + 1) % 3,
              a = face.v[j],
              b = face.v[next],
              e = face.edges[j];
            if (signs[j] === 0) {
              const p = point(a.r, face, e, a);
              hits.set(p.id, p);
            }
            if (signs[next] === 0) {
              const p = point(b.r, face, e, b);
              hits.set(p.id, p);
            }
            if (signs[j] * signs[next] < 0) {
              const t = div(
                sub(s, e.a.r[input.sweepAxis]),
                sub(e.b.r[input.sweepAxis], e.a.r[input.sweepAxis]),
              );
              const xyz = e.a.r.map((r, i) =>
                add(r, mul(sub(e.b.r[i], r), t)),
              ) as [R, R, R];
              const p = point(xyz, face, e);
              hits.set(p.id, p);
            }
          }
          if (zeros === 3) {
            coplanar.set(face.id, face);
            station.coplanarFaces.push({
              sourceFaceId: face.id,
              pointIds: face.v.map(
                (v) => `vertex:${fanRoot(fanKey(v, face.id))}`,
              ) as [string, string, string],
              sourceEdgeIds: face.edges.map((e) => e.id),
            });
          } else if (hits.size === 1) {
            // A tangent vertex is the entire exact intersection of this face.
          } else if (hits.size === 2) {
            const [a, b] = [...hits.values()];
            const edge =
              zeros === 2
                ? face.edges.find(
                    (e) =>
                      cmp(e.a.r[input.sweepAxis], s) === 0 &&
                      cmp(e.b.r[input.sweepAxis], s) === 0,
                  )
                : undefined;
            if (edge) edgeCuts.push({ a, b, face, edge });
            else emit(a, b, face);
          } else
            throw Error(`unresolved triangle intersection at face ${face.id}`);
        }
        // Keep every area triangle above. Its one-dimensional outline omits
        // only edges internal to the observed coplanar patch, never source data.
        for (const face of coplanar.values())
          for (let j = 0; j < 3; j++) {
            const e = face.edges[j];
            const areaRefs = e.refs.filter((ref) =>
              coplanar.has(ref.sourceFaceId),
            );
            if (areaRefs.length > 2)
              station.reasons.push(`nonmanifold coplanar patch edge ${e.id}`);
            if (areaRefs.length !== 2) {
              const a = point(face.v[j].r, face, e, face.v[j]);
              const b = point(
                face.v[(j + 1) % 3].r,
                face,
                e,
                face.v[(j + 1) % 3],
              );
              emit(a, b, face, e, true);
            }
          }
        for (const cut of edgeCuts) {
          const areaRefs = cut.edge.refs.filter((ref) =>
            coplanar.has(ref.sourceFaceId),
          );
          if (areaRefs.length === 2) continue;
          emit(cut.a, cut.b, cut.face, cut.edge);
        }
        const adjacency = new Map<string, number[]>(),
          duplicates = new Set<string>();
        for (const seg of station.segments) {
          const k =
            seg.from < seg.to
              ? `${seg.from}|${seg.to}`
              : `${seg.to}|${seg.from}`;
          if (duplicates.has(k))
            station.reasons.push(`overlapping duplicate cut segment ${seg.id}`);
          duplicates.add(k);
          for (const p of [seg.from, seg.to]) {
            const refs = adjacency.get(p) ?? [];
            refs.push(seg.id);
            adjacency.set(p, refs);
          }
        }
        const areaPoints = new Set(
          station.coplanarFaces.flatMap((face) => face.pointIds),
        );
        station.isolatedPointIds = station.points
          .filter((p) => !adjacency.has(p.id) && !areaPoints.has(p.id))
          .map((p) => p.id);
        for (const [p, refs] of adjacency) {
          if (refs.length > 2)
            station.reasons.push(`branched/nonmanifold section point ${p}`);
          if (
            (refs.length === 2 &&
              directed.has(refs[0]) &&
              directed.has(refs[1]) &&
              station.segments[refs[0]].from ===
                station.segments[refs[1]].from) ||
            (refs.length === 2 &&
              directed.has(refs[0]) &&
              directed.has(refs[1]) &&
              station.segments[refs[0]].to === station.segments[refs[1]].to)
          )
            station.reasons.push(`inconsistent directed cut winding at ${p}`);
        }
        // Exact interval sweep. All possible geometric contacts are checked;
        // disjoint intervals avoid a quadratic all-pairs scan.
        const stationBounds = boundsFor(station.points.map((p) => p.point));
        const span = stationBounds.max.map((v, k) => v - stationBounds.min[k]);
        const sweep = span[0] >= span[1] ? 0 : 1;
        const otherAxis = 1 - sweep;
        const intervals = station.segments
          .map((segment) => {
            const p = exact.get(segment.from)!,
              q = exact.get(segment.to)!;
            return {
              segment,
              p,
              q,
              lo: p.map((v, k) => (cmp(v, q[k]) < 0 ? v : q[k])) as RP,
              hi: p.map((v, k) => (cmp(v, q[k]) > 0 ? v : q[k])) as RP,
            };
          })
          .sort((a, b) => {
            tick();
            return cmp(a.lo[sweep], b.lo[sweep]);
          });
        let active: typeof intervals = [];
        for (const current of intervals) {
          active = active.filter(
            (previous) => cmp(previous.hi[sweep], current.lo[sweep]) >= 0,
          );
          for (const previous of active) {
            tick();
            if (
              cmp(previous.hi[otherAxis], current.lo[otherAxis]) < 0 ||
              cmp(current.hi[otherAxis], previous.lo[otherAxis]) < 0
            )
              continue;
            const a = previous.segment,
              b = current.segment;
            const p = previous.p,
              q = previous.q,
              r = current.p,
              t = current.q;
            const o1 = orient(p, q, r),
              o2 = orient(p, q, t),
              o3 = orient(r, t, p),
              o4 = orient(r, t, q);
            const shared = [a.from, a.to].filter(
              (id) => id === b.from || id === b.to,
            );
            if (!o1 && !o2 && !o3 && !o4) {
              const k = cmp(p[0], q[0]) !== 0 ? 0 : 1,
                lo = cmp(p[k], q[k]) < 0 ? p[k] : q[k],
                hi = cmp(p[k], q[k]) > 0 ? p[k] : q[k],
                bl = cmp(r[k], t[k]) < 0 ? r[k] : t[k],
                bh = cmp(r[k], t[k]) > 0 ? r[k] : t[k];
              const overlap = cmp(
                cmp(lo, bl) > 0 ? lo : bl,
                cmp(hi, bh) < 0 ? hi : bh,
              );
              if (overlap < 0)
                station.reasons.push(
                  `overlapping collinear cut segments ${a.id}/${b.id}`,
                );
              else if (overlap === 0 && !shared.length)
                station.reasons.push(
                  `self-intersection/nonvertex contact in cut segments ${a.id}/${b.id}`,
                );
            } else if (
              (o1 * o2 < 0 && o3 * o4 < 0) ||
              (!shared.length &&
                (onSegment(r, p, q) ||
                  onSegment(t, p, q) ||
                  onSegment(p, r, t) ||
                  onSegment(q, r, t)))
            )
              station.reasons.push(
                `self-intersection/nonvertex contact in cut segments ${a.id}/${b.id}`,
              );
          }
          active.push(current);
        }
        const used = new Set<number>();
        for (const seed of station.segments) {
          if (used.has(seed.id)) continue;
          const componentNodes = new Set<string>(),
            componentEdges = new Set<number>(),
            queue = [seed.from];
          while (queue.length) {
            const p = queue.pop()!;
            if (componentNodes.has(p)) continue;
            componentNodes.add(p);
            for (const e of adjacency.get(p) ?? []) {
              componentEdges.add(e);
              const seg = station.segments[e];
              queue.push(seg.from === p ? seg.to : seg.from);
            }
          }
          if ([...componentNodes].some((p) => adjacency.get(p)!.length > 2)) {
            for (const id of componentEdges) used.add(id);
            station.untracedSegmentIds.push(...componentEdges);
            continue;
          }
          const ends = [...componentNodes].filter(
            (p) => adjacency.get(p)!.length === 1,
          );
          const closed = ends.length === 0;
          if (!closed && ends.length !== 2) {
            for (const id of componentEdges) used.add(id);
            station.untracedSegmentIds.push(...componentEdges);
            station.reasons.push('unresolved chain endpoint count');
            continue;
          }
          const start = closed
            ? [...componentNodes].sort()[0]
            : (ends.find(
                (p) => station.segments[adjacency.get(p)![0]].from === p,
              ) ?? ends.sort()[0]);
          const points = [start],
            segmentIds: number[] = [];
          let current = start;
          while (true) {
            const possible = (adjacency.get(current) ?? []).filter(
              (id) => !used.has(id),
            );
            if (!possible.length) break;
            const id =
                possible.find((id) => station.segments[id].from === current) ??
                possible[0],
              seg = station.segments[id];
            used.add(id);
            segmentIds.push(id);
            const next = seg.from === current ? seg.to : seg.from;
            if (next === start) break;
            points.push(next);
            current = next;
          }
          if (segmentIds.length !== componentEdges.size) {
            station.untracedSegmentIds.push(
              ...[...componentEdges].filter((id) => !used.has(id)),
            );
            station.reasons.push('incomplete source path traversal');
            continue;
          }
          const rp = points.map((id) => exact.get(id)!),
            bounds = boundsFor(points.map((id) => pointMap.get(id)!.point));
          const corners = points
            .filter(
              (p, i) =>
                (!closed && (i === 0 || i === points.length - 1)) ||
                orient(
                  rp[(i + rp.length - 1) % rp.length],
                  rp[i],
                  rp[(i + 1) % rp.length],
                ) !== 0,
            )
            .map((pointId) => ({
              pointId,
              sourceEdgeIds: pointMap
                .get(pointId)!
                .originalEdges.map((e) => e.id),
            }));
          const path: SourceSectionPath = {
            id: `${closed ? 'loop' : 'chain'}-${closed ? station.loops.length : station.openChains.length}`,
            pointIds: points,
            segmentIds,
            sourceFaceIds: [
              ...new Set(
                segmentIds.flatMap((id) => station.segments[id].sourceFaceIds),
              ),
            ].sort((a, b) => a - b),
            corners,
            bounds,
          };
          if (closed) {
            let area = ZERO;
            for (let i = 0; i < rp.length; i++)
              area = add(
                area,
                sub(
                  mul(rp[i][0], rp[(i + 1) % rp.length][1]),
                  mul(rp[i][1], rp[(i + 1) % rp.length][0]),
                ),
              );
            area = div(area, rat(BigInt(2)));
            if (!area.n) station.reasons.push('zero-area closed section');
            path.signedAreaStudsSquared = display(area);
            path.exactSignedArea = repr(area);
            station.loops.push(path);
          } else station.openChains.push(path);
        }
        if (!station.reasons.length && !station.openChains.length) {
          const containers = station.loops.map((loop) =>
            station.loops.filter((other) => {
              if (other === loop) return false;
              // Charge every polygon edge used by the exact containment test.
              for (const ignored of other.pointIds) {
                void ignored;
                tick();
              }
              return contains(
                other.pointIds.map((id) => exact.get(id)!),
                exact.get(loop.pointIds[0])!,
              );
            }),
          );
          station.loops.forEach((loop, i) => {
            loop.nestingDepth = containers[i].length;
            const parent = [...containers[i]].sort(
              (a, b) =>
                containers[station.loops.indexOf(b)].length -
                containers[station.loops.indexOf(a)].length,
            )[0];
            if (parent) loop.parentLoopId = parent.id;
          });
          if (
            result.sourceTopology.sourceClosureVerified &&
            !station.coplanarFaces.length
          ) {
            station.loops.forEach((loop, i) => {
              const root =
                containers[i].find((other) => other.nestingDepth === 0) ?? loop;
              const sign = exactAreaSign(loop);
              const rootSign = exactAreaSign(root);
              if (sign !== rootSign * (loop.nestingDepth! % 2 ? -1 : 1))
                station.reasons.push(
                  `source winding does not encode the observed solid/hole nesting: ${loop.id}`,
                );
            });
            if (!station.reasons.length)
              for (const loop of station.loops)
                loop.loopKind =
                  loop.nestingDepth! % 2 ? 'hole-boundary' : 'solid-boundary';
          }
        }
        if (station.points.length)
          station.bounds = boundsFor(station.points.map((p) => p.point));
        station.sourceClosureVerified =
          result.sourceTopology.sourceClosureVerified &&
          !station.coplanarFaces.length &&
          !station.openChains.length &&
          !station.reasons.length;
        if (!station.reasons.length && !result.reasons.length) {
          station.status = 'diagnosed';
          station.solidHoleStatus = station.openChains.length
            ? 'unavailable-open-profile'
            : station.coplanarFaces.length
              ? 'unavailable-coplanar-section'
              : !station.sourceClosureVerified
                ? 'unavailable-source-closure'
                : 'classified';
          if (station.solidHoleStatus === 'classified')
            station.solidRegions = station.loops
              .filter((loop) => loop.loopKind === 'solid-boundary')
              .map((loop) => {
                const holes = station.loops.filter(
                  (hole) =>
                    hole.loopKind === 'hole-boundary' &&
                    hole.parentLoopId === loop.id,
                );
                const area = holes.reduce(
                  (sum, hole) =>
                    sub(sum, absoluteR(parseR(hole.exactSignedArea!))),
                  absoluteR(parseR(loop.exactSignedArea!)),
                );
                return {
                  outerLoopId: loop.id,
                  holeLoopIds: holes.map((h) => h.id),
                  areaStudsSquared: display(area),
                  exactAreaStudsSquared: repr(area),
                };
              });
        } else station.reasons.push(...result.reasons);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        station.reasons.push(message);
        budgetExhausted ||= message.includes('budget exceeded');
        station.status = 'unresolved';
        station.solidHoleStatus = 'unresolved';
        station.solidRegions = [];
        station.sourceClosureVerified = false;
        station.untracedSegmentIds = station.segments.map(
          (segment) => segment.id,
        );
        for (const loop of station.loops) delete loop.loopKind;
      }
    }
    const delta = (a: { min: V2; max: V2 }, b: { min: V2; max: V2 }) => ({
      min: b.min.map((v, i) => v - a.min[i]) as V2,
      max: b.max.map((v, i) => v - a.max[i]) as V2,
    });
    for (let i = 0; i < result.stations.length - 1; i++) {
      const a = result.stations[i],
        b = result.stations[i + 1];
      result.comparison.independentShapeDeltas.push({
        fromStation: a.coordinate,
        toStation: b.coordinate,
        loopCountDelta: b.loops.length - a.loops.length,
        openChainCountDelta: b.openChains.length - a.openChains.length,
        ...(a.bounds && b.bounds
          ? { boundsDelta: delta(a.bounds, b.bounds) }
          : {}),
      });
      const pair: SourceSectionsResult['comparison']['pairs'][number] = {
        fromStation: a.coordinate,
        toStation: b.coordinate,
        paths: [],
      };
      result.comparison.pairs.push(pair);
      if (
        budgetExhausted ||
        a.status !== 'diagnosed' ||
        b.status !== 'diagnosed'
      ) {
        result.comparison.reasons.push(
          'unresolved station prevents source-profile correspondence',
        );
        continue;
      }
      const ap = [...a.loops, ...a.openChains],
        bp = [...b.loops, ...b.openChains];
      if (ap.length !== bp.length) {
        result.comparison.reasons.push(
          'path topology changed between stations',
        );
        continue;
      }
      const pathsByFace = new Map<number, Set<SourceSectionPath>>();
      for (const path of bp)
        for (const face of path.sourceFaceIds) {
          tick();
          const paths = pathsByFace.get(face) ?? new Set<SourceSectionPath>();
          paths.add(path);
          pathsByFace.set(face, paths);
        }
      const eligible = ap.map((path) => {
        const candidates = new Set<SourceSectionPath>();
        for (const face of path.sourceFaceIds) {
          tick();
          for (const candidate of pathsByFace.get(face) ?? []) {
            tick();
            if (
              path.id.startsWith('loop') === candidate.id.startsWith('loop') &&
              path.loopKind === candidate.loopKind &&
              path.nestingDepth === candidate.nestingDepth
            )
              candidates.add(candidate);
          }
        }
        return [...candidates];
      });
      if (
        eligible.some((matches) => matches.length !== 1) ||
        new Set(eligible.map((matches) => matches[0])).size !== bp.length
      ) {
        result.comparison.reasons.push(
          'persistent original face provenance does not give a unique path correspondence',
        );
        continue;
      }
      const aPoints = new Map(a.points.map((point) => [point.id, point]));
      const bPoints = new Map(b.points.map((point) => [point.id, point]));
      for (let k = 0; k < ap.length; k++) {
        const path = ap[k],
          other = eligible[k][0];
        const cornersByEdge = new Map<
          string,
          Set<SourceSectionPath['corners'][number]>
        >();
        for (const corner of other.corners)
          for (const edge of corner.sourceEdgeIds) {
            tick();
            const corners = cornersByEdge.get(edge) ?? new Set();
            corners.add(corner);
            cornersByEdge.set(edge, corners);
          }
        const matching = path.corners.map((corner) => {
          const candidates = new Set<SourceSectionPath['corners'][number]>();
          for (const edge of corner.sourceEdgeIds) {
            tick();
            for (const candidate of cornersByEdge.get(edge) ?? []) {
              tick();
              candidates.add(candidate);
            }
          }
          return [...candidates];
        });
        if (
          path.corners.length !== other.corners.length ||
          matching.some((m) => m.length !== 1) ||
          new Set(matching.map((m) => m[0])).size !== other.corners.length
        ) {
          result.comparison.reasons.push(
            'original edge provenance does not give a complete unique corner correspondence',
          );
          continue;
        }
        const offsets = path.corners.map((corner, j) => {
          const from = aPoints.get(corner.pointId)!,
            to = bPoints.get(matching[j][0].pointId)!,
            offset = to.point.map((v, q) => v - from.point[q]) as V2;
          return {
            fromPoint: from.id,
            toPoint: to.id,
            delta: offset,
            distanceStuds: Math.hypot(...offset),
          };
        });
        pair.paths.push({
          fromPath: path.id,
          toPath: other.id,
          sharedSourceFaceIds: path.sourceFaceIds.filter((id) => {
            tick();
            return pathsByFace.get(id)?.has(other);
          }),
          cornerOffsets: offsets,
          maxCornerOffsetStuds: offsets.reduce(
            (max, offset) => Math.max(max, offset.distanceStuds),
            0,
          ),
          boundsDelta: delta(path.bounds, other.bounds),
          ...(path.signedAreaStudsSquared !== undefined &&
          other.signedAreaStudsSquared !== undefined
            ? {
                areaDeltaStudsSquared:
                  other.signedAreaStudsSquared - path.signedAreaStudsSquared,
              }
            : {}),
        });
      }
    }
    if (result.stations.length < 2)
      result.comparison.reasons.push(
        'at least two stations are required for comparison',
      );
    result.comparison.status = result.comparison.reasons.length
      ? 'unavailable'
      : 'comparable';
    result.status =
      result.reasons.length ||
      result.stations.some((s) => s.status === 'unresolved')
        ? 'unresolved'
        : 'diagnosed';
    if (result.stations.some((s) => s.status === 'unresolved'))
      result.reasons.push(
        'one or more original-source sections are unresolved; independent station diagnostics retained',
      );
    return result;
  } catch (error) {
    result.reasons.push(error instanceof Error ? error.message : String(error));
    result.comparison.reasons.push('source-section computation unavailable');
    return result;
  }
}
