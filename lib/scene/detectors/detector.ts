import type { Raster } from '../../brick-engine.ts';
import type { SceneElementInstance } from '../scene-types.ts';

/** Detector output is data only. Detectors must never mutate a mesh or model. */
export interface SceneDetector {
  detect(image: Raster): Promise<SceneElementInstance[]>;
}
