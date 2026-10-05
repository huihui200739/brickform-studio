import { ASSEMBLY_PARTS, type V3 } from '../../lib/assembly-catalog.ts';
import type { Brick, Model } from '../../lib/brick-engine.ts';
import {
  loadCatalogGeometry,
  type SurfaceScoreInput,
} from './catalog-surface-score.ts';
import {
  proposeExteriorVoid,
  type ExteriorVoidInput,
  type ExteriorVoidResult,
} from './exterior-void.ts';
import {
  auditLayoutAssembly,
  supportInterfaceParts,
} from './layout-assembly.ts';
import {
  proposeUprightLayouts,
  uprightCatalogBrick,
  type UprightLayoutCandidate,
  type UprightLayoutResult,
} from './upright-layout.ts';

export type ExteriorLayoutInput = {
  /** Complete original source after physical-stud normalization, never fitted. */
  source: ExteriorVoidInput['source'];
  axis: ExteriorVoidInput['axis'];
  direction: ExteriorVoidInput['direction'];
  coverageMode?: ExteriorVoidInput['coverageMode'];
  baselineModel: Model;
  /** Occupancy/color which the source void must not remove. */
  preserveCells?: ReadonlySet<string>;
  /** May only tighten the actual surface scorer's work limits. */
  scoreLimits?: SurfaceScoreInput['limits'];
};
type AssemblyAudit = ReturnType<typeof auditLayoutAssembly>;
export type ExteriorLayoutCandidate = {
  attempt: 'initial' | 'support-interface-retry';
  layout: UprightLayoutCandidate;
  improvement: {
    status: 'improving' | 'not-improving' | 'unavailable' | 'over-budget';
    reasons: string[];
    sourceRmsGainStuds?: number;
    symmetricRmsGainStuds?: number;
  };
  /** Every improving candidate receives its own complete final-model audit. */
  audit?: AssemblyAudit;
  softwareCandidate: boolean;
};
export type ExteriorLayoutResult = {
  status: 'software-candidate' | 'noop' | 'rejected' | 'unresolved';
  /** Independent baseline copy unless a complete audited candidate is selected. */
  model: Model;
  sourceVoid?: ExteriorVoidResult;
  views: V3[];
  editableCells: string[];
  protectedExteriorCells: {
    key: string;
    partIds: number[];
    reasons: string[];
  }[];
  attempts: {
    kind: 'initial' | 'support-interface-retry';
    layoutStatus: UprightLayoutResult['status'];
    reasons: string[];
    candidateIndices: number[];
    interfacePartIds: number[];
    reconstructSupportIds: number[];
  }[];
  candidates: ExteriorLayoutCandidate[];
  softwareCandidateIndices: number[];
  selectedCandidateIndex?: number;
  supportRetry: {
    attempted: boolean;
    unresolvedPartIds: number[];
    reasons: string[];
  };
  limits: { candidatesPerAttempt: 3; supportRetries: 1; changedCells: 512 };
  scope: 'source-defined-exterior-only';
  sourceTruthVerified: false;
  appearanceAccepted: false;
  fullInsertionPathVerified: false;
  physicalBuildVerified: false;
  accepted: false;
  reasons: string[];
};
const MAX_CHANGES = 512;
const MAX_BODY_WORK = 2000000;
const MIN_GAIN = 0.05;
const P95_ALLOWANCE = 0.02;

