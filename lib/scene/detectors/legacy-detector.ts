import type { Raster } from '../../brick-engine.ts';
import {
  ColorSemanticDetector,
  type ImageSemanticDetection,
  type SemanticDetector,
} from '../../image-semantics.ts';
import { instanceId } from '../../scene-elements.ts';
import type { SceneDetector } from './detector.ts';
import type { SceneElementInstance } from '../scene-types.ts';

/**
 * Compatibility adapter for the current colour detector. It deliberately
 * converts candidates to instances and stops there; all placement remains in
 * scene planning and composition.
 */
export class LegacySceneDetector implements SceneDetector {
  private readonly detector: SemanticDetector;

  constructor(detector: SemanticDetector = new ColorSemanticDetector()) {
    this.detector = detector;
  }

  async detect(image: Raster): Promise<SceneElementInstance[]> {
    const detections = await this.detector.detect(image);
    return detections.map((detection) => this.toInstance(detection));
  }

  private toInstance(detection: ImageSemanticDetection): SceneElementInstance {
    return {
      id: instanceId(detection.kind, detection.bbox),
      category: detection.kind,
      confidence: detection.confidence,
      imageBox: detection.bbox,
      imageMask: detection.mask,
      imageMaskSize: detection.maskSize,
      anchorUV: detection.anchorUV,
      anchorConfidence: detection.anchorConfidence,
      anchorKind:
        detection.kind === 'tree' || detection.kind === 'brazier'
          ? 'ground'
          : undefined,
      evidence: detection.evidence,
      detectionSource: 'color',
    };
  }
}

export function legacySceneDetector(
  detector?: SemanticDetector,
): SceneDetector {
  return new LegacySceneDetector(detector);
}
