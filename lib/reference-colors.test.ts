import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BoxGeometry } from 'three';
import { colorFromReference, referenceMask } from './reference-colors.ts';
import { PALETTE } from './brick-engine.ts';
import { MESH_FEATURE } from './mesh-types.ts';

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
void test('a dark opening that dominates its height band still leaves the unseen back in the main material', () => {
  const g = new BoxGeometry(2, 2, 2, 10, 10, 10).toNonIndexed();
  const positions = new Float32Array(g.attributes.position.array),
    data = new Uint8ClampedArray(40 * 40 * 4);
  // A wide dark stripe covers most of one height band without becoming the
  // model's main material, so that band is dominated by near-black faces.
  for (let y = 2; y < 38; y++)
    for (let x = 2; x < 38; x++)
      data.set(
        y > 14 && y < 26 && x > 8 && x < 32
          ? [36, 36, 36, 255]
          : [215, 186, 140, 255],
        (y * 40 + x) * 4,
      );
  const result = colorFromReference(
    {
      name: 'opening',
      positions,
      colors: new Uint8Array(positions.length / 3),
    },
    { width: 40, height: 40, data },
    { yaw: 0, pitch: 0, perspective: 0 },
  );
  let backDark = 0,
    frontDark = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const z = (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3;
    if (isDarkBrick(result.colors[i / 3])) {
      if (z > 0.99) frontDark++;
      if (z < -0.99) backDark++;
    }
  }
  assert.ok(frontDark > 0, 'the observed dark opening keeps its colour');
  assert.equal(
    backDark,
    0,
    'the unseen back wall takes the dominant sand material instead',
  );
  g.dispose();
});

void test('an abrupt warm dark stripe is preserved because paint and a hard shadow are ambiguous', () => {
  const g = new BoxGeometry(2, 2, 2, 8, 8, 8).toNonIndexed();
  const positions = new Float32Array(g.attributes.position.array),
    data = new Uint8ClampedArray(40 * 40 * 4);
  // Identical pixels could be dark brown paint or a hard shadow. A global hue
  // remap used to erase the stripe without evidence; the boundary must remain.
  for (let y = 2; y < 38; y++)
    for (let x = 2; x < 38; x++)
      data.set(
        x > 22 && x < 32 ? [53, 33, 0, 255] : [215, 186, 140, 255],
        (y * 40 + x) * 4,
      );
  const mesh = {
    name: 'shading',
    positions,
    colors: new Uint8Array(positions.length / 3),
  };
  const on = colorFromReference(
      mesh,
      { width: 40, height: 40, data },
      undefined,
      true,
    ),
    off = colorFromReference(
      mesh,
      { width: 40, height: 40, data },
      undefined,
      false,
    ),
    present = (result: typeof on) => {
      const set = new Set<string>();
      for (let i = 0; i < result.colors.length; i += 3)
        set.add(Array.from(result.colors.slice(i, i + 3)).join(','));
      return set;
    };
  assert.deepEqual(
    present(on),
    new Set(['215,186,140', '53,33,0']),
    'regional inference must not erase a separate dark material',
  );
  assert.ok(
    present(off).size > 1,
    'turning shadow reduction off keeps the photograph’s shading',
  );
  g.dispose();
});

void test('muted olive foliage is read from the picture, not from the brick colour it becomes', () => {
  const g = new BoxGeometry(2, 2, 2, 6, 6, 6).toNonIndexed();
  const positions = new Float32Array(g.attributes.position.array),
    data = new Uint8ClampedArray(40 * 40 * 4);
  // Olive leaves on the left, sunlit sand on the right. Both are warm and
  // desaturated, and the palette has no olive green, so the leaves quantise to
  // the same brick as the ground they stand on. Only the picture can tell them
  // apart, which is exactly what the foliage flag has to record.
  for (let y = 2; y < 38; y++)
    for (let x = 2; x < 38; x++)
      data.set(
        (x < 20 ? [110, 116, 78] : [215, 186, 140]).concat(255),
        (y * 40 + x) * 4,
      );
  const result = colorFromReference(
    {
      name: 'foliage',
      positions,
      colors: new Uint8Array(positions.length / 3),
    },
    { width: 40, height: 40, data },
    { yaw: 0, pitch: 0, perspective: 0 },
  );
  assert.ok(result.features, 'every projected face carries its feature byte');
  assert.equal(
    result.features!.length,
    positions.length / 9,
    'one flag byte per triangle',
  );
  let olive = 0,
    sand = 0;
  for (let t = 0; t < result.features!.length; t++) {
    if (!(result.features![t] & MESH_FEATURE.foliage)) continue;
    const x =
      (positions[t * 9] + positions[t * 9 + 3] + positions[t * 9 + 6]) / 3;
    if (x < -0.01) olive++;
    else if (x > 0.01) sand++;
  }
  assert.ok(olive > 0, 'the olive half is flagged as foliage');
  assert.equal(sand, 0, 'the sand half is never flagged');
  g.dispose();
});

