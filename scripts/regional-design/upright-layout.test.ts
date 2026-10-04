import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { ASSEMBLY_PARTS } from '../../lib/assembly-catalog.ts';
import {
  validateModel,
  type Model,
  type Brick,
} from '../../lib/brick-engine.ts';
import { instructionModel } from '../../lib/build-instructions.ts';
import { planGridAssembly } from '../../lib/connection-plan.ts';
import {
  proposeUprightLayouts,
  uprightCatalogBrick,
  type UprightLayoutInput,
} from './upright-layout.ts';

const frame = { width: 4, depth: 4 };
const brick = (
  id: number,
  part = '3024',
  x = 1,
  y = 0,
  z = 1,
  color = 7,
  rotation = 0,
) => uprightCatalogBrick(part, x, y, z, rotation, color, id, frame);
const model = (bricks: Brick[]): Model => ({
  ...frame,
  name: 'independent control',
  height: 8,
  bricks,
  levels: [0, 1],
  supportCount: 0,
  source: 'sample',
  resolution: 4,
  shape: 'sculpture',
  assemblyStrategy: 'connector-graph',
});
function input(bricks = [brick(1)]): UprightLayoutInput {
  // Independently specified flat display surface at one plate height.
  return {
    source: {
      positions: [
        1, 0.4, 1, 1, 0.4, 3, 3, 0.4, 3, 1, 0.4, 1, 3, 0.4, 3, 3, 0.4, 1,
      ],
      faceIds: [0, 1],
      completeOcclusionGeometry: true,
    },
    baselineModel: model(bricks),
    editableCells: new Set(['1,0,1', '1,0,2', '2,0,1', '2,0,2', '1,1,1']),
    lockedPartIds: new Set(),
    views: [[0, 1, 0]],
    scoreOptions: { sampleSpacingStuds: 0.15, maxRayDistanceStuds: 8 },
  };
}
function occupancy(bricks: readonly Brick[]) {
  const cells = new Map<string, number>();
  for (const b of bricks)
    for (let x = b.x; x < b.x + b.w; x++)
      for (let y = b.y; y < b.y + b.h; y++)
        for (let z = b.z; z < b.z + b.d; z++) {
          const k = `${x},${y},${z}`;
          assert.ok(!cells.has(k), `overlap at ${k}`);
          cells.set(k, b.color);
        }
  return cells;
}
void test('real catalog replacement improves an independently specified flat surface and has a software assembly order', () => {
  const before = [
    brick(1),
    brick(2, '3024', 1, 1, 1),
    brick(3, '3024', 1, 0, 2),
    brick(4, '3024', 2, 0, 1),
    brick(5, '3024', 2, 0, 2),
  ];
  const i = input(before);
  i.intendedCells = new Map(
    ['1,0,1', '1,0,2', '2,0,1', '2,0,2'].map((k) => [k, { color: 7 }]),
  );
  i.smoothTopCells = new Set(i.intendedCells.keys());
  const snapshot = JSON.stringify(i.baselineModel);
  const result = proposeUprightLayouts(i);
  assert.equal(result.status, 'candidate', JSON.stringify(result.reasons));
  const c = result.candidates[0];
  assert.deepEqual(
    occupancy(c.bricks),
    new Map([...i.intendedCells].map(([k, v]) => [k, v.color])),
  );
  assert.ok(c.bricks.every((b) => ASSEMBLY_PARTS[b.part].kind === 'tile'));
  assert.equal(c.score.status, 'scored');
  assert.equal(c.baselineScore.status, 'scored');
  if (c.score.status === 'scored' && c.baselineScore.status === 'scored') {
    assert.ok(
      c.score.symmetricRmsStuds + 0.05 < c.baselineScore.symmetricRmsStuds,
      JSON.stringify({ before: c.baselineScore, after: c.score }),
    );
    assert.ok(c.score.sourceToParts.coverage > 0.99);
  }
  assert.equal(validateModel(model(c.bricks)).collisions, 0);
  assert.deepEqual(planGridAssembly(c.bricks).unresolved, []);
  assert.equal(c.requiresConnectionAndInstallationAudit, true);
  assert.equal(JSON.stringify(i.baselineModel), snapshot);
  assert.deepEqual(proposeUprightLayouts(i), result);
});
void test('holes, neighboring thin layers and explicit two-color boundaries survive every layout', () => {
  const i = input([]);
  i.editableCells = new Set(['1,0,1', '1,0,2', '2,0,1', '2,0,2', '1,2,1']);
  i.intendedCells = new Map([
    ['1,0,1', { color: 7 }],
    ['2,0,1', { color: 11 }],
    ['1,0,2', { color: 7 }],
    ['1,2,1', { color: 7 }],
  ]);
  const result = proposeUprightLayouts(i);
  assert.equal(result.status, 'candidate');
  for (const c of result.candidates) {
    assert.ok(c.bricks.every((b) => Number.isSafeInteger(b.id) && b.id > 0));
    assert.equal(new Set(c.bricks.map((b) => b.id)).size, c.bricks.length);
    assert.deepEqual(
      occupancy(c.bricks),
      new Map([...i.intendedCells].map(([k, v]) => [k, v.color])),
    );
    assert.ok(!occupancy(c.bricks).has('2,0,2')); // void, not a rectangular fill
    assert.ok(!occupancy(c.bricks).has('1,1,1')); // retained inter-layer gap
    assert.ok(c.bricks.every((b) => ASSEMBLY_PARTS[b.part].kind !== 'tile'));
  }
});
void test('deliberate construction, supports, installed and semantic parts stay exactly retained', () => {
  for (const marker of [
    {
      construction: {
        origin: 'cavity-lintel' as const,
        openingId: 'opening',
        role: 'bridge' as const,
      },
    },
    { support: true },
    { installation: 'mount' },
    { section: 'component-statue' },
  ]) {
    const original = { ...brick(1), ...marker };
    const i = input([original]);
    const result = proposeUprightLayouts(i);
    assert.equal(result.status, 'noop', JSON.stringify(result.reasons));
    assert.deepEqual(result.bricks, [original]);
    i.intendedCells = new Map();
    assert.equal(proposeUprightLayouts(i).status, 'rejected');
  }
});
void test('a complete crossing part cannot be cut or recolored through an editable fragment', () => {
  const original = brick(1, '3022');
  const i = input([original]);
  i.editableCells = new Set(['1,0,1']);
  const result = proposeUprightLayouts(i);
  assert.equal(result.status, 'noop');
  assert.deepEqual(result.bricks, [original]);
  i.intendedCells = new Map([['1,0,1', { color: 11 }]]);
  assert.equal(proposeUprightLayouts(i).status, 'rejected');
});
void test('retained connections forbid replacing needed top studs with tiles', () => {
  const lower = brick(1, '3022'),
    upper = { ...brick(2, '3024', 1, 1, 1), support: true };
  const i = input([lower, upper]);
  i.smoothTopCells = new Set(['1,0,1', '1,0,2', '2,0,1', '2,0,2']);
  const result = proposeUprightLayouts(i);
  assert.equal(result.status, 'candidate', JSON.stringify(result.reasons));
  for (const c of result.candidates) {
    assert.ok(c.bricks.some((b) => b.id === upper.id));
    const under = c.bricks.find(
      (b) =>
        b.x <= 1 && b.x + b.w > 1 && b.z <= 1 && b.z + b.d > 1 && b.y === 0,
    )!;
    assert.notEqual(ASSEMBLY_PARTS[under.part].kind, 'tile');
    assert.equal(validateModel(model(c.bricks)).unsupported, 0);
    assert.deepEqual(planGridAssembly(c.bricks).unresolved, []);
  }
});
void test('poses match the actual instruction convention for every quarter turn', () => {
  for (const part of ['3001', '3023', '3069b'])
    for (const q of [0, 1, 2, 3]) {
      const b = brick(1, part, 1, 2, 1, 7, q);
      const staged = instructionModel(model([{ ...b, pose: undefined }]))
        .bricks[0];
      assert.deepEqual(b.pose, staged.pose);
    }
});
void test('malformed grids, unknown locks, wrong poses and transparent targets cannot authorize edits', () => {
  for (const edit of [
    (i: UprightLayoutInput) => {
      i.editableCells = new Set(['1.5,0,1']);
    },
    (i: UprightLayoutInput) => {
      i.editableCells = new Set(['1,9,1']);
    },
    (i: UprightLayoutInput) => {
      i.lockedPartIds = new Set([99]);
    },
    (i: UprightLayoutInput) => {
      i.intendedCells = new Map([['1,0,1', { color: 14 }]]);
    },
    (i: UprightLayoutInput) => {
      i.maxCandidates = 7;
    },
  ]) {
    const i = input(),
      before = structuredClone(i.baselineModel.bricks);
    edit(i);
    const result = proposeUprightLayouts(i);
    assert.equal(result.status, 'rejected');
    assert.deepEqual(result.bricks, before);
  }
  const overflow = input();
  overflow.baselineModel.bricks[0].id = Number.MAX_SAFE_INTEGER;
  assert.equal(proposeUprightLayouts(overflow).status, 'rejected');
  const i = input();
  i.baselineModel.bricks[0].pose!.position[0] += 1;
  const result = proposeUprightLayouts(i);
  assert.equal(result.status, 'noop');
  assert.deepEqual(result.bricks, i.baselineModel.bricks);
});

