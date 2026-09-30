import test from 'node:test';
import assert from 'node:assert/strict';
import { installCavityLintel } from './cavity-lintel.ts';
import { finishModel, validateModel } from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { connectedBelow } from './build-instructions.ts';

for (const axis of [0, 2] as const) test(`a ten-stud cavity has a counted lintel supported at both ends, axis ${axis}`, () => {
  const source = new Map<string, { color: number; support: boolean }>();
  for (let x = 0; x < 20; x++)
    for (let z = 0; z < 20; z++)
      for (const y of [2, 14]) source.set(`${x},${y},${z}`, { color: 7, support: false });
  const cells = new Map(source);
  const box = axis === 2 ? { min: [4, 3, 2] as [number,number,number], max: [14, 12, 4] as [number,number,number] }
    : { min: [2, 3, 4] as [number,number,number], max: [4, 12, 14] as [number,number,number] };
  const fixed = installCavityLintel(cells, source, box, axis, 7);
  assert.equal(fixed.filter(b => b.part === '3020').length, 2);
  assert.equal(fixed.filter(b => b.part === '3034').length, 1);
  const blocked = (x: number, y: number, z: number) =>
    [x, y, z].every((v, i) => v >= box.min[i] && v < box.max[i]);
  const model = groupImageAssembly(finishModel(cells, 20, 17, 20, 'image', 'niche', 20, 7, blocked, fixed));
  const check = validateModel(model);
  assert.equal(check.collisions, 0);
  assert.equal(check.unsupported, 0);
  assert.equal(check.connected, true);
  const beam = model.bricks.find(b => b.part === '3034' && b.y === 13)!;
  const bearings = connectedBelow(model, beam);
  assert.equal(bearings.length, 2);
  assert.ok(bearings.every(b => b.part === '3020'));
  assert.ok(model.bricks.every(b => !blocked(b.x, b.y, b.z)));
});

test('a lintel cannot invent bearing pillars in a foreground semantic clearance', () => {
  const source = new Map<string, { color: number; support: boolean }>();
  for (let x = 0; x < 20; x++)
    for (let z = 2; z < 4; z++)
      for (const y of [2, 14]) source.set(`${x},${y},${z}`, { color: 7, support: false });
  const cells = new Map(source);
  const before = new Map(cells);
  const fixed = installCavityLintel(cells, source, { min: [4, 3, 2], max: [14, 12, 4] }, 2, 7,
    (x, y) => x >= 14 && y >= 4 && y < 12);
  assert.deepEqual(fixed, []);
  assert.deepEqual(cells, before, 'a rejected bearing must leave no partial pillars');
});
