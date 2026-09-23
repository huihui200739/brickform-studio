import type {
  RepresentationPlan,
  RepresentationRouter,
  RepresentationRoutingContext,
} from './representation-types.ts';
import type { SceneElementInstance } from '../scene/scene-types.ts';

/**
 * Routes an instance to an expression. Routing produces a plan only; it does
 * not remove cells, add bricks, or otherwise mutate the reconstruction.
 */
export class DefaultRepresentationRouter implements RepresentationRouter {
  route(
    instance: SceneElementInstance,
    context: RepresentationRoutingContext = {},
  ): RepresentationPlan {
    const matches = context.matches ?? [];
    const candidates = matches.map((match) => match.template.id);
    const best = matches[0];
    const confidence = Math.max(0, Math.min(1, best?.score ?? instance.confidence));
    if (instance.category === 'statue' || instance.category === 'person') {
      if (best?.template.id === 'statue-standing' && best.score >= 0.72)
        return {
          elementId: instance.id,
          kind: 'component',
          templateId: best.template.id,
          confidence,
          reason: ['high-confidence focal component'],
        };
      if (instance.imageMask && candidates.includes('statue-relief'))
        return {
          elementId: instance.id,
          kind: 'relief',
          templateId: 'statue-relief',
          confidence,
          reason: ['instance mask available for relief'],
        };
      if (candidates.includes('statue-simplified'))
        return {
          elementId: instance.id,
          kind: 'semantic-template',
          templateId: 'statue-simplified',
          confidence,
          reason: ['focal template preserves detected subject'],
        };
      return {
        elementId: instance.id,
        kind: 'generic-geometry',
        confidence,
        reason: ['no executable focal template; preserve source geometry'],
      };
    }
    if (best?.template.representation === 'component' && best.score >= 0.7)
      return {
        elementId: instance.id,
        kind: 'component',
        templateId: best.template.id,
        confidence,
        reason: ['registered component match'],
      };
    if (best)
      return {
        elementId: instance.id,
        kind: 'semantic-template',
        templateId: best.template.id,
        confidence,
        reason: ['registered semantic template match'],
      };
    return {
      elementId: instance.id,
      kind: 'generic-geometry',
      confidence,
      reason: ['no executable template; preserve source geometry'],
    };
  }
}

export const defaultRepresentationRouter = new DefaultRepresentationRouter();

export function routeSceneElement(
  instance: SceneElementInstance,
  context: RepresentationRoutingContext = {},
) {
  return defaultRepresentationRouter.route(instance, context);
}

export function routeSceneElements(
  instances: SceneElementInstance[],
  context: (instance: SceneElementInstance) => RepresentationRoutingContext =
    () => ({}),
) {
  return instances.map((instance) =>
    defaultRepresentationRouter.route(instance, context(instance)),
  );
}
