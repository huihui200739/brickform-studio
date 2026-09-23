import type { ComponentRegion } from './semantic-components.ts';
import { componentTemplate } from './component-library.ts';
import { groupSceneElements } from './scene/scene-grouping.ts';
import type { SceneElementGroup, SceneElementInstance } from './scene/scene-types.ts';

export type GroupConsistencyResult = {
  groups: SceneElementGroup[];
  changed: string[];
};

/**
 * Propagate one executable style through a repeated visual group. A member
 * can still be rejected later by placement validation, but it may not silently
 * fall back to a different style before that validation has a chance to run.
 */
export function enforceGroupConsistency(regions: ComponentRegion[]): GroupConsistencyResult {
  const elements = regions.map((region) => region.sceneElement).filter(Boolean) as SceneElementInstance[];
  const groups = groupSceneElements(elements);
  const changed: string[] = [];
  for (const group of groups.filter((candidate) => candidate.styleLock)) {
    const members = regions.filter((region) =>
      region.sceneElement && group.members.includes(region.sceneElement.id),
    );
    if (!members.length) continue;
    const counts = new Map<string, number>();
    for (const member of members) {
      const template = member.templateId || (member.kind === 'tree' ? 'tree-basic' : undefined);
      if (template) counts.set(template, (counts.get(template) || 0) + 1);
    }
    const preferred = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
    if (!preferred || !componentTemplate(preferred)) continue;
    const choices = [preferred, ...members.flatMap((member) => member.templateCandidates || [])]
      .filter((id, index, all) => all.indexOf(id) === index && !!componentTemplate(id));
    group.preferredTemplates = choices;
    for (const member of members) {
      if (member.templateId !== preferred) {
        member.templateId = preferred;
        member.representation = componentTemplate(preferred)?.representation === 'component'
          ? 'component'
          : 'semantic-template';
        changed.push(member.id);
      }
      member.templateCandidates = choices;
      if (member.sceneElement) member.sceneElement.groupId = group.id;
    }
  }
  return { groups, changed };
}
