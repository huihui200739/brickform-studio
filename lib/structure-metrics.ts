import { ASSEMBLY_PARTS } from './assembly-catalog.ts';
import { validateModel, type Brick, type Model } from './brick-engine.ts';

export type StructureMetrics = {
  totalParts: number;
  measuredParts: number;
  excludedParts: number;
  addedSupportParts: number;
  smallParts: number;
  smallPartRate: number;
  aboveGroundParts: number;
  bridgeCandidateParts: number;
  exactStackedParts: number;
  exactStackRate: number;
  multiSupportParts: number;
  multiSupportRate: number;
  lowContactParts: number;
  lowContactRate: number;
  supportInterfaces: number;
  singleStudInterfaces: number;
  singleStudInterfaceRate: number;
  averageSupportPartners: number;
  maxExactStackRun: number;
  validation: ReturnType<typeof validateModel>;
};

type Options = { minBridgeArea?: number; lowContactRatio?: number };
type Support = { contacts: number; ids: Set<number> };

const GRID_KINDS = new Set(['brick', 'plate', 'tile']);
const cellKey = (x: number, y: number, z: number) => `${x},${y},${z}`;
const rate = (value: number, total: number) => (total ? value / total : 0);

function isGridPart(brick: Brick) {
  const part = ASSEMBLY_PARTS[brick.part];
  return (
    !!part &&
    GRID_KINDS.has(part.kind) &&
    [brick.x, brick.y, brick.z, brick.w, brick.d, brick.h].every(
      Number.isInteger,
    )
  );
}

function sameFootprint(a: Brick, b: Brick) {
  return a.x === b.x && a.z === b.z && a.w === b.w && a.d === b.d;
}

/**
 * Deterministic, geometry-only buildability indicators for grid-aligned parts.
 * They describe stud contact and brick bonding; they are not a force simulation
 * or a claim that a real model is physically stable.
 */
export function analyzeStructure(
  model: Model,
  options: Options = {},
): StructureMetrics {
  const minBridgeArea = options.minBridgeArea ?? 4;
  const lowContactRatio = options.lowContactRatio ?? 0.5;
  const measured = model.bricks.filter(isGridPart);
  const byId = new Map(measured.map((brick) => [brick.id, brick]));
  const topStuds = new Map<string, Set<number>>();

  // Tiles have bottom sockets but no top studs, so they may be measured as an
  // upper part without being counted as a legal support for another part.
  for (const brick of measured) {
    const part = ASSEMBLY_PARTS[brick.part];
    if (!['brick', 'plate'].includes(part.kind)) continue;
    for (let x = brick.x; x < brick.x + brick.w; x++)
      for (let z = brick.z; z < brick.z + brick.d; z++) {
        const key = cellKey(x, brick.y + brick.h, z);
        const ids = topStuds.get(key) || new Set<number>();
        ids.add(brick.id);
        topStuds.set(key, ids);
      }
  }

  const supports = new Map<number, Support>();
  for (const brick of measured) {
    if (brick.y === 0) continue;
    const ids = new Set<number>();
    let contacts = 0;
    for (let x = brick.x; x < brick.x + brick.w; x++)
      for (let z = brick.z; z < brick.z + brick.d; z++) {
        const below = topStuds.get(cellKey(x, brick.y, z));
        if (!below?.size) continue;
        const others = [...below].filter((id) => id !== brick.id);
        if (!others.length) continue;
        contacts++;
        others.forEach((id) => ids.add(id));
      }
    supports.set(brick.id, { contacts, ids });
  }

  const aboveGround = measured.filter((brick) => brick.y > 0);
  const bridgeCandidates = aboveGround.filter(
    (brick) => brick.w * brick.d >= minBridgeArea,
  );
  const exactParents = new Map<number, number>();
  let exactStackedParts = 0;
  let multiSupportParts = 0;
  let lowContactParts = 0;
  let supportInterfaces = 0;
  let singleStudInterfaces = 0;
  let supportPartnerTotal = 0;

  for (const brick of aboveGround) {
    const support = supports.get(brick.id)!;
    supportPartnerTotal += support.ids.size;
    const contactsById = new Map<number, number>();
    for (let x = brick.x; x < brick.x + brick.w; x++)
      for (let z = brick.z; z < brick.z + brick.d; z++)
        for (const id of topStuds.get(cellKey(x, brick.y, z)) || [])
          if (id !== brick.id)
            contactsById.set(id, (contactsById.get(id) || 0) + 1);
    supportInterfaces += contactsById.size;
    singleStudInterfaces += [...contactsById.values()].filter(
      (contacts) => contacts === 1,
    ).length;
    if (support.contacts / (brick.w * brick.d) < lowContactRatio)
      lowContactParts++;
  }

  for (const brick of bridgeCandidates) {
    const support = supports.get(brick.id)!;
    if (support.ids.size >= 2) multiSupportParts++;
    if (support.ids.size !== 1) continue;
    const parentId = [...support.ids][0];
    const parent = byId.get(parentId);
    if (parent && sameFootprint(brick, parent)) {
      exactStackedParts++;
      exactParents.set(brick.id, parentId);
    }
  }

  const runMemo = new Map<number, number>();
  const exactRun = (id: number): number => {
    const cached = runMemo.get(id);
    if (cached !== undefined) return cached;
    const parent = exactParents.get(id);
    const run = parent === undefined ? 0 : 1 + exactRun(parent);
    runMemo.set(id, run);
    return run;
  };
  const maxExactStackRun = Math.max(
    0,
    ...bridgeCandidates.map((brick) => exactRun(brick.id)),
  );
  const smallParts = measured.filter((brick) => brick.w * brick.d <= 2).length;

  return {
    totalParts: model.bricks.length,
    measuredParts: measured.length,
    excludedParts: model.bricks.length - measured.length,
    addedSupportParts: model.bricks.filter((brick) => brick.support).length,
    smallParts,
    smallPartRate: rate(smallParts, measured.length),
    aboveGroundParts: aboveGround.length,
    bridgeCandidateParts: bridgeCandidates.length,
    exactStackedParts,
    exactStackRate: rate(exactStackedParts, bridgeCandidates.length),
    multiSupportParts,
    multiSupportRate: rate(multiSupportParts, bridgeCandidates.length),
    lowContactParts,
    lowContactRate: rate(lowContactParts, aboveGround.length),
    supportInterfaces,
    singleStudInterfaces,
    singleStudInterfaceRate: rate(singleStudInterfaces, supportInterfaces),
    averageSupportPartners: rate(supportPartnerTotal, aboveGround.length),
    maxExactStackRun,
    validation: validateModel(model),
  };
}
