import type {
  RepresentationPlan,
  RepresentationRouter,
  RepresentationRoutingContext,
} from './representation-types.ts';
import type { SceneElementInstance } from '../scene/scene-types.ts';
import type { StructureCategory } from '../structure-classifier.ts';

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

/** Route scene-level landmarks before generic voxel packing is considered. */
export function routeStructureRepresentation(
  category: StructureCategory,
  confidence: number,
) {
  if ((category === 'lattice-tower' || category === 'tower') && confidence >= 0.62)
    return {
      kind: 'procedural-structure' as const,
      confidence,
      reason: ['open landmark structure uses procedural tower template'],
    };
  if (category === 'arch-structure' || category === 'stepped-monument')
    return {
      kind: 'parametric-structure' as const,
      confidence,
      reason: ['repeated architectural profile uses parametric structure'],
    };
  return {
    kind: 'generic-geometry' as const,
    confidence,
    reason: ['structure remains on the validated voxel route'],
  };
}

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
