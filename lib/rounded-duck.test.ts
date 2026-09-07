import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fitDuckImage, roundedDuck, SAMPLE_FIT } from './rounded-duck.ts';
import { validateAssembly } from './assembly-validation.ts';
import { inventory, toLDraw } from './brick-engine.ts';
import { manualHTML, csv } from './manual.ts';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/duck-raster.json', import.meta.url), 'utf8'),
);
const raster = {
  width: fixture.width,
  height: fixture.height,
  data: Buffer.from(fixture.rgba, 'base64'),
};
const options = { background: 'auto' as const, threshold: 70 };

void test('reference measurements follow image landmarks and normalize left-facing ducks', () => {
  const fit = fitDuckImage(raster, options);
  assert.equal(fit.bodyColor, 3);
  assert.equal(fit.beakColor, 2);
  assert.ok(fit.head.diameter > 0.48 && fit.head.diameter < 0.55);
  const mirrored = Buffer.alloc(raster.data.length);
  for (let y = 0; y < raster.height; y++)
    for (let x = 0; x < raster.width; x++)
      raster.data.copy(
        mirrored,
        (y * raster.width + x) * 4,
        (y * raster.width + raster.width - 1 - x) * 4,
        (y * raster.width + raster.width - x) * 4,
      );
  const left = fitDuckImage({ ...raster, data: mirrored }, options);
  assert.equal(left.mirrored, true);
  for (const part of ['head', 'body', 'beak', 'eye'] as const)
    for (const k of Object.keys(fit[part]))
      assert.ok(
        Math.abs(
          (fit[part] as Record<string, number>)[k] -
            (left[part] as Record<string, number>)[k],
        ) < 1e-8,
      );
  // Move the head in the input without changing the lower body. A preset-only
  // implementation would leave the fitted head position unchanged.
  const shifted = Buffer.from(raster.data);
  for (let y = 0; y < 57; y++)
    for (let x = 0; x < 128; x++) {
      const dest = (y * 128 + x) * 4,
        source = (y * 128 + x - 5) * 4;
      if (x < 5) shifted.fill(255, dest, dest + 4);
      else raster.data.copy(shifted, dest, source, source + 4);
    }
  const changed = fitDuckImage({ ...raster, data: shifted }, options);
  assert.ok(Math.abs(changed.head.z - fit.head.z) > 0.01);
  assert.notEqual(toLDraw(roundedDuck(changed)), toLDraw(roundedDuck(fit)));
});

void test('every exposed size and fullness setting has ordered real connections and no exterior supports', () => {
  const fit = fitDuckImage(raster, options);
  for (const size of [18, 20, 22])
    for (const fullness of [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15]) {
      const model = roundedDuck(fit, size, fullness, true),
        v = validateAssembly(model);
      assert.equal(v.collisions, 0, `${size}/${fullness}: collisions`);
      assert.equal(
        v.unsupported,
        0,
        `${size}/${fullness}: unsupported ${v.badIds.join(',')}`,
      );
      assert.equal(v.connected, true, `${size}/${fullness}: disconnected`);
      assert.equal(v.invalidParts, 0);
      assert.equal(model.supportCount, 0);
      assert.ok(model.bricks.every((b) => !b.support));
      assert.ok(model.bricks.length < 800);
      assert.ok(model.reconstruction!.trimmedFraction < 0.12);
      assert.equal(model.bricks.filter((b) => b.section === 'eyes').length, 2);
      assert.equal(model.bricks.filter((b) => b.section === 'wings').length, 4);
      assert.ok(model.bricks.some((b) => b.part === '15068'));
    }
});

void test('model, bill tiles, inventory and exported assembly instructions share exact placements', () => {
  const model = roundedDuck();
  assert.equal(
    inventory(model.bricks).reduce((s, p) => s + p.quantity, 0),
    model.bricks.length,
  );
  assert.ok(
    model.bricks.some((b) => b.section === 'beak' && b.part.startsWith('306')),
  );
  assert.equal(
    new Set(model.bricks.map((b) => b.id)).size,
    model.bricks.length,
  );
  const ldr = toLDraw(model);
  assert.equal(
    ldr.split('\n').filter((l) => l.startsWith('1 ')).length,
    model.bricks.length,
  );
  assert.equal(
    ldr.split('\n').filter((l) => l.trim() === '0 STEP').length,
    model.levels.length,
  );
  const html = manualHTML(model);
  assert.ok(html.includes('安装两侧弧面翅膀'));
  assert.ok(html.includes('98138'));
  assert.ok(csv(model).includes('15068'));
  for (const b of model.bricks)
    assert.ok(b.step! >= 0 && b.step! < model.levels.length);
});

void test('blank, invalid and unsupported references fail explicitly instead of returning a duck preset', () => {
  assert.throws(
    () =>
      fitDuckImage(
        { ...raster, data: Buffer.alloc(raster.data.length, 255) },
        options,
      ),
    /主体/,
  );
  assert.throws(
    () => fitDuckImage({ ...raster, data: Buffer.alloc(4) }, options),
    /像素/,
  );
  assert.throws(
    () => fitDuckImage(raster, { ...options, background: 'keep' }),
    /分离主体/,
  );
  assert.throws(
    () =>
      roundedDuck({
        ...SAMPLE_FIT,
        head: { ...SAMPLE_FIT.head, diameter: NaN },
      }),
    /比例/,
  );
});
