import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReliefStatueFromMask,
  extractStatueMaskFromReference,
  injectStatueIntoNiche,
} from './statue-fallback.ts';

test('image-driven statue fallback creates a shallow subject volume', () => {
  const width = 40,
    height = 40;
  const mask = new Uint8Array(width * height);
  for (let y = 8; y < 32; y++)
    for (let x = 15; x < 25; x++) mask[y * width + x] = 1;
  const relief = buildReliefStatueFromMask(mask, width, height, 20, 24, 2);
  assert.ok(relief.cells.length > 0);
  assert.equal(
    Math.max(...relief.cells.map((v) => v[2])) -
      Math.min(...relief.cells.map((v) => v[2])) +
      1,
    2,
  );
});

test('central reference fallback is deterministic and stays away from the rear plane', () => {
  const data = new Uint8ClampedArray(80 * 80 * 4).fill(220);
  for (let y = 20; y < 52; y++)
    for (let x = 31; x < 49; x++) data.set([45, 45, 45, 255], (y * 80 + x) * 4);
  const image = { width: 80, height: 80, data };
  const a = injectStatueIntoNiche(image, 28, 50, 12);
  const b = injectStatueIntoNiche(image, 28, 50, 12);
  assert.deepEqual(a, b);
  assert.ok(a.cells.length > 0);
  assert.ok(Math.min(...a.cells.map((v) => v[2])) >= 2);
});

test('mask extraction returns a bounded central ROI', () => {
  const data = new Uint8ClampedArray(20 * 20 * 4).fill(200);
  const result = extractStatueMaskFromReference({
    width: 20,
    height: 20,
    data,
  });
  assert.equal(result.width, Math.ceil(20 * 0.66) - Math.floor(20 * 0.34));
  assert.equal(result.height, Math.ceil(20 * 0.58) - Math.floor(20 * 0.18));
});
