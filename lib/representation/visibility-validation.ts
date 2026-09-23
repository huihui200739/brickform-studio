import type { Brick, Model, Raster } from '../brick-engine.ts';
import type { TriangleMesh } from '../mesh-types.ts';
import { meshFrame } from '../semantic-components.ts';
import { referenceAlignment, type ReferenceCamera } from '../reference-colors.ts';
import type {
  ImageBox,
  RepresentationKind,
  RepresentationResult,
  SceneElementInstance,
} from '../scene/scene-types.ts';

export const PRIMARY_MIN_COVERAGE = 0.25;
const WIDTH = 192;
const HEIGHT = 192;

export type ReferenceView = {
  camera: ReferenceCamera;
  project: (point: [number, number, number]) => [number, number, number];
};

/** Uses exactly the crop and camera estimated for image-to-mesh alignment. */
export function createReferenceView(
  mesh: TriangleMesh,
  image: Raster,
  resolution: number,
  camera?: ReferenceCamera,
): ReferenceView {
  const alignment = referenceAlignment(mesh, image, camera);
  const frame = meshFrame(mesh, resolution);
  return {
    camera: alignment.camera,
    project: ([x, y, z]) => {
      const point = alignment.view.point(
        frame.min[0] + ((x - 1) / frame.scale),
        frame.min[1] + (((y - 2) * 0.4) / frame.scale),
        frame.min[2] + ((z - 1) / frame.scale),
      );
      return [
        (alignment.left + ((point[0] - alignment.view.minX) /
          (alignment.view.maxX - alignment.view.minX)) *
          (alignment.right - alignment.left)) / (image.width - 1),
        (alignment.top + ((alignment.view.maxY - point[1]) /
          (alignment.view.maxY - alignment.view.minY)) *
          (alignment.bottom - alignment.top)) / (image.height - 1),
        point[2],
      ];
    },
  };
}

/** Orthographic fallback for imported/manual models without a reference image. */
export function createModelView(model: Model, camera: ReferenceCamera = {
  yaw: 0,
  pitch: 15,
  perspective: 0,
}): ReferenceView {
  const yaw = camera.yaw * Math.PI / 180;
  const pitch = camera.pitch * Math.PI / 180;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const raw = ([x, y, z]: [number, number, number]) => [
    cy * (x - model.width / 2) - sy * (z - model.depth / 2),
    -sy * sp * (x - model.width / 2) + cp * ((y - model.height / 2) * 0.4) - cy * sp * (z - model.depth / 2),
    sy * cp * (x - model.width / 2) + sp * ((y - model.height / 2) * 0.4) + cy * cp * (z - model.depth / 2),
  ];
  const corners = [0, model.width].flatMap((x) => [0, model.height].flatMap((y) =>
    [0, model.depth].map((z) => raw([x, y, z]))));
  const minX = Math.min(...corners.map((p) => p[0]));
  const maxX = Math.max(...corners.map((p) => p[0]));
  const minY = Math.min(...corners.map((p) => p[1]));
  const maxY = Math.max(...corners.map((p) => p[1]));
  return {
    camera,
    project: (point) => {
      const p = raw(point);
      return [(p[0] - minX) / (maxX - minX),
        (maxY - p[1]) / (maxY - minY), p[2]];
    },
  };
}

function brickBounds(bricks: Brick[]): RepresentationResult['bbox3d'] {
  if (!bricks.length) return undefined;
  const min = [Infinity, Infinity, Infinity] as [number, number, number];
  const max = [-Infinity, -Infinity, -Infinity] as [number, number, number];
  for (const b of bricks) {
    const lo = [b.x, b.y, b.z];
    const hi = [b.x + b.w, b.y + b.h, b.z + b.d];
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], lo[a]);
      max[a] = Math.max(max[a], hi[a]);
    }
  }
  return { min, max };
}

export function makeRepresentationResult(
  element: SceneElementInstance,
  requestedKind: RepresentationKind,
  actualKind: RepresentationKind,
  model: Model,
  section: string,
  fallbackLevel: number,
): RepresentationResult {
  const bricks = model.bricks.filter((b) => b.section === section);
  return {
    elementId: element.id,
    requestedKind,
    actualKind,
    committed: false,
    brickIds: bricks.map((b) => b.id),
    bbox3d: brickBounds(bricks),
    brickCount: bricks.length,
    visibleFromReference: false,
    fallbackLevel,
    failureReasons: [],
  };
}

type Projection = { x0: number; x1: number; y0: number; y1: number; depth: number };
function projectBrick(brick: Brick, view: ReferenceView): Projection {
  const points = [brick.x, brick.x + brick.w].flatMap((x) =>
    [brick.y, brick.y + brick.h].flatMap((y) =>
      [brick.z, brick.z + brick.d].map((z) => view.project([x, y, z]))));
  return {
    x0: Math.max(0, Math.floor(Math.min(...points.map((p) => p[0])) * WIDTH)),
    x1: Math.min(WIDTH - 1, Math.ceil(Math.max(...points.map((p) => p[0])) * WIDTH)),
    y0: Math.max(0, Math.floor(Math.min(...points.map((p) => p[1])) * HEIGHT)),
    y1: Math.min(HEIGHT - 1, Math.ceil(Math.max(...points.map((p) => p[1])) * HEIGHT)),
    depth: points.reduce((sum, p) => sum + p[2], 0) / points.length,
  };
}

