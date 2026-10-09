import {
  PALETTE,
  isOpaquePaletteColor,
  type Brick,
  type Raster,
} from './brick-engine.ts';
import { lab, match } from './material-color-space.ts';
import { choosePartColor } from './part-color-policy.ts';
import type { SceneElementInstance } from './scene-elements.ts';
import {
  assignComponentMaterialIntent,
  type ComponentMaterialIntentResult,
  type ComponentMaterialRole,
} from './component-material-intent.ts';

export type ComponentMaterialDesign = {
  method: 'reference-instance-material-design';
  source: 'reference-mask' | 'template-default';
  status: 'candidate' | 'ambiguous' | 'unobserved';
  approximation: true;
  targetColor?: number;
  pixels: number;
  brightPixels: number;
  agreement: number;
  limitations: string[];
  /** Opt-in planning intent, not inferred intrinsic material. */
  materialIntent?: 'monolithic';
  materialIntentEvidence?: {
    method: 'material-first-single-material-design';
    sameFamilyAgreement: number;
    accentPixels: number;
    intrinsicMaterialVerified: false;
  };
};
const LIMITATIONS = [
  'A masked reference exposure is a design material candidate, not recovered intrinsic albedo. Shadows and genuine dark paint remain ambiguous in a single image.',
  'Only the statue template neutral body slot is eligible. Accessories, bases, identity, part geometry and poses are retained; unverified part/color combinations still require procurement review.',
];
// Explicit body slots used by the standing figure and ordinary-part statue
// fallbacks. Sharing the template gray does not make a helmet, shield, spear,
// mounting plate or unknown part eligible for the body's reference material.
const STATUE_BODY_PARTS = new Set([
  '3816c',
  '3815b',
  '3817c',
  '973',
  '3818',
  '3819',
  '3820',
  '3626c',
  '3003',
  '3004',
  '3005',
  '3023',
  '3024',
  '3710',
]);

/** Do not use a bounding box or a color hint as proof of object material. A
 * detector mask must refer to this exact raster, and must have enough opaque
 * samples. Legacy/manual builds without this explicit binding remain unchanged. */
