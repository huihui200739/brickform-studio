import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carveMultiView,
  outline,
  reconstructMultiView,
  multiViewToModel,
  type MultiView,
} from './multiview.ts';
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
  const sides = model.bricks.filter(
    (b) => b.x <= 1 || b.x + b.w >= model.width - 1,
  );
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
    inputs({ axis: 'front', image: framed }, { axis: 'side', image: framed }),
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

void test('three-view draft keeps physical dimensions, exposes only boundary faces, and packs the inspected volume', () => {
  const views: MultiView[] = [
    { axis: 'front', image: front() },
    { axis: 'side', image: side() },
    { axis: 'top', image: plan() },
  ];
  const { mesh, volume } = reconstructMultiView(views, 20, 'draft');
  const { width: w, height: h, depth: d } = volume;
  const triangleCount = mesh.positions.length / 9;
  assert.equal(
    triangleCount,
    4 * (w * h + w * d + h * d),
    'no internal voxel faces',
  );
  assert.equal(mesh.colors.length, triangleCount * 3);
  for (const [axis, expected] of [
    [0, w],
    [1, h * 0.4],
    [2, d],
  ]) {
    const coords = Array.from(mesh.positions).filter(
      (_, index) => index % 3 === axis,
    );
    assert.equal(Math.min(...coords), 0);
    assert.ok(Math.abs(Math.max(...coords) - expected) < 1e-5);
  }
  const model = multiViewToModel(structuredClone(volume), 'draft');
  assert.deepEqual(model.bricks, carveMultiView(views, 20, 'draft').bricks);
  assert.equal(
    model.viewsDesign!.cells,
    volume.solid.reduce((sum, cell) => sum + cell, 0),
  );
  assert.equal(validateModel(model).unsupported, 0);
});

void test('right-side front-left and plan front-bottom put asymmetric steps at +Z', () => {
  // A full-width low platform with a taller block at the front. The side view
  // has the tall block on the left. Front and top still see full rectangles.
  const sideSteps = picture(40, 40, (x, y) => {
    if (x < 4 || x >= 36 || y < 4 || y >= 36) return null;
    return y >= 20 || x < 20 ? [215, 186, 140] : null;
  });
  const square = block(40, 40, [4, 4, 32, 32]);
  const { volume } = reconstructMultiView(
    [
      { axis: 'front', image: square },
      { axis: 'side', image: sideSteps },
      { axis: 'top', image: square },
    ],
    20,
  );
  const at = (x: number, y: number, z: number) =>
    (y * volume.depth + z) * volume.width + x;
  const x = Math.floor(volume.width / 2),
    y = volume.height - 1;
  assert.equal(volume.solid[at(x, y, volume.depth - 1)], 1, 'front is high');
  assert.equal(volume.solid[at(x, y, 0)], 0, 'back is low');
  const reversed = reconstructMultiView(
    [
      { axis: 'front', image: square },
      { axis: 'side', image: sideSteps, mirrored: true },
      { axis: 'top', image: square },
    ],
    20,
  ).volume;
  assert.equal(
    reversed.solid[at(x, y, 0)],
    1,
    'side horizontal flip reverses depth',
  );
});

void test('top silhouette orientation and vertical flip agree with front at +Z', () => {
  const square = block(40, 40, [4, 4, 32, 32]);
  const notchedPlan = block(40, 40, [4, 4, 32, 32], [16, 24, 8, 12]);
  const views: MultiView[] = [
    { axis: 'front', image: square },
    { axis: 'side', image: square },
    { axis: 'top', image: notchedPlan },
  ];
  const v = reconstructMultiView(views, 20).volume;
  const at = (z: number) => z * v.width + Math.floor(v.width / 2);
  assert.equal(v.solid[at(v.depth - 1)], 0, 'bottom of plan is front');
  assert.equal(v.solid[at(0)], 1, 'back retained');
  views[2].flippedVertical = true;
  const flipped = reconstructMultiView(views, 20).volume;
  assert.equal(flipped.solid[at(0)], 0);
  assert.equal(flipped.solid[at(v.depth - 1)], 1);
});

