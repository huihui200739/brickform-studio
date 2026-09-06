import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  sampleModel,
  imageToModel,
  inventory,
  validateModel,
  toLDraw,
  PARTS,
} from './brick-engine.ts';
test('all sample sizes are non-overlapping, supported, connected and use valid brick dimensions', () => {
  for (const resolution of [12, 20, 28])
    for (const depth of [2, 4, 6, 8, 10]) {
      const m = sampleModel(resolution, depth);
      assert.deepEqual(validateModel(m), {
        collisions: 0,
        unsupported: 0,
        connected: true,
        brickCount: m.bricks.length,
      });
      assert.equal(
        inventory(m.bricks).reduce((n, p) => n + p.quantity, 0),
        m.bricks.length,
      );
      for (const b of m.bricks) {
        assert.ok(PARTS[b.part]);
        assert.equal(
          b.w * b.d,
          b.part === '3010' ? 4 : b.part === '3004' ? 2 : 1,
        );
        assert.ok(
          b.x >= 0 && b.x + b.w <= m.width && b.z >= 0 && b.z + b.d <= m.depth,
        );
      }
    }
});
test('different input silhouettes create different models and fill unsupported columns', () => {
  const data = new Uint8ClampedArray(12 * 12 * 4).fill(255);
  for (let y = 2; y < 10; y++)
    for (let x = 2; x < 10; x++) {
      const i = (y * 12 + x) * 4;
      data[i] = 242;
      data[i + 1] = 205;
      data[i + 2] = 55;
    }
  const options = {
    resolution: 12,
    depth: 4,
    threshold: 70,
    background: 'white' as const,
  };
  const a = imageToModel({ width: 12, height: 12, data }, options, 'square');
  for (let y = 4; y < 8; y++)
    for (let x = 5; x < 10; x++) {
      const i = (y * 12 + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
    }
  const b = imageToModel({ width: 12, height: 12, data }, options, 'notch');
  assert.notDeepEqual(a.bricks, b.bricks);
  assert.ok(b.supportCount > 0);
  assert.equal(validateModel(b).connected, true);
  assert.equal(validateModel(b).unsupported, 0);
});
test('blank images fail clearly; transparent images and tiny inputs stay bounded', () => {
  assert.throws(
    () =>
      imageToModel(
        { width: 1, height: 1, data: [255, 255, 255, 255] },
        { resolution: 12, depth: 2, threshold: 70, background: 'white' },
        'blank',
      ),
    /没有找到主体/,
  );
  assert.throws(() =>
    imageToModel(
      { width: 1, height: 1, data: [0, 0, 0, 0] },
      { resolution: 12, depth: 2, threshold: 70, background: 'keep' },
      'transparent',
    ),
  );
  const m = imageToModel(
    { width: 1, height: 1, data: [242, 205, 55, 255] },
    { resolution: 12, depth: 2, threshold: 70, background: 'white' },
    'tiny',
  );
  assert.equal(validateModel(m).connected, true);
});
test('LDraw exports every brick and a step for every layer', () => {
  const m = sampleModel(12, 4),
    lines = toLDraw(m).split('\n');
  assert.equal(lines.filter((l) => l.startsWith('1 ')).length, m.bricks.length);
  assert.equal(lines.filter((l) => l === '0 STEP').length, m.height);
  assert.ok(!toLDraw(m).includes('NaN'));
});

test('transparent background preserves black subjects and small inputs have no upscale gaps', () => {
  const data = new Uint8ClampedArray(3 * 3 * 4);
  data[(1 * 3 + 1) * 4 + 3] = 255;
  const m = imageToModel(
    { width: 3, height: 3, data },
    { resolution: 12, depth: 2, threshold: 70, background: 'auto' },
    'black pixel',
  );
  const black = m.bricks.filter((b) => b.color === 1);
  assert.equal(
    black.reduce((n, b) => n + b.w * b.d, 0),
    (m.width - 2) * (m.height - 2) * 2,
  );
  assert.equal(validateModel(m).connected, true);
});
