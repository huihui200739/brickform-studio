import test from 'node:test';
import assert from 'node:assert/strict';
import { aestheticScore, scorePackingChoice } from './aesthetic-packing.ts';
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