void test('opaque background gradients cannot flood through a pale stepped surface', () => {
  const shades: Colour[] = [
    [245, 237, 227],
    [239, 231, 217],
    [233, 225, 207],
    [227, 219, 197],
    [221, 213, 187],
    [215, 207, 177],
    [215, 201, 165],
    [215, 195, 153],
    [215, 189, 141],
  ];
  const image = picture(40, 40, (x, y) => {
    if (x < 4 || x >= 36 || y < 4 || y >= 36) return [255, 255, 255];
    return shades[y - 4] || [215, 186, 140];
  });
  const s = outline({ axis: 'front', image });
  assert.equal(
    s.mask[20 * 40 + 20],
    1,
    'the continuous platform is not erased',
  );
  assert.equal(s.mask[39 * 40 + 20], 0, 'the backdrop is still excluded');
});

void test('an explicit transparent doorway remains a hole in the carved structure', () => {
  const image = front([14, 14, 12, 12]);
  const s = outline({ axis: 'front', image });
  assert.equal(s.mask[20 * 40 + 20], 0);
  const { volume } = reconstructMultiView(
    [
      { axis: 'front', image },
      { axis: 'side', image: side() },
      { axis: 'top', image: plan() },
    ],
    20,
  );
  const x = Math.floor(volume.width / 2),
    y = Math.floor(volume.height / 2);
  for (let z = 0; z < volume.depth; z++)
    assert.equal(
      volume.solid[(y * volume.depth + z) * volume.width + x],
      0,
      'opening is not cosmetically filled',
    );
});

void test('front paint is not repeated onto the unobserved back or hidden faces', () => {
  const painted = picture(40, 40, (x, y) => {
    if (x < 4 || x >= 36 || y < 4 || y >= 36) return null;
    return x > 14 && x < 26 && y > 10 && y < 30
      ? [36, 36, 36]
      : [215, 186, 140];
  });
  const { mesh, volume } = reconstructMultiView(
    [
      { axis: 'front', image: painted },
      { axis: 'side', image: side() },
      { axis: 'top', image: plan() },
    ],
    20,
    'paint',
    { softenShadows: false },
  );
  let frontDark = 0,
    backDark = 0;
  for (let i = 0; i < mesh.positions.length; i += 9) {
    const zs = [
      mesh.positions[i + 2],
      mesh.positions[i + 5],
      mesh.positions[i + 8],
    ];
    const dark = mesh.colors[i / 3] === 36;
    if (dark && zs.every((z) => z === volume.depth)) frontDark++;
    if (dark && zs.every((z) => z === 0)) backDark++;
  }
  assert.ok(frontDark > 0, 'observed material is retained');
  assert.equal(backDark, 0, 'a doorway is not printed on the unseen rear');
});

void test('contradictory same-size silhouettes cannot release a truncated model', () => {
  const step = picture(40, 40, (x, y) => {
    if (x < 4 || x >= 36 || y < 4 || y >= 36) return null;
    return y >= 20 || x < 20 ? [215, 186, 140] : null;
  });
  const planL = picture(40, 40, (x, y) => {
    if (x < 4 || x >= 36 || y < 4 || y >= 36 || (x < 20 && y >= 20))
      return null;
    return [215, 186, 140];
  });
  const { volume } = reconstructMultiView(
    [
      { axis: 'front', image: step },
      { axis: 'side', image: step },
      { axis: 'top', image: planL },
    ],
    20,
  );
  assert.equal(volume.quality!.passed, false);
  assert.ok(volume.quality!.projections.some((p) => p.retainedFraction < 0.8));
  assert.throws(() => multiViewToModel(volume), /未通过一致性检查/);
});

void test('optional material shading reduction keeps accents while suppressing warm wall shadows', () => {
  const shaded = picture(40, 40, (x, y) => {
    if (x < 4 || x >= 36 || y < 4 || y >= 36) return null;
    if (x >= 14 && x < 20) return [53, 33, 0];
    if (x >= 26 && x < 30 && y > 10 && y < 30) return [201, 26, 9];
    return [215, 186, 140];
  });
  const views: MultiView[] = [
    { axis: 'front', image: shaded },
    { axis: 'side', image: side() },
    { axis: 'top', image: plan() },
  ];
  const on = reconstructMultiView(views, 20).volume;
  const off = reconstructMultiView(views, 20, 'raw', {
    softenShadows: false,
  }).volume;
  assert.ok(on.colours.includes(2), 'red accent survives');
  assert.equal(
    on.colours.includes(10),
    false,
    'dark warm seam is not a second wall material',
  );
  assert.ok(off.colours.includes(10), 'raw material option remains available');
});
