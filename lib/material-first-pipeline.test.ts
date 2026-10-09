import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BoxGeometry } from 'three';
import { colorFromReference } from './reference-colors.ts';
import type { Raster } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';

const camera = { yaw: 0, pitch: 0, perspective: 0 };
function fixture(pixel: (x: number, y: number) => number[]) {
  const geometry = new BoxGeometry(2, 2, 2, 8, 8, 8).toNonIndexed();
  const positions = new Float32Array(geometry.attributes.position.array);
  geometry.dispose();
  const mesh: TriangleMesh = {
    name: 'material-pipeline-regression', positions,
    colors: new Uint8Array(positions.length / 3).fill(244),
  };
  const image: Raster = { width: 40, height: 40, data: new Uint8ClampedArray(6400) };
  for (let y = 4; y < 36; y++) for (let x = 4; x < 36; x++)
    (image.data as Uint8ClampedArray).set([...pixel(x, y), 255], (y * 40 + x) * 4);
  return { mesh, image };
}
function paints(mesh: TriangleMesh) {
  const values = new Set<string>();
  for (let i = 0; i < mesh.colors.length; i += 3)
    values.add(Array.from(mesh.colors.subarray(i, i + 3)).join(','));
  return values;
}

test('actual reference projection uses one material for hard same-material shadow, preserving the raw source ledger', () => {
  const { mesh, image } = fixture((_x, y) => {
    const scale = y < 20 ? 1 : 0.35;
    return [228, 204, 165].map((v) => Math.round(v * scale));
  });
  const originalColors = mesh.colors.slice();
  const originalRGBA = Array.from(image.data);
  const radiance = colorFromReference(mesh, image, camera, true);
  const first = colorFromReference(mesh, image, camera, true, { materialMode: 'material-first' });
  assert.ok(paints(radiance).size > 1, 'control reproduces photo-tone part colours');
  assert.equal(paints(first).size, 1, 'chosen material is not split at the shadow edge');
  assert.equal(first.coloring?.materialMode, 'material-first');
  assert.ok(first.materialDesign?.materialFirst?.changedPixels);
  assert.equal(first.positions, mesh.positions);
  assert.deepEqual(mesh.colors, originalColors);
  assert.deepEqual(Array.from(image.data), originalRGBA);
  assert.deepEqual(first.sourceObservations, radiance.sourceObservations);
  assert.equal(first.materialDesign?.materialFirst?.intrinsicMaterialVerified, false);
});

test('actual projection retains genuine red and blue rather than using a global body colour', () => {
  const { mesh, image } = fixture((x, y) => {
    const base = x < 20 ? [201, 26, 9] : [0, 85, 191];
    return base.map((v) => Math.round(v * (y < 20 ? 1 : 0.45)));
  });
  const first = colorFromReference(mesh, image, camera, true, { materialMode: 'material-first' });
  assert.deepEqual(paints(first), new Set(['201,26,9', '0,85,191']));
});

test('radiance mode stays byte-compatible and invalid material design choices fail', () => {
  const { mesh, image } = fixture((_x, y) => y < 20 ? [228, 204, 165] : [70, 48, 20]);
  const original = colorFromReference(mesh, image, camera, true);
  const explicit = colorFromReference(mesh, image, camera, true, { materialMode: 'radiance' });
  assert.deepEqual(explicit, original);
  assert.throws(() => colorFromReference(mesh, image, camera, true,
    { materialMode: 'invented' as never }), /material design mode is invalid/);
});
