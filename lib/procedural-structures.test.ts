import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLatticeTowerScaffold } from './procedural-structures.ts';

test('lattice scaffold has four legs, a platform and a spire', () => {
  const bricks = generateLatticeTowerScaffold(24, 60, 16, () => true, 7);
  assert.ok(bricks.length >= 12);
  assert.ok(bricks.some((b) => b.y > 25));
  assert.ok(bricks.some((b) => b.part === '3710'));
  assert.ok(new Set(bricks.map((b) => `${b.x},${b.y},${b.z}`)).size === bricks.length);
});