function bodyKeys(b: Brick): string[] {
  if (
    ![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isFinite) ||
    b.w <= 0 ||
    b.h <= 0 ||
    b.d <= 0
  )
    throw Error(`unresolved part body: ${b.id}`);
  const count =
    (Math.ceil(b.x + b.w) - Math.floor(b.x)) *
    (Math.ceil(b.y + b.h) - Math.floor(b.y)) *
    (Math.ceil(b.z + b.d) - Math.floor(b.z));
  if (!Number.isSafeInteger(count) || count > MAX_BODY_WORK)
    throw Error('protected body envelope exceeds work budget');
  const keys: string[] = [];
  for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
    for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
      for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++)
        keys.push(`${x},${y},${z}`);
  return keys;
}
function ordinaryUpright(b: Brick, model: Model): boolean {
  const part = ASSEMBLY_PARTS[b.part];
  if (
    !part ||
    !['brick', 'plate'].includes(part.kind) ||
    ![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isSafeInteger) ||
    !b.pose ||
    b.pose.matrix.length !== 9 ||
    b.pose.position.length !== 3 ||
    ![...b.pose.matrix, ...b.pose.position].every(Number.isFinite)
  )
    return false;
  for (let q = 0; q < 4; q++) {
    const expected = uprightCatalogBrick(
      b.part,
      b.x,
      b.y,
      b.z,
      q,
      b.color,
      b.id,
      model,
    );
    if (
      b.w === expected.w &&
      b.h === expected.h &&
      b.d === expected.d &&
      expected.pose!.matrix.every(
        (v, i) => Math.abs(v - b.pose!.matrix[i]) < 1e-6,
      ) &&
      expected.pose!.position.every(
        (v, i) => Math.abs(v - b.pose!.position[i]) < 1e-6,
      )
    )
      return true;
  }
  return false;
}
function protectionReasons(b: Brick, model: Model): string[] {
  return [
    ...(b.construction ? ['active construction'] : []),
    ...(b.installation ? ['declared installation'] : []),
    ...(b.colorChoice ? ['declared catalog color choice'] : []),
    ...(b.section?.startsWith('component-') ? ['semantic component'] : []),
    ...(ASSEMBLY_PARTS[b.part]?.kind === 'tile' ? ['existing tile'] : []),
    ...(!ordinaryUpright(b, model)
      ? ['non-upright or unsupported catalog pose']
      : []),
  ];
}
function improvement(
  candidate: UprightLayoutCandidate,
): ExteriorLayoutCandidate['improvement'] {
  if (candidate.changedCells.length > MAX_CHANGES)
    return {
      status: 'over-budget',
      reasons: ['actual changed cells exceed 512; candidate was not trimmed'],
    };
  const before = candidate.baselineScore,
    after = candidate.score;
  if (before.status !== 'scored' || after.status !== 'scored')
    return {
      status: 'unavailable',
      reasons: [
        ...(before.status === 'unavailable'
          ? before.reasons.map((s) => `baseline: ${s}`)
          : []),
        ...(after.status === 'unavailable'
          ? after.reasons.map((s) => `candidate: ${s}`)
          : []),
      ],
    };
  const sourceRmsGainStuds =
    before.sourceToParts.rmsStuds - after.sourceToParts.rmsStuds;
  const symmetricRmsGainStuds =
    before.symmetricRmsStuds - after.symmetricRmsStuds;
  const reasons = [
    ...(before.scope !== 'sampled-final-scene-owned-projection-only' ||
    after.scope !== 'sampled-final-scene-owned-projection-only'
      ? ['complete final-scene owned projection was not scored']
      : []),
    ...(sourceRmsGainStuds <= MIN_GAIN
      ? ['source RMS gain must exceed 0.05 stud']
      : []),
    ...(symmetricRmsGainStuds <= MIN_GAIN
      ? ['symmetric RMS gain must exceed 0.05 stud']
      : []),
    ...(after.symmetricP95Studs > before.symmetricP95Studs + P95_ALLOWANCE
      ? ['symmetric P95 worsens by more than 0.02 stud']
      : []),
    ...(after.missingOrExtraArea
      ? ['candidate has sampled missing or extra visible area']
      : []),
  ];
  return {
    status: reasons.length ? 'not-improving' : 'improving',
    reasons,
    sourceRmsGainStuds,
    symmetricRmsGainStuds,
  };
}

/** Offline deletion/repacking experiment. Original source geometry can be
 * inaccurate; passing this pipeline does not establish reference-photo truth,
 * complete insertion paths, stock/color availability or physical buildability. */
