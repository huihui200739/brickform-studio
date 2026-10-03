import test from 'node:test';
import assert from 'node:assert/strict';
import { CylinderGeometry, SphereGeometry } from 'three';
import { designRegionPlanes } from './surface-region-design.ts';
import type { TriangleMesh } from './mesh-types.ts';

function roof(hole = false) {
  const p: number[] = [],
    colors: number[] = [];
  const point = (x: number, y: number) => [
    x,
    y,
    2 +
      0.5 * y +
      (x && y && x < 20 && y < 12
        ? 0.025 * Math.sin(x * 73.13 + y * 113.79)
        : 0),
  ];
  for (let y = 0; y < 12; y += 0.5)
    for (let x = 0; x < 20; x += 0.5) {
      if (hole && x >= 8 && x < 12 && y >= 4 && y < 8) continue;
      const a = point(x, y),
        b = point(x + 0.5, y),
        c = point(x + 0.5, y + 0.5),
        d = point(x, y + 0.5);
      p.push(...a, ...b, ...c, ...a, ...c, ...d);
      colors.push(
        ...(x < 10 ? [10, 50, 150, 10, 50, 150] : [100, 30, 15, 100, 30, 15]),
      );
    }
  return {
    name: 'inclined painted surface',
    positions: Float32Array.from(p),
    colors: Uint8Array.from(colors),
  } satisfies TriangleMesh;
}

void test('inclined plane reduces reconstruction noise while preserving slope, source paint and shared vertices', () => {
  const source = roof(),
    original = new Float32Array(source.positions);
  const result = designRegionPlanes(source, 20);
  assert.ok(result.patches.length > 0);
  assert.ok(
    result.patches.every(
      (p) => p.residualAfterStuds < p.residualBeforeStuds * 0.5,
    ),
  );
  assert.deepEqual(source.positions, original);
  assert.equal(result.mesh.colors, source.colors);
  assert.ok(
    result.patches.every(
      (p) => Math.abs(Math.abs(p.normal[1] / p.normal[2]) - 0.5) < 0.001,
    ),
  );
  const shared = new Map<string, string>();
  for (let i = 0; i < original.length; i += 3) {
    const key = original.slice(i, i + 3).join(','),
      value = result.mesh.positions.slice(i, i + 3).join(',');
    if (shared.has(key)) assert.equal(shared.get(key), value);
    shared.set(key, value);
    const x = original[i],
      y = original[i + 1];
    if (x === 0 || x === 20 || y === 0 || y === 12)
      assert.deepEqual(
        result.mesh.positions.slice(i, i + 3),
        original.slice(i, i + 3),
      );
  }
});

void test('open edges around an inclined window and disconnected near surfaces remain fixed', () => {
  const source = roof(true),
    result = designRegionPlanes(source, 20);
  assert.ok(result.patches.length > 0);
  for (let i = 0; i < source.positions.length; i += 3) {
    const x = source.positions[i],
      y = source.positions[i + 1];
    if (
      ((x === 8 || x === 12) && y >= 4 && y <= 8) ||
      ((y === 4 || y === 8) && x >= 8 && x <= 12)
    )
      assert.deepEqual(
        result.mesh.positions.slice(i, i + 3),
        source.positions.slice(i, i + 3),
        'window edge cannot move',
      );
  }
  const second = new Float32Array(source.positions);
  for (let i = 2; i < second.length; i += 3) second[i] += 0.0001;
  const separate = {
    ...source,
    positions: Float32Array.from([...source.positions, ...second]),
    colors: Uint8Array.from([...source.colors, ...source.colors]),
  };
  const designed = designRegionPlanes(separate, 20);
  assert.ok(
    designed.patches.every(
      (p) =>
        p.sourceFaceIds.every((f) => f < source.positions.length / 9) ||
        p.sourceFaceIds.every((f) => f >= source.positions.length / 9),
    ),
    'nearby surfaces are not welded',
  );
});

void test('coherent spherical and cylindrical curvature is retained', () => {
  for (const geometry of [
    new SphereGeometry(10, 96, 64),
    new CylinderGeometry(10, 10, 16, 128, 48, true),
  ]) {
    const flat = geometry.toNonIndexed();
    const mesh = {
      name: 'curve control',
      positions: Float32Array.from(flat.attributes.position.array),
      colors: new Uint8Array(flat.attributes.position.count),
    };
    const result = designRegionPlanes(mesh, 20);
    assert.equal(result.patches.length, 0, mesh.name);
    assert.equal(result.mesh, mesh);
    geometry.dispose();
    flat.dispose();
  }
});
