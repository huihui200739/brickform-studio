export type {
  RepresentationKind,
  RepresentationPlan,
  RepresentationResult,
} from '../scene/scene-types.ts';

import type { SceneElementInstance } from '../scene/scene-types.ts';
import type { ComponentMatch } from '../component-retrieval.ts';

export type RepresentationRoutingContext = {
  matches?: ComponentMatch[];
  preferredTemplateIds?: string[];
};

export interface RepresentationRouter {
  route(
    instance: SceneElementInstance,
    context?: RepresentationRoutingContext,
  ): import('../scene/scene-types.ts').RepresentationPlan;
}
