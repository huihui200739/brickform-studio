import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  proposeExteriorVoid,
  type ExteriorVoidInput,
} from './exterior-void.ts';
import { uprightCatalogBrick } from './upright-layout.ts';
import type { Model } from '../../lib/brick-engine.ts';

function panel(x: number, y0 = 0, y1 = 0.4, z0 = 0, z1 = 1) {
  return [x, y0, z0, x, y1, z0, x, y1, z1, x, y0, z0, x, y1, z1, x, y0, z1];
}
function box(lo: [number, number, number], hi: [number, number, number]) {
  const [x, y, z] = lo,
    [X, Y, Z] = hi,
    out: number[] = [];
  type P = [number, number, number];
  const quad = (a: P, b: P, c: P, d: P) =>
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad([x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]);
  quad([X, y, z], [X, Y, z], [X, Y, Z], [X, y, Z]);
  quad([x, y, z], [X, y, z], [X, y, Z], [x, y, Z]);
  quad([x, Y, z], [x, Y, Z], [X, Y, Z], [X, Y, z]);
  quad([x, y, z], [x, Y, z], [X, Y, z], [X, y, z]);
  quad([x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]);
  return out;
}
function fixture(positions = panel(2.4)): ExteriorVoidInput {
  const model: Model = {
    name: 'void control',
    width: 5,
    height: 6,
    depth: 4,
    bricks: [],
    levels: [],
    source: 'image',
    shape: 'sculpture',
    resolution: 28,
    supportCount: 0,
  };
  model.bricks = [uprightCatalogBrick('3023', 3, 0, 0, 0, 7, 1, model)];
  return {
    source: { positions, faceIds: [0, 1], complete: true },
    model,
    axis: 0,
    direction: 1,
  };
}
void test('complete near-axis source footprint proves only body cells strictly outside its full depth', () => {
  const i = fixture(),
    snapshot = JSON.stringify(i);
  const result = proposeExteriorVoid(i);
  assert.equal(result.status, 'candidate');
  if (result.status !== 'candidate') throw Error('unavailable');
  assert.deepEqual(result.emptyBodyCells, ['3,0,0', '4,0,0']);
  assert.equal(result.columns.length, 1);
  assert.equal(result.sourceTruthVerified, false);
  assert.equal(result.assemblyVerified, false);
  assert.equal(JSON.stringify(i), snapshot);
  i.model.bricks = [uprightCatalogBrick('3023', 2, 0, 0, 0, 7, 1, i.model)];
  const near = proposeExteriorVoid(i);
  assert.ok(near.status === 'candidate');
  assert.deepEqual(near.emptyBodyCells, ['3,0,0']);
});
void test('partial target coverage, holes and positive overlaps never authorize whole-cell deletion', () => {
  for (const p of [
    panel(2.4, 0.05, 0.4),
    [...panel(2.4, 0, 0.15), ...panel(2.4, 0.25, 0.4)],
    [...panel(2.4), ...panel(2.4)],
  ]) {
    const i = fixture(p);
    i.source.faceIds = Array.from({ length: p.length / 9 }, (_, i) => i);
    const r = proposeExteriorVoid(i);
    assert.equal(r.status, 'noop');
    assert.equal(r.emptyBodyCells.length, 0);
    assert.ok(r.rejectedColumns.length > 0);
  }
});
void test('all original surfaces protect thin foreground layers and nearby objects; back layers do not fill the exterior', () => {
  const inFront = fixture([...panel(2.4), ...panel(3.5, 0.1, 0.2, 0.2, 0.3)]);
  const blocked = proposeExteriorVoid(inFront);
  assert.equal(blocked.status, 'noop');
  assert.match(blocked.rejectedColumns[0].reason, /another original surface/);
  const behind = proposeExteriorVoid(fixture([...panel(2.4), ...panel(1.2)]));
  assert.equal(behind.status, 'candidate');
});
void test('negative-facing target uses the full cell far edge and physical plate height', () => {
  const i = fixture(panel(2.4));
  const p = Array.from(i.source.positions);
  for (let at = 0; at < p.length; at += 9) {
    const b = p.slice(at + 3, at + 6);
    p.splice(at + 3, 3, ...p.slice(at + 6, at + 9));
    p.splice(at + 6, 3, ...b);
  }
  i.source.positions = p;
  i.direction = -1;
  i.model.bricks = [uprightCatalogBrick('3023', 1, 0, 0, 0, 7, 1, i.model)];
  const r = proposeExteriorVoid(i);
  assert.equal(r.status, 'candidate');
  if (r.status !== 'candidate') throw Error('unavailable');
  assert.deepEqual(r.emptyBodyCells, ['1,0,0']);
});
void test('folds, incomplete scenes, invalid selections and nonfinite outside geometry fail without partial permission', () => {
  for (const i of [
    { ...fixture(), direction: -1 as const },
    { ...fixture(), source: { ...fixture().source, complete: false } },
    { ...fixture(), source: { ...fixture().source, faceIds: [0, 0] } },
    fixture([...panel(2.4), NaN, 0, 0, 0, 1, 0, 0, 0, 1]),
  ])
    assert.equal(proposeExteriorVoid(i).status, 'unavailable');
});

