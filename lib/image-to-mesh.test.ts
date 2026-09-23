import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import {
  referenceAlignment,
  estimateReferenceCamera,
  colorFromReference,
} from './reference-colors.ts';
import {
  imageAnchorToMesh,
  projectImageRay,
  raycastMesh,
} from './image-to-mesh.ts';
import { ColorSemanticDetector } from './image-semantics.ts';
import {
  replacementConfidence,
  mergeRefinementRegions,
} from './semantic-refinement.ts';
import {
  COMPONENT_SIZES,
  type ComponentRegion,
} from './semantic-components.ts';
const g = new BoxGeometry(2, 2, 2, 6, 6, 6).toNonIndexed();
const mesh = {
  name: 'ray fixture',
  positions: new Float32Array(g.attributes.position.array),
  colors: new Uint8Array(g.attributes.position.count).fill(150),
};
g.dispose();
const image = {
  width: 64,
  height: 64,
  data: new Uint8ClampedArray(64 * 64 * 4),
};
for (let y = 8; y < 56; y++)
  for (let x = 8; x < 56; x++)
    image.data.set([180, 170, 160, 255], (y * 64 + x) * 4);
for (const perspective of [0, 0.25, 0.5])
  test(`shared projection round trips through actual triangles (${perspective})`, () => {
    const a = referenceAlignment(mesh, image, {
      yaw: 30,
      pitch: 25,
      perspective,
    });
    const hit = imageAnchorToMesh(mesh, a, [64, 64], [0.5, 0.5]);
    assert.ok(hit);
    const q = a.view.point(...hit.point);
    const px =
      a.left +
      ((q[0] - a.view.minX) / (a.view.maxX - a.view.minX)) * (a.right - a.left);
    const py =
      a.top +
      ((a.view.maxY - q[1]) / (a.view.maxY - a.view.minY)) * (a.bottom - a.top);
    assert.ok(Math.abs(px / 63 - hit.uv[0]) < 1e-6);
    assert.ok(Math.abs(py / 63 - hit.uv[1]) < 1e-6);
    assert.ok(hit.point.some((v) => Math.abs(Math.abs(v) - 1) < 1e-6));
    assert.equal(imageAnchorToMesh(mesh, a, [64, 64], [-1, 0]), undefined);
    assert.equal(
      raycastMesh(mesh, { origin: [5, 5, 5], direction: [1, 0, 0] }),
      undefined,
    );
    assert.ok(
      projectImageRay(a, [64, 64], [0.5, 0.5]).direction.every(Number.isFinite),
    );
  });
test('estimator and colouring share the exact camera', () => {
  const camera = estimateReferenceCamera(mesh, image);
  const result = colorFromReference(mesh, image, camera);
  assert.equal(result.coloring!.yaw, camera.yaw);
  assert.deepEqual(result.colors, colorFromReference(mesh, image).colors);
});
test('image colour detector is deterministic, bottom-centred and cannot invent statues or bases', async () => {
  const raster = { width: 64, height: 64, data: image.data.slice() };
  for (let y = 18; y < 28; y++)
    for (let x = 14; x < 22; x++)
      raster.data.set([50, 140, 50, 255], (y * 64 + x) * 4);
  for (let y = 18; y < 25; y++)
    for (let x = 40; x < 45; x++)
      raster.data.set([254, 138, 24, 255], (y * 64 + x) * 4);
  const d = new ColorSemanticDetector(),
    found = await d.detect(raster);
  assert.deepEqual(found, await d.detect(raster));
  assert.deepEqual(
    new Set(found.map((v) => v.kind)),
    new Set(['tree', 'brazier']),
  );
  for (const v of found) {
    assert.ok(Math.abs(v.anchorUV[1] - v.bbox.y - v.bbox.height) < 1e-9);
    assert.ok(v.anchorConfidence >= 0.8);
  }
});
test('weak anchor cannot be outweighed by all other perfect scores', () => {
  assert.equal(replacementConfidence(1, 1, 1, 1, 1, 0.45), 0.45);
  assert.equal(replacementConfidence(1, 1, 1, 1, 1, 1), 1);
  assert.equal(replacementConfidence(NaN, 1, 1, 1, 1, 1), 0);
});
test('redetection preserves manual overrides and replaces system decisions', () => {
  const manual: ComponentRegion = {
    id: 'manual',
    kind: 'statue',
    source: 'manual',
    confirmed: true,
    anchor: [0.5, 0.5, 0.5],
    rotation: 0,
    ...COMPONENT_SIZES.statue,
  };
  const old: ComponentRegion = {
    ...manual,
    id: 'old',
    kind: 'tree',
    source: 'color',
    autoRefinement: true,
  };
  const fresh = { ...old, id: 'fresh', confirmed: false };
  assert.deepEqual(mergeRefinementRegions([manual, old], [fresh]), [
    manual,
    fresh,
  ]);
});
