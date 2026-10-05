type Axis = 0 | 1 | 2;
type Direction = -1 | 1;
export type AxisRegionLimits = {
  faces: number;
  facesPerRegion: number;
  usableRegions: number;
};
export const AXIS_REGION_LIMITS: Readonly<AxisRegionLimits> = Object.freeze({
  faces: 250000,
  facesPerRegion: 4096,
  usableRegions: 64,
});
export type AxisRegionInput = {
  /** Complete ORIGINAL source in physical studs, including Y in studs. */
  source: { positions: ArrayLike<number>; complete: boolean };
  limits?: Partial<AxisRegionLimits>;
};
export type AxisRegion = {
  sourceFaceIds: number[];
  axis: Axis | null;
  direction: Direction | null;
  area: number;
  projectedArea: number | null;
  projectionBounds: {
    axes: [Axis, Axis];
    min: [number, number];
    max: [number, number];
    span: [number, number];
    cellSpan: [number, number];
    cellArea: number;
  } | null;
  minCos: number;
  status: 'usable' | 'rejected' | 'unresolved';
  reasons: string[];
};
type Enumeration = {
  scope: 'source-axis-regions-only';
  sourceTruthVerified: false;
  completeEnumeration: boolean;
  regions: AxisRegion[];
  reasons: string[];
  stats: {
    sourceFaces: number;
    regions: number;
    usableRegions: number;
    rejectedRegions: number;
    unresolvedRegions: number;
  };
};
export type AxisRegionResult =
  | { status: 'unavailable'; reasons: string[] }
  | (Enumeration & { status: 'selected' | 'unresolved' });
type Edge = {
  count: number;
  face: number;
  direction: Direction;
  otherFace: number;
  otherDirection: Direction;
};
const STEP = [1, 0.4, 1] as const;
const DEGENERATE = 1;
const OFF_AXIS = 2;
const NON_MANIFOLD = 4;
const SAME_WINDING = 8;

/** Source-only candidates, without welding, fitting, filling or deletion.
 * A usable region passes necessary whole-cell area/span bounds; this does not
 * prove any complete cell footprint is covered, nor that photo truth or an
 * assembly has been verified. Downstream geometry/assembly checks decide that.
 * Work is bounded by source faces and their three exact edge associations. */
