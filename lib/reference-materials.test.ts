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

void test('two nearly identical shaded blue faces do not acquire a grey seam; black and gold paint survive', () => {
  const width = 205,
    height = 40;
  const data = new Uint8Array(width * height * 4);
  const mask = new Uint8Array(width * height).fill(1);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const local = x < 100 ? x : x - 105;
      const scale = local < 30 ? 0.4 + (0.6 * local) / 29 : 1;
      const color =
        y >= 35
          ? [242, 205, 55]
          : x >= 100 && x < 105
            ? [36, 36, 36]
            : (x < 100 ? [77, 72, 122] : [74, 72, 124]).map((v) =>
                Math.round(v * scale),
              );
      data.set([...color, 255], (y * width + x) * 4);
    }
  const source = data.slice();
  const on = referenceMaterials({ width, height, data }, mask, true);
  const off = referenceMaterials({ width, height, data }, mask, false);
  assert.equal(
    off.palette[75],
    12,
    'ordinary nearest matching loses the blue hue',
  );
  assert.equal(off.palette[180], 4);
  assert.equal(on.palette[75], 4);
  assert.equal(on.palette[180], 4);
  for (let y = 0; y < 35; y++)
    for (let x = 100; x < 105; x++) assert.equal(on.palette[y * width + x], 1);
  for (let i = 35 * width; i < height * width; i++)
    assert.equal(on.palette[i], off.palette[i]);
  const correction = on.design.regions.find((r) => r.quantization)!;
  assert.ok(correction.quantization!.witnessRegionIds.length > 0);
  for (const id of correction.quantization!.witnessRegionIds) {
    assert.notEqual(id, correction.id);
    assert.equal(
      off.design.regions[id].color,
      4,
      'witness has an independent original blue match',
    );
    assert.equal(
      on.design.regions[id].quantization,
      undefined,
      'corrections cannot become witnesses',
    );
  }
  assert.deepEqual(on.labels, off.labels);
  assert.deepEqual(data, source);
});

void test('isolated chromatic near ties remain unchanged without another observed material region', () => {
  const width = 100,
    height = 30;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const scale = x < 30 ? 0.4 + (0.6 * x) / 29 : 1;
      data.set(
        [...[77, 72, 122].map((v) => Math.round(v * scale)), 255],
        (y * width + x) * 4,
      );
    }
  const result = referenceMaterials(
    { width, height, data },
    new Uint8Array(width * height).fill(1),
    true,
  );
  assert.equal(result.palette[75], 12);
  assert.ok(result.design.regions.every((r) => !r.quantization));
});

void test('subtle cool illumination on grey material is not treated as blue paint', () => {
  const width = 100,
    height = 30;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const scale = 0.45 + (0.55 * x) / 99;
      data.set(
        [...[125, 130, 136].map((v) => Math.round(v * scale)), 255],
        (y * width + x) * 4,
      );
    }
  const result = referenceMaterials(
    { width, height, data },
    new Uint8Array(width * height).fill(1),
    true,
  );
  assert.ok(result.design.regions.every((r) => !r.quantization));
  assert.ok([...result.palette].every((c) => [1, 11, 12].includes(c)));
});
