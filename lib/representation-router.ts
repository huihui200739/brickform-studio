import type { ComponentMatch } from './component-retrieval.ts';
import {
  defaultRepresentationRouter,
} from './representation/representation-router.ts';
import type {
  RepresentationKind,
  SceneElementInstance,
} from './scene-elements.ts';

/** Legacy decision shape retained for existing assembly callers. */
export type RepresentationDecision = {
  kind: RepresentationKind;
  templateId?: string;
  candidates: string[];
  reason: string;
};

/** Compatibility facade over the Phase-1 plan router. */
export function routeRepresentation(
  instance: SceneElementInstance,
  matches: ComponentMatch[] = [],
): RepresentationDecision {
  const plan = defaultRepresentationRouter.route(instance, { matches });
  return {
    kind: plan.kind === 'generic-geometry' ? 'voxel' : plan.kind,
    templateId: plan.templateId,
    candidates: matches.map((match) => match.template.id),
    reason: plan.reason.join('；'),
  };
}

export type { RepresentationKind } from './scene-elements.ts';