void test('explicit piecewise target preserves a folded profile and deletes only beyond its whole outer envelope', () => {
  const p = [
    2.2, 0, 0, 2.6, 0.2, 0, 2.6, 0.2, 1, 2.2, 0, 0, 2.6, 0.2, 1, 2.2, 0, 1, 2.6,
    0.2, 0, 2.2, 0.4, 0, 2.2, 0.4, 1, 2.6, 0.2, 0, 2.2, 0.4, 1, 2.6, 0.2, 1,
  ];
  const i = fixture(p);
  i.source.faceIds = [0, 1, 2, 3];
  assert.equal(proposeExteriorVoid(i).status, 'unavailable');
  i.coverageMode = 'piecewise-exterior-envelope';
  const snapshot = JSON.stringify(i);
  const r = proposeExteriorVoid(i);
  assert.equal(r.status, 'candidate', JSON.stringify(r));
  if (r.status !== 'candidate') throw Error('unavailable');
  assert.deepEqual(r.emptyBodyCells, ['3,0,0', '4,0,0']);
  assert.equal(r.columns[0].sourceMaxSignedDepth, 2.6);
  assert.equal(r.columns[0].depthFragments?.length, 4);
  assert.equal(JSON.stringify(i), snapshot);
});

void test('projected union cannot hide a gap by summing overlapping layers, including narrow gaps', () => {
  for (const [lo, hi] of [
    [0.1, 0.3],
    [0.199995, 0.200005],
  ]) {
    const p = [
      ...panel(2.4, 0, lo),
      ...panel(2.4, 0, lo),
      ...panel(2.6, hi, 0.4),
      ...panel(2.6, hi, 0.4),
    ];
    const i = fixture(p);
    i.source.faceIds = Array.from({ length: p.length / 9 }, (_, id) => id);
    i.coverageMode = 'piecewise-exterior-envelope';
    const r = proposeExteriorVoid(i);
    assert.equal(r.status, 'noop', JSON.stringify(r));
    assert.match(
      r.rejectedColumns[0].reason,
      /partial target footprint or hole/,
    );
  }
});

void test('compound depth layers remain separate and never authorize deleting between front and back layers', () => {
  const i = fixture([...panel(2.4), ...panel(4.2)]);
  i.source.faceIds = [0, 1, 2, 3];
  i.coverageMode = 'piecewise-exterior-envelope';
  i.model.width = 7;
  const fullModel = {
    ...i.model,
    name: 'layer control',
    levels: [],
    source: 'image' as const,
    shape: 'sculpture' as const,
    resolution: 28,
    supportCount: 0,
  };
  i.model.bricks = [
    uprightCatalogBrick('3023', 3, 0, 0, 0, 7, 1, fullModel),
    uprightCatalogBrick('3023', 5, 0, 0, 0, 7, 2, fullModel),
  ];
  const r = proposeExteriorVoid(i);
  assert.equal(r.status, 'candidate', JSON.stringify(r));
  if (r.status !== 'candidate') throw Error('unavailable');
  assert.deepEqual(r.emptyBodyCells, ['5,0,0', '6,0,0']);
  assert.ok(r.columns[0].depthFragments?.some((f) => f.maxSignedDepth === 2.4));
  assert.ok(r.columns[0].depthFragments?.some((f) => f.maxSignedDepth === 4.2));
  i.source.positions = [
    ...Array.from(i.source.positions),
    ...panel(6.1, 0.1, 0.2, 0.2, 0.3),
  ];
  const blocked = proposeExteriorVoid(i);
  assert.equal(blocked.status, 'noop', JSON.stringify(blocked));
  assert.match(blocked.rejectedColumns[0].reason, /another original surface/);
});