export function proposeExteriorLayouts(
  input: ExteriorLayoutInput,
): ExteriorLayoutResult {
  const views: V3[] = [
    [0, 0, 0].map((_, axis) =>
      axis === input.axis ? input.direction : 0,
    ) as V3,
    ...[0, 1, 2]
      .filter((axis) => axis !== input.axis)
      .map((axis) => [0, 0, 0].map((_, a) => (axis === a ? 1 : 0)) as V3),
  ];
  const result: ExteriorLayoutResult = {
    status: 'unresolved',
    model: structuredClone(input.baselineModel),
    views,
    editableCells: [],
    protectedExteriorCells: [],
    attempts: [],
    candidates: [],
    softwareCandidateIndices: [],
    supportRetry: { attempted: false, unresolvedPartIds: [], reasons: [] },
    limits: { candidatesPerAttempt: 3, supportRetries: 1, changedCells: 512 },
    scope: 'source-defined-exterior-only',
    sourceTruthVerified: false,
    appearanceAccepted: false,
    fullInsertionPathVerified: false,
    physicalBuildVerified: false,
    accepted: false,
    reasons: [],
  };
  try {
    const baseline = input.baselineModel;
    const sourceVoid = proposeExteriorVoid({
      source: input.source,
      model: baseline,
      axis: input.axis,
      direction: input.direction,
      ...(input.coverageMode ? { coverageMode: input.coverageMode } : {}),
    });
    result.sourceVoid = sourceVoid;
    if (sourceVoid.status === 'unavailable') {
      result.reasons = [...sourceVoid.reasons];
      return result;
    }
    const editable = new Set(sourceVoid.emptyBodyCells);
    const preserved = new Set([
      ...(input.preserveCells ?? []),
      ...(baseline.semanticReservedCells ?? []),
    ]);
    const protectedCells = new Map<
      string,
      { key: string; partIds: number[]; reasons: string[] }
    >();
    const protect = (key: string, reason: string, id?: number) => {
      if (!editable.has(key) && !protectedCells.has(key)) return;
      editable.delete(key);
      const record = protectedCells.get(key) ?? {
        key,
        partIds: [],
        reasons: [],
      };
      if (!record.reasons.includes(reason)) record.reasons.push(reason);
      if (id !== undefined && !record.partIds.includes(id))
        record.partIds.push(id);
      protectedCells.set(key, record);
    };
    for (const key of preserved) {
      const coordinates = key.split(',').map(Number);
      if (
        coordinates.length !== 3 ||
        !coordinates.every(Number.isSafeInteger) ||
        coordinates.join(',') !== key
      )
        throw Error('invalid preserved cell address');
      protect(key, 'preserved occupancy/color or semantic reservation');
    }
    const lockedPartIds = new Set<number>();
    const reconstructSupportIds = new Set<number>();
    const partBodies = new Map<number, string[]>();
    let bodyWork = 0;
    for (const b of baseline.bricks) {
      if (!Number.isSafeInteger(b.id) || b.id < 1 || partBodies.has(b.id))
        throw Error('invalid or duplicate baseline part IDs');
      const cells = bodyKeys(b);
      bodyWork += cells.length;
      if (bodyWork > MAX_BODY_WORK)
        throw Error('complete baseline body work exceeds budget');
      partBodies.set(b.id, cells);
      const reasons = protectionReasons(b, baseline);
      if (reasons.length) {
        lockedPartIds.add(b.id);
        for (const key of cells)
          for (const reason of reasons) protect(key, reason, b.id);
      }
    }
    result.protectedExteriorCells = [...protectedCells.values()].sort((a, b) =>
      a.key.localeCompare(b.key),
    );
    result.editableCells = [...editable].sort();
    if (!editable.size) {
      result.status = 'noop';
      result.reasons = [
        'no unprotected source-defined exterior body cells',
        ...sourceVoid.reasons,
      ];
      return result;
    }
    if (editable.size > MAX_CHANGES) {
      result.reasons = [
        `${editable.size} actual deletion cells exceed 512; region was not trimmed`,
      ];
      return result;
    }
    for (const b of baseline.bricks)
      if (
        b.support &&
        !lockedPartIds.has(b.id) &&
        partBodies.get(b.id)!.some((key) => editable.has(key))
      )
        reconstructSupportIds.add(b.id);
    // One fresh read per actual bounded deletion request; both attempts and
    // every score share it. No cross-call cache hides changes to baked parts.
    const catalog = loadCatalogGeometry();
    const run = (
      kind: ExteriorLayoutCandidate['attempt'],
      bridge?: NonNullable<ReturnType<typeof supportInterfaceParts>>,
    ) => {
      const supports = new Set([
        ...reconstructSupportIds,
        ...(bridge?.reconstructSupportIds ?? []),
      ]);
      const layouts = proposeUprightLayouts({
        source: {
          positions: input.source.positions,
          faceIds: input.source.faceIds,
          completeOcclusionGeometry: input.source.complete,
        },
        baselineModel: baseline,
        editableCells: editable,
        lockedPartIds,
        lockedCells: preserved,
        reconstructSupportIds: supports,
        ...(bridge
          ? {
              interfacePartIds: bridge.interfacePartIds,
              allowSupportSectionMerge: true,
            }
          : {}),
        intendedCells: new Map(),
        boundaryPolicy: 'repack-complete-parts',
        maxCandidates: 3,
        views,
        scoreOptions: {
          catalog,
          sampleSpacingStuds: 0.2,
          maxRayDistanceStuds: 100,
          comparison: 'final-scene-owned-projection',
          partScoringFootprint: 'owned-source-projection',
          cullDisjointContext: true,
          ...(input.scoreLimits ? { limits: input.scoreLimits } : {}),
        },
      });
      const indices: number[] = [];
      for (const layout of layouts.candidates) {
        const index = result.candidates.length;
        const scored = improvement(layout);
        // The orchestrator authorizes deletion only. Boundary repacking cannot
        // introduce any added occupancy/color change, even inside the region.
        if (
          layout.changedCells.some(
            (c) => !editable.has(c.key) || !c.before || c.after,
          )
        ) {
          scored.status = 'not-improving';
          scored.reasons.push(
            'candidate changed occupancy/color beyond the authorized deletion target',
          );
        }
        const record: ExteriorLayoutCandidate = {
          attempt: kind,
          layout,
          improvement: scored,
          softwareCandidate: false,
        };
        if (scored.status === 'improving') {
          record.audit = auditLayoutAssembly(baseline, layout);
          record.softwareCandidate =
            record.audit.status === 'audited' &&
            record.audit.softwareConnected &&
            record.audit.declaredGeometryPassed !== false;
          if (record.softwareCandidate)
            result.softwareCandidateIndices.push(index);
        }
        result.candidates.push(record);
        indices.push(index);
      }
      result.attempts.push({
        kind,
        layoutStatus: layouts.status,
        reasons: [...layouts.reasons],
        candidateIndices: indices,
        interfacePartIds: [...(bridge?.interfacePartIds ?? [])],
        reconstructSupportIds: [...supports],
      });
    };
    run('initial');
    // All initial improvements have now been audited. Retry at most once and
    // only for unresolved generated-support interfaces, never by adding volume.
    const unresolved = new Set<number>();
    for (const record of result.candidates)
      if (record.audit?.status === 'rejected')
        for (const id of record.audit.unresolvedPartIds ?? [])
          unresolved.add(id);
    result.supportRetry.unresolvedPartIds = [...unresolved].sort(
      (a, b) => a - b,
    );
    if (!result.softwareCandidateIndices.length && unresolved.size) {
      const bridge = supportInterfaceParts(baseline, [...unresolved]);
      if (
        bridge &&
        [...bridge.interfacePartIds].every((id) => !lockedPartIds.has(id))
      ) {
        result.supportRetry.attempted = true;
        run('support-interface-retry', bridge);
      } else
        result.supportRetry.reasons.push(
          'no bounded same-color ordinary support interface is available',
        );
    }
    if (result.softwareCandidateIndices.length) {
      result.softwareCandidateIndices.sort((a, b) => {
        const x = result.candidates[a].layout.score,
          y = result.candidates[b].layout.score;
        return x.status === 'scored' && y.status === 'scored'
          ? x.symmetricRmsStuds - y.symmetricRmsStuds || a - b
          : a - b;
      });
      const index = result.softwareCandidateIndices[0],
        audit = result.candidates[index].audit!;
      if (audit.status !== 'audited')
        throw Error('selected candidate has no complete assembly audit');
      result.status = 'software-candidate';
      result.selectedCandidateIndex = index;
      result.model = audit.model;
      result.reasons = [
        'sampled exterior improvement and complete software assembly/declared-geometry gates passed; photo truth and complete insertion remain unverified',
      ];
    } else if (
      result.candidates.some((c) =>
        ['unavailable', 'over-budget'].includes(c.improvement.status),
      ) ||
      result.attempts.some((a) => a.layoutStatus === 'rejected')
    ) {
      result.status = 'unresolved';
      result.reasons = [
        'one or more required candidate/score computations were unavailable; all diagnostics retained',
      ];
    } else if (
      result.candidates.some((c) => c.improvement.status === 'improving')
    ) {
      result.status = 'rejected';
      result.reasons = [
        'all improving candidates failed complete software assembly or declared geometry',
      ];
    } else {
      result.status = result.candidates.length ? 'rejected' : 'noop';
      result.reasons = [
        'no candidate passed the sampled exterior improvement gate',
      ];
    }
    return result;
  } catch (error) {
    result.status = 'unresolved';
    result.reasons.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}
