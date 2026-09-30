import { test } from 'node:test';
import assert from 'node:assert/strict';
import { referenceMaterials } from './reference-materials.ts';

void test('a continuous sand illumination gradient is unified while a dark painted stripe survives', () => {
  const width = 80,
    height = 50,
    data = new Uint8Array(width * height * 4),
    mask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const scale = x < 30 ? 0.45 + (0.55 * x) / 29 : 1;
      const rgb =
        x >= 60 && x < 65
          ? [53, 33, 0]
          : [215, 186, 140].map((v) => Math.round(v * scale));
      data.set([...rgb, 255], (y * width + x) * 4);
    }
  const on = referenceMaterials({ width, height, data }, mask, true),
    off = referenceMaterials({ width, height, data }, mask, false);
  assert.deepEqual([...new Set(on.palette.slice(0, 60))], [7]);
  assert.equal(on.palette[62], 10);
  assert.ok(new Set(off.palette.slice(0, 60)).size > 1);
  assert.ok(on.design.normalizedPixels > 0);
  assert.ok(on.design.regions.some((r) => r.inferredIllumination));
  assert.ok(on.design.warnings.some((w) => w.includes('inference')));
  assert.equal(data[62 * 4], 53, 'source pixels are preserved');
});

void test('neutral grey and black accents are not lifted to a lighter object material', () => {
  const width = 60,
    height = 24,
    data = new Uint8Array(width * height * 4),
    mask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          ...(x < 20
            ? [244, 244, 244]
            : x < 40
              ? [150, 150, 150]
              : [36, 36, 36]),
          255,
        ],
        (y * width + x) * 4,
      );
  const result = referenceMaterials({ width, height, data }, mask, true);
  assert.deepEqual(
    [result.palette[5], result.palette[25], result.palette[45]],
    [0, 11, 1],
  );
  assert.equal(result.design.normalizedPixels, 0);
});

void test('a continuous multicolor paint gradient is rejected rather than turned into one material', () => {
  const width = 200,
    height = 20,
    data = new Uint8Array(width * height * 4),
    mask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      data.set(
        [
          Math.round(230 - (200 * x) / (width - 1)),
          45,
          Math.round(30 + (200 * x) / (width - 1)),
          255,
        ],
        (y * width + x) * 4,
      );
  const result = referenceMaterials({ width, height, data }, mask, true);
  assert.ok(result.design.regions.some((r) => r.chromaticityResidual > 0.1));
  assert.ok(new Set(result.palette).size >= 2);
  assert.equal(result.design.normalizedPixels, 0);
});
