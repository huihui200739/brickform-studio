import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  sampleModel,
  imageToModel,
  inventory,
  validateModel,
  toLDraw,
  CATALOG,
  type Model,
} from './brick-engine.ts';
import { manualHTML, csv } from './manual.ts';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/duck-raster.json', import.meta.url), 'utf8'),
);
const duck = {
  width: fixture.width,
  height: fixture.height,
  data: Buffer.from(fixture.rgba, 'base64'),
};
function assertValid(m: Model) {
  const v = validateModel(m);
  assert.deepEqual(v, {
    collisions: 0,
    unsupported: 0,
    invalidParts: 0,
    connected: true,
    brickCount: m.bricks.length,
  });
  assert.equal(
    inventory(m.bricks).reduce((n, p) => n + p.quantity, 0),
    m.bricks.length,
  );
  for (const b of m.bricks) {
    assert.ok(CATALOG.some((p) => p.id === b.part));
    assert.ok(
      b.x >= 0 &&
        b.x + b.w <= m.width &&
        b.z >= 0 &&
        b.z + b.d <= m.depth &&
        b.y >= 0 &&
        b.y + b.h <= m.height,
    );
  }
}
test('all supported sample sizes have a connected base and legal brick and plate geometry', () => {
  for (const resolution of [20, 28, 36])
    for (const depth of [4, 8, 12, 16, 20])
      assertValid(sampleModel(resolution, depth));
});
test('actual uploaded duck: both shapes and all UI resolutions produce valid connected builds', () => {
  for (const resolution of [20, 28, 36])
    for (const shape of ['sculpture', 'relief'] as const) {
      const m = imageToModel(
        duck,
        { resolution, depth: 12, threshold: 70, background: 'white', shape },
        'test duck',
      );
      assertValid(m);
      assert.ok(m.bricks.some((b) => b.h === 1 && b.y > 1));
      assert.ok(m.bricks.some((b) => b.h === 3));
      assert.ok(m.bricks.some((b) => b.w * b.d === 8));
      assert.equal(m.source, 'image');
    }
});
test('sculpture has variable cross sections and fewer subject voxels than the same extruded image', () => {
  const options = {
    resolution: 28,
    depth: 12,
    threshold: 70,
    background: 'white' as const,
  };
  const sculpture = imageToModel(
    duck,
    { ...options, shape: 'sculpture' },
    'duck',
  );
  const relief = imageToModel(duck, { ...options, shape: 'relief' }, 'duck');
  const volume = (m: Model) =>
    m.bricks
      .filter((b) => b.y > 1 && !b.support)
      .reduce((n, b) => n + b.w * b.d * b.h, 0);
  assert.ok(volume(sculpture) < volume(relief) * 0.85);
  const byPixel = new Map<string, Set<number>>();
  for (const b of sculpture.bricks.filter((b) => b.y > 1 && !b.support))
    for (let dy = 0; dy < b.h; dy++)
      for (let dx = 0; dx < b.w; dx++)
        for (let dz = 0; dz < b.d; dz++) {
          const k = `${b.x + dx},${b.y + dy}`;
          const zs = byPixel.get(k) || new Set();
          zs.add(b.z + dz);
          byPixel.set(k, zs);
        }
  assert.ok(new Set([...byPixel.values()].map((z) => z.size)).size >= 4);
  assert.ok(
    sculpture.bricks.filter((b) => b.support).every((b) => b.color === 3),
  );
});
test('blank and transparent images fail clearly; opaque black PNG pixels survive and upscale without gaps', () => {
  assert.throws(
    () =>
      imageToModel(
        { width: 1, height: 1, data: [255, 255, 255, 255] },
        { resolution: 20, depth: 4, threshold: 70, background: 'white' },
        'blank',
      ),
    /没有找到主体/,
  );
  assert.throws(() =>
    imageToModel(
      { width: 1, height: 1, data: [0, 0, 0, 0] },
      { resolution: 20, depth: 4, threshold: 70, background: 'keep' },
      'blank',
    ),
  );
  const data = new Uint8ClampedArray(3 * 3 * 4);
  data[19] = 255;
  const m = imageToModel(
    { width: 3, height: 3, data },
    {
      resolution: 20,
      depth: 4,
      threshold: 70,
      background: 'auto',
      shape: 'relief',
    },
    'black',
  );
  assertValid(m);
  assert.equal(
    m.bricks
      .filter((b) => b.y > 1 && b.color === 1)
      .reduce((n, b) => n + b.w * b.d * b.h, 0),
    (m.width - 2) * (m.height - 2) * 4,
  );
});
test('narrow and wide images keep every base piece connected', () => {
  for (const [w, h] of [
    [3, 18],
    [18, 3],
    [7, 12],
    [12, 7],
  ]) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = 242;
      data[i * 4 + 1] = 205;
      data[i * 4 + 2] = 55;
      data[i * 4 + 3] = 255;
    }
    assertValid(
      imageToModel(
        { width: w, height: h, data },
        { resolution: 20, depth: 8, threshold: 70, background: 'keep' },
        'rectangle',
      ),
    );
  }
});
test('LDraw has correct plate-unit heights, orientations and one placement for each BOM item', () => {
  const m = sampleModel(20, 8);
  const lines = toLDraw(m).split('\n'),
    placements = lines.filter((l) => l.startsWith('1 '));
  assert.equal(placements.length, m.bricks.length);
  assert.equal(lines.filter((l) => l === '0 STEP').length, m.levels.length);
  placements.forEach((line, i) => {
    const b = m.bricks[i];
    assert.equal(Number(line.split(' ')[3]), -(b.y + b.h) * 8);
  });
  assert.ok(!toLDraw(m).includes('NaN'));
});
test('manual includes every placement once, uses millimetres correctly and escapes user-entered names', () => {
  const m = sampleModel(20, 8);
  m.name = '<script>alert(1)</script>';
  const html = manualHTML(m);
  const ids = [...html.matchAll(/<tr><td>#(\d+)<\/td>/g)].map((i) =>
    Number(i[1]),
  );
  assert.equal(ids.length, m.bricks.length);
  assert.equal(new Set(ids).size, m.bricks.length);
  assert.ok(html.includes((m.height * 3.2).toFixed(1) + ' mm'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('NaN'));
  assert.equal(
    csv(m)
      .split('\r\n')
      .slice(1)
      .reduce((n, row) => n + Number(row.split(',').at(-1)), 0),
    m.bricks.length,
  );
});
