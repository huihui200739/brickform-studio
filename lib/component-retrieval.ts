import {
  COMPONENT_LIBRARY,
  type LegoComponentTemplate,
} from './component-library.ts';
import type { SceneElementInstance } from './scene-elements.ts';
export type ComponentMatch = {
  template: LegoComponentTemplate;
  score: number;
  reasons: string[];
};
export type RetrievalContext = {
  templatePreference?: string[];
  installationFit?: Record<string, number>;
  surroundingFit?: Record<string, number>;
};
export function retrieveComponentForInstance(
  instance: SceneElementInstance,
  context: RetrievalContext = {},
  templates = COMPONENT_LIBRARY,
): ComponentMatch[] {
  return templates
    .filter(
      (t) =>
        t.category === instance.category ||
        (instance.category === 'plant' && t.category === 'tree'),
    )
    .map((template) => {
      const scale = instance.scaleHint;
      const size = scale
        ? (['width', 'height', 'depth'] as const).reduce(
            (n, k) =>
              n +
              Math.min(scale[k], template.bboxStuds[k]) /
                Math.max(scale[k], template.bboxStuds[k], 1e-9),
            0,
          ) / 3
        : 0.5;
      const colors = instance.colorHints?.length
        ? instance.colorHints.filter((c) => template.colors.includes(c))
            .length / instance.colorHints.length
        : 0.5;
      const anchor =
        !instance.anchorKind ||
        instance.anchorKind === template.anchor.kind ||
        (['ground', 'surface'].includes(instance.anchorKind) &&
          ['ground', 'surface'].includes(template.anchor.kind))
          ? 1
          : 0;
      let score =
        0.4 * instance.confidence +
        0.35 * size +
        0.1 * colors +
        0.1 * anchor +
        0.05 * (context.templatePreference?.includes(template.id) ? 1 : 0.5);
      if (
        context.installationFit?.[template.id] === 0 ||
        context.surroundingFit?.[template.id] === 0
      )
        score = 0;
      if (template.requiresMask && !instance.imageMask) score = 0;
      // A relief does not require the confidence necessary to invent articulated anatomy.
      if (
        instance.category === 'statue' &&
        template.representation === 'component' &&
        instance.confidence < 0.95
      )
        score = 0;
      return {
        template,
        score: Number.isFinite(score) ? score : 0,
        reasons: [
          `category:${instance.category}`,
          `scale:${size.toFixed(2)}`,
          `anchor:${anchor}`,
        ],
      };
    })
    .sort(
      (a, b) => b.score - a.score || a.template.id.localeCompare(b.template.id),
    );
}
export function retrieveComponent(
  instance: SceneElementInstance,
  templates = COMPONENT_LIBRARY,
) {
  const matches = retrieveComponentForInstance(instance, {}, templates);
  // Preserve the Phase 1 public choice for callers that display a low
  // confidence statue suggestion; Phase 2 uses the new standing template as
  // a verified fallback during composition.
  if (
    instance.category === 'statue' &&
    instance.confidence < 0.95 &&
    matches[0]?.template.id === 'statue-simple-standing'
  )
    return matches.find((match) => match.template.id === 'statue-simplified') || matches[0];
  return matches[0];
}
export function fallbackRepresentation(
  instance: SceneElementInstance,
  match?: ComponentMatch,
) {
  if (
    match &&
    match.score >= 0.7 &&
    match.template.representation === 'component'
  )
    return 'component' as const;
  if (
    instance.category === 'statue' &&
    instance.imageMask &&
    match?.template.fallback === 'relief'
  )
    return 'relief' as const;
  if (instance.imageMask && match?.template.requiresMask)
    return 'relief' as const;
  return 'voxel' as const;
}
