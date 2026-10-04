import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Model } from '../../lib/brick-engine.ts';
import { instructionModel } from '../../lib/build-instructions.ts';
import {
  proposeUprightLayouts,
  uprightCatalogBrick,
} from './upright-layout.ts';
import {
  auditLayoutAssembly,
  supportInterfaceParts,
} from './layout-assembly.ts';

function fixture(dropBoth = false) {
  const model: Model = {
    name: 'bridged support',
    width: 4,
    height: 6,
    depth: 4,
    bricks: [],
    levels: [0, 1, 2],
    source: 'sample',
    shape: 'sculpture',
    resolution: 4,
    supportCount: 2,
    assemblyStrategy: 'connector-graph',
  };
  model.bricks = [
    uprightCatalogBrick('3023', 1, 0, 1, 0, 7, 1, model),
    { ...uprightCatalogBrick('3024', 1, 1, 1, 0, 7, 2, model), support: true },
    { ...uprightCatalogBrick('3024', 2, 1, 1, 0, 7, 3, model), support: true },
    uprightCatalogBrick('3023', 1, 2, 1, 0, 7, 4, model),
  ];
  const baseline = instructionModel(model);
  const ids = new Set(dropBoth ? [2, 3] : [2]);
  const result = proposeUprightLayouts({
    baselineModel: baseline,
    source: {
      positions: [
        1, 0.4, 1, 1, 0.4, 2, 3, 0.4, 2, 1, 0.4, 1, 3, 0.4, 2, 3, 0.4, 1,
      ],
      faceIds: [0, 1],
      completeOcclusionGeometry: true,
    },
    editableCells: new Set(dropBoth ? ['1,1,1', '2,1,1'] : ['1,1,1']),
    intendedCells: new Map(),
    lockedPartIds: ids,
    reconstructSupportIds: ids,
    boundaryPolicy: 'repack-complete-parts',
    views: [[0, 1, 0]],
    scoreOptions: { maxRayDistanceStuds: 8 },
  });
  assert.equal(result.status, 'candidate', JSON.stringify(result.reasons));
  return { baseline, candidate: result.candidates[0] };
}
void test('explicit generated-support redesign replans the complete assembly without changing retained parts or outside colors', () => {
  const { baseline, candidate } = fixture();
  const snapshot = JSON.stringify({ baseline, candidate });
  const result = auditLayoutAssembly(baseline, candidate);
  assert.equal(result.status, 'audited', JSON.stringify(result));
  if (result.status !== 'audited') throw Error('not audited');
  assert.equal(result.softwareConnected, true);
  assert.equal(result.outsideNominalOccupancyColorChanges, 0);
  assert.equal(result.model.supportCount, 1);
  assert.deepEqual(result.reconstructedSupportIDs, [2]);
  assert.equal(result.fullInsertionPathVerified, false);
  assert.equal(result.accepted, false);
  const order = new Map(result.model.bricks.map((b, i) => [b.id, i]));
  for (const b of result.model.bricks)
    for (const id of b.assemblyMove?.parentIds ?? [])
      assert.ok(order.get(id)! < order.get(b.id)!);
  assert.equal(JSON.stringify({ baseline, candidate }), snapshot);
});
void test('a prettier void which disconnects its overhead structure is rejected without adding hidden supports', () => {
  const { baseline, candidate } = fixture(true);
  const result = auditLayoutAssembly(baseline, candidate);
  assert.equal(result.status, 'rejected');
  assert.match(result.reasons?.join(' ') ?? '', /unresolved/);
});
void test('outside recoloring, altered retained parts, missing IDs and undeclared support deletion fail the independent final audit', () => {
  const { baseline, candidate } = fixture();
  const recolored = structuredClone(candidate);
  recolored.bricks[0].color = 9;
  assert.equal(auditLayoutAssembly(baseline, recolored).status, 'rejected');
  const missing = structuredClone(candidate);
  missing.retainedIDs.pop();
  assert.equal(auditLayoutAssembly(baseline, missing).status, 'rejected');
  const undeclared = structuredClone(candidate);
  undeclared.reconstructedSupportIDs = [];
  assert.equal(auditLayoutAssembly(baseline, undeclared).status, 'rejected');
});

