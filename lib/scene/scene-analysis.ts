import type { Raster } from '../brick-engine.ts';
import { applyFocalPriority } from '../focal-priority.ts';
import { groupSceneElements } from './scene-grouping.ts';
import type { SceneDetector } from './detectors/detector.ts';
import type { SceneAnalysis, SceneElementInstance } from './scene-types.ts';

/** Runs image analysis and groups the resulting independent instances. */
export async function analyzeScene(
  image: Raster,
  detector: SceneDetector,
): Promise<SceneAnalysis> {
  const detected = await detector.detect(image);
  const elements = detected.map((element) => applyFocalPriority(element));
  return { elements, groups: groupSceneElements(elements) };
}

export function normalizeSceneElements(
  elements: SceneElementInstance[],
): SceneAnalysis {
  const normalized = elements.map((element) => applyFocalPriority(element));
  return { elements: normalized, groups: groupSceneElements(normalized) };
}
