import { PALETTE, isOpaquePaletteColor, type Brick } from './brick-engine.ts';
import type { ComponentMaterialDesign } from './component-materials.ts';
import { choosePartColor, type PartColorSubstitution } from './part-color-policy.ts';
import { partColorEvidence, type PurchaseSource, type PurchaseStatus } from './purchase-inventory.ts';

/** Roles come from planning, never from gray, part identity, a box, or "statue".
 * Stone gear means sculpted equipment, not a person's actual metal/accessories. */
export type ComponentMaterialRole =
  | 'body' | 'stone-gear' | 'stone'
  | 'metal' | 'accessory' | 'accent' | 'foliage' | 'wood' | 'flame'
  | 'mount' | 'unknown';
export type ComponentMaterialMember = {
  brickId: number;
  materialRole: ComponentMaterialRole;
  /** Explicit caller preservation; no spatial reservation guess. */
  reserved?: boolean;
};
export type ComponentMaterialIntent = {
  groupId: string;
  materialIntent: 'monolithic-stone' | 'multimaterial';
  paletteColor: number;
  members: readonly ComponentMaterialMember[];
  /** Rerun catalogue policy for a NEW explicit design target. This does not
   * supply new catalogue evidence; unknown target combinations need review. */
  reviewedSubstitutions?: 'preserve' | 're-evaluate';
} & (
  | { source: 'explicit-design'; referenceBinding?: never }
  | { source: 'reference-binding'; referenceBinding: ComponentMaterialDesign }
);
export type ComponentMaterialIntentEntry = {
  groupId: string;
  brickId: number;
  part: string;
  materialRole: ComponentMaterialRole;
  source: ComponentMaterialIntent['source'];
  from: number;
  target: number;
  status: 'changed' | 'unchanged' | 'protected' | 'blocked';
  reason:
    | 'same-material-design' | 'already-selected' | 'multimaterial-component'
    | 'unbound-reference' | 'protected-material-role' | 'reserved' | 'support'
    | 'reviewed-substitution' | 'invalid-opaque-palette' | 'catalog-unavailable';
  catalogStatus?: PurchaseStatus;
  catalogSource?: PurchaseSource;
  rejectedSubstitution?: PartColorSubstitution;
  priorColorChoice?: PartColorSubstitution;
};
export type ComponentMaterialIntentResult = {
  bricks: Brick[];
  audit: {
    method: 'component-material-intent-design';
    approximation: true;
    intrinsicMaterialVerified: false;
    stockChecked: false;
    changedBricks: number;
    catalogBlocked: number;
    reviewRequired: boolean;
    entries: ComponentMaterialIntentEntry[];
    limitations: string[];
  };
};
const ELIGIBLE_ROLES = new Set<ComponentMaterialRole>(['body', 'stone-gear', 'stone']);
const copyChoice = (choice: PartColorSubstitution): PartColorSubstitution => ({
  ...choice,
  source: { ...choice.source },
});

/** Apply a DESIGN palette without replacing geometry, poses, IDs, supports, or
 * source observations. Groups use final unique brick IDs (ordinary fallback
 * templates acquire these IDs only when committed). A markup/red box is
 * explicit-design, NOT reference material observation. The existing exact-mask
 * binding is positive palette evidence only alongside a monolithic plan. */