void test('explicit complete-part repacking freezes outside colors, holes, connector tops and sections', () => {
  const a = { ...brick(1, '3022'), section: 'subject' },
    b = { ...brick(2, '3022', 1, 1, 1), section: 'subject' };
  const i = input([a, b]);
  i.boundaryPolicy = 'repack-complete-parts';
  i.editableCells = new Set(['1,0,1']);
  i.intendedCells = new Map([['1,0,1', { color: 11 }]]);
  const result = proposeUprightLayouts(i);
  assert.equal(result.status, 'candidate', JSON.stringify(result.reasons));
  const expected = occupancy([a, b]);
  expected.set('1,0,1', 11);
  for (const c of result.candidates) {
    assert.deepEqual(occupancy(c.bricks), expected);
    assert.equal(c.boundary.outsideOccupancyColorChanges, 0);
    assert.ok(c.boundary.frozenCells.length === 3);
    assert.ok(c.bricks.every((p) => p.section === 'subject'));
    assert.deepEqual(
      c.bricks.find((p) => p.id === 2),
      b,
    );
  }
  // Explicit smooth permission is only for editable cells, never outside studs.
  i.smoothTopCells = new Set(['2,0,2']);
  assert.equal(proposeUprightLayouts(i).status, 'rejected');
});
void test('complete-part repacking cannot touch installed supports, posed parts or outside tiles', () => {
  for (const extra of [
    { support: true },
    {
      construction: {
        origin: 'cavity-lintel' as const,
        openingId: 'o',
        role: 'bridge' as const,
      },
    },
    { installation: 'm' },
    { section: 'component-tree' },
  ]) {
    const i = input([{ ...brick(1, '3022'), ...extra }]);
    i.boundaryPolicy = 'repack-complete-parts';
    i.editableCells = new Set(['1,0,1']);
    assert.equal(proposeUprightLayouts(i).status, 'noop');
    i.intendedCells = new Map([['1,0,1', { color: 11 }]]);
    assert.equal(proposeUprightLayouts(i).status, 'rejected');
  }
  const i = input([brick(1, '3068b')]);
  i.boundaryPolicy = 'repack-complete-parts';
  i.editableCells = new Set(['1,0,1']);
  assert.equal(proposeUprightLayouts(i).status, 'noop');
});
