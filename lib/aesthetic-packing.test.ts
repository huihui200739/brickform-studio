import test from 'node:test';
import assert from 'node:assert/strict';
import { aestheticScore, optimizeAestheticPacking, scorePackingChoice } from './aesthetic-packing.ts';
import { sampleModel } from './brick-engine.ts';

test('packing choice prefers larger connected pieces over noisy singles', () => {
  const large = scorePackingChoice({ area: 8, height: 3, contacts: 4, supporters: 2, exactStack: false, small: false });
  const small = scorePackingChoice({ area: 1, height: 1, contacts: 1, supporters: 1, exactStack: true, small: true });
  assert.ok(large > small);
});

test('finished models expose a deterministic aesthetic breakdown', () => {
  const model = sampleModel(20, 8);
  const first = aestheticScore(model);
  const second = aestheticScore(model);
  assert.deepEqual(first, second);
  assert.ok(first.score >= 0 && first.score <= 1);
});

test('aesthetic post-processing removes a redundant support without breaking the graph', () => {
  const model = {
    name: 'support-reduction',
    bricks: [
      { id: 1, part: '3020', x: 0, y: 0, z: 0, w: 4, d: 2, h: 1, color: 7 },
      { id: 2, part: '3024', x: 0, y: 1, z: 0, w: 1, d: 1, h: 1, color: 7, support: true },
      { id: 3, part: '3024', x: 1, y: 1, z: 0, w: 1, d: 1, h: 1, color: 7, support: true },
      { id: 4, part: '3020', x: 0, y: 2, z: 0, w: 2, d: 1, h: 1, color: 7 },
    ],
    width: 4,
    depth: 2,
    height: 3,
    levels: [0, 1, 2],
    supportCount: 2,
    source: 'sample' as const,
    resolution: 20,
    shape: 'sculpture' as const,
  };
  const before = model.supportCount;
  const result = optimizeAestheticPacking(model, 8);
  assert.ok(result.removed >= 1);
  assert.ok(model.supportCount < before);
  assert.equal(model.bricks.length, 3);
});
