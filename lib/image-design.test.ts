import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  generateImageDesign,
  imageTreatment,
  type ImageDesignOptions,
} from './image-design.ts';
import {
  validateModel,
  inventory,
  toLDraw,
  type Raster,
} from './brick-engine.ts';
import {
  stageBricks,
  placementContext,
  topDiagram,
} from './build-instructions.ts';
import { manualHTML } from './manual.ts';
const options: ImageDesignOptions = {
  resolution: 20,
  depth: 4,
  threshold: 70,
  background: 'auto',
  mode: 'auto',
};
function raster(
  width: number,
  height: number,
  pixel: (x: number, y: number) => number[],
): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, data };
}
const white = [255, 255, 255, 255],
  blue = [0, 85, 191, 255],
  red = [201, 26, 9, 255];
const fixtures = {
  house: raster(32, 32, (x, y) =>
    y >= 13 && y < 29 && x >= 7 && x < 25
      ? blue
      : y > 3 && y < 14 && Math.abs(x - 16) < y - 2
        ? red
        : white,
  ),
  cup: raster(32, 32, (x, y) =>
    (x > 5 && x < 20 && y > 6 && y < 27) ||
    (x >= 20 && x < 28 && y > 9 && y < 23 && !(x < 25 && y > 12 && y < 20))
      ? blue
      : white,
  ),
  transparent: raster(32, 32, (x, y) =>
    Math.hypot(x - 16, y - 16) < 11 ? red : [0, 0, 0, 0],
  ),
  separated: raster(32, 32, (x, y) =>
    (x > 3 && x < 9 && y > 5 && y < 12) ||
    (x > 22 && x < 29 && y > 18 && y < 27)
      ? blue
      : white,
  ),
  scene: raster(32, 24, (x, y) => [x * 8, y * 10, (x + y) * 4, 255]),
  thin: raster(3, 32, (_, y) => (y > 2 && y < 30 ? blue : white)),
};
void test('different objects, transparent images and scenes generate connected real-part models with bounded groups', () => {
  for (const [name, image] of Object.entries(fixtures))
    for (const resolution of [20, 28, 36]) {
      const model = generateImageDesign(
        image,
        { ...options, resolution },
        name,
      );
      const v = validateModel(model);
      assert.equal(v.collisions, 0, name);
      assert.equal(v.unsupported, 0, name);
      assert.equal(v.invalidParts, 0, name);
      assert.equal(v.connected, true, name);
      assert.equal(
        inventory(model.bricks).reduce((n, p) => n + p.quantity, 0),
        model.bricks.length,
      );
      assert.equal(
        toLDraw(model)
          .split('\n')
          .filter((l) => l.startsWith('1 ')).length,
        model.bricks.length,
      );
      assert.ok(model.bricks.every((b) => !!b.pose && !!b.section));
      assert.deepEqual(
        model.levels,
        model.assembly!.steps.map((_, i) => i),
      );
      for (const step of model.levels)
        assert.ok(
          stageBricks(model, step).length > 0 &&
            stageBricks(model, step).length <= 12,
        );
    }
  assert.notDeepEqual(
    generateImageDesign(fixtures.house, options, 'house').bricks,
    generateImageDesign(fixtures.cup, options, 'cup').bricks,
  );
});
void test('automatic treatment retains complex and uniform pictures, and explicit modes remain selectable', () => {
  assert.equal(imageTreatment(fixtures.house, options).shape, 'sculpture');
  assert.equal(
    imageTreatment(fixtures.transparent, options).background,
    'auto',
  );
  assert.equal(imageTreatment(fixtures.scene, options).shape, 'relief');
  assert.equal(imageTreatment(fixtures.scene, options).background, 'keep');
  assert.equal(
    imageTreatment(fixtures.house, { ...options, background: 'keep' }).shape,
    'relief',
  );
  assert.equal(
    generateImageDesign(
      raster(8, 8, () => white),
      options,
      'white',
    ).imageDesign!.background,
    'keep',
  );
  for (const mode of ['sculpture', 'relief'] as const) {
    const model = generateImageDesign(
      fixtures.cup,
      { ...options, mode, depth: 8 },
      mode,
    );
    assert.equal(model.shape, mode);
  }
  assert.throws(
    () =>
      generateImageDesign(
        raster(2, 2, () => [0, 0, 0, 0]),
        options,
        'empty',
      ),
    /透明/,
  );
  assert.throws(
    () =>
      generateImageDesign(fixtures.house, { ...options, depth: NaN }, 'bad'),
    /参数/,
  );
});
void test('generic instructions preserve placement order, use generic directions and export every piece once', () => {
  const model = generateImageDesign(fixtures.house, options, 'house <test>');
  for (const step of model.levels) {
    const batch = stageBricks(model, step);
    batch.forEach((b, i) => {
      const context = placementContext(model, step, i);
      assert.ok(context.visible.every((p) => p.id <= b.id));
    });
  }
  const html = manualHTML(model);
  assert.doesNotMatch(html, /鸭嘴|小鸭|NaN|Infinity/);
  assert.match(html, /house &lt;test&gt;/);
  assert.equal(
    (html.match(/class="instruction-card"/g) || []).length,
    model.bricks.length,
  );
  assert.match(topDiagram(model, 0, 0), /数字增大方向/);
});
