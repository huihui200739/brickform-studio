import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, SphereGeometry } from 'three';
import type { TriangleMesh } from './mesh-types.ts';
import { designMeshSurfaces } from './surface-design.ts';
import { meshToDesign } from './mesh-design.ts';
import { inventory, validateModel } from './brick-engine.ts';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readGLB } from './read-glb.ts';

function wall() {
  const geometry = new BoxGeometry(20, 12, 4, 40, 24, 4).toNonIndexed();
  geometry.translate(10, 6, 2);
  const p = Float32Array.from(geometry.attributes.position.array);
  for (let i = 0; i < p.length; i += 3)
    if (p[i + 2] === 4)
      p[i + 2] +=
        0.12 *
        Math.sin((p[i] / 20) * Math.PI * 2) *
        Math.sin((p[i + 1] / 12) * Math.PI * 2);
  const colors = new Uint8Array(p.length / 3);
  for (let i = 0; i < p.length; i += 9)
    colors.set(p[i] < 10 ? [201, 26, 9] : [150, 150, 150], i / 3);
  geometry.dispose();
  return {
    name: 'painted noisy wall',
    positions: p,
    colors,
  } satisfies TriangleMesh;
}

void test('connected wall interior is planarized without changing paint, shared topology or silhouette bounds', () => {
  const source = wall(),
    original = new Float32Array(source.positions);
  const result = designMeshSurfaces(source, 20);
  assert.ok(
    result.design.patches.some(
      (p) =>
        p.axis === 2 &&
        p.direction === 1 &&
        p.residualAfterStuds < p.residualBeforeStuds * 0.5,
    ),
  );
  assert.ok(result.design.adjustedVertices > 0);
  assert.deepEqual(source.positions, original, 'source mesh is not mutated');
  assert.equal(
    result.mesh.colors,
    source.colors,
    'paint boundaries stay on their source triangles',
  );
  const bound = (p: Float32Array, a: number) => {
    let lo = Infinity,
      hi = -Infinity;
    for (let i = a; i < p.length; i += 3) {
      lo = Math.min(lo, p[i]);
      hi = Math.max(hi, p[i]);
    }
    return [lo, hi];
  };
  for (const a of [0, 1, 2])
    assert.deepEqual(bound(result.mesh.positions, a), bound(original, a));
  const copies = new Map<string, string>();
  for (let i = 0; i < original.length; i += 3) {
    const key = Array.from(original.slice(i, i + 3)).join(','),
      value = Array.from(result.mesh.positions.slice(i, i + 3)).join(',');
    if (copies.has(key))
      assert.equal(
        value,
        copies.get(key),
        'all copies of a shared vertex move together',
      );
    copies.set(key, value);
    if (
      original[i] === 0 ||
      original[i] === 20 ||
      original[i + 1] === 0 ||
      original[i + 1] === 12
    )
      assert.deepEqual(
        result.mesh.positions.slice(i, i + 3),
        original.slice(i, i + 3),
        'crease boundaries remain fixed',
      );
  }
});

void test('a broad spherical curve and an oblique roof are not replaced with axis-aligned planes', () => {
  const sphere = new SphereGeometry(10, 64, 48).toNonIndexed();
  const curved: TriangleMesh = {
    name: 'curved control',
    positions: Float32Array.from(sphere.attributes.position.array),
    colors: new Uint8Array(sphere.attributes.position.count),
  };
  assert.equal(designMeshSurfaces(curved, 20).mesh, curved);
  const roof = wall();
  for (let i = 0; i < roof.positions.length; i += 3)
    roof.positions[i + 2] += roof.positions[i + 1] * 0.5;
  const designed = designMeshSurfaces(roof, 20);
  assert.equal(
    designed.design.patches.some((p) => p.axis === 2),
    false,
    'oblique faces retain their slope',
  );
  sphere.dispose();
});

void test('real Temple boundary triangles limit planarization rather than turning against their original normals', async () => {
  const bytes = gunzipSync(
    readFileSync(new URL('./fixtures/temple-standard.glb.gz', import.meta.url)),
  );
  const source = await readGLB(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    'Temple boundary regression',
  );
  const result = designMeshSurfaces(source, 28);
  assert.ok(
    result.design.patches.some((p) => p.displacementFraction < 1),
    'real boundary risk must exercise backtracking',
  );
  const normal = (p: Float32Array, i: number) => {
    const a = [0, 1, 2].map((k) => p[i + 3 + k] - p[i + k]),
      b = [0, 1, 2].map((k) => p[i + 6 + k] - p[i + k]);
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
  };
  let changed = 0;
  for (let i = 0; i < source.positions.length; i += 9) {
    if (
      result.mesh.positions
        .slice(i, i + 9)
        .every((v, k) => v === source.positions[i + k])
    )
      continue;
    changed++;
    const a = normal(source.positions, i),
      b = normal(result.mesh.positions, i);
    const cosine =
      a.reduce((sum, v, k) => sum + v * b[k], 0) /
      (Math.hypot(...a) * Math.hypot(...b));
    assert.ok(
      cosine >= 0.5 - 1e-6,
      `triangle ${i / 9} has an unsafe rotation: ${cosine}`,
    );
  }
  assert.ok(changed > 0);
  assert.ok(
    result.design.patches.every(
      (p) => p.residualAfterStuds < p.residualBeforeStuds,
    ),
  );
});

void test('separate surfaces around a window retain the window and step levels through final brick conversion', () => {
  const positions: number[] = [],
    colors: number[] = [];
  for (const [x, y, z, w, h, d] of [
    [0, 0, 0, 20, 0.8, 12],
    [0, 0.8, 0, 6, 12, 3],
    [14, 0.8, 0, 6, 12, 3],
    [6, 0.8, 0, 8, 3, 3],
    [6, 9.8, 0, 8, 3, 3],
    [6, 0.8, 3, 8, 1.2, 3],
  ]) {
    const g = new BoxGeometry(
      w,
      h,
      d,
      Math.max(1, w * 2),
      Math.max(1, Math.round(h * 2)),
      2,
    ).toNonIndexed();
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    for (let i = 0; i < g.attributes.position.array.length; i += 3) {
      const p = g.attributes.position.array;
      if (p[i + 2] === 3 && h >= 3)
        p[i + 2] += 0.06 * Math.sin(p[i]) * Math.sin(p[i + 1]);
    }
    positions.push(...g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count / 3; i++)
      colors.push(215, 186, 140);
    g.dispose();
  }
  const model = meshToDesign(
    {
      name: 'window and step',
      positions: Float32Array.from(positions),
      colors: Uint8Array.from(colors),
    },
    20,
  );
  const occupied = (x: number, y: number, z: number) =>
    model.bricks.some(
      (b) =>
        x >= b.x &&
        x < b.x + b.w &&
        y >= b.y &&
        y < b.y + b.h &&
        z >= b.z &&
        z < b.z + b.d,
    );
  assert.equal(occupied(10, 17, 2), false, 'window stays empty');
  assert.equal(occupied(10, 6, 5), true, 'low front step survives');
  assert.equal(occupied(10, 10, 5), false, 'step cannot be raised into a wall');
  const validation = validateModel(model);
  assert.equal(
    validation.collisions + validation.unsupported + validation.invalidParts,
    0,
  );
  assert.equal(validation.connected, true);
  assert.equal(
    inventory(model.bricks).reduce((n, p) => n + p.quantity, 0),
    model.bricks.length,
  );
  assert.ok(model.surfaceDesign?.patches.length);
});
