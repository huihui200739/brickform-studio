import type { TriangleMesh } from './mesh-types.ts';
import { validateSurfaceClearance } from './surface-clearance.ts';

type Vec = [number, number, number];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

// Jacobi diagonalization of a real symmetric covariance matrix. The smallest
// eigenvector is the least-squares plane normal, independent of world axes.
function planeNormal(covariance: number[][], outward: Vec): Vec {
  const a = covariance.map((row) => [...row]);
  const eigenvectors = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let iteration = 0; iteration < 24; iteration++) {
    let p = 0,
      q = 1;
    for (const [i, j] of [
      [0, 2],
      [1, 2],
    ])
      if (Math.abs(a[i][j]) > Math.abs(a[p][q])) {
        p = i;
        q = j;
      }
    if (Math.abs(a[p][q]) < 1e-12) break;
    const angle = Math.atan2(2 * a[p][q], a[q][q] - a[p][p]) / 2;
    const c = Math.cos(angle),
      s = Math.sin(angle);
    const pp = c * c * a[p][p] - 2 * s * c * a[p][q] + s * s * a[q][q];
    const qq = s * s * a[p][p] + 2 * s * c * a[p][q] + c * c * a[q][q];
    for (let k = 0; k < 3; k++) {
      if (k !== p && k !== q) {
        const kp = c * a[k][p] - s * a[k][q],
          kq = s * a[k][p] + c * a[k][q];
        a[k][p] = a[p][k] = kp;
        a[k][q] = a[q][k] = kq;
      }
      const ep = c * eigenvectors[k][p] - s * eigenvectors[k][q];
      eigenvectors[k][q] = s * eigenvectors[k][p] + c * eigenvectors[k][q];
      eigenvectors[k][p] = ep;
    }
    a[p][p] = pp;
    a[q][q] = qq;
    a[p][q] = a[q][p] = 0;
  }
  const id = [0, 1, 2].reduce((i, j) => (a[j][j] < a[i][i] ? j : i));
  const n = eigenvectors.map((row) => row[id]) as Vec;
  return n.map((v) => v * (dot(n, outward) < 0 ? -1 : 1)) as Vec;
}

export type RegionPlanePatch = {
  sourceFaceIds: number[];
  normal: Vec;
  centerStuds: Vec;
  areaStudsSquared: number;
  residualBeforeStuds: number;
  residualAfterStuds: number;
  maxDisplacementStuds: number;
  adjustedVertices: number;
  displacementFraction: number;
  normalConsensus: number;
  curvatureExplainedFraction: number;
  limitedVertices: number;
  residualNeighbourCoherence: number;
};

function solve(matrix: number[][], values: number[]) {
  const a = matrix.map((row, i) => [...row, values[i]]);
  for (let col = 0; col < values.length; col++) {
    let pivot = col;
    for (let row = col + 1; row < a.length; row++)
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (Math.abs(a[pivot][col]) < 1e-10) return undefined;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let i = col; i <= values.length; i++) a[col][i] /= divisor;
    for (let row = 0; row < a.length; row++)
      if (row !== col) {
        const factor = a[row][col];
        for (let i = col; i <= values.length; i++)
          a[row][i] -= factor * a[col][i];
      }
  }
  return a.map((row) => row[values.length]);
}

/** A separate candidate for broad inclined planes. Paint is never a boundary
 * test or a fitting weight. Exact shared edges and unchanged boundary vertices
 * preserve holes, creases and distinct sides of a thin surface. */