export function bindComponentMaterial(
  instance: SceneElementInstance,
  image: Raster,
  options: { materialFirst?: boolean } = {},
): SceneElementInstance {
  if (instance.category !== 'statue') return instance;
  const result: ComponentMaterialDesign = {
    method: 'reference-instance-material-design',
    source: 'template-default',
    status: 'unobserved',
    approximation: true,
    pixels: 0,
    brightPixels: 0,
    agreement: 0,
    limitations: [...LIMITATIONS],
  };
  const mask = instance.imageMask,
    size = instance.imageMaskSize;
  const count = image.width * image.height;
  if (
    !mask ||
    !size ||
    size[0] !== image.width ||
    size[1] !== image.height ||
    mask.length !== count ||
    image.data.length !== count * 4
  )
    return { ...instance, materialDesign: result };
  const samples: {
    color: number;
    lightness: number;
    chroma: number;
    hue: number;
  }[] = [];
  for (let p = 0; p < count; p++) {
    if (!mask[p] || image.data[p * 4 + 3] !== 255) continue;
    const r = image.data[p * 4],
      g = image.data[p * 4 + 1],
      b = image.data[p * 4 + 2];
    const l = lab(r, g, b);
    samples.push({
      color: match(r, g, b),
      lightness: l[0],
      chroma: Math.hypot(l[1], l[2]),
      hue: Math.atan2(l[2], l[1]),
    });
  }
  result.source = 'reference-mask';
  result.pixels = samples.length;
  result.status = 'ambiguous';
  if (samples.length < 16) return { ...instance, materialDesign: result };
  samples.sort((a, b) => a.lightness - b.lightness);
  const bright = samples.slice(
    Math.floor(samples.length * 0.6),
    Math.ceil(samples.length * 0.9),
  );
  result.brightPixels = bright.length;
  if (bright.length < 5 || bright[bright.length - 1].lightness < 20)
    return { ...instance, materialDesign: result };
  const votes = new Map<number, number>();
  for (const sample of bright)
    votes.set(sample.color, (votes.get(sample.color) ?? 0) + 1);
  const ranking = [...votes].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const [color, votesForColor] = ranking[0];
  result.agreement = votesForColor / bright.length;
  // A clearly multicolored figure cannot be reduced to a single body material.
  // This is separate from low-light grayscale, which is inherently ambiguous.
  const winner = bright.find((sample) => sample.color === color)!;
  const distinct = samples.filter(
    (sample) =>
      sample.lightness >= 25 &&
      sample.chroma >= 18 &&
      winner.chroma >= 18 &&
      Math.abs(
        Math.atan2(
          Math.sin(sample.hue - winner.hue),
          Math.cos(sample.hue - winner.hue),
        ),
      ) >
        Math.PI / 4,
  );
  if (
    result.agreement < 0.7 ||
    distinct.length / samples.length > 0.12 ||
    !isOpaquePaletteColor(color)
  )
    return { ...instance, materialDesign: result };
  result.status = 'candidate';
  result.targetColor = color;
  if (options.materialFirst && result.agreement >= 0.85) {
    // Conservative same-family DESIGN agreement. Warm scalar stone shadows
    // retain their hue/chroma; sizable truly neutral/metal or distinct painted
    // accents do not. Neutral scalar shadows remain ambiguous and abstain when
    // their visible midtones form a contrasting neutral material candidate.
    const accentPixels = samples.filter((sample) => {
      const hueDifference = Math.abs(Math.atan2(
        Math.sin(sample.hue - winner.hue), Math.cos(sample.hue - winner.hue),
      ));
      if (winner.chroma >= 12) {
        return sample.chroma < Math.max(4, winner.chroma * 0.2) ||
          (sample.chroma >= 8 && hueDifference > Math.PI / 6);
      }
      return sample.chroma >= 14 ||
        (sample.lightness >= 25 && Math.abs(sample.lightness - winner.lightness) > 18);
    }).length;
    const sameFamilyAgreement = 1 - accentPixels / samples.length;
    if (sameFamilyAgreement >= 0.94) {
      result.materialIntent = 'monolithic';
      result.materialIntentEvidence = {
        method: 'material-first-single-material-design', sameFamilyAgreement,
        accentPixels, intrinsicMaterialVerified: false,
      };
      result.limitations = [
        LIMITATIONS[0],
        'Material-first opt-in declares a single-material statue DESIGN from an exact-mask candidate. Only known neutral body and sculpted template gear are rebound; mounts, actual accents, unknown parts, supports and human-reviewed choices remain protected. Unknown catalogue combinations need review; no stock verified.',
      ];
    }
  }
  return { ...instance, materialDesign: result };
}

const STATUE_STONE_GEAR = new Set(['3844', '3846', '4497']);
export type StatueMaterialAssignmentAudit = Omit<ComponentMaterialIntentResult['audit'], 'entries'> & {
  entries: (ComponentMaterialIntentResult['audit']['entries'][number] & { localIndex: number })[];
  referenceDesign: {
    method: 'material-first-reference-design';
    source: 'reference-mask';
    targetColor: number;
    pixels: number;
    agreement: number;
    sameFamilyAgreement: number;
    intrinsicMaterialVerified: false;
  };
};

/** Only the exact catalogue-policy stamp generated by the default gray spear
 * may be reevaluated by this new design plan. Unknown/human choices stay locked. */
