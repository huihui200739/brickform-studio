import {
  ASSEMBLY_PARTS,
  rotate,
  transform,
  type V3,
} from '../../lib/assembly-catalog.ts';
import {
  isOpaquePaletteColor,
  type Brick,
  type Model,
} from '../../lib/brick-engine.ts';
import {
  loadCatalogGeometry,
  scoreCatalogSurface,
  type SurfaceScore,
  type SurfaceScoreInput,
} from './catalog-surface-score.ts';

type Cell = { color: number };
export type UprightLayoutInput = {
  source: SurfaceScoreInput['source'];
  baselineModel: Model;
  /** Already established sole source ownership, not a bounding box. */
  editableCells: ReadonlySet<string>;
  lockedPartIds: ReadonlySet<number>;
  lockedCells?: ReadonlySet<string>;
  /** Complete desired occupancy/color within editableCells; omissions are void.
   * Geometry inference belongs to the source target builder, not this packer. */
  intendedCells?: ReadonlyMap<string, Cell>;
  /** Explicit smooth exposed top cells; tiles are otherwise never generated. */
  smoothTopCells?: ReadonlySet<string>;
  /** Body cells whose top studs are required by a connection interface. */
  requiredConnectorCells?: ReadonlySet<string>;
  views: readonly V3[];
  maxCandidates?: number;
  scoreOptions?: Pick<
    SurfaceScoreInput,
    'catalog' | 'sampleSpacingStuds' | 'maxRayDistanceStuds' | 'limits'
  >;
};
export type UprightLayoutCandidate = {
  strategy: string;
  bricks: Brick[];
  changedCells: { key: string; before?: Cell; after?: Cell }[];
  removedIDs: number[];
  addedIDs: number[];
  retainedIDs: number[];
  baselineScore: SurfaceScore;
  score: SurfaceScore;
  /** Both are mandatory root integration gates, not supplied by this module. */
  requiresConnectionAndInstallationAudit: true;
  reasons: string[];
};
export type UprightLayoutResult = {
  status: 'candidate' | 'noop' | 'rejected';
  /** Rejected/noop results preserve an independent copy of the baseline. */
  bricks: Brick[];
  candidates: UprightLayoutCandidate[];
  reasons: string[];
};
const MAX_CELLS = 65536;
const MAX_FIT_TESTS = 2000000;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
function parseKey(value: string): V3 {
  const p = value.split(',').map(Number);
  if (
    p.length !== 3 ||
    p.some((v) => !Number.isSafeInteger(v)) ||
    key(p[0], p[1], p[2]) !== value
  )
    throw Error('invalid editable grid address');
  return p as V3;
}
function bodyKeys(b: Brick): string[] {
  const out: string[] = [];
  if (
    ![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isFinite) ||
    b.w <= 0 ||
    b.h <= 0 ||
    b.d <= 0
  )
    throw Error(`unresolved baseline envelope: ${b.id}`);
  // Fractional/posed parts are retained; conservatively lock intersected grid cells.
  const count =
    (Math.ceil(b.x + b.w) - Math.floor(b.x)) *
    (Math.ceil(b.y + b.h) - Math.floor(b.y)) *
    (Math.ceil(b.z + b.d) - Math.floor(b.z));
  if (count > MAX_CELLS)
    throw Error('baseline part envelope exceeds layout work bound');
  for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
    for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
      for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++)
        out.push(key(x, y, z));
  return out;
}
/** Build the same upright physical pose as instructionModel, including the
 * real rotated catalog dimensions. Existing baseline poses are not rewritten. */