export function designRegionPlanes(mesh: TriangleMesh, resolution: number) {
  const p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  const scale = resolution / Math.max(...hi.map((v, a) => v - lo[a]));
  const patches: RegionPlanePatch[] = [];
  if (!Number.isFinite(scale) || scale <= 0) return { mesh, patches };
  const vertices: { point: Vec; copies: number[]; faces: number[] }[] = [];
  const vertexIds = new Map<string, number>();
  const faces: {
    vertices: number[];
    normal: Vec;
    center: Vec;
    area: number;
  }[] = [];
  const edges = new Map<string, number[]>();
  for (let i = 0; i < p.length; i += 9) {
    const ids: number[] = [];
    for (let j = 0; j < 3; j++) {
      const at = i + j * 3;
      const key = `${p[at]},${p[at + 1]},${p[at + 2]}`;
      let id = vertexIds.get(key);
      if (id === undefined) {
        id = vertices.length;
        vertexIds.set(key, id);
        vertices.push({
          point: [0, 1, 2].map((a) => (p[at + a] - lo[a]) * scale) as Vec,
          copies: [],
          faces: [],
        });
      }
      vertices[id].copies.push(at);
      vertices[id].faces.push(i / 9);
      ids.push(id);
    }
    const [a, b, c] = ids.map((id) => vertices[id].point);
    const n = cross(sub(b, a), sub(c, a)),
      size = Math.hypot(...n);
    faces.push({
      vertices: ids,
      normal: n.map((v) => (size ? v / size : 0)) as Vec,
      center: a.map((v, k) => (v + b[k] + c[k]) / 3) as Vec,
      area: size / 2,
    });
    for (let j = 0; j < 3; j++) {
      const u = ids[j],
        v = ids[(j + 1) % 3],
        key = `${Math.min(u, v)},${Math.max(u, v)}`;
      const adjacent = edges.get(key);
      if (adjacent) adjacent.push(i / 9);
      else edges.set(key, [i / 9]);
    }
  }
  const neighbours = Array.from({ length: faces.length }, () => [] as number[]);
  const boundary = new Set<number>();
  for (const [key, fs] of edges)
    if (fs.length !== 2)
      for (const id of key.split(',').map(Number)) boundary.add(id);
  for (const fs of edges.values())
    if (fs.length === 2) {
      neighbours[fs[0]].push(fs[1]);
      neighbours[fs[1]].push(fs[0]);
    }
  const seen = new Uint8Array(faces.length),
    out = new Float32Array(p);
  const order = faces
    .map((_, i) => i)
    .sort((a, b) => faces[b].area - faces[a].area);
  for (const seed of order) {
    const initial = faces[seed];
    // Existing axis-plane design owns these faces. A tilted surface must retain
    // its measured slope rather than being snapped to a dominant world axis.
    if (
      seen[seed] ||
      !initial.area ||
      Math.max(...initial.normal.map(Math.abs)) >= 0.96
    )
      continue;
    const queue = [seed];
    seen[seed] = 1;
    for (let h = 0; h < queue.length; h++)
      for (const f of neighbours[queue[h]]) {
        if (
          seen[f] ||
          !faces[f].area ||
          dot(faces[f].normal, initial.normal) < 0.9 ||
          dot(faces[f].normal, faces[queue[h]].normal) < 0.94 ||
          Math.abs(dot(sub(faces[f].center, initial.center), initial.normal)) >
            0.3
        )
          continue;
        seen[f] = 1;
        queue.push(f);
      }
    if (queue.length < 8) continue;
    const area = queue.reduce((sum, f) => sum + faces[f].area, 0);
    if (area < 16) continue;
    const center = [0, 1, 2].map(
      (a) =>
        queue.reduce((sum, f) => sum + faces[f].center[a] * faces[f].area, 0) /
        area,
    ) as Vec;
    const sumNormal = [0, 1, 2].map((a) =>
      queue.reduce((sum, f) => sum + faces[f].normal[a] * faces[f].area, 0),
    ) as Vec;
    const covariance = Array.from({ length: 3 }, () => [0, 0, 0]);
    for (const f of queue) {
      const delta = faces[f].vertices.map((id) =>
        sub(vertices[id].point, center),
      );
      const sum = [0, 1, 2].map((a) => delta.reduce((n, d) => n + d[a], 0));
      for (let a = 0; a < 3; a++)
        for (let b = 0; b < 3; b++)
          covariance[a][b] +=
            (faces[f].area *
              (delta.reduce((n, d) => n + d[a] * d[b], 0) + sum[a] * sum[b])) /
            (12 * area);
    }
    const normal = planeNormal(covariance, sumNormal);
    const consensus = dot(sumNormal, normal) / area;
    if (consensus < 0.99) continue;
    const ids = new Set(queue.flatMap((f) => faces[f].vertices)),
      region = new Set(queue);
    const tangent = cross(
      normal,
      Math.abs(normal[1]) < 0.8 ? [0, 1, 0] : [1, 0, 0],
    );
    const u = tangent.map((v) => v / Math.hypot(...tangent)) as Vec,
      v = cross(normal, u);
    const spans = [u, v].map((direction) => {
      let min = Infinity,
        max = -Infinity;
      for (const id of ids) {
        const value = dot(vertices[id].point, direction);
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
      return max - min;
    });
    if (spans.some((s) => s < 4)) continue;
    const residual = (positions: Float32Array) =>
      Math.sqrt(
        queue.reduce(
          (sum, f) =>
            sum +
            (faces[f].area *
              faces[f].vertices.reduce((n, id) => {
                const at = vertices[id].copies[0],
                  point = [0, 1, 2].map(
                    (a) => (positions[at + a] - lo[a]) * scale,
                  ) as Vec;
                return n + dot(sub(point, center), normal) ** 2;
              }, 0)) /
              3,
          0,
        ) / area,
      );
    const before = residual(p);
    if (before < 0.005 || before > 0.15) continue;
    // A broad shallow curve also has low plane RMS. Reject a plane when a
    // coherent quadratic bend explains the residual; a tighter plane threshold
    // alone would still flatten large-radius cylindrical and spherical shapes.
    const matrix = Array.from(
      { length: 6 },
      () => Array(6).fill(0) as number[],
    );
    const values = Array(6).fill(0) as number[];
    const samples: { basis: number[]; height: number; weight: number }[] = [];
    for (const f of queue)
      for (const id of faces[f].vertices) {
        const delta = sub(vertices[id].point, center);
        const x = dot(delta, u) / spans[0],
          y = dot(delta, v) / spans[1];
        const basis = [1, x, y, x * x, x * y, y * y];
        const height = dot(delta, normal),
          weight = faces[f].area / (3 * area);
        samples.push({ basis, height, weight });
        for (let a = 0; a < 6; a++) {
          values[a] += basis[a] * height * weight;
          for (let b = 0; b < 6; b++)
            matrix[a][b] += basis[a] * basis[b] * weight;
        }
      }
    const quadratic = solve(matrix, values);
    const fittedError = quadratic
      ? samples.reduce(
          (sum, s) =>
            sum +
            s.weight *
              (s.height -
                s.basis.reduce((n, b, i) => n + b * quadratic[i], 0)) **
                2,
          0,
        )
      : before ** 2;
    const curvatureExplainedFraction = Math.max(
      0,
      1 - fittedError / before ** 2,
    );
    if (curvatureExplainedFraction > 0.75) continue;
    const regionHeights = new Map(
      queue.map((f) => [f, dot(sub(faces[f].center, center), normal)]),
    );
    let covarianceHeight = 0,
      heightA = 0,
      heightB = 0;
    for (const f of queue)
      for (const g of neighbours[f])
        if (g > f && region.has(g)) {
          const a = regionHeights.get(f)!,
            b = regionHeights.get(g)!;
          const weight = Math.min(faces[f].area, faces[g].area);
          covarianceHeight += a * b * weight;
          heightA += a * a * weight;
          heightB += b * b * weight;
        }
    const residualNeighbourCoherence =
      covarianceHeight / Math.max(1e-12, Math.sqrt(heightA * heightB));
    // Quadratic fits miss a multi-cycle wave. A smooth connected residual field
    // is evidence of shape, so it cannot be flattened as unstructured noise.
    if (residualNeighbourCoherence > 0.9) continue;
    const changes: { id: number; target: Vec }[] = [];
    for (const id of ids) {
      const vertex = vertices[id];
      if (
        boundary.has(id) ||
        vertex.faces.some((f) => !region.has(f)) ||
        vertex.point.some(
          (d, a) => d < 1e-5 || d > (hi[a] - lo[a]) * scale - 1e-5,
        )
      )
        continue;
      const distance = dot(sub(vertex.point, center), normal);
      if (Math.abs(distance) < 1e-5 || Math.abs(distance) > 0.25) continue;
      const target = vertex.point.map(
        (d, a) => d - normal[a] * distance,
      ) as Vec;
      if (target.some((d, a) => d < 0 || d > (hi[a] - lo[a]) * scale)) continue;
      changes.push({ id, target });
    }
    if (!changes.length) continue;
    const fractions = new Float64Array(changes.length).fill(1);
    const changeIds = new Map(changes.map((c, i) => [c.id, i]));
    const apply = () => {
      for (const [i, change] of changes.entries())
        for (const at of vertices[change.id].copies)
          for (let a = 0; a < 3; a++)
            out[at + a] =
              (vertices[change.id].point[a] +
                (change.target[a] - vertices[change.id].point[a]) *
                  fractions[i]) /
                scale +
              lo[a];
    };
    const unsafe = () =>
      queue.filter((f) => {
        const points = faces[f].vertices.map((id) => {
          const at = vertices[id].copies[0];
          return Array.from(out.slice(at, at + 3)) as Vec;
        });
        const n = cross(sub(points[1], points[0]), sub(points[2], points[0]));
        return (
          Math.hypot(...n) <= 0 ||
          dot(n, faces[f].normal) < Math.hypot(...n) * 0.5
        );
      });
    apply();
    let bad = unsafe();
    // Tiny triangles next to one crease should limit their own incident
    // vertices, rather than suppress the entire independent roof interior.
    for (let iteration = 0; bad.length && iteration < 24; iteration++) {
      const limited = new Set(bad.flatMap((f) => faces[f].vertices));
      for (const id of limited) {
        const i = changeIds.get(id);
        if (i !== undefined)
          fractions[i] = fractions[i] > 1 / 64 ? fractions[i] / 2 : 0;
      }
      apply();
      bad = unsafe();
    }
    const after = residual(out);
    if (bad.length || after >= before * 0.8) {
      fractions.fill(0);
      apply();
      continue;
    }
    patches.push({
      sourceFaceIds: queue,
      normal,
      centerStuds: center,
      areaStudsSquared: area,
      residualBeforeStuds: before,
      residualAfterStuds: after,
      maxDisplacementStuds: Math.max(
        ...changes.map(
          (c, i) =>
            Math.hypot(...sub(c.target, vertices[c.id].point)) * fractions[i],
        ),
      ),
      adjustedVertices: changes.filter((_, i) => fractions[i] > 0).length,
      displacementFraction: Math.min(...fractions),
      normalConsensus: consensus,
      curvatureExplainedFraction,
      limitedVertices: changes.filter((_, i) => fractions[i] < 1).length,
      residualNeighbourCoherence,
    });
  }
  const clearance = patches.length
    ? validateSurfaceClearance(p, out, resolution)
    : undefined;
  return {
    mesh:
      patches.length && clearance?.accepted ? { ...mesh, positions: out } : mesh,
    patches: clearance && !clearance.accepted ? [] : patches,
    clearance,
  };
}
