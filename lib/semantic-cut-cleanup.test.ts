import test from 'node:test';
import assert from 'node:assert/strict';
import type { Model, Brick } from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { removeSemanticCutRemnants } from './semantic-cut-cleanup.ts';

test('semantic cleanup removes local disconnected chains and preserves other geometry', () => {
  const brick = (id: number, x: number, y: number): Brick =>
    ({ id, part: '3024', x, y, z: 3, w: 1, d: 1, h: 1, color: 7 });
  const raw: Model = {
    name: 'cut-remnants', width: 12, height: 12, depth: 12,
    bricks: [brick(1, 3, 0), brick(2, 3, 1), brick(3, 3, 5), brick(4, 3, 6),
      brick(5, 9, 5), brick(6, 4, 5)],
    levels: [0, 1, 5, 6], supportCount: 0, source: 'image', resolution: 20, shape: 'sculpture',
  };
  const model = groupImageAssembly(raw);
  model.bricks.find(b => b.id === 6)!.section = 'component-preserved';
  const original = model.bricks.map(b => ({ ...b }));
  assert.equal(removeSemanticCutRemnants(model, [{ min: [3, 3, 3], max: [4, 5, 4] }]), 2);
  assert.deepEqual(model.bricks.map(b => [b.x, b.y]), [[3, 0], [3, 1], [9, 5], [4, 5]]);
  assert.deepEqual(model.bricks.map(b => b.pose), original.filter(b => b.id !== 3 && b.id !== 4).map(b => b.pose));
  assert.equal(new Set(model.bricks.map(b => b.id)).size, model.bricks.length);
  assert.ok(model.assembly!.steps.every((_, i) => model.bricks.some(b => b.step === i)));
});