void test('empty references fail instead of applying background colors', () => {
  assert.throws(
    () => referenceMask({ width: 10, height: 10, data: new Uint8Array(400) }),
    /没有清晰主体/,
  );
  assert.throws(() => referenceMask({ width: 2, height: 2, data: [] }), /无效/);
});

// Abrupt dark regions retain black or dark grey; they are never globally
// lifted merely because another region is a light material.
const isDarkBrick = (value: number) => value === 36 || value === 100;
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
    if (isDarkBrick(result.colors[i / 3])) {
      if (z > 0.99) frontDark++;
      if (z < -0.99) backDark++;
    }
  }
  assert.ok(frontDark > 0);
  assert.equal(backDark, 0);
  g.dispose();
});

void test('unseen material votes are invariant to dense tessellation of a smaller painted region', () => {
  const raster = {
    width: 100,
    height: 100,
    data: new Uint8Array(100 * 100 * 4),
  };
  for (let y = 4; y < 96; y++)
    for (let x = 4; x < 96; x++)
      raster.data.set(
        x < 41 ? [0, 85, 191, 255] : [201, 26, 9, 255],
        (y * 100 + x) * 4,
      );
  const mesh = (divisions: number) => {
    const positions: number[] = [];
    const plane = (
      left: number,
      right: number,
      z: number,
      subdivisions: number,
    ) => {
      for (let y = 0; y < subdivisions; y++)
        for (let x = 0; x < subdivisions; x++) {
          const a = left + ((right - left) * x) / subdivisions,
            b = left + ((right - left) * (x + 1)) / subdivisions;
          const c = -1 + (2 * y) / subdivisions,
            d = -1 + (2 * (y + 1)) / subdivisions;
          positions.push(a, c, z, b, c, z, b, d, z, a, c, z, b, d, z, a, d, z);
        }
    };
    plane(-1, -0.2, 1, divisions);
    plane(-0.2, 1, 1, 1);
    plane(-1, 1, -1, 1);
    return {
      name: 'painted-area',
      positions: new Float32Array(positions),
      colors: new Uint8Array(positions.length / 3),
    };
  };
  const backColors = (result: ReturnType<typeof colorFromReference>) => {
    const colors = new Set<string>();
    for (let i = 0; i < result.positions.length; i += 9)
      if (result.positions[i + 2] === -1)
        colors.add(Array.from(result.colors.slice(i / 3, i / 3 + 3)).join(','));
    return colors;
  };
  const coarse = colorFromReference(
    mesh(1),
    raster,
    { yaw: 0, pitch: 0, perspective: 0 },
    false,
  );
  const dense = colorFromReference(
    mesh(20),
    raster,
    { yaw: 0, pitch: 0, perspective: 0 },
    false,
  );
  assert.deepEqual(backColors(coarse), new Set(['201,26,9']));
  assert.deepEqual(backColors(dense), backColors(coarse));
  assert.deepEqual(
    dense.materialDesign!.projection!.materialPixels,
    coarse.materialDesign!.projection!.materialPixels,
  );
  assert.ok(dense.materialDesign!.projection!.inferredFaces > 0);
});

