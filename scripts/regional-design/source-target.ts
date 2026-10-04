import type { Brick } from '../../lib/brick-engine.ts';
import type { TriangleMesh } from '../../lib/mesh-types.ts';
import {
  classifySurfaceOwnership,
  type MeshSurfaceOwnership,
} from '../../lib/mesh-surface-ownership.ts';
import { collectSourceDepth } from './source-depth.ts';
import { buildOwnedDepthQueries } from './owned-depth-queries.ts';

type Point = [number, number, number];
type Box = { min: Point; max: Point; reason: string };
type Edge = {
  a: number;
  b: number;
  selected: { face: number; from: number; to: number }[];
  allFaces: Set<number>;
};
export type RegionalBoundary = {
  vertices: Point[];
  kind: 'outer' | 'hole' | 'unclassified';
  interfaceSourceFaceIds: number[];
};
export type RegionalComponent = {
  sourceFaceIds: number[];
  areaStudsSquared: number;
  normal: Point;
  normalConsensus: number;
  kind: 'plane' | 'compound';
  boundaries: RegionalBoundary[];
};

const cross = (a: Point, b: Point): Point => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Point, b: Point): Point => a.map((n, i) => n - b[i]) as Point;
const dot = (a: Point, b: Point) => a.reduce((n, v, i) => n + v * b[i], 0);
const pointKey = (p: Point) => p.join(',');
const edgeKey = (a: number, b: number) => `${Math.min(a, b)},${Math.max(a, b)}`;

/** Exact selected-source topology. No distance welding, convex hull or inferred
 * closure. Actual volume ownership and original geometry remain separate. */
function sourceTopology(mesh: TriangleMesh, selectedIds: readonly number[]) {
  const p = mesh.positions;
  const selected = new Set(selectedIds);
  const vertices: Point[] = [],
    ids = new Map<string, number>();
  const edges = new Map<string, Edge>();
  const faceVertices = new Map<number, number[]>();
  const point = (f: number, j: number) =>
    Array.from(p.subarray(f * 9 + j * 3, f * 9 + j * 3 + 3)) as Point;
  for (const f of selectedIds) {
    const vs = [0, 1, 2].map((j) => {
      const v = point(f, j),
        key = pointKey(v);
      let id = ids.get(key);
      if (id === undefined) {
        id = vertices.length;
        ids.set(key, id);
        vertices.push(v);
      }
      return id;
    });
    faceVertices.set(f, vs);
    for (let j = 0; j < 3; j++) {
      const a = vs[j],
        b = vs[(j + 1) % 3],
        key = edgeKey(a, b);
      let e = edges.get(key);
      if (!e) {
        e = { a, b, selected: [], allFaces: new Set() };
        edges.set(key, e);
      }
      e.selected.push({ face: f, from: a, to: b });
      e.allFaces.add(f);
    }
  }
  // Outside incidence is necessary: selecting two of three faces cannot turn
  // a non-manifold source edge into an apparently safe shared edge.
  for (let f = 0; f < p.length / 9; f++) {
    if (selected.has(f)) continue;
    const vs = [0, 1, 2].map((j) => ids.get(pointKey(point(f, j))));
    for (let j = 0; j < 3; j++) {
      const a = vs[j],
        b = vs[(j + 1) % 3];
      if (a !== undefined && b !== undefined)
        edges.get(edgeKey(a, b))?.allFaces.add(f);
    }
  }
  return { vertices, edges, faceVertices };
}

