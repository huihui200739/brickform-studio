import { ASSEMBLY_PARTS } from './assembly-catalog.ts';
import type { Brick, Model } from './brick-engine.ts';

export type AestheticBreakdown = {
  score: number;
  symmetryScore: number;
  contourClarityScore: number;
  largeBrickUsageScore: number;
  repetitionConsistencyScore: number;
  surfaceRegularityScore: number;
  focalElementVisibilityScore: number;
  noisySmallBrickPenalty: number;
  visibleSupportPenalty: number;
  randomVoxelNoisePenalty: number;
};

export function scorePackingChoice(input: {
  area: number;
  height: number;
  contacts: number;
  supporters: number;
  exactStack: boolean;
  small: boolean;
}) {
  return input.area * 8 + input.height * 2 + Math.min(12, input.contacts) * 3 + Math.min(4, input.supporters) * 2
    - (input.exactStack ? 8 : 0) - (input.small ? 7 : 0);
}

function symmetry(model: Model) {
  if (!model.bricks.length) return 0;
  const centre = model.width / 2;
  const occupied = new Set(model.bricks.map((b) => `${b.y}:${Math.round((b.x + b.w / 2) * 2)}`));
  let paired = 0;
  for (const b of model.bricks) {
    const mirror = Math.round((2 * centre - (b.x + b.w / 2)) * 2);
    if (occupied.has(`${b.y}:${mirror}`)) paired++;
  }
  return paired / model.bricks.length;
}

export function aestheticScore(model: Model): AestheticBreakdown {
  const measured = model.bricks.filter((b) => !!ASSEMBLY_PARTS[b.part]);
  const small = measured.filter((b) => b.w * b.d <= 2).length;
  const large = measured.filter((b) => b.w * b.d >= 6).length;
  const supports = measured.filter((b) => b.support).length;
  const repeated = new Map<string, number>();
  for (const b of measured) repeated.set(b.part, (repeated.get(b.part) || 0) + 1);
  const repetition = measured.length ? Math.max(...repeated.values()) / measured.length : 0;
  const score = Math.max(0, Math.min(1,
    symmetry(model) * 0.2 +
    (large / Math.max(1, measured.length)) * 0.18 +
    repetition * 0.15 +
    (1 - small / Math.max(1, measured.length)) * 0.2 +
    (1 - supports / Math.max(1, measured.length)) * 0.17 +
    (model.sceneElements?.some((e) => e.mustRepresent && e.outcome === 'committed') ? 0.1 : 0),
  ));
  return {
    score,
    symmetryScore: symmetry(model),
    contourClarityScore: large / Math.max(1, measured.length),
    largeBrickUsageScore: large / Math.max(1, measured.length),
    repetitionConsistencyScore: repetition,
    surfaceRegularityScore: 1 - small / Math.max(1, measured.length),
    focalElementVisibilityScore: model.sceneElements?.length ? (model.sceneElements.filter((e) => !e.mustRepresent || e.outcome === 'committed').length / model.sceneElements.length) : 1,
    noisySmallBrickPenalty: small / Math.max(1, measured.length),
    visibleSupportPenalty: supports / Math.max(1, measured.length),
    randomVoxelNoisePenalty: 0,
  };
}