void test('every positive-area microscopic foreground face protects its real depth', () => {
  const positions = [
    ...panel(2.4),
    ...box([3.2, 0.1, 0.2], [3.6, 0.100001, 0.200001]),
  ];
  for (const coverageMode of [
    'near-axis-single-layer',
    'piecewise-exterior-envelope',
  ] as const) {
    const i = { ...fixture(positions), coverageMode };
    const before = JSON.stringify(i);
    const result = proposeExteriorVoid(i);
    assert.equal(result.status, 'noop', JSON.stringify(result));
    assert.match(result.rejectedColumns[0].reason, /another original surface/);
    assert.deepEqual(result.emptyBodyCells, []);
    assert.equal(JSON.stringify(i), before);
  }
  const selected = fixture([
    ...panel(2.4),
    ...panel(3.5, 0.1, 0.100001, 0.2, 0.200001),
  ]);
  selected.source.faceIds = [0, 1, 2, 3];
  selected.coverageMode = 'piecewise-exterior-envelope';
  const result = proposeExteriorVoid(selected);
  assert.equal(result.status, 'candidate', JSON.stringify(result));
  assert.deepEqual(result.emptyBodyCells, ['4,0,0']);
  assert.equal(result.columns[0].sourceMaxSignedDepth, 3.5);
  assert.equal(result.columns[0].depthFragments?.length, 4);
});

void test('real narrow holes in either projected axis are never complete within an area tolerance', () => {
  for (const positions of [
    [...panel(2.4, 0, 0.2), ...panel(2.4, 0.200000001, 0.4)],
    [...panel(2.4, 0, 0.4, 0, 0.5), ...panel(2.4, 0, 0.4, 0.500000001, 1)],
  ]) {
    for (const coverageMode of [
      'near-axis-single-layer',
      'piecewise-exterior-envelope',
    ] as const) {
      const i = { ...fixture(positions), coverageMode };
      i.source.faceIds = [0, 1, 2, 3];
      const result = proposeExteriorVoid(i);
      assert.equal(result.status, 'noop', JSON.stringify(result));
      assert.deepEqual(result.emptyBodyCells, []);
      assert.match(
        result.rejectedColumns[0].reason,
        /partial target footprint or hole/,
      );
    }
  }
});

void test('unselected bbox misses consume the unchanged finite projection budget', () => {
  const i = fixture([...panel(2.4), ...panel(3.5, 0.4, 800.4, 1, 1101)]);
  i.model.height = 2001;
  i.model.depth = 1101;
  i.coverageMode = 'piecewise-exterior-envelope';
  const result = proposeExteriorVoid(i);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.reasons, [
    'exterior projection work budget exceeded',
  ]);
  assert.equal('emptyBodyCells' in result, false);
});

void test('default mode rejects every positive-area overlap even below the former epsilon', () => {
  const i = fixture([
    ...panel(2.4),
    ...panel(2.4, 0.1, 0.100001, 0.2, 0.200001),
  ]);
  i.source.faceIds = [0, 1, 2, 3];
  const result = proposeExteriorVoid(i);
  assert.equal(result.status, 'noop', JSON.stringify(result));
  assert.deepEqual(result.emptyBodyCells, []);
  assert.match(
    result.rejectedColumns[0].reason,
    /overlapping target projections/,
  );
});

