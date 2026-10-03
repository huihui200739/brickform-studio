import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { colorFromReference } from './reference-colors.ts';
import { validateSurfaceProjection } from './surface-projection-validation.ts';

void test('surface candidate uses the fixed source camera, bounds and paint correspondence', () => {
  const geometry = new BoxGeometry(20, 12, 4, 4, 4, 4).toNonIndexed();
  const raw = {
    name: 'fixed projection',
    positions: Float32Array.from(geometry.attributes.position.array),
    colors: new Uint8Array(geometry.attributes.position.count),
  };
  const data = new Uint8Array(128 * 96 * 4);
  for (let y = 8; y < 88; y++)
    for (let x = 8; x < 120; x++)
      data.set(
        x < 64 ? [10, 50, 150, 255] : [100, 30, 15, 255],
        (y * 128 + x) * 4,
      );
  const source = colorFromReference(
    raw,
    { width: 128, height: 96, data },
    { yaw: 0, pitch: 0, perspective: 0 },
  );
  const graph = source.sourceObservations!;
  assert.ok(graph);
  const identity = validateSurfaceProjection(source, source, graph);
  assert.equal(identity.passed, true);
  assert.equal(
    identity.silhouetteChangedPixels +
      identity.materialChangedPixels +
      identity.maxVertexDisplacementPixels,
    0,
  );
  const positions = new Float32Array(source.positions);
  for (let i = 0; i < positions.length; i += 3) positions[i] += 2;
  const translated = validateSurfaceProjection(
    source,
    { ...source, positions },
    graph,
  );
  assert.equal(
    translated.passed,
    false,
    'candidate bounds must not be recentered to hide a translation',
  );
  assert.ok(translated.silhouetteChangedPixels > 0);
  assert.ok(translated.maxVertexDisplacementPixels > 1.5);
  const colors = new Uint8Array(source.colors.length).fill(255);
  const repainted = validateSurfaceProjection(
    source,
    { ...source, colors },
    graph,
  );
  assert.equal(repainted.passed, false);
  assert.ok(repainted.materialChangedPixels > 0);
  assert.equal(repainted.silhouetteChangedPixels, 0);
  geometry.dispose();
});
