import type { TriangleMesh } from './mesh-types.ts';
import {
  designRegionPlanes,
  type RegionPlanePatch,
} from './surface-region-design.ts';
import {
  validateSurfaceProjection,
  type SurfaceProjectionValidation,
} from './surface-projection-validation.ts';

export type SurfaceDesign = {
  method: 'connected-mesh-planes';
  patches: Array<{
    axis: 0 | 1 | 2;
    direction: -1 | 1;
    coordinateStuds: number;
    faces: number;
    areaStudsSquared: number;
    normalConsensus: number;
    residualBeforeStuds: number;
    residualAfterStuds: number;
    adjustedVertices: number;
    maxDisplacementStuds: number;
    displacementFraction: number;
  }>;
  adjustedVertices: number;
  regionPlanes?: {
    method: 'connected-inclined-planes';
    patches: RegionPlanePatch[];
    projection: SurfaceProjectionValidation;
  };
  warnings: string[];
};

/** Fit connected, already nearly planar mesh patches before voxelization.
 * Shared vertices move together and patch boundaries stay fixed: windows,
 * stairs, creases and silhouette extrema cannot be bridged or filled here.
 * This is a bounded design approximation, not recovery of hidden geometry. */
export function designMeshSurfaces(mesh: TriangleMesh, resolution: number) {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a], p[i]);
    max[a] = Math.max(max[a], p[i]);
  }
  const scale = resolution / Math.max(...max.map((v, a) => v - min[a]));
  const design: SurfaceDesign = {
    method: 'connected-mesh-planes',
    patches: [],
    adjustedVertices: 0,
    warnings: [
      'Nearly planar patches are a bounded mesh design inference. Unseen topology, intrinsic material, curved-part selection and load strength are not established.',
    ],
  };
  if (!Number.isFinite(scale) || scale <= 0) return { mesh, design };
  type Vertex = { point: number[]; faces: number[]; indices: number[] };
  type Face = {
    vertices: number[];
    axis: 0 | 1 | 2;
    direction: -1 | 1;
    cosine: number;
    area: number;
    depth: number;
  };
  const vertices: Vertex[] = [],
    vertexIds = new Map<string, number>(),
    faces: Face[] = [];
  for (let i = 0; i < p.length; i += 9) {
    const ids: number[] = [];
    for (let j = 0; j < 3; j++) {
      const at = i + j * 3;
      // GLB positions are non-indexed here. Restore only exact shared vertices;
      // proximity welding could connect distinct sides of a thin gap.
      const key = `${p[at]},${p[at + 1]},${p[at + 2]}`;
      let id = vertexIds.get(key);
      if (id === undefined) {
        id = vertices.length;
        vertexIds.set(key, id);
        vertices.push({
          point: [p[at], p[at + 1], p[at + 2]].map(
            (v, a) => (v - min[a]) * scale,
          ),
          faces: [],
          indices: [],
        });
      }
      vertices[id].faces.push(i / 9);
      vertices[id].indices.push(at);
      ids.push(id);
    }
    const [a, b, c] = ids.map((id) => vertices[id].point);
    const ab = b.map((v, i) => v - a[i]),
      ac = c.map((v, i) => v - a[i]);
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const size = Math.hypot(...normal);
    const axis = normal
      .map(Math.abs)
      .indexOf(Math.max(...normal.map(Math.abs))) as 0 | 1 | 2;
    faces.push({
      vertices: ids,
      axis,
      direction: normal[axis] >= 0 ? 1 : -1,
      cosine: size ? Math.abs(normal[axis]) / size : 0,
      area: size / 2,
      depth: (a[axis] + b[axis] + c[axis]) / 3,
    });
  }
  const edges = new Map<string, number[]>();
  for (let f = 0; f < faces.length; f++) {
    const v = faces[f].vertices;
    for (const [a, b] of [
      [v[0], v[1]],
      [v[1], v[2]],
      [v[2], v[0]],
    ]) {
      const key = `${Math.min(a, b)},${Math.max(a, b)}`;
      const adjacent = edges.get(key);
      if (adjacent) adjacent.push(f);
      else edges.set(key, [f]);
    }
  }
  const neighbours = Array.from({ length: faces.length }, () => [] as number[]);
  // Non-manifold edges are not trusted as plane continuation.
  for (const adjacent of edges.values())
    if (adjacent.length === 2) {
      neighbours[adjacent[0]].push(adjacent[1]);
      neighbours[adjacent[1]].push(adjacent[0]);
    }
  const processed = new Uint8Array(faces.length),
    out = new Float32Array(p);
  for (let seed = 0; seed < faces.length; seed++) {
    const initial = faces[seed];
    if (processed[seed] || initial.cosine < 0.96 || !initial.area) continue;
    const queue = [seed];
    processed[seed] = 1;
    for (let h = 0; h < queue.length; h++)
      for (const f of neighbours[queue[h]]) {
        const face = faces[f];
        if (
          processed[f] ||
          face.axis !== initial.axis ||
          face.direction !== initial.direction ||
          face.cosine < 0.96 ||
          Math.abs(face.depth - initial.depth) > 0.25
        )
          continue;
        processed[f] = 1;
        queue.push(f);
      }
    if (queue.length < 4) continue;
    const area = queue.reduce((sum, f) => sum + faces[f].area, 0);
    const coordinate =
      queue.reduce((sum, f) => sum + faces[f].area * faces[f].depth, 0) / area;
    const cosine =
      queue.reduce((sum, f) => sum + faces[f].area * faces[f].cosine, 0) / area;
    const ids = new Set(queue.flatMap((f) => faces[f].vertices));
    const span = [0, 1, 2]
      .filter((a) => a !== initial.axis)
      .map((a) => {
        let lo = Infinity,
          hi = -Infinity;
        for (const id of ids) {
          lo = Math.min(lo, vertices[id].point[a]);
          hi = Math.max(hi, vertices[id].point[a]);
        }
        return hi - lo;
      });
    const residual = (positions: Float32Array) =>
      Math.sqrt(
        queue.reduce(
          (sum, f) =>
            sum +
            (faces[f].area *
              faces[f].vertices.reduce(
                (s, v) =>
                  s +
                  ((positions[vertices[v].indices[0] + initial.axis] -
                    min[initial.axis]) *
                    scale -
                    coordinate) **
                    2,
                0,
              )) /
              3,
          0,
        ) / area,
      );
    const before = residual(p);
    if (
      area < 16 ||
      span.some((s) => s < 4) ||
      cosine < 0.99 ||
      before > 0.1 ||
      before < 0.005
    )
      continue;
    const region = new Set(queue),
      changes: Array<[number, number]> = [];
    for (const id of ids) {
      const vertex = vertices[id],
        depth = vertex.point[initial.axis];
      // Retain creases, holes, silhouette extents and patch-to-patch boundaries.
      if (
        vertex.faces.some((f) => !region.has(f)) ||
        depth < 1e-5 ||
        depth > (max[initial.axis] - min[initial.axis]) * scale - 1e-5
      )
        continue;
      const displacement = Math.abs(depth - coordinate);
      if (displacement < 1e-5 || displacement > 0.25) continue;
      for (const index of vertex.indices)
        changes.push([index + initial.axis, out[index + initial.axis]]);
      for (const index of vertex.indices)
        out[index + initial.axis] = coordinate / scale + min[initial.axis];
    }
    if (!changes.length) continue;
    // Keep both projected winding and the source outward orientation. Merely
    // checking the dominant normal component misses tiny boundary triangles
    // that turn more than 90 degrees after an interior vertex is displaced.
    const normalAt = (positions: Float32Array, f: number) => {
      const [a, b, c] = faces[f].vertices.map((v) => vertices[v].indices[0]);
      const ab = [0, 1, 2].map((k) => positions[b + k] - positions[a + k]),
        ac = [0, 1, 2].map((k) => positions[c + k] - positions[a + k]);
      return [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ];
    };
    const unsafeFaces = () =>
      queue.some((f) => {
        const normal = normalAt(out, f),
          oldNormal = normalAt(p, f);
        const dot = normal.reduce((sum, v, a) => sum + v * oldNormal[a], 0);
        return (
          normal[initial.axis] * initial.direction <= 0 ||
          dot < 0.5 * Math.hypot(...normal) * Math.hypot(...oldNormal)
        );
      });
    const targets = changes.map(([index]) => out[index]);
    let displacementFraction = 1,
      unsafe = unsafeFaces();
    while (unsafe && displacementFraction > 1 / 64) {
      displacementFraction /= 2;
      for (let i = 0; i < changes.length; i++) {
        const [index, value] = changes[i];
        out[index] = value + (targets[i] - value) * displacementFraction;
      }
      unsafe = unsafeFaces();
    }
    if (unsafe) {
      for (const [index, value] of changes) out[index] = value;
      continue;
    }
    const adjustedVertices = Array.from(ids).filter((id) => {
      const at = vertices[id].indices[0] + initial.axis;
      return out[at] !== p[at];
    }).length;
    const maxDisplacement = changes.reduce(
      (max, [index, old]) => Math.max(max, Math.abs(out[index] - old) * scale),
      0,
    );
    design.adjustedVertices += adjustedVertices;
    design.patches.push({
      axis: initial.axis,
      direction: initial.direction,
      coordinateStuds: coordinate,
      faces: queue.length,
      areaStudsSquared: area,
      normalConsensus: cosine,
      residualBeforeStuds: before,
      residualAfterStuds: residual(out),
      adjustedVertices,
      maxDisplacementStuds: maxDisplacement,
      displacementFraction,
    });
  }
  const axisMesh = design.patches.length ? { ...mesh, positions: out } : mesh;
  // Photograph-derived candidates use the unchanged input camera and paint.
  // Imports without source observations retain their existing geometry design.
  if (mesh.sourceObservations) {
    const inclined = designRegionPlanes(axisMesh, resolution);
    if (inclined.patches.length) {
      const projection = validateSurfaceProjection(
        axisMesh,
        inclined.mesh,
        mesh.sourceObservations,
      );
      if (projection.passed) {
        design.regionPlanes = {
          method: 'connected-inclined-planes',
          patches: inclined.patches,
          projection,
        };
        const moved = new Set<string>();
        for (let i = 0; i < p.length; i += 3)
          if (
            [0, 1, 2].some((a) => p[i + a] !== inclined.mesh.positions[i + a])
          )
            moved.add(`${p[i]},${p[i + 1]},${p[i + 2]}`);
        design.adjustedVertices = moved.size;
        return { mesh: inclined.mesh, design };
      }
    }
  }
  return { mesh: axisMesh, design };
}