export function uprightCatalogBrick(
  part: string,
  x: number,
  y: number,
  z: number,
  rotation: number,
  color: number,
  id: number,
  model: Pick<Model, 'width' | 'depth'>,
): Brick {
  const p = ASSEMBLY_PARTS[part];
  if (
    !p ||
    !['brick', 'plate', 'tile'].includes(p.kind) ||
    ![0, 1, 2, 3].includes(rotation)
  )
    throw Error('unsupported upright catalog choice');
  const w = rotation % 2 ? p.d : p.w,
    d = rotation % 2 ? p.w : p.d,
    matrix = rotate(rotation);
  const center = transform(matrix, [0, p.bottom - p.h * 4, p.centerZ || 0]);
  return {
    id,
    part,
    x,
    y,
    z,
    w,
    d,
    h: p.h,
    rotation,
    color,
    pose: {
      matrix,
      position: [
        (x + w / 2 - model.width / 2) * 20 - center[0],
        -(y + p.h / 2) * 8 - center[1],
        (z + d / 2 - model.depth / 2) * 20 - center[2],
      ],
    },
  };
}
function uprightRegular(b: Brick, model: Model) {
  const p = ASSEMBLY_PARTS[b.part];
  if (
    !p ||
    !['brick', 'plate', 'tile'].includes(p.kind) ||
    !b.pose ||
    ![b.x, b.y, b.z, b.w, b.d, b.h].every(Number.isSafeInteger)
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
    if (expected.w !== b.w || expected.d !== b.d || expected.h !== b.h)
      continue;
    if (
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
const signature = (bricks: readonly Brick[]) =>
  bricks
    .map((b) =>
      JSON.stringify([b.part, b.x, b.y, b.z, b.w, b.h, b.d, b.color, b.pose]),
    )
    .sort()
    .join('\n');
export function proposeUprightLayouts(
  input: UprightLayoutInput,
): UprightLayoutResult {
  const original = input.baselineModel.bricks.map((b) => structuredClone(b));
  const end = (
    status: 'noop' | 'rejected',
    reasons: string[],
  ): UprightLayoutResult => ({
    status,
    bricks: original,
    candidates: [],
    reasons,
  });
  try {
    const model = input.baselineModel;
    if (!input.editableCells.size)
      return end('noop', ['no source-owned editable cells']);
    if (input.editableCells.size > MAX_CELLS)
      throw Error('editable region exceeds layout work bound');
    if (
      ![model.width, model.depth, model.height].every(
        (v) => Number.isSafeInteger(v) && v > 0,
      )
    )
      throw Error('invalid baseline model grid');
    const count = input.maxCandidates ?? 6;
    if (!Number.isInteger(count) || count < 1 || count > 6)
      throw Error('candidate count must be between 1 and 6');
    const faces = input.source.faceIds;
    if (
      !faces?.length ||
      !input.source.positions.length ||
      input.source.positions.length % 9 ||
      new Set(faces).size !== faces.length ||
      faces.some(
        (v) =>
          !Number.isSafeInteger(v) ||
          v < 0 ||
          v >= input.source.positions.length / 9,
      )
    )
      throw Error('source target faces are unresolved');
    const addresses = [...input.editableCells].map(parseKey);
    if (
      addresses.some(
        ([x, y, z]) =>
          x < 0 ||
          x >= model.width ||
          y < 0 ||
          y >= model.height ||
          z < 0 ||
          z >= model.depth,
      )
    )
      throw Error('editable cell outside model grid');
    const ids = new Set<number>();
    const baselineCells = new Map<string, Cell>(),
      blocked = new Set(input.lockedCells),
      removals: Brick[] = [],
      retained: Brick[] = [];
    const keepReasons = new Set<string>();
    for (const b of model.bricks) {
      if (!Number.isSafeInteger(b.id) || b.id < 1 || ids.has(b.id))
        throw Error('baseline part IDs are invalid or duplicated');
      ids.add(b.id);
      const keys = bodyKeys(b);
      for (const k of keys)
        if (input.editableCells.has(k))
          baselineCells.set(k, { color: b.color });
      const locked =
        input.lockedPartIds.has(b.id) ||
        b.support ||
        b.construction ||
        b.installation ||
        b.section?.startsWith('component-');
      const inside = keys.every(
        (k) => input.editableCells.has(k) && !blocked.has(k),
      );
      if (!locked && inside && uprightRegular(b, model)) removals.push(b);
      else {
        retained.push(b);
        for (const k of keys) if (input.editableCells.has(k)) blocked.add(k);
        if (keys.some((k) => input.editableCells.has(k)))
          keepReasons.add(
            locked
              ? 'locked construction/component retained'
              : !inside
                ? 'complete part crosses editable boundary and is retained'
                : 'non-upright or unsupported part retained',
          );
      }
    }
    for (const id of input.lockedPartIds)
      if (!ids.has(id)) throw Error(`unknown locked part ID: ${id}`);
    const desired = input.intendedCells
      ? new Map(
          [...input.intendedCells].map(([k, cell]) => [
            k,
            { color: cell.color },
          ]),
        )
      : new Map(baselineCells);
    if (desired.size > MAX_CELLS)
      throw Error('intended cells exceed layout work bound');
    for (const [k, cell] of desired) {
      parseKey(k);
      if (!input.editableCells.has(k))
        throw Error('intended cell is outside source-owned editable set');
      if (!isOpaquePaletteColor(cell.color))
        throw Error('invalid or translucent intended color');
    }
    for (const k of blocked)
      if (input.editableCells.has(k)) {
        const before = baselineCells.get(k),
          after = desired.get(k);
        if (before?.color !== after?.color)
          throw Error(
            `intended target conflicts with locked/retained cell: ${k}`,
          );
      }
    const remaining = new Map([...desired].filter(([k]) => !blocked.has(k)));
    // A complete kept part must keep its original material at every retained body cell.
    for (const b of retained)
      for (const k of bodyKeys(b))
        if (input.editableCells.has(k) && desired.get(k)?.color !== b.color)
          throw Error(
            `intended target changes retained part material: ${b.id}`,
          );
    for (const k of input.smoothTopCells ?? [])
      if (!remaining.has(k))
        throw Error(`smooth-top target is not an editable intended cell: ${k}`);
    if (!removals.length && !remaining.size)
      return end('noop', [
        ...keepReasons,
        'no complete replaceable part or new intended cells',
      ]);
    const needed = new Set(input.requiredConnectorCells);
    for (const b of retained)
      if ([b.x, b.y, b.z, b.w, b.d].every(Number.isSafeInteger))
        for (let x = b.x; x < b.x + b.w; x++)
          for (let z = b.z; z < b.z + b.d; z++) needed.add(key(x, b.y - 1, z));
    const changedCells = [
      ...new Set([...baselineCells.keys(), ...desired.keys()]),
    ]
      .sort()
      .flatMap((k) =>
        baselineCells.get(k)?.color === desired.get(k)?.color
          ? []
          : [
              {
                key: k,
                ...(baselineCells.has(k)
                  ? { before: { ...baselineCells.get(k)! } }
                  : {}),
                ...(desired.has(k) ? { after: { ...desired.get(k)! } } : {}),
              },
            ],
      );
    const catalog = input.scoreOptions?.catalog ?? loadCatalogGeometry();
    const score = (regional: Brick[], context: Brick[]) =>
      scoreCatalogSurface({
        ...input.scoreOptions,
        catalog,
        source: input.source,
        model: { width: model.width, depth: model.depth, bricks: regional },
        contextBricks: context,
        completeCandidateOcclusionGeometry: true,
        views: input.views,
      });
    const baselineScore = score(removals, retained);
    const variants = [
      { name: 'brick-courses-0', phase: 0, plates: false, reverse: false },
      {
        name: 'brick-courses-1-staggered',
        phase: 1,
        plates: false,
        reverse: true,
      },
      {
        name: 'brick-courses-2-staggered',
        phase: 2,
        plates: false,
        reverse: false,
      },
      { name: 'plate-courses-forward', phase: 0, plates: true, reverse: false },
      {
        name: 'plate-courses-staggered',
        phase: 1,
        plates: true,
        reverse: true,
      },
      {
        name: 'plate-courses-crosswise',
        phase: 2,
        plates: true,
        reverse: false,
      },
    ];
    const choices = Object.entries(ASSEMBLY_PARTS).filter(
      ([, p]) =>
        ['brick', 'plate', 'tile'].includes(p.kind) && [1, 3].includes(p.h),
    );
    const minY = Math.min(...[...remaining.keys()].map((k) => parseKey(k)[1]));
    let fitTests = 0;
    const candidates: UprightLayoutCandidate[] = [],
      seen = new Set<string>();
    for (const variant of variants) {
      if (candidates.length >= count) break;
      const used = new Set<string>(),
        added: Brick[] = [];
      const order = [...remaining.keys()].sort((a, b) => {
        const [ax, ay, az] = parseKey(a),
          [bx, by, bz] = parseKey(b);
        const direction =
          variant.reverse && (ay - minY + variant.phase) % 2 ? -1 : 1;
        return ay - by || direction * (az - bz || ax - bx);
      });
      let nextID = [...ids].reduce((max, id) => Math.max(max, id), 0) + 1;
      if (
        !Number.isSafeInteger(nextID) ||
        nextID + remaining.size > Number.MAX_SAFE_INTEGER
      )
        throw Error('candidate part IDs exceed safe integer range');
      for (const cellKey of order) {
        if (used.has(cellKey)) continue;
        const [sx, sy, sz] = parseKey(cellKey),
          color = remaining.get(cellKey)!.color;
        const backward =
          variant.reverse && (sy - minY + variant.phase) % 2 !== 0;
        const options: { brick: Brick; keys: string[]; rank: number }[] = [];
        for (const [part, p] of choices)
          for (const q of p.w === p.d ? [0] : [0, 1]) {
            if (
              p.kind === 'brick' &&
              (variant.plates || (sy - minY) % 3 !== variant.phase)
            )
              continue;
            const w = q % 2 ? p.d : p.w,
              d = q % 2 ? p.w : p.d;
            const x = backward ? sx - w + 1 : sx,
              z = backward ? sz - d + 1 : sz;
            const brick = uprightCatalogBrick(
              part,
              x,
              sy,
              z,
              q,
              color,
              nextID,
              model,
            );
            const keys = bodyKeys(brick);
            let valid = true;
            for (const k of keys) {
              if (++fitTests > MAX_FIT_TESTS)
                throw Error('layout search work budget exceeded');
              if (
                !remaining.has(k) ||
                remaining.get(k)!.color !== color ||
                used.has(k)
              ) {
                valid = false;
                break;
              }
            }
            if (!valid) continue;
            if (
              p.kind === 'tile' &&
              keys.some((k) => {
                const [x, y, z] = parseKey(k);
                return (
                  !input.smoothTopCells?.has(k) ||
                  needed.has(k) ||
                  desired.has(key(x, y + 1, z))
                );
              })
            )
              continue;
            // Prefer tiles only on explicitly declared exposed smooth targets.
            // Course phases/directions provide actual alternative staggered layouts.
            const rank =
              keys.length * 100 +
              (p.kind === 'tile' ? 100000 : 0) +
              (q === variant.phase % 2 ? 0.1 : 0);
            options.push({ brick, keys, rank });
          }
        options.sort(
          (a, b) => b.rank - a.rank || a.brick.part.localeCompare(b.brick.part),
        );
        const picked = options[0];
        if (!picked)
          throw Error(
            `no real catalog footprint covers intended cell: ${cellKey}`,
          );
        for (const k of picked.keys) used.add(k);
        added.push(picked.brick);
        nextID++;
      }
      if (used.size !== remaining.size)
        throw Error('incomplete intended cell coverage');
      const layoutSignature = signature(added);
      if (!changedCells.length && layoutSignature === signature(removals))
        continue;
      if (seen.has(layoutSignature)) continue;
      seen.add(layoutSignature);
      const full = [...retained.map((b) => structuredClone(b)), ...added];
      const surfaceScore = score(added, retained);
      candidates.push({
        strategy: variant.name,
        bricks: full,
        changedCells: structuredClone(changedCells),
        removedIDs: removals.map((b) => b.id),
        addedIDs: added.map((b) => b.id),
        retainedIDs: retained.map((b) => b.id),
        baselineScore,
        score: surfaceScore,
        requiresConnectionAndInstallationAudit: true,
        reasons: [
          ...keepReasons,
          'complete source target coverage by real upright catalog footprints',
          'candidate only; source appearance gain and assembly acceptance require integration',
          ...(surfaceScore.status === 'unavailable'
            ? [
                'complete final geometry score unavailable: ' +
                  surfaceScore.reasons.join('; '),
              ]
            : []),
        ],
      });
    }
    if (!candidates.length)
      return end('noop', [
        ...keepReasons,
        'enumerated layouts reproduce baseline complete parts',
      ]);
    return {
      status: 'candidate',
      bricks: structuredClone(candidates[0].bricks),
      candidates,
      reasons: [
        'bounded offline proposals; no supports inserted and no commit authorized',
      ],
    };
  } catch (error) {
    return end('rejected', [
      error instanceof Error ? error.message : String(error),
    ]);
  }
}