function overlaps(a: ImageBox, b: ImageBox) {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (w * h) / Math.max(1e-9, a.width * a.height);
}

/** Validates geometry, reference placement, and actual front-most pixels. */
export function validateElementVisibility(
  element: SceneElementInstance,
  representationResult: RepresentationResult,
  referenceView: ReferenceView,
  finalModel: Model,
): RepresentationResult {
  const result = { ...representationResult, failureReasons: [...representationResult.failureReasons] };
  const target = new Set(result.brickIds);
  const bricks = finalModel.bricks.filter((b) => target.has(b.id));
  if (!bricks.length || !result.brickCount || bricks.length !== result.brickCount) {
    result.failureReasons.push('no final bricks for element');
    return result;
  }
  if (!result.bbox3d || result.bbox3d.min.some((v, i) =>
    !Number.isFinite(v) || result.bbox3d!.max[i] - v <= 0)) {
    result.failureReasons.push('invalid 3D bounds');
    return result;
  }
  const targetPixels = new Uint8Array(WIDTH * HEIGHT);
  const depth = new Float64Array(WIDTH * HEIGHT).fill(-Infinity);
  const owner = new Uint8Array(WIDTH * HEIGHT);
  const projected = bricks.map((b) => projectBrick(b, referenceView));
  const x0 = Math.min(...projected.map((p) => p.x0)) / WIDTH;
  const x1 = Math.max(...projected.map((p) => p.x1)) / WIDTH;
  const y0 = Math.min(...projected.map((p) => p.y0)) / HEIGHT;
  const y1 = Math.max(...projected.map((p) => p.y1)) / HEIGHT;
  result.projectedBox = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  if (element.imageBox && overlaps(result.projectedBox, element.imageBox) < 0.2) {
    result.failureReasons.push('projected geometry misses reference image box');
    return result;
  }
  for (const brick of finalModel.bricks) {
    const p = projectBrick(brick, referenceView);
    const belongs = target.has(brick.id);
    if (p.x1 < p.x0 || p.y1 < p.y0) continue;
    for (let y = p.y0; y <= p.y1; y++)
      for (let x = p.x0; x <= p.x1; x++) {
        const k = y * WIDTH + x;
        if (belongs) targetPixels[k] = 1;
        if (p.depth > depth[k] + 1e-6 ||
          (Math.abs(p.depth - depth[k]) <= 1e-6 && belongs)) {
          depth[k] = p.depth;
          owner[k] = belongs ? 1 : 2;
        }
      }
  }
  let total = 0, visible = 0;
  const box = element.imageBox;
  for (let y = 0; y < HEIGHT; y++)
    for (let x = 0; x < WIDTH; x++) {
      const k = y * WIDTH + x;
      if (!targetPixels[k]) continue;
      if (box && (x / WIDTH < box.x - 0.04 || x / WIDTH > box.x + box.width + 0.04 ||
        y / HEIGHT < box.y - 0.04 || y / HEIGHT > box.y + box.height + 0.04)) continue;
      total++;
      if (owner[k] === 1) visible++;
    }
  result.projectedCoverage = total ? visible / total : 0;
  result.occlusionRatio = total ? 1 - visible / total : 1;
  const targetDepth = projected.reduce((sum, item) => sum + item.depth, 0) / Math.max(1, projected.length);
  const nearestOccluderDepth = finalModel.bricks
    .filter((brick) => !target.has(brick.id))
    .map((brick) => ({ brick, projection: projectBrick(brick, referenceView) }))
    .filter(({ projection }) =>
      projection.x1 >= x0 * WIDTH && projection.x0 <= x1 * WIDTH &&
      projection.y1 >= y0 * HEIGHT && projection.y0 <= y1 * HEIGHT &&
      projection.depth > targetDepth + 1e-4,
    )
    .map(({ projection }) => projection.depth)
    .sort((a, b) => a - b)[0];
  const depthPassed = !(result.occlusionRatio > 0.75 && nearestOccluderDepth !== undefined);
  result.depthCheck = { targetDepth, nearestOccluderDepth, passed: depthPassed };
  if (!depthPassed)
    result.failureReasons.push('element depth is behind an overlapping wall or support');
  const threshold = element.mustRepresent || element.importance === 'primary'
    ? PRIMARY_MIN_COVERAGE : 0.05;
  result.visibleFromReference = total > 0 && result.projectedCoverage >= threshold && depthPassed;
  if (!result.visibleFromReference)
    result.failureReasons.push(`reference-view coverage ${result.projectedCoverage.toFixed(3)} below ${threshold}`);
  result.committed = result.brickCount > 0 && result.visibleFromReference;
  return result;
}
