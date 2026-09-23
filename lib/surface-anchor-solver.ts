import type { Model, Raster } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';
import type { ReferenceCamera } from './reference-colors.ts';
import { referenceAlignment } from './reference-colors.ts';
import { imageAnchorToMesh } from './image-to-mesh.ts';
import { meshFrame, type ComponentRegion } from './semantic-components.ts';
import type { SceneElementInstance } from './scene/scene-types.ts';
import type { V3 } from './assembly-catalog.ts';
import type { AnchorResult } from './anchor-result.ts';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

function imageAnchorOf(element: SceneElementInstance) {
  if (element.anchorUV) return element.anchorUV;
  if (element.imageBox)
    return [element.imageBox.x + element.imageBox.width / 2, element.imageBox.y + element.imageBox.height] as [number, number];
  return [0.5, 0.5] as [number, number];
}

function toNormalizedAnchor(grid: V3, point: V3): V3 {
  return [
    clamp((point[0] - 1) / Math.max(1, grid[0]), 0, 1),
    clamp((point[1] - 2) / Math.max(1, grid[1]), 0, 1),
    clamp((point[2] - 1) / Math.max(1, grid[2]), 0, 1),
  ];
}

function distanceToBrick(point: V3, brick: Model['bricks'][number]) {
  const closest: V3 = [
    clamp(point[0], brick.x, brick.x + brick.w),
    clamp(point[1], brick.y, brick.y + brick.h),
    clamp(point[2], brick.z, brick.z + brick.d),
  ];
  return {
    distance: Math.hypot(...point.map((value, axis) => value - closest[axis])),
    closest,
  };
}

function surfaceCandidates(model: Model, point: V3, normal: V3, kind: AnchorResult['surfaceKind']) {
  return model.bricks
    .filter((brick) => !brick.section?.startsWith('component-'))
    .map((brick) => {
      const nearest = distanceToBrick(point, brick);
      const top = Math.abs(normal[1]) > 0.55 && Math.abs(nearest.closest[1] - (brick.y + brick.h)) < 0.01;
      const vertical = Math.abs(normal[1]) <= 0.55 && (
        Math.abs(nearest.closest[0] - brick.x) < 0.01 ||
        Math.abs(nearest.closest[0] - (brick.x + brick.w)) < 0.01 ||
        Math.abs(nearest.closest[2] - brick.z) < 0.01 ||
        Math.abs(nearest.closest[2] - (brick.z + brick.d)) < 0.01
      );
      const orientation = kind === 'ground' ? (top ? 0 : 2) : kind === 'wall' ? (vertical ? 0 : 2) : 1;
      return { brick, nearest, score: nearest.distance + orientation };
    })
    .filter((candidate) => candidate.nearest.distance <= 3.5)
    .sort((a, b) => a.score - b.score);
}

function groundTop(model: Model, point: V3) {
  let best = 2;
  for (const brick of model.bricks) {
    if (brick.y + brick.h > point[1] + 1.5) continue;
    if (point[0] < brick.x - 1 || point[0] > brick.x + brick.w + 1 || point[2] < brick.z - 1 || point[2] > brick.z + brick.d + 1) continue;
    if (brick.y + brick.h > best) best = brick.y + brick.h;
  }
  return best;
}

/**
 * Calibrate an image anchor against both the source mesh and the generated
 * brick structure. The returned worldAnchor is in brick-grid coordinates;
 * normalizedAnchor is the compatibility value consumed by ComponentRegion.
 */
export function solveSurfaceAnchor(
  element: SceneElementInstance,
  mesh: TriangleMesh,
  image: Raster,
  model: Model,
  resolution: number,
  camera?: ReferenceCamera,
): AnchorResult {
  const imageAnchor = imageAnchorOf(element);
  const result: AnchorResult = {
    elementId: element.id,
    imageAnchor: { x: imageAnchor[0], y: imageAnchor[1] },
    worldAnchor: { x: 0, y: 0, z: 0 },
    surface: { detected: false, normal: [0, 1, 0], supportBrickIds: [] },
    depthConfidence: 0,
    attached: false,
    failureReasons: [],
  };
  try {
    const alignment = referenceAlignment(mesh, image, camera);
    const hit = imageAnchorToMesh(mesh, alignment, [image.width, image.height], imageAnchor);
    if (!hit) {
      result.failureReasons.push('image anchor did not intersect the reconstruction mesh');
      return result;
    }
    const frame = meshFrame(mesh, resolution);
    const normalized = hit.point.map((value, axis) => clamp((value - frame.min[axis]) / Math.max(frame.span[axis], 1e-9), 0, 1)) as V3;
    const point: V3 = [normalized[0] * model.width + 1, normalized[1] * model.height + 2, normalized[2] * model.depth + 1];
    const normal = hit.normal as [number, number, number];
    const kind: AnchorResult['surfaceKind'] = Math.abs(normal[1]) > 0.55 ? 'ground' : Math.abs(normal[0]) + Math.abs(normal[2]) > 0.55 ? 'wall' : 'unknown';
    const candidates = surfaceCandidates(model, point, normal, kind);
    const support = candidates.slice(0, kind === 'wall' ? 3 : 2).map((candidate) => candidate.brick.id);
    let attachedPoint = candidates[0]?.nearest.closest || point;
    let y = attachedPoint[1];
    if (element.category === 'statue' && kind === 'wall') {
      // A statue is seated on the nearest cavity floor/platform, then moved
      // toward the viewer so its body does not become part of the wall.
      y = groundTop(model, point);
      attachedPoint = [point[0], y, point[2]];
    } else if (kind === 'ground') {
      y = groundTop(model, point);
      attachedPoint = [point[0], y, point[2]];
    }
    const offset = element.category === 'brazier' && kind === 'wall' ? 1 : element.category === 'statue' && kind === 'wall' ? 0.75 : 0;
    const world: V3 = [attachedPoint[0] + normal[0] * offset, y + (kind === 'ground' ? 0 : normal[1] * offset), attachedPoint[2] + normal[2] * offset];
    const normalizedAnchor = toNormalizedAnchor([model.width, model.height, model.depth], world);
    result.worldAnchor = { x: world[0], y: world[1], z: world[2] };
    result.normalizedAnchor = normalizedAnchor;
    result.surface = { detected: candidates.length > 0, normal, supportBrickIds: support };
    result.surfaceKind = kind;
    result.depthConfidence = Math.min(1, hit.raycastConfidence * (alignment.confidence || 0.5) * (candidates.length ? 1 : 0.4));
    result.attached = candidates.length > 0 && support.length > 0;
    if (!result.surface.detected) result.failureReasons.push('no nearby generated brick surface matched the ray hit');
    if (!result.attached) result.failureReasons.push('surface has no attachable support bricks');
    if (result.depthConfidence < 0.35) result.failureReasons.push('surface depth confidence is low');
  } catch (error) {
    result.failureReasons.push(error instanceof Error ? error.message : 'surface anchor calibration failed');
  }
  return result;
}

export function applyAnchorResult(region: ComponentRegion, result: AnchorResult) {
  if (!result.normalizedAnchor) return region;
  return {
    ...region,
    anchor: [...result.normalizedAnchor] as V3,
    referenceAnchor: [...result.normalizedAnchor] as V3,
    anchorResult: result,
    sceneElement: region.sceneElement ? {
      ...region.sceneElement,
      worldAnchor: [...result.normalizedAnchor] as V3,
      anchorResult: result,
    } : region.sceneElement,
  };
}
