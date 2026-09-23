import type { SceneElementInstance } from './scene-elements.ts';

/**
 * Assigns a stable visual priority to detected instances. The score is only
 * used to protect important subjects during representation and finishing; it
 * never invents a scene element or moves its anchor.
 */
export function focalPriority(
  instance: Pick<SceneElementInstance, 'category' | 'confidence' | 'imageBox'>,
) {
  const category = instance.category;
  const confidence = Math.max(0, Math.min(1, instance.confidence || 0));
  const box = instance.imageBox;
  const area = box ? Math.max(0, box.width * box.height) : 0;
  const centrality = box
    ? 1 - Math.min(1, Math.hypot(box.x + box.width / 2 - 0.5, box.y + box.height / 2 - 0.48) / 0.72)
    : 0;
  let score = 0.35 * confidence + 0.35 * centrality + 0.3 * Math.min(1, area * 18);
  if (category === 'statue') score = Math.max(score, 0.86 * confidence + 0.14);
  if (category === 'stairs' || category === 'column' || category === 'door')
    score = Math.max(score, 0.55 * confidence + 0.2);
  const importance =
    score >= 0.68 ? 'primary' : score >= 0.32 ? 'secondary' : 'background';
  return {
    importance,
    importanceScore: Math.max(0, Math.min(1, score)),
    mustRepresent: category === 'statue' ||
      (importance === 'primary' && confidence >= 0.55),
  } as const;
}

export function applyFocalPriority<T extends SceneElementInstance>(instance: T): T {
  return Object.assign(instance, focalPriority(instance));
}
