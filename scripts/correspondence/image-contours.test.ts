import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Raster } from '../../lib/brick-engine.ts';
import type { ContourSample } from './mesh-contours.ts';
import {
  extractImageContours,
  scoreContourCorrespondence,
} from './image-contours.ts';

function raster(
  width: number,
  height: number,
  value: (x: number, y: number) => number,
  alpha = (_x: number, _y: number) => 255,
): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = value(x, y);
      data.set([v, v, v, alpha(x, y)], (y * width + x) * 4);
    }
  return { width, height, data };
}
const sample = (
  x: number,
  y: number,
  tx: number,
  ty: number,
  group = 0,
  weight = 1,
): ContourSample => ({ x, y, tx, ty, group, weight });

void test('bounded non-clipping illumination rescale preserves long grayscale line evidence and original bytes', () => {
  const a = raster(96, 96, (x) => (x < 48 ? 80 : 200)),
    b = raster(96, 96, (x) => (x < 48 ? 56 : 116)),
    originalA = Array.from(a.data),
    originalB = Array.from(b.data),
    first = extractImageContours(a),
    second = extractImageContours(b);
  assert.ok(
    first.samples.length > 30,
    'a continuous internal edge is retained',
  );
  assert.equal(first.summary.retainedChains, 1);
  assert.equal(second.samples.length, first.samples.length);
  for (let i = 0; i < first.samples.length; i++) {
    assert.equal(first.samples[i].x, second.samples[i].x);
    assert.equal(first.samples[i].y, second.samples[i].y);
    assert.ok(Math.abs(first.samples[i].tx - second.samples[i].tx) < 1e-10);
    assert.ok(Math.abs(first.samples[i].ty - second.samples[i].ty) < 1e-10);
    assert.ok(
      Math.abs(first.samples[i].weight - second.samples[i].weight) < 1e-10,
    );
  }
  assert.deepEqual(Array.from(a.data), originalA);
  assert.deepEqual(Array.from(b.data), originalB);
});

void test('unoriented tangent matching penalizes cross directions, truncates distance, and exposes shared image-chain evidence', () => {
  const geometry = [
      sample(20, 30, 1, 0, 0, 2),
      sample(60, 30, 1, 0, 1, 1),
      sample(90, 90, 1, 0, 2, 1),
    ],
    image = [sample(20, 30, -1, 0, 7), sample(60, 30, -1, 0, 7)],
    result = scoreContourCorrespondence(geometry, image);
  assert.equal(result.residual, 0.25);
  assert.equal(result.coverage, 0.75);
  assert.equal(result.matchedWeight, 3);
  assert.deepEqual(
    result.groups.map((g) => g.matchedImageGroups),
    [[7], [7], []],
    'two geometric groups share one image chain, not independent source evidence',
  );
  const opposite = scoreContourCorrespondence(
      [sample(20, 30, 1, 0)],
      [sample(20, 30, -1, 0)],
    ),
    cross = scoreContourCorrespondence(
      [sample(20, 30, 1, 0)],
      [sample(20, 30, 0, 1)],
    ),
    shifted = scoreContourCorrespondence(
      [sample(20, 30, 1, 0)],
      [sample(20, 34, 1, 0)],
    ),
    absent = scoreContourCorrespondence(
      [sample(20, 30, 1, 0)],
      [sample(20, 39, 1, 0)],
    );
  assert.equal(opposite.residual, 0);
  assert.equal(opposite.coverage, 1);
  assert.equal(cross.residual, 0.5);
  assert.equal(cross.coverage, 0);
  assert.equal(shifted.residual, 0.5);
  assert.equal(shifted.coverage, 1);
  assert.equal(absent.residual, 1);
  assert.equal(absent.coverage, 0);
  const omitted = scoreContourCorrespondence(geometry, image, 0);
  assert.equal(omitted.residual, 0.5);
  assert.equal(omitted.coverage, 0.5);
  assert.deepEqual(
    omitted.groups.map((g) => g.group),
    [1, 2],
  );
});

