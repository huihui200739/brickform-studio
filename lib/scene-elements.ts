/**
 * Backwards-compatible exports for the pre-Phase-1 callers.
 * New code should import from ./scene/scene-types and ./scene/scene-grouping.
 */
import {
  groupSceneElements,
  toLegacySceneGroups,
} from './scene/scene-grouping.ts';
import type {
  ElementCategory,
  RepresentationKind,
  SceneElementGroup,
  SceneElementInstance,
} from './scene/scene-types.ts';

export type SceneCategory = ElementCategory;
export type {
  ElementCategory,
  RepresentationKind,
  SceneElementGroup,
  SceneElementInstance,
} from './scene/scene-types.ts';
export type SceneElement = SceneElementInstance;

export type RepeatedElementGroup = SceneElementGroup & {
  layoutHint?: SceneElementGroup['layout'];
  templatePreference?: string[];
  templateChoices?: string[];
  styleLocked?: boolean;
};

/** IDs depend on geometry, never confidence sorting or instance count. */
export function instanceId(
  category: SceneCategory,
  box: NonNullable<SceneElementInstance['imageBox']>,
) {
  return `${category}-${[box.x, box.y, box.width, box.height]
    .map((value) => Math.round(value * 10000))
    .join('-')}`;
}

/** Legacy adapter; grouping itself lives in the scene layer. */
export function repeatedGroups(
  instances: SceneElementInstance[],
): RepeatedElementGroup[] {
  return toLegacySceneGroups(groupSceneElements(instances));
}
