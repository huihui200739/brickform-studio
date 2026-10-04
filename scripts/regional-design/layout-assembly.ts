import { planGridAssembly } from '../../lib/connection-plan.ts';
import {
  validateModel,
  type Brick,
  type Model,
} from '../../lib/brick-engine.ts';
import { auditDesignGeometry } from '../../lib/design-geometry.ts';
import { procurementReport } from '../../lib/purchase-inventory.ts';
import {
  uprightCatalogBrick,
  type UprightLayoutCandidate,
} from './upright-layout.ts';
import { ASSEMBLY_PARTS } from '../../lib/assembly-catalog.ts';

/** One bounded retry may join same-color, same-bottom neighbors at a failed
 * generated support interface. It adds no target occupancy and grants no edits
 * to deliberate construction, tiles or semantic components. */
export function supportInterfaceParts(
  baseline: Model,
  unresolvedIDs: readonly number[],
) {
  const interfaces = new Set<number>(),
    supports = new Set<number>();
  const ordinary = (b: Brick) =>
    !b.construction &&
    !b.installation &&
    !b.colorChoice &&
    !b.section?.startsWith('component-') &&
    ['brick', 'plate'].includes(ASSEMBLY_PARTS[b.part]?.kind);
  for (const id of unresolvedIDs) {
    const b = baseline.bricks.find((b) => b.id === id);
    if (!b?.support || !ordinary(b)) continue;
    for (const neighbor of baseline.bricks) {
      if (
        neighbor.id === b.id ||
        !ordinary(neighbor) ||
        neighbor.y !== b.y ||
        neighbor.color !== b.color
      )
        continue;
      const xContact =
        (neighbor.x + neighbor.w === b.x || b.x + b.w === neighbor.x) &&
        Math.min(neighbor.z + neighbor.d, b.z + b.d) >
          Math.max(neighbor.z, b.z);
      const zContact =
        (neighbor.z + neighbor.d === b.z || b.z + b.d === neighbor.z) &&
        Math.min(neighbor.x + neighbor.w, b.x + b.w) >
          Math.max(neighbor.x, b.x);
      if (!xContact && !zContact) continue;
      interfaces.add(b.id);
      interfaces.add(neighbor.id);
      supports.add(b.id);
      if (neighbor.support) supports.add(neighbor.id);
      if (interfaces.size > 32) return undefined;
    }
  }
  return interfaces.size
    ? {
        interfacePartIds: interfaces,
        reconstructSupportIds: supports,
        allowSupportSectionMerge: true,
      }
    : undefined;
}