function contains(point: number[], polygon: number[][]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    const turn =
      (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
    if (
      Math.abs(turn) < 1e-10 &&
      point.every(
        (v, k) =>
          v >= Math.min(a[k], b[k]) - 1e-10 &&
          v <= Math.max(a[k], b[k]) + 1e-10,
      )
    )
      return 'boundary';
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < a[0] + ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1])
    )
      inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function validateBoundaryLoops(
  regions: RegionalComponent[],
  frame: MeshSurfaceOwnership['normalization'],
) {
  const warnings = new Set<string>();
  const physical = (point: Point): Point => [
    point[0],
    point[1] * frame.plateHeight,
    point[2],
  ];
  const project = (boundary: RegionalBoundary, axis: number) =>
    boundary.vertices.map((point) =>
      physical(point).filter((_, a) => a !== axis),
    );
  const dominantAxis = (normal: Point) =>
    normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
  let segmentTests = 0;
  const intersects = (a: number[], b: number[], c: number[], d: number[]) => {
    if (++segmentTests > 200000)
      throw Error('source-boundary-workload-unavailable');
    const turn = (a: number[], b: number[], c: number[]) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const on = (a: number[], b: number[], point: number[]) =>
      Math.abs(turn(a, b, point)) <= 1e-10 &&
      point.every(
        (v, axis) =>
          v >= Math.min(a[axis], b[axis]) - 1e-10 &&
          v <= Math.max(a[axis], b[axis]) + 1e-10,
      );
    const abC = turn(a, b, c),
      abD = turn(a, b, d),
      cdA = turn(c, d, a),
      cdB = turn(c, d, b);
    return (
      (((abC > 1e-10 && abD < -1e-10) || (abC < -1e-10 && abD > 1e-10)) &&
        ((cdA > 1e-10 && cdB < -1e-10) || (cdA < -1e-10 && cdB > 1e-10))) ||
      on(a, b, c) ||
      on(a, b, d) ||
      on(c, d, a) ||
      on(c, d, b)
    );
  };
  const loopsIntersect = (a: number[][], b: number[][]) => {
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++)
        if (
          intersects(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])
        )
          return true;
    return false;
  };
  const invalidate = (component: RegionalComponent) => {
    for (const boundary of component.boundaries) boundary.kind = 'unclassified';
  };
  try {
    for (const component of regions) {
      if (component.kind !== 'plane') {
        // Compound loops remain exact 3D topology, without planar hole claims.
        continue;
      }
      const loops = component.boundaries.map((boundary) =>
        project(boundary, dominantAxis(component.normal)),
      );
      let invalid = false;
      for (const loop of loops) {
        for (let i = 0; i < loop.length; i++)
          for (let j = i + 1; j < loop.length; j++) {
            if (j === i + 1 || (i === 0 && j === loop.length - 1)) continue;
            if (
              intersects(
                loop[i],
                loop[(i + 1) % loop.length],
                loop[j],
                loop[(j + 1) % loop.length],
              )
            ) {
              warnings.add('self-intersecting-source-boundary');
              invalid = true;
            }
          }
      }
      for (let i = 0; i < loops.length; i++)
        for (let j = i + 1; j < loops.length; j++)
          if (loopsIntersect(loops[i], loops[j])) {
            warnings.add('intersecting-source-boundary-loops');
            invalid = true;
          }
      if (invalid) invalidate(component);
    }
    for (let i = 0; i < regions.length; i++)
      for (let j = i + 1; j < regions.length; j++) {
        const a = regions[i],
          b = regions[j];
        if (
          a.kind !== 'plane' ||
          b.kind !== 'plane' ||
          !a.boundaries.length ||
          !b.boundaries.length
        )
          continue;
        const origin = physical(a.boundaries[0].vertices[0]);
        if (
          Math.abs(dot(a.normal, b.normal)) < 1 - 1e-8 ||
          ![...a.boundaries, ...b.boundaries].every((boundary) =>
            boundary.vertices.every(
              (point) =>
                Math.abs(dot(sub(physical(point), origin), a.normal)) <= 1e-8,
            ),
          )
        )
          continue;
        const axis = dominantAxis(a.normal),
          aLoops = a.boundaries.map((boundary) => project(boundary, axis)),
          bLoops = b.boundaries.map((boundary) => project(boundary, axis));
        const insideSurface = (point: number[], loops: number[][][]) =>
          loops.filter((loop) => contains(point, loop) === 'inside').length %
            2 ===
          1;
        const overlap =
          aLoops.some((aLoop) =>
            bLoops.some((bLoop) => loopsIntersect(aLoop, bLoop)),
          ) ||
          a.boundaries.some(
            (boundary, index) =>
              boundary.kind === 'outer' &&
              insideSurface(aLoops[index][0], bLoops),
          ) ||
          b.boundaries.some(
            (boundary, index) =>
              boundary.kind === 'outer' &&
              insideSurface(bLoops[index][0], aLoops),
          );
        if (overlap) {
          warnings.add('overlapping-coplanar-source-components');
          invalidate(a);
          invalidate(b);
        }
      }
  } catch {
    warnings.add('source-boundary-workload-unavailable');
    for (const component of regions) invalidate(component);
  }
  return [...warnings];
}

