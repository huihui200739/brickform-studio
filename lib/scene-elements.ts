export type SceneCategory =
  | 'tree'
  | 'plant'
  | 'statue'
  | 'brazier'
  | 'lamp'
  | 'fountain'
  | 'stairs'
  | 'column'
  | 'door'
  | 'window'
  | 'bench'
  | 'vehicle'
  | 'animal'
  | 'furniture'
  | 'decor'
  | 'unknown';
export type RepresentationKind =
  | 'component'
  | 'semantic-template'
  | 'parametric-structure'
  | 'procedural-structure'
  | 'relief'
  | 'voxel';
export type SceneElementInstance = {
  id: string;
  category: SceneCategory;
  confidence: number;
  imageBox?: { x: number; y: number; width: number; height: number };
  imageMask?: Uint8Array;
  anchorUV?: [number, number];
  bbox3d?: { min: [number, number, number]; max: [number, number, number] };
  worldAnchor?: [number, number, number];
  scaleHint?: { width: number; depth: number; height: number };
  colorHints?: number[];
  shapeEmbedding?: number[];
  evidence?: string[];
  imageMaskSize?: [number, number];
  anchorKind?: 'ground' | 'wall' | 'surface' | 'free';
  groupId?: string;
  importance?: 'primary' | 'secondary' | 'background';
  importanceScore?: number;
  chosenRepresentation?: RepresentationKind;
  chosenTemplateId?: string;
  outcome?: 'pending' | 'committed' | 'preserved';
  reason?: string;
};

export type SceneElement = SceneElementInstance;
export type RepeatedElementGroup = {
  id: string;
  category: 'tree' | 'plant' | 'lamp' | 'decor';
  members: string[];
  layoutHint?: 'line' | 'ring' | 'symmetric' | 'scattered';
  templatePreference?: string[];
};
/** IDs depend on geometry, never confidence sorting or the number of instances. */
export function instanceId(
  category: SceneCategory,
  box: NonNullable<SceneElementInstance['imageBox']>,
) {
  return `${category}-${[box.x, box.y, box.width, box.height].map((v) => Math.round(v * 10000)).join('-')}`;
}
export function repeatedGroups(
  instances: SceneElementInstance[],
): RepeatedElementGroup[] {
  const groups: RepeatedElementGroup[] = [];
  for (const category of ['tree', 'plant', 'lamp', 'decor'] as const) {
    const members = instances
      .filter((i) => i.category === category && i.imageBox)
      .sort((a, b) => a.id.localeCompare(b.id));
    if (members.length < 2) continue;
    const ys = members.map((i) => i.anchorUV?.[1] ?? i.imageBox!.y);
    const id = `group-${category}-${members[0].id}`;
    groups.push({
      id,
      category,
      members: members.map((i) => i.id),
      layoutHint:
        Math.max(...ys) - Math.min(...ys) < 0.06 ? 'line' : 'scattered',
    });
    for (const member of members) member.groupId = id;
  }
  return groups;
}