void test('an added part cannot pass assembly audit with a forged or nonfinite catalog pose', () => {
  const { baseline } = fixture();
  const generated = proposeUprightLayouts({
    baselineModel: baseline,
    source: {
      positions: [1, 0.4, 1, 1, 0.4, 2, 3, 0.4, 2],
      faceIds: [0],
      completeOcclusionGeometry: true,
    },
    editableCells: new Set(['1,2,1', '2,2,1']),
    lockedPartIds: new Set(),
    intendedCells: new Map([['1,2,1', { color: 7 }]]),
    boundaryPolicy: 'repack-complete-parts',
    views: [[0, 1, 0]],
    scoreOptions: { maxRayDistanceStuds: 8 },
  });
  assert.equal(generated.status, 'candidate', JSON.stringify(generated));
  const candidate = generated.candidates[0];
  assert.ok(candidate.addedIDs.length);
  for (const value of [NaN, Infinity, 100]) {
    const forged = structuredClone(candidate);
    forged.bricks.find((b) => b.id === forged.addedIDs[0])!.pose!.position[0] =
      value;
    const result = auditLayoutAssembly(baseline, forged);
    assert.equal(result.status, 'rejected');
    assert.match(result.reasons?.join(' ') ?? '', /pose/);
  }
});

void test('same-color interface repacking builds a real bridge without adding outside volume; deliberate parts and color boundaries remain protected', () => {
  const { baseline } = fixture();
  baseline.bricks.push(
    {
      ...uprightCatalogBrick('3005', 1, 2, 1, 0, 7, 5, baseline),
      support: true,
      section: 'supports',
    },
    {
      ...uprightCatalogBrick('3024', 1, 5, 1, 0, 7, 6, baseline),
      section: 'subject',
    },
  );
  // Replace the original bridge with a right-hand plate, so the left tower
  // initially depends on the generated column which the void target removes.
  baseline.bricks = baseline.bricks.filter((b) => b.id !== 4);
  baseline.bricks.push({
    ...uprightCatalogBrick('3024', 2, 2, 1, 0, 7, 4, baseline),
    section: 'subject',
  });
  for (const b of baseline.bricks)
    b.section ??= b.support ? 'supports' : 'subject';
  const interfaces = supportInterfaceParts(baseline, [5, 6]);
  assert.ok(interfaces);
  assert.deepEqual(
    [...interfaces.interfacePartIds].sort((a, b) => a - b),
    [4, 5],
  );
  const result = proposeUprightLayouts({
    baselineModel: baseline,
    source: {
      positions: [
        1, 0.4, 1, 1, 0.4, 2, 3, 0.4, 2, 1, 0.4, 1, 3, 0.4, 2, 3, 0.4, 1,
      ],
      faceIds: [0, 1],
      completeOcclusionGeometry: true,
    },
    editableCells: new Set(['1,1,1']),
    intendedCells: new Map(),
    lockedPartIds: new Set([2]),
    ...interfaces,
    reconstructSupportIds: new Set([2, ...interfaces.reconstructSupportIds]),
    boundaryPolicy: 'repack-complete-parts',
    views: [[0, 1, 0]],
    scoreOptions: { maxRayDistanceStuds: 8 },
  });
  assert.equal(result.status, 'candidate', JSON.stringify(result.reasons));
  const audits = result.candidates.map((c) => auditLayoutAssembly(baseline, c));
  const valid = audits.find(
    (a) => a.status === 'audited' && a.softwareConnected,
  );
  assert.ok(valid, JSON.stringify(audits));
  assert.equal(valid.outsideNominalOccupancyColorChanges, 0);
  const wrongColor = structuredClone(baseline);
  wrongColor.bricks.find((b) => b.id === 4)!.color = 9;
  assert.equal(supportInterfaceParts(wrongColor, [5]), undefined);
  const deliberate = structuredClone(baseline);
  deliberate.bricks.find((b) => b.id === 4)!.colorChoice = {
    requestedColor: 7,
    selectedColor: 7,
    reason: 'reviewed-unsupported-catalog-color',
    source: {
      url: 'https://example.invalid/control',
      checkedAt: '2026-10-04',
      kind: 'vendored-ldraw-header',
    },
  };
  assert.equal(supportInterfaceParts(deliberate, [5]), undefined);
});
