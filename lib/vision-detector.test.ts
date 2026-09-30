import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSceneRaster } from './local-scene-request.ts';
import {
  decodeVisionScene,
  hasVerifiedIdentity,
  VisionSceneDetector,
  type VisionSceneResponse,
} from './scene/detectors/vision-detector.ts';

const image = {
  width: 4,
  height: 4,
  data: new Uint8ClampedArray(64).fill(255),
};
function response(): VisionSceneResponse {
  return {
    version: 1,
    imageSize: [4, 4],
    engineFingerprint: 'a'.repeat(64),
    models: {
      detection: { repo: 'test/learned-detector', revision: 'b'.repeat(40) },
      segmentation: { repo: 'test/masks', revision: 'c'.repeat(40) },
    },
    elements: [
      {
        category: 'brazier',
        label: 'burning flame',
        identityScore: 0.44,
        identityThreshold: 0.3,
        identitySupported: true,
        maskScore: 0.85,
        imageBox: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
        anchorUV: [0.5, 0.75],
        maskSize: [4, 4],
        maskRuns: [5, 2, 9, 2],
      },
    ],
  };
}

void test('grounded identity score remains separate from placement and segmentation scores', () => {
  const element = decodeVisionScene(response(), image)[0];
  assert.equal(element.identity!.score, 0.44);
  assert.equal(element.confidence, 0.44);
  assert.equal(element.identity!.maskScore, 0.85);
  assert.equal(hasVerifiedIdentity(element), true);
  element.identity!.score = 0.1;
  element.anchorConfidence = 1;
  element.placementScore = 1;
  assert.equal(hasVerifiedIdentity(element), false);
});

void test('color candidates cannot invent learned instances when the model found none', async () => {
  const empty = response();
  empty.elements = [];
  assert.deepEqual(
    await new VisionSceneDetector(async () => empty).detect(image),
    [],
  );
});

void test('mask and reference bounds reject corrupt observations before geometry removal', () => {
  const invalid = response();
  invalid.elements[0].maskRuns = [15, 2];
  assert.throws(() => decodeVisionScene(invalid, image));
  const mismatched = response();
  mismatched.imageSize = [8, 8];
  assert.throws(() => decodeVisionScene(mismatched, image));
  const threshold = response();
  threshold.elements[0].identityThreshold = 0;
  assert.throws(() => decodeVisionScene(threshold, image));
});

void test('native raster input validates byte values and allocation limits', () => {
  assert.equal(
    decodeSceneRaster({ width: 4, height: 4, rgba: Array(64).fill(255) }).data
      .length,
    64,
  );
  assert.throws(() =>
    decodeSceneRaster({ width: 4, height: 4, rgba: Array(64).fill(256) }),
  );
  assert.throws(() =>
    decodeSceneRaster({ width: 10000, height: 10000, rgba: [] }),
  );
});
