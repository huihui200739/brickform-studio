import test from 'node:test';
import assert from 'node:assert/strict';
import { regularizePlatform } from './horizontal-surfaces.ts';

test('level plaza removes isolated one-plate sampling noise and preserves stairs, holes and pedestals', () => {
  const cells = new Map<string, { color: number; support: boolean }>();
  for (let x = 0; x < 20; x++)
    for (let z = 0; z < 20; z++)
      for (let y = 2; y <= 8; y++)
        cells.set(`${x},${y},${z}`, { color: 7, support: false });
  cells.set('5,9,5', { color: 7, support: false });
  cells.delete('8,8,8');
  for (let y = 9; y <= 12; y++)
    cells.set(`12,${y},12`, { color: 7, support: false });
  for (let y = 2; y <= 8; y++) cells.delete(`15,${y},15`);
  for (let x = 0; x < 4; x++)
    for (let z = 0; z < 20; z++)
      for (let y = 9; y <= 11; y++)
        cells.set(`${x},${y},${z}`, { color: 7, support: false });
  assert.equal(regularizePlatform(cells, 20, 40, 20), 2);
  assert.equal(cells.has('5,9,5'), false);
  assert.equal(cells.has('8,8,8'), true);
  assert.equal(cells.has('12,12,12'), true);
  assert.equal(cells.has('15,8,15'), false);
  assert.equal(cells.has('2,11,9'), true);
});
