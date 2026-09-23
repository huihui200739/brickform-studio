import type { TriangleMesh } from './mesh-types.ts';
import type { referenceAlignment } from './reference-colors.ts';
import type { V3 } from './assembly-catalog.ts';

// A yaw/pitch alone does not define image pixels: use the SAME foreground crop,
// mesh centre, perspective and sampled projected bounds as reference colouring.
export type ReferenceAlignment = ReturnType<typeof referenceAlignment>;
export type Ray = { origin: V3; direction: V3 };
const sub = (a: V3, b: V3) => a.map((v, i) => v - b[i]) as V3;
const dot = (a: V3, b: V3) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: V3): V3 => v.map((x) => x / Math.hypot(...v)) as V3;
export function projectImageRay(
  alignment: ReferenceAlignment,
  imageSize: [number, number],
  uv: [number, number],
): Ray {
  const { camera, view, left, right, top, bottom, center, extent } = alignment;
  const yaw = (camera.yaw * Math.PI) / 180,
    pitch = (camera.pitch * Math.PI) / 180;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const rightAxis: V3 = [cy, 0, -sy],
    up: V3 = [-sy * sp, cp, -cy * sp],
    forward: V3 = [sy * cp, sp, cy * cp];
  const x =
    view.minX +
    ((uv[0] * (imageSize[0] - 1) - left) / (right - left)) *
      (view.maxX - view.minX);
  const y =
    view.maxY -
    ((uv[1] * (imageSize[1] - 1) - top) / (bottom - top)) *
      (view.maxY - view.minY);
  const point = (xx: number, yy: number, z: number) =>
    center.map(
      (v, i) => v + rightAxis[i] * xx + up[i] * yy + forward[i] * z,
    ) as V3;
  if (camera.perspective > 0) {
    const distance = extent / camera.perspective;
    const origin = point(0, 0, distance);
    return { origin, direction: unit(sub(point(x, y, 0), origin)) };
  }
  return {
    origin: point(x, y, extent * 2),
    direction: forward.map((v) => -v) as V3,
  };
}
export function raycastMesh(mesh: TriangleMesh, ray: Ray) {
  let nearest:
    | { point: V3; normal: V3; distance: number; triangle: number }
    | undefined;
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 9) {
    const a = Array.from(p.slice(i, i + 3)) as V3,
      b = Array.from(p.slice(i + 3, i + 6)) as V3,
      c = Array.from(p.slice(i + 6, i + 9)) as V3;
    const e1 = sub(b, a),
      e2 = sub(c, a),
      h = cross(ray.direction, e2),
      det = dot(e1, h);
    if (Math.abs(det) < 1e-10) continue;
    const s = sub(ray.origin, a),
      u = dot(s, h) / det;
    if (u < 0 || u > 1) continue;
    const q = cross(s, e1),
      v = dot(ray.direction, q) / det;
    if (v < 0 || u + v > 1) continue;
    const distance = dot(e2, q) / det;
    if (distance < 1e-8 || (nearest && distance >= nearest.distance)) continue;
    nearest = {
      point: ray.origin.map((v, j) => v + distance * ray.direction[j]) as V3,
      normal: unit(cross(e1, e2)),
      distance,
      triangle: i / 9,
    };
  }
  return nearest;
}
export function imageAnchorToMesh(
  mesh: TriangleMesh,
  alignment: ReferenceAlignment,
  imageSize: [number, number],
  uv: [number, number],
) {
  if (uv.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return undefined;
  // Exact ray first. At most two image pixels, never a search for another object.
  for (const [dx, dy] of [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-2, 0],
    [2, 0],
    [0, -2],
    [0, 2],
  ]) {
    const sample: [number, number] = [
      uv[0] + dx / (imageSize[0] - 1),
      uv[1] + dy / (imageSize[1] - 1),
    ];
    if (sample.some((v) => v < 0 || v > 1)) continue;
    const hit = raycastMesh(
      mesh,
      projectImageRay(alignment, imageSize, sample),
    );
    if (hit)
      return {
        ...hit,
        uv: sample,
        raycastConfidence: dx === 0 && dy === 0 ? 1 : 0.85,
      };
  }
  return undefined;
}
export const projectImagePointToMesh = imageAnchorToMesh;
