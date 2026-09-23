import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PACKING_CASES } from '../benchmarks/packing-cases.ts';
import { CATALOG } from './brick-engine.ts';

void test('checkerboard exterior requires at least 240 subject parts with this catalog', () => {
  const exposed = (x: number, y: number, z: number) =>
    x === 0 || x === 7 || z === 0 || z === 5 || y === 10;
  let exteriorCells = 0;
  for (let y = 2; y < 11; y++)
    for (let z = 0; z < 6; z++)
      for (let x = 0; x < 8; x++) {
        if (exposed(x, y, z)) exteriorCells++;
        for (const part of CATALOG) {
          for (const [w, d] of [
            [part.w, part.d],
            [part.d, part.w],
          ]) {
            if (x + w > 8 || y + part.h > 11 || z + d > 6) continue;
            const colors = new Set<number>();
            let count = 0;
            for (let dy = 0; dy < part.h; dy++)
              for (let dz = 0; dz < d; dz++)
                for (let dx = 0; dx < w; dx++) {
                  if (!exposed(x + dx, y + dy, z + dz)) continue;
                  colors.add((x + dx + y + dy - 2 + z + dz) % 2);
                  count++;
                }
            if (colors.size <= 1)
              assert.ok(
                count <= 1,
                `${part.id} could cover multiple exterior cells`,
              );
          }
        }
      }
  assert.equal(exteriorCells, 240);
});

for (const id of ['solid-box', 'striped-box', 'noisy-interior-box']) {
  void test(`${id}: packing preserves every voxel and exposed colour`, () => {
    const model = PACKING_CASES.find((item) => item.id === id)!.create();
    const occupied = new Map<string, number>();
    for (const b of model.bricks) {
      for (let y = b.y; y < b.y + b.h; y++)
        for (let z = b.z; z < b.z + b.d; z++)
          for (let x = b.x; x < b.x + b.w; x++) {
            const k = `${x},${y},${z}`;
            assert.ok(!occupied.has(k), `overlap at ${k}`);
            occupied.set(k, b.color);
          }
    }
    assert.equal(occupied.size, 8 * 11 * 6);
    for (let y = 0; y < 11; y++)
      for (let z = 0; z < 6; z++)
        for (let x = 0; x < 8; x++) {
          const k = `${x},${y},${z}`;
          assert.ok(occupied.has(k), `missing ${k}`);
          if (x === 0 || x === 7 || z === 0 || z === 5 || y === 0 || y === 10) {
            const color =
              id === 'striped-box' && y >= 2
                ? (x + y - 2 + z) % 2
                  ? 7
                  : 8
                : 7;
            assert.equal(occupied.get(k), color, `exposed colour at ${k}`);
          }
        }
  });
}

void test('hidden colour noise does not fragment a uniform shell', () => {
  const plain = PACKING_CASES.find((c) => c.id === 'solid-box')!.create();
  const noisy = PACKING_CASES.find(
    (c) => c.id === 'noisy-interior-box',
  )!.create();
  assert.ok(Math.abs(plain.bricks.length - noisy.bricks.length) <= 1);
});