function components(
  mesh: TriangleMesh,
  sourceIds: readonly number[],
  frame: MeshSurfaceOwnership['normalization'],
) {
  const t = sourceTopology(mesh, sourceIds),
    warnings: string[] = [];
  const links = new Map(sourceIds.map((f) => [f, new Set<number>()]));
  for (const e of t.edges.values()) {
    if (e.a === e.b || e.allFaces.size > 2 || e.selected.length > 2)
      warnings.push('degenerate-or-non-manifold-source-edge');
    if (e.selected.length === 2) {
      const [a, b] = e.selected;
      if (a.from === b.from) warnings.push('inconsistent-source-winding');
      links.get(a.face)!.add(b.face);
      links.get(b.face)!.add(a.face);
    }
  }
  const grid = (v: Point): Point =>
    v.map(
      (n, a) =>
        ((n - frame.min[a]) * frame.scale) / (a === 1 ? frame.plateHeight : 1) +
        frame.gridOffset[a],
    ) as Point;
  const physical = (v: Point): Point => {
    const q = grid(v);
    q[1] *= frame.plateHeight;
    return q;
  };
  const seen = new Set<number>(),
    result: RegionalComponent[] = [];
  for (const seed of sourceIds) {
    if (seen.has(seed)) continue;
    const queue = [seed],
      fs: number[] = [];
    while (queue.length) {
      const f = queue.pop()!;
      if (seen.has(f)) continue;
      seen.add(f);
      fs.push(f);
      queue.push(...links.get(f)!);
    }
    fs.sort((a, b) => a - b);
    const set = new Set(fs),
      sum: Point = [0, 0, 0];
    let area2 = 0;
    for (const f of fs) {
      const vs = t.faceVertices.get(f)!.map((id) => physical(t.vertices[id]));
      const n = cross(sub(vs[1], vs[0]), sub(vs[2], vs[0]));
      area2 += Math.hypot(...n);
      for (let a = 0; a < 3; a++) sum[a] += n[a];
    }
    const norm = Math.hypot(...sum),
      normal = sum.map((v) => (norm ? v / norm : 0)) as Point;
    const origin = physical(t.vertices[t.faceVertices.get(seed)![0]]);
    const residual = Math.max(
      ...fs.flatMap((f) =>
        t.faceVertices
          .get(f)!
          .map((id) =>
            Math.abs(dot(sub(physical(t.vertices[id]), origin), normal)),
          ),
      ),
    );
    const planar = area2 > 0 && norm / area2 >= 0.995 && residual <= 0.05;
    if (!area2) warnings.push('zero-area-source-component');
    const boundaryEdges = [...t.edges.values()].filter(
      (e) => e.selected.length === 1 && set.has(e.selected[0].face),
    );
    const outgoing = new Map<number, Edge[]>(),
      incoming = new Map<number, Edge[]>();
    for (const e of boundaryEdges) {
      const { from, to } = e.selected[0];
      outgoing.set(from, [...(outgoing.get(from) ?? []), e]);
      incoming.set(to, [...(incoming.get(to) ?? []), e]);
    }
    const branch = [...new Set([...outgoing.keys(), ...incoming.keys()])].some(
      (v) => outgoing.get(v)?.length !== 1 || incoming.get(v)?.length !== 1,
    );
    const boundaries: RegionalBoundary[] = [];
    if (branch) warnings.push('open-or-branching-source-boundary');
    else {
      const used = new Set<Edge>();
      for (const first of boundaryEdges) {
        if (used.has(first)) continue;
        const points: Point[] = [],
          outside = new Set<number>();
        let current = first;
        do {
          used.add(current);
          points.push(grid(t.vertices[current.selected[0].from]));
          for (const f of current.allFaces) if (!set.has(f)) outside.add(f);
          current = outgoing.get(current.selected[0].to)![0];
        } while (!used.has(current));
        if (current !== first || points.length < 3)
          warnings.push('invalid-source-boundary-cycle');
        else
          boundaries.push({
            vertices: points,
            kind: 'unclassified',
            interfaceSourceFaceIds: [...outside].sort((a, b) => a - b),
          });
      }
      if (planar) {
        const axis = normal
          .map(Math.abs)
          .indexOf(Math.max(...normal.map(Math.abs)));
        const axes = [0, 1, 2].filter((a) => a !== axis);
        const polygons = boundaries.map((b) =>
          b.vertices.map((v) =>
            axes.map((a) => v[a] * (a === 1 ? frame.plateHeight : 1)),
          ),
        );
        for (let i = 0; i < boundaries.length; i++) {
          const relations = polygons.map((poly, j) =>
            j === i ? 'outside' : contains(polygons[i][0], poly),
          );
          if (relations.includes('boundary'))
            warnings.push('touching-source-boundary-loops');
          else
            boundaries[i].kind =
              relations.filter((r) => r === 'inside').length % 2
                ? 'hole'
                : 'outer';
        }
      }
    }
    result.push({
      sourceFaceIds: fs,
      areaStudsSquared: area2 / 2,
      normal,
      normalConsensus: area2 ? norm / area2 : 0,
      kind: planar ? 'plane' : 'compound',
      boundaries,
    });
  }
  warnings.push(...validateBoundaryLoops(result, frame));
  return { components: result, warnings: [...new Set(warnings)] };
}

