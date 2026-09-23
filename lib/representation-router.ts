import type { ComponentMatch } from './component-retrieval.ts';
import type { RepresentationKind, SceneElementInstance } from './scene-elements.ts';

export type RepresentationDecision = {
  kind: RepresentationKind;
  templateId?: string;
  candidates: string[];
  reason: string;
};

/** Chooses an expression before assembly. It is deterministic and instance based. */
export function routeRepresentation(
  instance: SceneElementInstance,
  matches: ComponentMatch[] = [],
): RepresentationDecision {
  const candidates = matches.map((m) => m.template.id);
  const best = matches[0];
  if (instance.category === 'statue') {
    if (best?.template.id === 'statue-standing' && best.score >= 0.72)
      return { kind: 'component', templateId: best.template.id, candidates, reason: '高置信度人物组件' };
    if (instance.imageMask && candidates.includes('statue-relief'))
      return { kind: 'relief', templateId: 'statue-relief', candidates, reason: '参考图轮廓可生成浮雕' };
    if (candidates.includes('statue-simplified'))
      return { kind: 'semantic-template', templateId: 'statue-simplified', candidates, reason: '简化主视觉雕像保留存在感' };
    return { kind: 'voxel', candidates, reason: '保留主体体素，避免雕像消失' };
  }
  if (best?.template.representation === 'component' && best.score >= 0.7)
    return { kind: 'component', templateId: best.template.id, candidates, reason: '固定组件匹配' };
  if (best)
    return { kind: 'semantic-template', templateId: best.template.id, candidates, reason: '参数化语义模板匹配' };
  return { kind: 'voxel', candidates, reason: '没有可执行模板，保留原始体素' };
}
