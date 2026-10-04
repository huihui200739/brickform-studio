import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BoxGeometry } from 'three';
import {
  prepareMeshSurfaceOwnership,
  recordSurfaceOwnershipContribution,
} from '../../lib/mesh-surface-ownership.ts';
import { buildOwnedDepthQueries } from './owned-depth-queries.ts';

function fixture(
  extra: number[] = [2.1, 0.04, 0.08, 2.3, 0.04, 0.08, 2.1, 0.12, 0.08],
) {
  const box = new BoxGeometry(4, 4, 4).toNonIndexed();
  box.translate(2, 2, 2);
  const positions = Float32Array.from([
    ...box.attributes.position.array,
    ...extra,
  ]);
  box.dispose();
  const source = {
    name: 'full bounds and selected small source faces',
    positions,
    colors: new Uint8Array(positions.length / 3),
  };
  const ids = Array.from({ length: extra.length / 9 }, (_, i) => 12 + i);
  const ledger = prepareMeshSurfaceOwnership(
    source,
    {
      min: [0, 0, 0],
      scale: 1,
      gridOffset: [1, 2, 1],
      plateHeight: 0.4,
      gridSize: [4, 10, 4],
    },
    { regions: [{ regionId: 'small', sourceFaceIds: ids }] },
    source,
  );
  for (const id of ids)
    recordSurfaceOwnershipContribution(ledger, '3,2,1', id, 0.008);
  return ledger;
}

void test('a small corner source fragment supplies its own strictly interior sample and physical area', () => {
  const ledger = fixture();
  const before = structuredClone(ledger);
  const result = buildOwnedDepthQueries({
    ownership: ledger,
    regionId: 'small',
    editableCellKeys: ['3,2,1'],
    axis: 2,
  });
  assert.equal(result.status, 'collected');
  assert.deepEqual(result.unresolvedCells, []);
  assert.equal(result.queries.length, 1);
  const q = result.queries[0];
  assert.deepEqual(q.column, [3, 2]);
  assert.ok(q.samplePoint[0] > 3.1 && q.samplePoint[0] < 3.2);
  assert.ok(q.samplePoint[1] > 2.1 && q.samplePoint[1] < 2.2);
  assert.ok(
    Math.abs(q.areaStudsSquared - 0.008) < 1e-8,
    'Y area uses physical 0.4-plate scale',
  );
  assert.ok(Math.abs(q.surfaceDepth - 1.08) < 1e-8);
  assert.deepEqual(ledger, before);
});

void test('two surfaces in one owned cell retain both depth and face associations', () => {
  const first = [2.1, 0.04, 0.08, 2.3, 0.04, 0.08, 2.1, 0.12, 0.08];
  const ledger = fixture([
    ...first,
    ...first.map((v, i) => (i % 3 === 2 ? v + 0.6 : v)),
  ]);
  const result = buildOwnedDepthQueries({
    ownership: ledger,
    regionId: 'small',
    editableCellKeys: ['3,2,1'],
    axis: 2,
  });
  assert.deepEqual(result.unresolvedCells, []);
  assert.deepEqual(
    result.queries.map((q) => q.sourceFaceId),
    [12, 13],
  );
  assert.deepEqual(
    result.queries[0].samplePoint,
    result.queries[1].samplePoint,
  );
  assert.ok(
    result.queries[1].surfaceDepth - result.queries[0].surfaceDepth > 0.59,
  );
});

void test('a designed cell cannot borrow a source face that has no original area there', () => {
  const ledger = fixture();
  ledger.cells.set('4,2,1', structuredClone(ledger.cells.get('3,2,1')!));
  const result = buildOwnedDepthQueries({
    ownership: ledger,
    regionId: 'small',
    editableCellKeys: ['4,2,1'],
    axis: 2,
  });
  assert.equal(result.queries.length, 0);
  assert.ok(
    result.unresolvedCells[0].reasons.includes(
      'original-source-face-has-no-positive-area-in-designed-cell',
    ),
  );
});

void test('mixed ownership and tangent source fragments cannot supply a depth sample', () => {
  const ledger = fixture();
  recordSurfaceOwnershipContribution(ledger, '3,2,1', 0, 0.2);
  const mixed = buildOwnedDepthQueries({
    ownership: ledger,
    regionId: 'small',
    editableCellKeys: ['3,2,1'],
    axis: 2,
  });
  assert.equal(mixed.queries.length, 0);
  assert.ok(mixed.unresolvedCells.length);
  const tangent = buildOwnedDepthQueries({
    ownership: fixture(),
    regionId: 'small',
    editableCellKeys: ['3,2,1'],
    axis: 0,
  });
  assert.equal(tangent.queries.length, 0);
  assert.ok(
    tangent.unresolvedCells[0].reasons.includes(
      'original-source-face-tangent-to-depth-axis',
    ),
  );
});

void test('invalid selections and finite work budgets never return partial query permission', () => {
  const input = {
    ownership: fixture(),
    regionId: 'small',
    editableCellKeys: ['3,2,1'],
    axis: 2 as const,
  };
  assert.equal(
    buildOwnedDepthQueries({ ...input, limits: { clipEdgeTests: 1 } }).status,
    'unavailable',
  );
  assert.equal(
    buildOwnedDepthQueries({ ...input, editableCellKeys: ['3,2,1', '3,2,1'] })
      .status,
    'unavailable',
  );
  assert.equal(
    buildOwnedDepthQueries({ ...input, regionId: 'missing' }).status,
    'unavailable',
  );
  const extra = [2.1, 0.04, 0.08, 2.3, 0.04, 0.08, 2.1, 0.12, 0.08];
  const limited = buildOwnedDepthQueries({
    ...input,
    ownership: fixture([...extra, ...extra]),
    limits: { queries: 1 },
  });
  assert.equal(limited.status, 'unavailable');
  assert.deepEqual(limited.queries, []);
});
