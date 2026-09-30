import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fitRecessGeometry } from './design-geometry.ts';
import { colorFromReference, referenceAlignment } from './reference-colors.ts';
import { detectRefinements } from './semantic-refinement.ts';
import { VisionSceneDetector } from './scene/detectors/vision-detector.ts';

void test('cropped and full-frame statue masks identify the same observed rear wall', async () => {
  const read = (name: string) =>
    JSON.parse(
      gunzipSync(
        readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
      ).toString(),
    );
  const source = read('temple-original.mesh.json.gz');
  source.positions = new Float32Array(source.positions);
  source.colors = new Uint8Array(source.colors);
  const image = read('temple-original.raster.json.gz');
  const mesh = colorFromReference(source, image);
  const camera = { yaw: 15, pitch: 25, perspective: 0.25 };
  const regions = await detectRefinements(
    mesh,
    image,
    48,
    undefined,
    camera,
    new VisionSceneDetector(async () =>
      JSON.parse(
        readFileSync(
          new URL('./fixtures/temple-original.scene.json', import.meta.url),
          'utf8',
        ),
      ),
    ),
  );
  const element = regions.find((r) => r.kind === 'statue')!.sceneElement!;
  const box = element.imageBox!;
  const [w, h] = element.imageMaskSize!;
  assert.notDeepEqual(
    [w, h],
    [image.width, image.height],
    'this actual failure uses a cropped mask',
  );
  const full = new Uint8Array(image.width * image.height);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const u = x / (image.width - 1),
        v = y / (image.height - 1);
      if (
        u < box.x ||
        u > box.x + box.width ||
        v < box.y ||
        v > box.y + box.height
      )
        continue;
      full[y * image.width + x] =
        element.imageMask![
          Math.round(((v - box.y) / box.height) * (h - 1)) * w +
            Math.round(((u - box.x) / box.width) * (w - 1))
        ];
    }
  const alignment = referenceAlignment(mesh, image, camera);
  const cropped = fitRecessGeometry(
    mesh,
    image,
    element,
    alignment,
    48,
    [25, 42, 21],
    2,
    1,
  )!;
  const expanded = fitRecessGeometry(
    mesh,
    image,
    { ...element, imageMask: full, imageMaskSize: [image.width, image.height] },
    alignment,
    48,
    [25, 42, 21],
    2,
    1,
  )!;
  assert.ok(cropped && expanded);
  assert.equal(cropped.planes[0].coordinate, expanded.planes[0].coordinate);
  assert.deepEqual(cropped.openings[0].bounds, expanded.openings[0].bounds);
  assert.ok(cropped.planes[0].evidence.samples > 100);
  assert.ok(
    Math.abs(
      cropped.planes[0].evidence.inlierFraction -
        expanded.planes[0].evidence.inlierFraction,
    ) < 0.05,
  );

  const rejected: string[] = [];
  const unsupported = fitRecessGeometry(
    mesh,
    image,
    {
      ...element,
      imageMask: full.fill(1),
      imageMaskSize: [image.width, image.height],
    },
    alignment,
    48,
    [25, 42, 21],
    2,
    1,
    (reason) => rejected.push(reason),
  );
  assert.equal(
    unsupported,
    undefined,
    'identity and mounting confidence cannot invent a wall without observed mesh samples',
  );
  assert.ok(rejected.some((r) => r.includes('too few rear-wall mesh samples')));
});