/** Offline proposal only. Ownership is a necessary constraint, never evidence
 * that an ornament is noise, a colour is material, or a layout is buildable. */
export function proposeRegionalTarget(input: {
  sourceMesh: TriangleMesh;
  ownership: MeshSurfaceOwnership;
  regionId: string;
  baselineParts?: readonly Brick[];
  preserveCells?: ReadonlySet<string>;
  exclusions?: readonly Box[];
  depthAxis?: 0 | 1 | 2;
}) {
  const { ownership: ledger, sourceMesh, regionId } = input;
  const region = ledger.regions.find((r) => r.regionId === regionId);
  if (!region) throw Error('Unknown source-owned region.');
  if (
    sourceMesh.positions.length !== ledger.sourceMesh.positions.length ||
    sourceMesh.colors.length !== ledger.sourceMesh.colors.length ||
    !sourceMesh.positions.every(
      (v, i) => Number.isFinite(v) && v === ledger.sourceMesh.positions[i],
    ) ||
    !sourceMesh.colors.every((v, i) => v === ledger.sourceMesh.colors[i])
  )
    throw Error('Source geometry does not match the captured face stream.');
  const graph = sourceMesh.sourceObservations;
  if (
    graph &&
    (graph.sourcePositions.length !== sourceMesh.positions.length ||
      graph.sourcePositions.some((v, i) => v !== sourceMesh.positions[i]))
  )
    throw Error('Original observations do not match source geometry.');
  const exclusions = input.exclusions ?? [];
  for (const b of exclusions)
    if (
      ![...b.min, ...b.max].every(Number.isFinite) ||
      b.min.some((v, i) => v >= b.max[i])
    )
      throw Error('Invalid protected region.');
  const topology = components(
    sourceMesh,
    region.sourceFaceIds,
    ledger.normalization,
  );
  const editableShell: string[] = [],
    lockedShell: { key: string; reasons: string[] }[] = [];
  const lockedParts: { id: number; reason: string }[] = [];
  const touches = (b: Brick, q: number[]) =>
    q.every(
      (v, i) =>
        v + 1 > [b.x, b.y, b.z][i] && v < [b.x + b.w, b.y + b.h, b.z + b.d][i],
    );
  const structural = (input.baselineParts ?? []).filter(
    (b) =>
      b.construction ||
      b.support ||
      b.installation ||
      b.section?.startsWith('component-'),
  );
  const selectedSet = new Set(region.sourceFaceIds);
  const gridSamples: {
    index: number;
    faceId: number;
    pixel: number[];
    rawRGB: number[];
    rawRegionId: number;
    observed: boolean;
  }[] = [];
  if (graph)
    for (let i = 0; i < graph.projection.pixelFaces.length; i++) {
      const f = graph.projection.pixelFaces[i];
      if (selectedSet.has(f))
        gridSamples.push({
          index: i,
          faceId: f,
          pixel: Array.from(
            graph.projection.sourcePixelXY.subarray(i * 2, i * 2 + 2),
          ),
          rawRGB: Array.from(
            graph.projection.rawRGB.subarray(i * 3, i * 3 + 3),
          ),
          rawRegionId: graph.projection.rawRegionIds[i],
          observed: !!graph.projection.observed[i],
        });
    }
  const centroidSamples: {
    index: number;
    faceId: number;
    projectedXY: number[];
    pixel: number[];
    rawRGB: number[];
    rawRegionId: number;
    frontFaceId: number;
    depths: number[];
  }[] = [];
  if (graph)
    for (let i = 0; i < graph.projection.centroids.faces.length; i++) {
      const c = graph.projection.centroids,
        f = c.faces[i];
      if (selectedSet.has(f))
        centroidSamples.push({
          index: i,
          faceId: f,
          projectedXY: Array.from(c.projectedXY.subarray(i * 2, i * 2 + 2)),
          pixel: Array.from(c.sourcePixelXY.subarray(i * 2, i * 2 + 2)),
          rawRGB: Array.from(c.rawRGB.subarray(i * 3, i * 3 + 3)),
          rawRegionId: c.rawRegionIds[i],
          frontFaceId: c.frontFaces[i],
          depths: Array.from(c.depths.subarray(i * 2, i * 2 + 2)),
        });
    }
  const footprint = [...ledger.cells]
    .filter(
      ([, c]) =>
        c.selectedFaceIds.some((f) => selectedSet.has(f)) ||
        c.selectedShellOnlyFaceIds.some((f) => selectedSet.has(f)),
    )
    .map(([key]) => key)
    .sort();
  for (const key of footprint) {
    const q = key.split(',').map(Number),
      reasons: string[] = [];
    if (classifySurfaceOwnership(ledger, key, regionId) !== 'editable')
      reasons.push('mixed-or-edge-only-source-ownership');
    if (input.preserveCells?.has(key))
      reasons.push('preserved-source-or-mounting-cell');
    for (const box of exclusions)
      if (q.every((v, a) => v + 1 > box.min[a] && v < box.max[a]))
        reasons.push(box.reason);
    for (const b of structural)
      if (touches(b, q)) {
        reasons.push('locked-construction-or-component');
      }
    if (reasons.length)
      lockedShell.push({ key, reasons: [...new Set(reasons)] });
    else editableShell.push(key);
  }
  // A deliberate bridge may have no source-face overlap at all. Keep the
  // complete structural list, including bearing paths outside the face band.
  for (const b of structural)
    lockedParts.push({
      id: b.id,
      reason: b.construction
        ? `opening:${b.construction.openingId}:${b.construction.role}`
        : b.support
          ? 'support-bearing-path'
          : 'semantic-component',
    });
  const normal = topology.components.reduce<Point>(
    (s, c) =>
      s.map((v, a) => v + Math.abs(c.normal[a]) * c.areaStudsSquared) as Point,
    [0, 0, 0],
  );
  const axis =
    input.depthAxis ?? (normal.indexOf(Math.max(...normal)) as 0 | 1 | 2);
  const columnAxes = [0, 1, 2].filter((a) => a !== axis);
  const columns = [
    ...new Map(
      footprint.map((key) => {
        const q = key.split(',').map(Number);
        const c: [number, number] = [q[columnAxes[0]], q[columnAxes[1]]];
        return [c.join(','), c] as const;
      }),
    ).values(),
  ];
  const depth = collectSourceDepth({
    source: sourceMesh,
    normalization: ledger.normalization,
    axis,
    columns,
    selectedSourceFaceIds: region.sourceFaceIds,
  });
  const warnings = [...topology.warnings];
  const depthCellTolerance = 1e-8;
  // Center-column diagnostics remain available, but a small area fragment is
  // not required to cover the column center. Sample the actual original face
  // fragment; every contributor retains its own cell/depth association.
  const queryPlan = buildOwnedDepthQueries({
    ownership: ledger,
    regionId,
    editableCellKeys: editableShell,
    axis,
  });
  const queryByPoint = new Map<string, number>();
  const samples: { column: [number, number]; samplePoint: [number, number] }[] =
    [];
  const queryIndices = queryPlan.queries.map((query) => {
    const key = query.samplePoint.join(',');
    let index = queryByPoint.get(key);
    if (index === undefined) {
      index = samples.length;
      queryByPoint.set(key, index);
      samples.push({ column: query.column, samplePoint: query.samplePoint });
    }
    return index;
  });
  const ownedDepth = samples.length
    ? collectSourceDepth({
        source: sourceMesh,
        normalization: ledger.normalization,
        axis,
        columns: samples.map((s) => s.column),
        samplePoints: samples.map((s) => s.samplePoint),
        selectedSourceFaceIds: region.sourceFaceIds,
      })
    : undefined;
  if (
    queryPlan.status === 'unavailable' ||
    (samples.length && ownedDepth?.status !== 'collected')
  )
    warnings.push('owned-source-depth-unavailable');
  if (queryPlan.unresolvedCells.length)
    warnings.push('editable-source-cell-without-corresponding-depth-crossing');
  if (ownedDepth?.status === 'collected') {
    for (let i = 0; i < queryPlan.queries.length; i++) {
      const query = queryPlan.queries[i],
        column = ownedDepth.columns[queryIndices[i]];
      const cell = query.cellKey.split(',').map(Number);
      if (column.ambiguous) warnings.push('ambiguous-source-depth-crossings');
      if (
        !column.crossings.some(
          (crossing) =>
            crossing.faceIds.includes(query.sourceFaceId) &&
            Math.abs(crossing.depth - query.surfaceDepth) <=
              depthCellTolerance &&
            crossing.depth >= cell[axis] - depthCellTolerance &&
            crossing.depth <= cell[axis] + 1 + depthCellTolerance,
        )
      )
        warnings.push(
          'editable-source-cell-without-corresponding-depth-crossing',
        );
    }
  }
  if (!editableShell.length) warnings.push('no-sole-owned-editable-shell');
  return {
    version: 1 as const,
    status: warnings.length
      ? ('unresolved' as const)
      : ('ready-for-layout' as const),
    regionId,
    sourceFaceIds: [...region.sourceFaceIds],
    source: {
      positions: sourceMesh.positions.slice(),
      colors: sourceMesh.colors.slice(),
      observationsPresent: !!sourceMesh.sourceObservations,
    },
    voxelSource: {
      positions: ledger.mesh.positions.slice(),
      colors: ledger.mesh.colors.slice(),
    },
    observations: graph
      ? {
          camera: structuredClone(graph.camera),
          alignment: structuredClone(graph.alignment),
          rasterSize: [graph.raster.width, graph.raster.height],
          gridSamples,
          centroidSamples,
          internalCorrespondenceVerified: false,
        }
      : undefined,
    frame: structuredClone(ledger.normalization),
    components: topology.components,
    depth,
    ownedDepth: { queryPlan, queryIndices, rays: ownedDepth },
    depthCorrespondence: {
      method: 'owned-original-fragment-centroid-ray-in-closed-cell' as const,
      toleranceGridUnits: depthCellTolerance,
      surfaceDesignDisplacementAllowanceGridUnits: 0,
      scope: 'sampled-face-fragments-not-whole-cell-solid' as const,
    },
    boundaryScope:
      'validated-plane-loops-and-unclassified-3d-compound-loops' as const,
    editableShell,
    lockedShell,
    lockedParts,
    protectionScope: 'provided-upright-nominal-grid-bounds' as const,
    permissions: {
      commit: false,
      materialIdentityVerified: false,
      physicalBuildVerified: false,
    },
    warnings: [...new Set(warnings)],
  };
}