void test('missing image evidence, sparse short noise and alpha silhouettes cannot yield an apparent contour success', () => {
  const noisy = raster(128, 128, (x, y) =>
      x % 16 >= 7 && x % 16 <= 9 && y % 16 >= 7 && y % 16 <= 9 ? 230 : 50,
    ),
    noise = extractImageContours(noisy),
    empty = extractImageContours(raster(96, 96, () => 100)),
    alphaOnly = extractImageContours(
      raster(
        96,
        96,
        (_x, _y) => 100,
        (x, y) => (x >= 20 && x < 76 && y >= 20 && y < 76 ? 255 : 0),
      ),
    );
  assert.equal(
    noise.samples.length,
    0,
    'tiny high-contrast specks are not long chains',
  );
  assert.ok(noise.summary.rejectedShortChains > 0);
  assert.equal(empty.samples.length, 0);
  assert.equal(alphaOnly.samples.length, 0);
  assert.deepEqual(
    scoreContourCorrespondence([sample(30, 30, 1, 0)], empty.samples),
    {
      residual: 1,
      coverage: 0,
      matchedWeight: 0,
      groups: [
        {
          group: 0,
          totalWeight: 1,
          matchedWeight: 0,
          coverage: 0,
          residual: 1,
          matchedImageGroups: [],
          matchedImageComponents: [],
        },
      ],
      matches: [
        {
          geometryIndex: 0,
          imageIndex: null,
          geometryGroup: 0,
          imageGroup: null,
          distance: 8,
          directionDot: 0,
          orientationPenalty: 0.5,
          residual: 1,
          matched: false,
          weight: 1,
        },
      ],
    },
  );
  assert.equal(scoreContourCorrespondence([], []).coverage, 0);
  assert.equal(scoreContourCorrespondence([], []).residual, 1);
});

void test('large references are bounded to 320 analysis pixels while samples stay in original image coordinates', () => {
  const input = raster(640, 320, (x) => (x < 320 ? 50 : 210)),
    result = extractImageContours(input);
  assert.deepEqual(result.summary.analysisSize, [320, 160]);
  assert.deepEqual(result.summary.inputSize, [640, 320]);
  assert.deepEqual(result.summary.scale, [2, 2]);
  assert.ok(result.samples.length > 50);
  assert.ok(result.samples.every((p) => p.x > 315 && p.x < 325));
  assert.ok(
    Math.max(...result.samples.map((p) => p.y)) > 290,
    'samples were mapped back to the original frame',
  );
});

void test('directional sides of one closed frame remain one source component, while foreground masks exclude page edges', () => {
  const frame = raster(128, 128, (x, y) =>
      x >= 30 && x < 98 && y >= 30 && y < 98 ? 60 : 220,
    ),
    extracted = extractImageContours(frame),
    groups = Array.from(new Set(extracted.samples.map((p) => p.group)));
  assert.ok(
    groups.length >= 3,
    'a rectangle has at least three retained directional chains',
  );
  const components = new Set(extracted.samples.map((p) => p.component));
  assert.equal(
    components.size,
    1,
    'corners must not create independent observed landmarks',
  );
  const geometry = groups.slice(0, 3).map((group, i) => ({
      ...extracted.samples.find((p) => p.group === group)!,
      group: i,
    })),
    scored = scoreContourCorrespondence(geometry, extracted.samples);
  assert.equal(scored.coverage, 1);
  assert.equal(
    new Set(scored.groups.flatMap((g) => g.matchedImageGroups)).size,
    3,
  );
  assert.equal(
    new Set(scored.groups.flatMap((g) => g.matchedImageComponents)).size,
    1,
  );
  const foregroundMask = new Uint8Array(128 * 128);
  for (let y = 38; y < 90; y++)
    for (let x = 38; x < 90; x++) foregroundMask[y * 128 + x] = 1;
  assert.equal(
    extractImageContours(frame, foregroundMask).samples.length,
    0,
    'opaque page/frame boundaries outside the supplied foreground are excluded',
  );
  assert.throws(
    () => extractImageContours(frame, new Uint8Array(127)),
    /one byte per original image pixel/,
  );
});
