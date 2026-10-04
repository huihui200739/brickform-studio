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
