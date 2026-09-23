import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLatticeTowerScaffold } from './procedural-structures.ts';
import { BoxGeometry } from 'three';
import { meshToDesign } from './mesh-design.ts';
import { validateModel } from './brick-engine.ts';

test('lattice scaffold has four legs, a platform and a spire', () => {
  const bricks = generateLatticeTowerScaffold(24, 60, 16, () => true, 7);
  assert.ok(bricks.length >= 12);
  assert.ok(bricks.some((b) => b.y > 25));
  assert.ok(bricks.some((b) => b.part === '3710'));
  assert.ok(new Set(bricks.map((b) => `${b.x},${b.y},${b.z}`)).size === bricks.length);
});

test('lattice structures route to an open procedural representation', () => {
  const positions: number[] = [];
  const colors: number[] = [];
  for (const [x, z] of [[0, 0], [18, 0], [0, 18], [18, 18]]) {
    const geometry = new BoxGeometry(2, 54, 2).toNonIndexed().translate(x + 1, 27, z + 1);
    positions.push(...geometry.attributes.position.array);
    for (let i = 0; i < geometry.attributes.position.count / 3; i++) colors.push(215, 186, 140);
    geometry.dispose();
  }
  const model = meshToDesign({
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    name: 'sparse landmark',
  }, 28);
  assert.equal(model.structureCategory, 'lattice-tower');
  assert.equal(model.representationPlans?.[0]?.kind, 'procedural-structure');
  assert.ok(model.bricks.some((brick) => brick.part === '3710'));
  assert.equal(validateModel(model).connected, true);
});