function defaultSpearChoice(part: Brick) {
  const expected = choosePartColor('4497', 11), choice = part.colorChoice;
  return part.part === '4497' && !!choice && !!expected.substitution &&
    part.color === expected.color && choice.requestedColor === 11 &&
    choice.selectedColor === expected.color && choice.reason === expected.substitution.reason &&
    choice.source.url === expected.substitution.source.url &&
    choice.source.kind === expected.substitution.source.kind &&
    choice.source.checkedAt === expected.substitution.source.checkedAt;
}
function monolithicStatueAssignment(parts: Brick[], instance?: SceneElementInstance): {
  parts: Brick[];
  audit: StatueMaterialAssignmentAudit;
} | undefined {
  const design = instance?.materialDesign;
  if (
    instance?.category !== 'statue' || design?.materialIntent !== 'monolithic' ||
    design.source !== 'reference-mask' || design.status !== 'candidate' ||
    design.method !== 'reference-instance-material-design' ||
    design.targetColor === undefined || !isOpaquePaletteColor(design.targetColor) ||
    design.materialIntentEvidence?.method !== 'material-first-single-material-design'
  ) return undefined;
  // Template fallbacks use id=0 repeatedly. Temporary local IDs never escape
  // into installed geometry or replace the original component identity.
  const local = parts.map((part, index) => ({ ...part, id: index + 1 }));
  const result = assignComponentMaterialIntent(local, [{
    groupId: instance.id,
    materialIntent: 'monolithic-stone', paletteColor: design.targetColor,
    source: 'explicit-design', reviewedSubstitutions: 're-evaluate',
    members: parts.map((part, index) => {
      const autoSpear = defaultSpearChoice(part);
      const role: ComponentMaterialRole = STATUE_BODY_PARTS.has(part.part) && part.color === 11
        ? 'body' : STATUE_STONE_GEAR.has(part.part) && (part.color === 11 || autoSpear)
          ? 'stone-gear' : 'unknown';
      return { brickId: index + 1, materialRole: role, reserved: !!part.colorChoice && !autoSpear };
    }),
  }]);
  return {
    parts: result.bricks.map((part, index) => part === local[index]
      ? parts[index] : { ...part, id: parts[index].id }),
    audit: {
      ...result.audit,
      entries: result.audit.entries.map((entry) => ({
        ...entry, brickId: parts[entry.brickId - 1].id, localIndex: entry.brickId - 1,
      })),
      referenceDesign: {
        method: 'material-first-reference-design', source: 'reference-mask',
        targetColor: design.targetColor, pixels: design.pixels,
        agreement: design.agreement,
        sameFamilyAgreement: design.materialIntentEvidence.sameFamilyAgreement,
        intrinsicMaterialVerified: false,
      },
    },
  };
}

/** Detached assignment evidence for callers that persist design audits. Neither
 * this function nor the compatibility array wrapper mutates a Scene instance. */
export function materializeStatueBodyWithAudit(parts: Brick[], instance?: SceneElementInstance): {
  parts: Brick[];
  audit?: StatueMaterialAssignmentAudit;
} {
  return monolithicStatueAssignment(parts, instance) ?? { parts: materializeStatueBody(parts, instance) };
}

/** Legacy bindings rebind only neutral body. Opt-in monolithic bindings also
 * rebind known sculpted gear via the generic utility and actual catalog policy. */
export function materializeStatueBody(
  parts: Brick[],
  instance?: SceneElementInstance,
): Brick[] {
  const design = instance?.materialDesign;
  if (
    design?.status !== 'candidate' ||
    design.targetColor === undefined ||
    !isOpaquePaletteColor(design.targetColor)
  )
    return parts;
  const monolithic = monolithicStatueAssignment(parts, instance);
  if (monolithic) return monolithic.parts;
  const target = design.targetColor;
  return parts.map((part) => {
    if (
      part.color !== 11 ||
      part.colorChoice ||
      !STATUE_BODY_PARTS.has(part.part)
    )
      return part;
    const selected = choosePartColor(part.part, target);
    if (selected.color !== target || selected.substitution) return part;
    if (part.color === target) return part;
    return {
      ...part,
      color: target,
      ...(part.installation
        ? {
            installation: part.installation.replace(
              '无印刷灰色头部',
              `无印刷${PALETTE[target].name}头部`,
            ),
          }
        : {}),
    };
  });
}
