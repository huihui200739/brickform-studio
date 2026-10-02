import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BoxGeometry } from 'three';
import { buildMeshVolume } from './mesh-design.ts';
import type { TriangleMesh } from './mesh-types.ts';
import { triangleCellArea, triangleMaterialAreas } from './voxel-materials.ts';

function paintedWall(divisions: number, accentWidth = 0.2): TriangleMesh {
  const g = new BoxGeometry(20, 4, 20).toNonIndexed();
  g.translate(10, 2, 10);
  const source = g.attributes.position.array;
  const positions: number[] = [],
    colors: number[] = [];
  for (let i = 0; i < source.length; i += 9) {
    if ([2, 5, 8].every((k) => source[i + k] === 20)) continue;
    positions.push(...Array.from(source.slice(i, i + 9)));
    colors.push(0, 85, 191);
  }
  const panel = (
    left: number,
    right: number,
    divisions: number,
    color: number[],
  ) => {
    for (let x = 0; x < divisions; x++)
      for (let y = 0; y < divisions; y++) {
        const a = left + ((right - left) * x) / divisions;
        const b = left + ((right - left) * (x + 1)) / divisions;
        const c = (4 * y) / divisions,
          d = (4 * (y + 1)) / divisions;
        positions.push(
          a,
          c,
          20,
          b,
          c,
          20,
          b,
          d,
          20,
          a,
          c,
          20,
          b,
          d,
          20,
          a,
          d,
          20,
        );
        colors.push(...color, ...color);
      }
  };
  panel(0, 6 - accentWidth, 1, [0, 85, 191]);
  panel(6 - accentWidth, 6, divisions, [201, 26, 9]);
  panel(6, 20, 1, [0, 85, 191]);
  g.dispose();
  return {
    name: 'painted wall',
    positions: Float32Array.from(positions),
    colors: Uint8Array.from(colors),
  };
}

void test('a densely tessellated accent cannot outvote the larger exposed paint area of one voxel', () => {
  const coarse = buildMeshVolume(paintedWall(1), 20);
  const dense = buildMeshVolume(paintedWall(12), 20);
  for (let y = 3; y < 11; y++) {
    const key = `6,${y},20`;
    assert.equal(
      coarse.cells.get(key)?.color,
      4,
      '80% blue front area is the voxel material',
    );
    assert.equal(
      dense.cells.get(key)?.color,
      coarse.cells.get(key)?.color,
      'retessellation preserves paint',
    );
  }
});

void test('a larger true accent survives area voting and subdivisions preserve the entire grid', () => {
  const coarse = buildMeshVolume(paintedWall(1, 0.8), 20);
  const dense = buildMeshVolume(paintedWall(12, 0.8), 20);
  for (let y = 3; y < 11; y++)
    assert.equal(dense.cells.get(`6,${y},20`)?.color, 2);
  const cells = (volume: typeof coarse) =>
    [...volume.cells].sort(([a], [b]) => a.localeCompare(b));
  assert.deepEqual(
    cells(dense),
    cells(coarse),
    'paint and geometry stay identical after source subdivision',
  );
});

void test('clipped source area is conserved with physical plate height and excludes edge contacts', () => {
  const horizontal: [number, number, number][] = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 0, 2],
  ];
  const parts: number[] = [];
  triangleMaterialAreas(horizontal, [2, 1, 2], (_x, _y, _z, area) =>
    parts.push(area),
  );
  assert.deepEqual(
    parts.sort((a, b) => a - b),
    [0.5, 0.5, 1],
  );
  assert.equal(
    parts.reduce((a, b) => a + b, 0),
    2,
  );
  const vertical: [number, number, number][] = [
    [0, 0, 0],
    [2, 0, 0],
    [0, 5, 0],
  ];
  let total = 0;
  triangleMaterialAreas(
    vertical,
    [2, 5, 1],
    (_x, _y, _z, area) => (total += area),
  );
  assert.ok(
    Math.abs(total - 2) < 1e-12,
    'five plates measure two physical studs',
  );
  assert.ok(Math.abs(triangleCellArea(vertical, [0, 0, 0]) - 0.4) < 1e-12);
  assert.equal(
    triangleCellArea(horizontal, [1, 0, 1]),
    0,
    'contact at the diagonal edge has no material area',
  );
});