export function assignComponentMaterialIntent(
  bricks: readonly Brick[],
  groups: readonly ComponentMaterialIntent[],
): ComponentMaterialIntentResult {
  const byId = new Map(bricks.map((brick) => [brick.id, brick]));
  if (byId.size !== bricks.length) throw Error('Component material assignment requires unique brick IDs.');
  const owners = new Map<number, { group: ComponentMaterialIntent; member: ComponentMaterialMember }>();
  const groupIds = new Set<string>();
  for (const group of groups) {
    if (!group.groupId || groupIds.has(group.groupId)) throw Error('Component material group IDs must be unique and nonempty.');
    groupIds.add(group.groupId);
    for (const member of group.members) {
      if (!byId.has(member.brickId)) throw Error(`Component material member ${member.brickId} does not exist.`);
      if (owners.has(member.brickId)) throw Error(`Component material member ${member.brickId} has ambiguous group ownership.`);
      owners.set(member.brickId, { group, member });
    }
  }
  const entries: ComponentMaterialIntentEntry[] = [];
  const output = bricks.map((brick) => {
    const owner = owners.get(brick.id);
    if (!owner) return brick;
    const { group, member } = owner;
    const entry: ComponentMaterialIntentEntry = {
      groupId: group.groupId,
      brickId: brick.id,
      part: brick.part,
      materialRole: member.materialRole,
      source: group.source,
      from: brick.color,
      target: group.paletteColor,
      status: 'protected',
      reason: 'protected-material-role',
    };
    entries.push(entry);
    if (group.materialIntent !== 'monolithic-stone') {
      entry.reason = 'multimaterial-component';
      return brick;
    }
    if (group.source === 'reference-binding') {
      const binding = group.referenceBinding;
      if (
        binding?.method !== 'reference-instance-material-design' ||
        binding.source !== 'reference-mask' ||
        binding.status !== 'candidate' ||
        binding.targetColor !== group.paletteColor
      ) {
        entry.reason = 'unbound-reference';
        return brick;
      }
    } else if (group.source !== 'explicit-design') {
      entry.reason = 'unbound-reference';
      return brick;
    }
    if (!ELIGIBLE_ROLES.has(member.materialRole)) return brick;
    if (member.reserved) { entry.reason = 'reserved'; return brick; }
    if (brick.support) { entry.reason = 'support'; return brick; }
    // Reference radiance alone cannot discard a reviewed choice.
    const recheck = group.source === 'explicit-design' && group.reviewedSubstitutions === 're-evaluate';
    if (brick.colorChoice && !recheck) {
      entry.reason = 'reviewed-substitution';
      return brick;
    }
    const target = group.paletteColor;
    if (!isOpaquePaletteColor(target)) {
      entry.status = 'blocked';
      entry.reason = 'invalid-opaque-palette';
      return brick;
    }
    const selected = choosePartColor(brick.part, target);
    const evidence = partColorEvidence(brick.part);
    if (evidence) entry.catalogSource = { ...evidence.source };
    if (selected.color !== target || selected.substitution) {
      entry.status = 'blocked';
      entry.reason = 'catalog-unavailable';
      entry.catalogStatus = 'unsupported-color';
      if (selected.substitution) entry.rejectedSubstitution = copyChoice(selected.substitution);
      return brick;
    }
    entry.catalogStatus = evidence?.confirmedPaletteColors.includes(target)
      ? 'catalog-confirmed' : 'unverified';
    if (brick.color === target) {
      entry.status = 'unchanged';
      entry.reason = 'already-selected';
      return brick;
    }
    entry.status = 'changed';
    entry.reason = 'same-material-design';
    const { colorChoice, ...unchosen } = brick;
    if (colorChoice) entry.priorColorChoice = copyChoice(colorChoice);
    // Keep the existing unprinted-head caption truthful; text does not select
    // membership/roles and no general assembly instruction is rewritten.
    const installation = brick.installation?.replace(
      '无印刷灰色头部', `无印刷${PALETTE[target].name}头部`,
    );
    return {
      ...unchosen,
      color: target,
      ...(installation === undefined ? {} : { installation }),
    };
  });
  return {
    bricks: output,
    audit: {
      method: 'component-material-intent-design',
      approximation: true,
      intrinsicMaterialVerified: false,
      stockChecked: false,
      changedBricks: entries.filter((entry) => entry.status === 'changed').length,
      catalogBlocked: entries.filter((entry) => entry.reason === 'catalog-unavailable').length,
      reviewRequired: entries.some((entry) => entry.status === 'blocked' || entry.catalogStatus === 'unverified'),
      entries,
      limitations: [
        'Same-material intent is a design assignment, not recovered intrinsic albedo. Reference-mask candidates remain single-image approximations.',
        'Exact group membership and material roles come from planning. Metal, genuine accessories/accents, vegetation, flames, mounts, reserved bricks and supports are preserved.',
        'Only existing checked catalogue evidence is used. Unknown combinations need procurement review; no seller stock or physical build is verified.',
      ],
    },
  };
}