void test('unseen same-height walls inherit wall material rather than a larger sloping canopy', () => {
  const points: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    points.push(...a, ...b, ...c, ...a, ...c, ...d);
  // The canopy takes 75% of the reference, but both surfaces span the same Y.
  // A global height vote would paint the right wall blue at every height.
  quad([-2, -1, 1], [1, -1, 1], [1, 1, -1], [-2, 1, -1]);
  quad([1, -1, 1], [2, -1, 1], [2, 1, 1], [1, 1, 1]);
  quad([2, -1, 1], [2, -1, -1], [2, 1, -1], [2, 1, 1]);
  const positions = Float32Array.from(points);
  const data = new Uint8Array(80 * 40 * 4);
  for (let y = 2; y < 38; y++)
    for (let x = 4; x < 76; x++)
      data.set(
        (x < 58 ? [0, 85, 191] : [215, 186, 140]).concat(255),
        (y * 80 + x) * 4,
      );
  const result = colorFromReference(
    {
      name: 'canopy and wall',
      positions,
      colors: new Uint8Array(positions.length / 3),
    },
    { width: 80, height: 40, data },
    { yaw: 0, pitch: 0, perspective: 0 },
    false,
  );
  assert.equal(result.positions, positions);
  assert.deepEqual(
    Array.from(result.colors.slice(0, 6)),
    [0, 85, 191, 0, 85, 191],
    'observed blue canopy is preserved',
  );
  assert.deepEqual(
    Array.from(result.colors.slice(6)),
    Array(4).fill([215, 186, 140]).flat(),
    'front and unseen side walls use observed sand wall material',
  );
  const surfaces = result.materialDesign!.surfaces!;
  assert.equal(surfaces.inferredFaces, 2);
  const wall = surfaces.regions.find((r) => r.normal[0] > 0.99)!;
  assert.equal(wall.source, 'compatible-surface');
  assert.ok(wall.donorRegionIds.length > 0);
  assert.ok(
    wall.donorRegionIds.every(
      (id) => Math.abs(surfaces.regions[id].normal[1]) < 0.12,
    ),
    'roof observations are not wall donors',
  );
});

void test('a fully occluded thin rear panel is inferred, never observed as front foliage', () => {
  const points: number[] = [];
  const panel = (z: number) =>
    points.push(-1, -1, z, 1, -1, z, 1, 1, z, -1, -1, z, 1, 1, z, -1, 1, z);
  panel(0.01);
  panel(0);
  const positions = Float32Array.from(points);
  const data = new Uint8Array(40 * 40 * 4);
  for (let y = 2; y < 38; y++)
    for (let x = 2; x < 38; x++)
      data.set([110, 116, 78, 255], (y * 40 + x) * 4);
  const result = colorFromReference(
    { name: 'thin panels', positions, colors: new Uint8Array(12) },
    { width: 40, height: 40, data },
    { yaw: 0, pitch: 0, perspective: 0 },
    false,
  );
  assert.deepEqual(Array.from(result.materialEvidence!.observed), [1, 1, 0, 0]);
  assert.deepEqual(Array.from(result.features!.slice(2)), [0, 0]);
  assert.equal(result.positions, positions);
});

void test('a large face samples its visible portion even when its centroid is hidden', () => {
  const positions = Float32Array.from([
    -1, -1, 0, 1, -1, 0, 0, 1, 0, -0.4, -0.5, 0.2, 0.4, -0.5, 0.2, 0.4, 0, 0.2,
    -0.4, -0.5, 0.2, 0.4, 0, 0.2, -0.4, 0, 0.2,
  ]);
  const data = new Uint8Array(100 * 100 * 4);
  for (let y = 4; y < 96; y++)
    for (let x = 4; x < 96; x++) {
      const u = ((x - 4) / 91) * 2 - 1,
        v = 1 - ((y - 4) / 91) * 2;
      if (v >= -1 && v <= 1 && Math.abs(u) <= (1 - v) / 2)
        data.set(
          u >= -0.4 && u <= 0.4 && v >= -0.5 && v <= 0
            ? [201, 26, 9, 255]
            : [0, 85, 191, 255],
          (y * 100 + x) * 4,
        );
    }
  const result = colorFromReference(
    { name: 'partly hidden paint', positions, colors: new Uint8Array(9) },
    { width: 100, height: 100, data },
    { yaw: 0, pitch: 0, perspective: 0 },
    false,
  );
  assert.equal(result.materialEvidence!.observed[0], 1);
  assert.deepEqual(Array.from(result.colors.slice(0, 3)), [0, 85, 191]);
});
