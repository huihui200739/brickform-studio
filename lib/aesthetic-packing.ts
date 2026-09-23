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

function gridValid(model: Model) {
  const occupied = new Map<string, number>();
  const links = new Map<number, Set<number>>();
  for (const brick of model.bricks) {
    links.set(brick.id, new Set());
    for (let y = brick.y; y < brick.y + brick.h; y++)
      for (let x = brick.x; x < brick.x + brick.w; x++)
        for (let z = brick.z; z < brick.z + brick.d; z++) {
          const key = `${x},${y},${z}`;
          if (occupied.has(key)) return false;
          occupied.set(key, brick.id);
        }
  }
  for (const brick of model.bricks) {
    if (brick.y === 0) continue;
    for (let x = brick.x; x < brick.x + brick.w; x++)
      for (let z = brick.z; z < brick.z + brick.d; z++) {
        const below = occupied.get(`${x},${brick.y - 1},${z}`);
        if (below && below !== brick.id) {
          links.get(brick.id)!.add(below);
          links.get(below)!.add(brick.id);
        }
      }
    if (!links.get(brick.id)!.size) return false;
  }
  const seen = new Set<number>();
  const queue = model.bricks.length ? [model.bricks[0].id] : [];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...links.get(id)!);
  }
  return seen.size === model.bricks.length;
}

/** Remove only redundant hidden support columns, preserving every valid model. */
export function optimizeAestheticPacking(model: Model, maxAttempts = 256) {
  if (!model.bricks.length) return { removed: 0, model };
  const reserved = new Set(model.semanticReservedCells || []);
  const candidates = model.bricks
    .filter((brick) => brick.support && brick.y >= 1 && !brick.section?.startsWith('component-'))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z);
  let removed = 0;
  for (const candidate of candidates.slice(0, maxAttempts)) {
    const occupiedByReserved = [...reserved].some((key) => {
      const [x, y, z] = key.split(',').map(Number);
      return x >= candidate.x && x < candidate.x + candidate.w && y >= candidate.y && y < candidate.y + candidate.h && z >= candidate.z && z < candidate.z + candidate.d;
    });
    if (occupiedByReserved) continue;
    const next = model.bricks.filter((brick) => brick.id !== candidate.id);
    if (!gridValid({ ...model, bricks: next })) continue;
    // Keep IDs stable while iterating over the candidate snapshot. They are
    // renumbered once after all accepted removals.
    model.bricks = next;
    removed++;
  }
  model.bricks = model.bricks.map((brick, index) => ({ ...brick, id: index + 1 }));
  model.supportCount = model.bricks.filter((brick) => brick.support).length;
  model.levels = [...new Set(model.bricks.map((brick) => brick.y))].sort((a, b) => a - b);
  model.aesthetic = aestheticScore(model);
  return { removed, model };
}
