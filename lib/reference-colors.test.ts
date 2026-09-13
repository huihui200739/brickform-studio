import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BoxGeometry } from 'three';
import { colorFromReference, referenceMask } from './reference-colors.ts';
import { PALETTE } from './brick-engine.ts';

void test('reference projection preserves geometry, separates painted regions, and estimates unseen faces', () => {
  const geometry = new BoxGeometry(2, 2, 2, 5, 5, 5).toNonIndexed();
  const positions = new Float32Array(geometry.attributes.position.array);
  const mesh = {
    positions,
    colors: new Uint8Array(positions.length / 3).fill(244),
    name: 'test',
  };
  const data = new Uint8ClampedArray(40 * 40 * 4);
  for (let y = 4; y < 36; y++)
    for (let x = 4; x < 36; x++) {
      const hex = PALETTE[x < 20 ? 2 : 4].hex;
      data.set(
        [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).concat(255),
        (y * 40 + x) * 4,
      );
    }
  const result = colorFromReference(
    mesh,
    { width: 40, height: 40, data },
    { yaw: 0, pitch: 0, perspective: 0 },
  );
  assert.equal(result.positions, positions);
  assert.equal(
    mesh.colors.every((c) => c === 244),
    true,
    'original materials remain available',
  );
  assert.ok(
    result.coloring!.observedFraction > 0 &&
      result.coloring!.observedFraction < 0.6,
  );
  const present = new Set<string>();
  for (let i = 0; i < result.colors.length; i += 3)
    present.add(Array.from(result.colors.slice(i, i + 3)).join(','));
  assert.deepEqual(present, new Set(['201,26,9', '0,85,191']));
  geometry.dispose();
});
void test('empty references fail instead of applying background colors', () => {
  assert.throws(
    () => referenceMask({ width: 10, height: 10, data: new Uint8Array(400) }),
    /没有清晰主体/,
  );
  assert.throws(() => referenceMask({ width: 2, height: 2, data: [] }), /无效/);
});

void test('a dark window in the reference does not become a fake window on the unseen rear wall', () => {
  const g = new BoxGeometry(2, 2, 2, 10, 10, 10).toNonIndexed();
  const positions = new Float32Array(g.attributes.position.array),
    data = new Uint8ClampedArray(40 * 40 * 4);
  for (let y = 2; y < 38; y++)
    for (let x = 2; x < 38; x++)
      data.set(
        x > 15 && x < 24 && y > 10 && y < 30
          ? [36, 36, 36, 255]
          : [215, 186, 140, 255],
        (y * 40 + x) * 4,
      );
  const result = colorFromReference(
    { name: 'window', positions, colors: new Uint8Array(positions.length / 3) },
    { width: 40, height: 40, data },
    { yaw: 0, pitch: 0, perspective: 0 },
  );
  let frontDark = 0,
    backDark = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const z = (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3;
    if (result.colors[i / 3] === 36) {
      if (z > 0.99) frontDark++;
      if (z < -0.99) backDark++;
    }
  }
  assert.ok(frontDark > 0);
  assert.equal(backDark, 0);
  g.dispose();
});
