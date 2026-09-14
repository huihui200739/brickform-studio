import test from 'node:test';
import assert from 'node:assert/strict';
import { carveMultiView, outline, type MultiView } from './multiview.ts';
import { validateModel, PALETTE, type Raster } from './brick-engine.ts';

type Colour = [number, number, number];
// A picture with a transparent background: the outline is exact, so the carved
// volume can be predicted instead of merely observed.
function picture(
  width: number,
  height: number,
  paint: (x: number, y: number) => Colour | null,
): Raster {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const colour = paint(x, y);
      if (colour) data.set([...colour, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}
const block = (
  width: number,
  height: number,
  rect: [number, number, number, number],
  hole?: [number, number, number, number],
  colour: Colour = [215, 186, 140],
) =>
  picture(width, height, (x, y) => {
    const [bx, by, bw, bh] = rect;
    if (x < bx || y < by || x >= bx + bw || y >= by + bh) return null;
    if (hole) {
      const [hx, hy, hw, hh] = hole;
      if (x >= hx && y >= hy && x < hx + hw && y < hy + hh) return null;
    }
    return colour;
  });
const front = (hole?: [number, number, number, number]) =>
  block(40, 40, [4, 4, 32, 32], hole);
const side = (hole?: [number, number, number, number]) =>
  block(40, 40, [8, 4, 24, 32], hole);
const plan = (hole?: [number, number, number, number]) =>
  block(40, 40, [4, 8, 32, 24], hole);
const inputs = (...views: MultiView[]) => views;

void test('the volume is the intersection of the outlines', () => {
  // A notch cut out of the top of the front outline must be empty in the model,
  // even though the side outline is solid there.
  const model = carveMultiView(
    inputs(
      { axis: 'front', image: front([16, 4, 8, 10]) },
      { axis: 'side', image: side() },
    ),
    20,
    '槽口',
  );
  assert.equal(model.viewsDesign!.method, 'silhouette-carving');
  assert.deepEqual(model.viewsDesign!.views, ['front', 'side']);
  assert.equal(validateModel(model).connected, true);
  const top = Math.max(...model.bricks.map((b) => b.y + b.h)),
    middle = (model.width - 1) / 2,
    notch = model.bricks.filter((b) => b.y + b.h > top - 3);
  assert.ok(
    notch.every((b) => b.x + b.w < middle - 1 || b.x > middle + 1),
    'no brick sits above the notch',
  );
  assert.ok(
    model.bricks.some((b) => b.x < middle - 2 && b.y + b.h > top - 3),
    'the towers either side of the notch remain',
  );
});
void test('a hole present in two views is carved right through', () => {
  const model = carveMultiView(
    inputs(
      { axis: 'front', image: front([14, 18, 8, 18]) },
      { axis: 'side', image: side([12, 18, 6, 18]) },
      { axis: 'top', image: plan([14, 14, 8, 12]) },
    ),
    28,
    '门洞',
  );
  assert.deepEqual(model.viewsDesign!.views, ['front', 'side', 'top']);
  assert.equal(validateModel(model).connected, true);
  // The opening reaches the ground, so the middle of the model is two legs.
  const legs = new Set(
    model.bricks
      .filter((b) => b.y < 3 && !b.support)
      .flatMap((b) => [b.x, b.x + b.w - 1]),
  );
  assert.ok(Math.min(...legs) < 4 && Math.max(...legs) > model.width - 6);
});
void test('colours are read from the view that faces each side', () => {
  const model = carveMultiView(
    inputs(
      { axis: 'front', image: front(undefined) },
      { axis: 'side', image: side(undefined) },
      { axis: 'top', image: plan(undefined) },
    ),
    20,
    '面向配色',
  );
  const painted = new Set(model.bricks.map((b) => b.color)),
    names = [...painted].map((i) => PALETTE[i].name);
  assert.ok(names.includes('沙色'), 'the shared sand material is used');
  const sides = model.bricks.filter((b) => b.x <= 1 || b.x + b.w >= model.width - 1);
  assert.ok(sides.length > 0, 'the model has side faces');
  assert.equal(validateModel(model).connected, true);
});
void test('the physical ratio comes from the outlines, not from the pixel sizes', () => {
  // Two pictures with different pixel sizes: a 64 x 32 outline (twice as wide
  // as it is tall) and a 32 x 32 outline, so the model must be twice as wide as
  // it is deep.
  const model = carveMultiView(
    inputs(
      { axis: 'front', image: block(80, 40, [6, 4, 64, 32]) },
      { axis: 'side', image: block(60, 60, [4, 4, 32, 32]) },
    ),
    20,
    '比例',
  );
  const ratio = model.width / model.depth;
  assert.ok(
    ratio > 1.9 && ratio < 2.1,
    `front/side ratio was ${ratio.toFixed(2)}`,
  );
  assert.ok(model.width % 2 === 0 && model.depth % 2 === 0, 'even footprint');
});
void test('duplicate directions, a single view and an empty outline all fail', () => {
  assert.throws(
    () =>
      carveMultiView(
        inputs(
          { axis: 'front', image: front() },
          { axis: 'front', image: side() },
        ),
        20,
        '重复',
      ),
    /只能上传一张/,
  );
  assert.throws(
    () => carveMultiView(inputs({ axis: 'front', image: front() }), 20, '单张'),
    /至少上传/,
  );
  assert.throws(
    () =>
      carveMultiView(
        inputs(
          { axis: 'front', image: front() },
          { axis: 'side', image: picture(20, 20, () => null) },
        ),
        20,
        '空图',
      ),
    /没有清晰主体/,
  );
});
void test('a detached blob is not part of the object', () => {
  // A drop shadow, a watermark or a screenshot toolbar sits away from the body
  // and must not stretch the carved volume.
  const withBlob = (
    width: number,
    height: number,
    rect: [number, number, number, number],
  ) =>
    picture(width, height, (x, y) => {
      if (x > 34 && y > 34) return [40, 40, 40];
      const [bx, by, bw, bh] = rect;
      return x >= bx && y >= by && x < bx + bw && y < by + bh
        ? [215, 186, 140]
        : null;
    });
  const clean = carveMultiView(
    inputs(
      { axis: 'front', image: block(40, 40, [4, 4, 24, 32]) },
      { axis: 'side', image: block(40, 40, [4, 4, 24, 32]) },
    ),
    20,
    '干净',
  );
  const blobbed = carveMultiView(
    inputs(
      { axis: 'front', image: withBlob(40, 40, [4, 4, 24, 32]) },
      { axis: 'side', image: block(40, 40, [4, 4, 24, 32]) },
    ),
    20,
    '带杂物',
  );
  assert.equal(blobbed.width, clean.width);
  assert.equal(blobbed.height, clean.height);
  assert.equal(blobbed.depth, clean.depth);
});
void test('an anti-aliased edge does not colour the outer bricks', () => {
  // The border ring is a pale blend with the background; sampling it would
  // paint whole faces white.
  const framed = picture(40, 40, (x, y) => {
    if (x < 3 || y < 3 || x > 36 || y > 36) return null;
    if (x < 5 || y < 5 || x > 34 || y > 34) return [244, 244, 244];
    return [215, 186, 140];
  });
  const model = carveMultiView(
    inputs(
      { axis: 'front', image: framed },
      { axis: 'side', image: framed },
    ),
    20,
    '描边',
  );
  const whites = model.bricks.filter((b) => PALETTE[b.color].name === '白色');
  assert.equal(whites.length, 0, 'no brick takes the outline colour');
  assert.ok(
    model.bricks.every((b) => PALETTE[b.color].name === '沙色'),
    'the main material wins',
  );
});
void test('views that do not agree about the shape are rejected with the numbers', () => {
  // The front picture reused as the plan view: the widths disagree, which means
  // the pictures are not three orthographic views of one object.
  const wide = block(60, 40, [4, 4, 52, 32]),
    square = block(40, 40, [4, 4, 32, 32]);
  // Front / side imply a width:depth of 1.63, so a square plan view contradicts
  // them. A plan view as wide as it is deep would too.
  assert.throws(
    () =>
      carveMultiView(
        inputs(
          { axis: 'front', image: wide },
          { axis: 'side', image: square },
          { axis: 'top', image: square },
        ),
        20,
        '比例不符',
      ),
    /比例对不上/,
  );
  assert.doesNotThrow(() =>
    carveMultiView(
      inputs(
        { axis: 'front', image: wide },
        { axis: 'side', image: square },
        { axis: 'top', image: block(60, 40, [4, 4, 52, 32]) },
      ),
      20,
      '比例一致',
    ),
  );
});
void test('outline reports the drawn rectangle bounds', () => {
  const s = outline({ axis: 'front', image: block(40, 40, [6, 8, 20, 12]) });
  assert.deepEqual(
    { left: s.left, right: s.right, top: s.top, bottom: s.bottom },
    { left: 6, right: 25, top: 8, bottom: 19 },
  );
});
