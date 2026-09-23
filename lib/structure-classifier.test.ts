import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStructure } from './structure-classifier.ts';

test('sparse tall geometry is classified as a lattice tower', () => {
  const p: number[] = [];
  for (const x of [0, 10]) for (const z of [0, 10])
    for (const y of [0, 10, 20, 30, 40]) p.push(x, y, z);
  const result = classifyStructure({ positions: new Float32Array(p), colors: new Uint8Array(), name: 'test' });
  assert.equal(result.category, 'lattice-tower');
  assert.ok(result.confidence > 0);
});