export function selectAxisRegions(input: AxisRegionInput): AxisRegionResult {
  try {
    const limits = { ...AXIS_REGION_LIMITS, ...input.limits };
    for (const [key, value] of Object.entries(limits))
      if (
        !(key in AXIS_REGION_LIMITS) ||
        !Number.isSafeInteger(value) ||
        value < 1 ||
        value > AXIS_REGION_LIMITS[key as keyof AxisRegionLimits]
      )
        throw Error('invalid_bounded_axis_region_limits');
    const p = input.source.positions;
    const faceCount = p.length / 9;
    if (
      input.source.complete !== true ||
      !Number.isSafeInteger(faceCount) ||
      faceCount < 1
    )
      throw Error('invalid_or_incomplete_original_source');
    if (faceCount > limits.faces)
      return {
        status: 'unresolved',
        scope: 'source-axis-regions-only',
        sourceTruthVerified: false,
        completeEnumeration: false,
        regions: [],
        reasons: ['source_face_limit_exceeded'],
        stats: {
          sourceFaces: faceCount,
          regions: 0,
          usableRegions: 0,
          rejectedRegions: 0,
          unresolvedRegions: 0,
        },
      };
    const axes = new Uint8Array(faceCount);
    const directions = new Int8Array(faceCount);
    const cosines = new Float64Array(faceCount);
    const areas = new Float64Array(faceCount);
    const projectedAreas = new Float64Array(faceCount);
    const issues = new Uint8Array(faceCount);
    const edgeIds = new Uint32Array(faceCount * 3);
    const vertices = new Map<string, number>();
    const edgeIndex = new Map<string, number>();
    const edges: Edge[] = [];
    const parent = Uint32Array.from({ length: faceCount }, (_, id) => id);
    const find = (id: number): number => {
      let root = id;
      while (parent[root] !== root) root = parent[root];
      while (parent[id] !== id) {
        const next = parent[id];
        parent[id] = root;
        id = next;
      }
      return root;
    };
    for (let id = 0; id < faceCount; id++) {
      const points: number[][] = [];
      const vertexIds: number[] = [];
      for (let j = 0; j < 3; j++) {
        const at = id * 9 + j * 3;
        const point = [p[at], p[at + 1], p[at + 2]];
        if (point.some((v) => !Number.isFinite(v)))
          throw Error('non_finite_original_source');
        points.push(point);
        const key = point.join(',');
        let vertexId = vertices.get(key);
        if (vertexId === undefined) {
          vertexId = vertices.size;
          vertices.set(key, vertexId);
        }
        vertexIds.push(vertexId);
      }
      const [a, b, c] = points;
      const e = b.map((v, i) => v - a[i]);
      const f = c.map((v, i) => v - a[i]);
      const normal = [
        e[1] * f[2] - e[2] * f[1],
        e[2] * f[0] - e[0] * f[2],
        e[0] * f[1] - e[1] * f[0],
      ];
      const length = Math.hypot(...normal);
      if (!Number.isFinite(length)) throw Error('non_finite_face_geometry');
      areas[id] = length / 2;
      if (length === 0) {
        axes[id] = 3;
        issues[id] |= DEGENERATE;
      } else {
        let axis: Axis = 0;
        for (const candidate of [1, 2] as const)
          if (Math.abs(normal[candidate]) > Math.abs(normal[axis]))
            axis = candidate;
        axes[id] = axis;
        directions[id] = normal[axis] < 0 ? -1 : 1;
        cosines[id] = Math.abs(normal[axis]) / length;
        projectedAreas[id] = Math.abs(normal[axis]) / 2;
        if (cosines[id] < 0.98) issues[id] |= OFF_AXIS;
      }
      // Every face contributes associations, including off-axis/degenerate
      // faces. A third incident source face cannot be hidden by selection.
      for (let j = 0; j < 3; j++) {
        const from = vertexIds[j];
        const to = vertexIds[(j + 1) % 3];
        const direction: Direction = from < to ? 1 : -1;
        const key = from < to ? `${from},${to}` : `${to},${from}`;
        let edgeId = edgeIndex.get(key);
        if (edgeId === undefined) {
          edgeId = edges.length;
          edgeIndex.set(key, edgeId);
          edges.push({
            count: 1,
            face: id,
            direction,
            otherFace: -1,
            otherDirection: 1,
          });
        } else {
          const edge = edges[edgeId];
          edge.count++;
          if (edge.count === 2) {
            edge.otherFace = id;
            edge.otherDirection = direction;
          }
        }
        edgeIds[id * 3 + j] = edgeId;
      }
    }
    for (const edge of edges) {
      if (edge.count !== 2 || edge.direction === edge.otherDirection) continue;
      const a = edge.face;
      const b = edge.otherFace;
      if (
        issues[a] & (DEGENERATE | OFF_AXIS) ||
        issues[b] & (DEGENERATE | OFF_AXIS) ||
        axes[a] !== axes[b] ||
        directions[a] !== directions[b]
      )
        continue;
      const ra = find(a);
      const rb = find(b);
      parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
    for (let id = 0; id < faceCount; id++)
      for (let j = 0; j < 3; j++) {
        const edge = edges[edgeIds[id * 3 + j]];
        if (edge.count > 2) issues[id] |= NON_MANIFOLD;
        else if (edge.count === 2 && edge.direction === edge.otherDirection)
          issues[id] |= SAME_WINDING;
      }
    const grouped = new Map<number, AxisRegion>();
    for (let id = 0; id < faceCount; id++) {
      const root = find(id);
      let region = grouped.get(root);
      if (!region) {
        const axis = axes[id] === 3 ? null : (axes[id] as Axis);
        const projectedAxes = [0, 1, 2].filter((a) => a !== axis) as [
          Axis,
          Axis,
        ];
        region = {
          sourceFaceIds: [],
          axis,
          direction: axis === null ? null : (directions[id] as Direction),
          area: 0,
          projectedArea: axis === null ? null : 0,
          projectionBounds:
            axis === null
              ? null
              : {
                  axes: projectedAxes,
                  min: [Infinity, Infinity],
                  max: [-Infinity, -Infinity],
                  span: [0, 0],
                  cellSpan: [STEP[projectedAxes[0]], STEP[projectedAxes[1]]],
                  cellArea: STEP[projectedAxes[0]] * STEP[projectedAxes[1]],
                },
          minCos: 1,
          status: 'usable',
          reasons: [],
        };
        grouped.set(root, region);
      }
      region.sourceFaceIds.push(id);
      region.area += areas[id];
      region.minCos = Math.min(region.minCos, cosines[id]);
      if (region.projectedArea !== null)
        region.projectedArea += projectedAreas[id];
      const bounds = region.projectionBounds;
      if (bounds)
        for (let j = 0; j < 3; j++)
          for (let k = 0; k < 2; k++) {
            const value = p[id * 9 + j * 3 + bounds.axes[k]];
            bounds.min[k] = Math.min(bounds.min[k], value);
            bounds.max[k] = Math.max(bounds.max[k], value);
          }
      for (const [flag, reason] of [
        [DEGENERATE, 'degenerate_source_face'],
        [OFF_AXIS, 'source_face_cos_below_0.98'],
        [NON_MANIFOLD, 'non_manifold_source_edge'],
        [SAME_WINDING, 'same_direction_source_edge'],
      ] as const)
        if (issues[id] & flag && !region.reasons.includes(reason))
          region.reasons.push(reason);
    }
    const regions = [...grouped.values()];
    const reasons: string[] = [];
    for (const region of regions) {
      const bounds = region.projectionBounds;
      if (bounds) {
        bounds.span = [
          bounds.max[0] - bounds.min[0],
          bounds.max[1] - bounds.min[1],
        ];
        if (bounds.span.some((v) => !Number.isFinite(v)))
          throw Error('non_finite_region_geometry');
        if (region.projectedArea! < bounds.cellArea)
          region.reasons.push('projected_area_below_cell');
        if (bounds.span.some((v, k) => v < bounds.cellSpan[k]))
          region.reasons.push('projected_span_below_cell');
      }
      if (
        !Number.isFinite(region.area) ||
        (region.projectedArea !== null &&
          !Number.isFinite(region.projectedArea))
      )
        throw Error('non_finite_region_geometry');
      if (region.reasons.length) region.status = 'rejected';
      if (region.sourceFaceIds.length > limits.facesPerRegion) {
        region.status = 'unresolved';
        region.reasons.push('region_face_limit_exceeded');
        if (!reasons.includes('region_face_limit_exceeded'))
          reasons.push('region_face_limit_exceeded');
      }
    }
    const usable = regions.filter((r) => r.status === 'usable');
    if (usable.length > limits.usableRegions) {
      reasons.push('usable_region_limit_exceeded');
      // No arbitrary first-N selection: every candidate remains visible.
      for (const region of usable) {
        region.status = 'unresolved';
        region.reasons.push('usable_region_limit_exceeded');
      }
    }
    return {
      status: reasons.length ? 'unresolved' : 'selected',
      scope: 'source-axis-regions-only',
      sourceTruthVerified: false,
      completeEnumeration: true,
      regions,
      reasons,
      stats: {
        sourceFaces: faceCount,
        regions: regions.length,
        usableRegions: regions.filter((r) => r.status === 'usable').length,
        rejectedRegions: regions.filter((r) => r.status === 'rejected').length,
        unresolvedRegions: regions.filter((r) => r.status === 'unresolved')
          .length,
      },
    };
  } catch (error) {
    return {
      status: 'unavailable',
      reasons: [
        error instanceof Error ? error.message : 'invalid_axis_region_input',
      ],
    };
  }
}
