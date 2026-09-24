import type { Raster } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';
import {
  referenceAlignment,
  type ReferenceCamera,
} from './reference-colors.ts';
import { imageAnchorToMesh } from './image-to-mesh.ts';
import {
  type SemanticDetector,
} from './image-semantics.ts';
import {
  COMPONENT_SIZES,
  meshFrame,
  type ComponentRegion,
} from './semantic-components.ts';
import type { V3 } from './assembly-catalog.ts';
import {
  retrieveComponentForInstance,
} from './component-library.ts';
import { enforceGroupConsistency } from './element-grouping.ts';
import { routeRepresentation } from './representation-router.ts';
import { analyzeScene } from './scene/scene-analysis.ts';
import { LegacySceneDetector } from './scene/detectors/legacy-detector.ts';

export const AUTO_REPLACEMENT_THRESHOLD = 0.7;
export function automaticReplacementScore(region: ComponentRegion) {
  const score =
    region.autoScoreWithInstallation ?? region.replacementConfidence ?? 0;
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : 0;
}
export function replacementConfidence(
  semantic: number,
  camera: number,
  ray: number,
  geometry: number,
  installation: number,
  anchor: number,
) {
  const values = [semantic, camera, ray, geometry, installation, anchor];
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) return 0;
  // Do not let good colour/installation scores compensate for an unknown base.
  return Math.min(
    anchor,
    ray,
    geometry,
    0.35 * semantic +
      0.2 * camera +
      0.15 * ray +
      0.15 * geometry +
      0.15 * installation,
  );
}
export function mergeRefinementRegions(
  current: ComponentRegion[],
  fresh: ComponentRegion[],
) {
  const overrides = current.filter(
    (r) =>
      !r.autoRefinement &&
      (r.source === 'manual' ||
        r.confirmed ||
        r.placementStatus === 'rejected'),
  );
  return [
    ...overrides,
    ...fresh.filter(
      (r) =>
        !overrides.some(
          (p) =>
            p.id === r.id ||
            (p.kind === r.kind &&
              Math.hypot(...p.anchor.map((v, i) => v - r.anchor[i])) < 0.12),
        ),
    ),
  ].slice(0, 64);
}
export async function detectRefinements(
  mesh: TriangleMesh,
  image: Raster,
  resolution: number,
  detector?: SemanticDetector,
  camera?: ReferenceCamera,
): Promise<ComponentRegion[]> {
  const analysis = await analyzeScene(
    image,
    new LegacySceneDetector(detector),
  );
  const detections = analysis.elements;
  if (!detections.length) return [];
  const alignment = referenceAlignment(mesh, image, camera),
    frame = meshFrame(mesh, resolution);
  const regions: ComponentRegion[] = [];
  for (const [index, detection] of detections.entries()) {
    const hit = imageAnchorToMesh(
      mesh,
      alignment,
      [image.width, image.height],
      detection.anchorUV!,
    );
    if (!hit) continue;
    const anchor = hit.point.map(
      (v, i) => (v - frame.min[i]) / frame.span[i],
    ) as V3;
    if (anchor.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) continue;
    const kind = detection.category;
    if (kind !== 'tree' && kind !== 'brazier' && kind !== 'statue') continue;
    const size = COMPONENT_SIZES[kind];
    const bbox = detection.imageBox!;
    const anchorConfidence = detection.anchorConfidence ?? 0;
    // A mounting base needs an upward surface, not the front of a wall.
    const bottom = alignment.view.point(...hit.point);
    const top = alignment.view.point(
      hit.point[0],
      hit.point[1] + (size.height * 0.4) / frame.scale,
      hit.point[2],
    );
    const projectedHeight =
      ((Math.abs(top[1] - bottom[1]) /
        (alignment.view.maxY - alignment.view.minY)) *
        (alignment.bottom - alignment.top)) /
      (image.height - 1);
    const heightFit =
      Math.min(projectedHeight, bbox.height) /
      Math.max(projectedHeight, bbox.height, 1e-9);
    // A colour patch often raycasts to the visible front of a small object,
    // whose normal is vertical even though its base is hidden. Let the
    // proposal reach the transactional installer; the installer remains the
    // hard gate and rolls back any object that cannot actually be seated.
    const geometryFit = Math.min(
      1,
      Math.max(Math.max(0, hit.normal[1]), anchorConfidence * 0.9),
      Math.max(heightFit, anchorConfidence),
    );
    // Installation is provisional here. The transactional assembler must still
    // validate the complete surroundings before any actual replacement commits.
    const score = replacementConfidence(
      detection.confidence,
      alignment.confidence,
      hit.raycastConfidence,
      geometryFit,
      0,
      anchorConfidence,
    );
    const sceneElement = {
      ...detection,
      category: kind,
      imageBox: bbox,
      // The ray hit is only a provisional mesh sample. Surface calibration
      // writes worldAnchor after it finds an attachable generated brick.
      scaleHint: size,
      placementMode: kind === 'brazier'
        ? 'wall-mounted' as const
        : kind === 'statue'
          ? 'pedestal-mounted' as const
          : 'cavity-contained' as const,
    };
    const matches = retrieveComponentForInstance(sceneElement);
    const match = matches[0];
    const decision = routeRepresentation(
      sceneElement,
      matches,
    );
    regions.push({
      id: `image-${kind}-${index}`,
      kind,
      source: 'color',
      sceneElement,
      templateId: decision.templateId,
      representation: decision.kind,
      templateCandidates: decision.candidates,
      autoRefinement: true,
      anchor,
      referenceAnchor: [...anchor],
      imageUV: detection.anchorUV,
      ...size,
      rotation: 0,
      placed: true,
      confidence: detection.confidence,
      replacementConfidence: score,
      confirmed: false,
      evidence: [
        ...(detection.evidence || []),
        `表达方式：${decision.reason}`,
        `相机轮廓对齐评分 ${alignment.confidence.toFixed(2)}`,
      ],
      // Installation confidence is provisional here; the calibrated anchor is
      // a placement score, while the transactional assembler applies only the
      // category-specific wall attachment constraint.
      placementStatus: 'candidate',
      placementMode: sceneElement.placementMode,
      autoScoreWithInstallation: replacementConfidence(
        detection.confidence,
        alignment.confidence,
        hit.raycastConfidence,
        geometryFit,
        1,
        anchorConfidence,
      ),
    });
  }
  enforceGroupConsistency(regions);
  return regions
    .sort(
      (a, b) =>
        (b.autoScoreWithInstallation || 0) - (a.autoScoreWithInstallation || 0),
    )
    .slice(0, 64);
}
