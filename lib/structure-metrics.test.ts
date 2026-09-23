import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  summarizeSurfaceColors,
  type Brick,
  type Model,
} from './brick-engine.ts';
import { analyzeStructure } from './structure-metrics.ts';

function model(bricks: Brick[]): Model {
  return {
    name: 'structure fixture',
    bricks,
    width: 8,
    depth: 4,
    height: 6,
    levels: [...new Set(bricks.map((brick) => brick.y))],
    supportCount: 0,
    source: 'sample',
    resolution: 20,
    shape: 'sculpture',
  };
}

function plate(
  id: number,
  part: string,
  x: number,
  y: number,
  w: number,
  d: number,
): Brick {
  return { id, part, x, y, z: 0, w, d, h: 1, color: 3 };
}

void test('reports repeated same-footprint stacking as an interlock weakness', () => {
  const metrics = analyzeStructure(
    model([
      plate(1, '3020', 0, 0, 4, 2),
      plate(2, '3020', 0, 1, 4, 2),
      plate(3, '3020', 0, 2, 4, 2),
    ]),
  );
  assert.equal(metrics.bridgeCandidateParts, 2);
  assert.equal(metrics.exactStackedParts, 2);
  assert.equal(metrics.exactStackRate, 1);
  assert.equal(metrics.maxExactStackRun, 2);
  assert.equal(metrics.multiSupportParts, 0);
});

void test('recognises a plate that bonds two lower parts', () => {
  const metrics = analyzeStructure(
    model([
      plate(1, '3022', 0, 0, 2, 2),
      plate(2, '3022', 2, 0, 2, 2),
      plate(3, '3020', 0, 1, 4, 2),
    ]),
  );
  assert.equal(metrics.bridgeCandidateParts, 1);
  assert.equal(metrics.exactStackedParts, 0);
  assert.equal(metrics.multiSupportParts, 1);
  assert.equal(metrics.multiSupportRate, 1);
  assert.equal(metrics.supportInterfaces, 2);
  assert.equal(metrics.averageSupportPartners, 2);
});

void test('keeps low stud contact separate from same-footprint stacking', () => {
  const metrics = analyzeStructure(
    model([plate(1, '3024', 0, 0, 1, 1), plate(2, '3020', 0, 1, 4, 2)]),
  );
  assert.equal(metrics.lowContactParts, 1);
  assert.equal(metrics.singleStudInterfaces, 1);
  assert.equal(metrics.exactStackedParts, 0);
  assert.equal(metrics.validation.unsupported, 0);
});

void test('summarises exposed colours and their boundaries', () => {
  const mixed = summarizeSurfaceColors([
    { x: 0, y: 0, z: 0, color: 7 },
    { x: 1, y: 0, z: 0, color: 8 },
  ]);
  assert.deepEqual(mixed.colors, [7, 8]);
  assert.equal(mixed.boundaryEdges, 1);
  assert.equal(mixed.dominant, 7);

  const single = summarizeSurfaceColors([{ x: 0, y: 0, z: 0, color: 7 }]);
  assert.deepEqual(single.colors, [7]);
  assert.equal(single.boundaryEdges, 0);
});