void test('axis clipping snaps computed boundary intersections without changing source coordinates', () => {
  const i = fixture(panel(2.4, -0.17, 0.61, -0.31, 1.43));
  i.coverageMode = 'piecewise-exterior-envelope';
  const before = JSON.stringify(i);
  const result = proposeExteriorVoid(i);
  assert.equal(result.status, 'candidate', JSON.stringify(result));
  assert.deepEqual(result.emptyBodyCells, ['3,0,0', '4,0,0']);
  assert.equal(JSON.stringify(i), before);
  for (const coverageMode of [
    'near-axis-single-layer',
    'piecewise-exterior-envelope',
  ] as const) {
    const plate = { ...fixture(panel(2.99, 0, 1.2, 1, 3)), coverageMode };
    plate.model.bricks = [
      uprightCatalogBrick('3023', 3, 0, 1, 0, 7, 1, plate.model as Model),
    ];
    const result = proposeExteriorVoid(plate);
    assert.equal(result.status, 'candidate', JSON.stringify(result));
    assert.ok(
      result.columns.some((c) => c.column[0] === 2 && c.column[1] === 1),
    );
  }
});

void test('unrepresentable event bands and positive-area underflow fail without partial deletion permission', () => {
  const gap = fixture([
    ...panel(2.4, 0, 0.2),
    ...panel(2.4, 0.2 + Number.EPSILON / 8, 0.4),
  ]);
  gap.source.faceIds = [0, 1, 2, 3];
  gap.coverageMode = 'piecewise-exterior-envelope';
  const result = proposeExteriorVoid(gap);
  assert.equal(result.status, 'noop', JSON.stringify(result));
  assert.deepEqual(result.emptyBodyCells, []);
  assert.match(
    result.rejectedColumns[0].reason,
    /partial target footprint or hole/,
  );
  const tiny = fixture([...panel(2.4), ...panel(3.5, 0, 1e-170, 0, 1e-170)]);
  tiny.coverageMode = 'piecewise-exterior-envelope';
  const underflow = proposeExteriorVoid(tiny);
  assert.equal(underflow.status, 'unavailable', JSON.stringify(underflow));
  assert.match(underflow.reasons[0], /unresolved/);
  assert.equal('emptyBodyCells' in underflow, false);
  tiny.source.faceIds = [0, 1, 2, 3];
  const selectedUnderflow = proposeExteriorVoid(tiny);
  assert.equal(selectedUnderflow.status, 'unavailable');
  assert.deepEqual(selectedUnderflow.reasons, [
    'unresolved degenerate selected source geometry',
  ]);
});

void test('exact repeated crossing edges in opposite windings generate one geometric event and retain every depth contributor', () => {
  // Actual Temple B crossing endpoints: the four winding combinations used
  // to produce adjacent floating events at 31.12212043314825 and ...8254.
  const first = [
    31.056929133900432, 20.07611313572535, 2.6, 31.43499875679146,
    20.34157180470863, 2.6, 31.06, 20.3, 2.6,
  ];
  const second = [
    31.43499875679146, 20.380726180151182, 2.6, 31.066790553185854,
    20.07611313572535, 2.6, 31.4, 20.1, 2.6,
  ];
  const reverse = (p: number[]) => [
    ...p.slice(0, 3),
    ...p.slice(6, 9),
    ...p.slice(3, 6),
  ];
  const i = fixture([
    31,
    20,
    2.4,
    32,
    20,
    2.4,
    32,
    20.4,
    2.4,
    31,
    20,
    2.4,
    32,
    20.4,
    2.4,
    31,
    20.4,
    2.4,
    ...first,
    ...reverse(first),
    ...second,
    ...reverse(second),
  ]);
  i.source.faceIds = [0, 1, 2, 3, 4, 5];
  i.axis = 2;
  i.coverageMode = 'piecewise-exterior-envelope';
  i.model.width = 34;
  i.model.height = 52;
  i.model.depth = 6;
  i.model.bricks = [
    uprightCatalogBrick('3024', 31, 50, 3, 0, 7, 1, i.model as Model),
  ];
  const result = proposeExteriorVoid(i);
  assert.equal(result.status, 'candidate', JSON.stringify(result));
  assert.deepEqual(result.emptyBodyCells, ['31,50,3']);
  assert.equal(result.columns[0].sourceMaxSignedDepth, 2.6);
  assert.deepEqual(result.columns[0].sourceFaceIds, [0, 1, 2, 3, 4, 5]);
  assert.equal(result.columns[0].depthFragments?.length, 6);
});