function occupancy(bricks: readonly Brick[]) {
  const cells = new Map<string, Set<number>>();
  let work = 0;
  for (const b of bricks) {
    if (
      ![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isFinite) ||
      b.w <= 0 ||
      b.h <= 0 ||
      b.d <= 0
    )
      throw Error('unresolved body envelope');
    for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
      for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
        for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++) {
          if (++work > 2000000)
            throw Error('assembly envelope work budget exceeded');
          const k = `${x},${y},${z}`;
          const colors = cells.get(k) ?? new Set<number>();
          colors.add(b.color);
          cells.set(k, colors);
        }
  }
  return new Map(
    [...cells].map(([k, colors]) => [
      k,
      [...colors].sort((a, b) => a - b).join(','),
    ]),
  );
}
export function auditLayoutAssembly(
  baseline: Model,
  candidate: UprightLayoutCandidate,
) {
  try {
    if (!baseline.assembly || candidate.bricks.length > 14000)
      throw Error('missing or over-budget baseline assembly');
    const beforeParts = new Map(baseline.bricks.map((b) => [b.id, b]));
    const afterParts = new Map(candidate.bricks.map((b) => [b.id, b]));
    if (
      beforeParts.size !== baseline.bricks.length ||
      afterParts.size !== candidate.bricks.length
    )
      throw Error('duplicate assembly part IDs');
    for (const b of baseline.bricks)
      if (
        ((b.support && !candidate.reconstructedSupportIDs.includes(b.id)) ||
          b.construction ||
          b.installation ||
          b.colorChoice ||
          b.section?.startsWith('component-')) &&
        JSON.stringify(b) !== JSON.stringify(afterParts.get(b.id))
      )
        throw Error('protected construction/support/component changed');
    const removed = new Set(candidate.removedIDs),
      retained = new Set(candidate.retainedIDs),
      added = new Set(candidate.addedIDs);
    if (
      removed.size !== candidate.removedIDs.length ||
      retained.size !== candidate.retainedIDs.length ||
      added.size !== candidate.addedIDs.length ||
      [...beforeParts.keys()].some(
        (id) => removed.has(id) === retained.has(id),
      ) ||
      [...retained].some((id) => !beforeParts.has(id)) ||
      [...removed].some((id) => !beforeParts.has(id) || afterParts.has(id)) ||
      [...added].some((id) => beforeParts.has(id) || !afterParts.has(id)) ||
      afterParts.size !== retained.size + added.size ||
      [...afterParts.keys()].some((id) => !retained.has(id) && !added.has(id))
    )
      throw Error('incomplete replacement part ledger');
    for (const id of added) {
      const b = afterParts.get(id)!;
      const expected = uprightCatalogBrick(
        b.part,
        b.x,
        b.y,
        b.z,
        b.rotation ?? 0,
        b.color,
        b.id,
        baseline,
      );
      if (
        !b.pose ||
        b.pose.matrix.length !== 9 ||
        b.pose.position.length !== 3 ||
        ![...b.pose.matrix, ...b.pose.position].every(Number.isFinite) ||
        b.w !== expected.w ||
        b.h !== expected.h ||
        b.d !== expected.d ||
        b.pose.matrix.some(
          (v, i) => Math.abs(v - expected.pose!.matrix[i]) > 1e-6,
        ) ||
        b.pose.position.some(
          (v, i) => Math.abs(v - expected.pose!.position[i]) > 1e-6,
        )
      )
        throw Error(
          'added catalog pose does not match its declared body placement',
        );
    }
    if (
      candidate.reconstructedSupportIDs.some(
        (id) => !beforeParts.get(id)?.support || !removed.has(id),
      )
    )
      throw Error('invalid support reconstruction ledger');
    for (const id of candidate.retainedIDs)
      if (
        JSON.stringify(beforeParts.get(id)) !==
        JSON.stringify(afterParts.get(id))
      )
        throw Error('retained part changed before assembly audit');
    const before = occupancy(baseline.bricks),
      after = occupancy(candidate.bricks);
    const changes = new Map(candidate.changedCells.map((c) => [c.key, c]));
    for (const k of new Set([...before.keys(), ...after.keys()])) {
      const expected = changes.get(k);
      if (expected) {
        if (
          before.get(k) !==
            (expected.before ? String(expected.before.color) : undefined) ||
          after.get(k) !==
            (expected.after ? String(expected.after.color) : undefined)
        )
          throw Error('declared change does not match final body/color');
      } else if (before.get(k) !== after.get(k))
        throw Error('outside body occupancy or color changed');
    }
    const components = candidate.bricks
      .filter((b) => b.section?.startsWith('component-'))
      .sort((a, b) => (a.step ?? 0) - (b.step ?? 0) || a.id - b.id);
    const plan = planGridAssembly(
      candidate.bricks.filter((b) => !b.section?.startsWith('component-')),
    );
    if (plan.unresolved.length)
      return {
        status: 'rejected' as const,
        reasons: ['whole-model connection/final-approach plan unresolved'],
        unresolvedPartIds: plan.unresolved,
        assemblyAudited: true,
        accepted: false,
      };
    const model = structuredClone(baseline);
    // Retain IDs, poses, construction and semantic metadata. Only the ordinary
    // placement order is replanned; special component internals stay in order.
    const ordinary = plan.ordered.map(({ brick, move }, index) => ({
      ...structuredClone(brick),
      step: index,
      assemblyMove: move,
    }));
    model.bricks = [
      ...ordinary,
      ...components.map((brick, index) => ({
        ...structuredClone(brick),
        step: ordinary.length + index,
      })),
    ];
    model.levels = model.bricks.map((_, index) => index);
    model.supportCount = model.bricks.filter((b) => b.support).length;
    model.assembly!.steps = model.bricks.map((b) => ({
      name: b.section?.startsWith('component-')
        ? '组件连接'
        : b.assemblyMove?.direction === 'up'
          ? '下方扣接'
          : '主体连接',
      description:
        '局部设计实验；连接与最终一层接近已重规划，完整装入路径未验证。',
      section: b.section ?? 'subject',
    }));
    const validation = validateModel(model);
    const geometry = model.designGeometry
      ? auditDesignGeometry(model, model.designGeometry)
      : undefined;
    const procurement = procurementReport(model);
    return {
      status: 'audited' as const,
      model,
      assemblyAudited: true,
      softwareConnected:
        validation.connected &&
        !validation.invalidParts &&
        !validation.collisions &&
        !validation.unsupported,
      declaredGeometryPassed: geometry?.passed ?? null,
      validation,
      geometry,
      outsideNominalOccupancyColorChanges: 0,
      replannedParts: ordinary.length,
      semanticPartsRetained: components.length,
      reconstructedSupportIDs: candidate.reconstructedSupportIDs,
      procurement: {
        unverifiedLines: procurement.unverified,
        unsupportedColors: procurement.unsupportedColors,
        stockChecked: procurement.stockChecked,
        requiresReview: procurement.requiresReview,
        assemblyStepsRequireReview: procurement.assemblyStepsRequireReview,
      },
      fullInsertionPathVerified: false,
      physicalBuildVerified: false,
      accepted: false,
    };
  } catch (error) {
    return {
      status: 'rejected' as const,
      reasons: [error instanceof Error ? error.message : String(error)],
      assemblyAudited: true,
      accepted: false,
    };
  }
}
