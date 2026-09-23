import type {
  ElementCategory,
  SceneElementGroup,
  SceneElementInstance,
} from './scene-types.ts';

const GROUPABLE: ElementCategory[] = ['tree', 'plant', 'lamp', 'decor'];

function layoutFor(members: SceneElementInstance[]): SceneElementGroup['layout'] {
  const xs = members.map((m) => m.anchorUV?.[0] ?? m.imageBox?.x ?? 0.5);
  const ys = members.map((m) => m.anchorUV?.[1] ?? m.imageBox?.y ?? 0.5);
  const xSpan = Math.max(...xs) - Math.min(...xs);
  const ySpan = Math.max(...ys) - Math.min(...ys);
  if (members.length < 3) return ySpan < 0.06 ? 'line' : 'scattered';
  if (ySpan < 0.06) return 'line';
  if (xSpan < 0.06) return 'line';
  return xSpan > 0.12 && ySpan > 0.12 ? 'cluster' : 'scattered';
}

/** Groups instances for style propagation without changing their geometry. */
export function groupSceneElements(
  instances: SceneElementInstance[],
): SceneElementGroup[] {
  const groups: SceneElementGroup[] = [];
  for (const category of GROUPABLE) {
    const members = instances
      .filter((instance) => instance.category === category && instance.imageBox)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (members.length < 2) continue;
    const id = `group-${category}-${members[0].id}`;
    const group: SceneElementGroup = {
      id,
      category,
      members: members.map((member) => member.id),
      layout: layoutFor(members),
      styleLock: category === 'tree' || category === 'plant',
      preferredTemplates: [],
    };
    groups.push(group);
    for (const member of members) member.groupId = id;
  }
  return groups;
}

export type LegacySceneGroup = SceneElementGroup & {
  layoutHint: SceneElementGroup['layout'];
  styleLocked: boolean;
  templatePreference: string[];
  templateChoices: string[];
};

/** Adapter for the existing assembly/reporting API. */
export function toLegacySceneGroups(
  groups: SceneElementGroup[],
): LegacySceneGroup[] {
  return groups.map((group) => ({
    ...group,
    layoutHint: group.layout,
    styleLocked: group.styleLock,
    templatePreference: group.preferredTemplates,
    templateChoices: group.preferredTemplates,
  }));
}
