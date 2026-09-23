import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BoxGeometry } from 'three';
import { meshToDesign, meshToDesignAuto } from './mesh-design.ts';
import { inventory, validateModel, type Model } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';
import { manualHTML } from './manual.ts';

function boxes(items: number[][]): TriangleMesh {
  const positions: number[] = [],
    colors: number[] = [];
  for (const [x, y, z, w, h, d] of items) {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    positions.push(...g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count / 3; i++)
      colors.push(215, 186, 140);
    g.dispose();
  }
  return {
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    name: '体积测试',
  };
}
function occupied(m: Model, x: number, y: number, z: number) {
  return m.bricks.some(
    (b) =>
      !b.support &&
      x >= b.x &&
      x < b.x + b.w &&
      y >= b.y &&
      y < b.y + b.h &&
      z >= b.z &&
      z < b.z + b.d,
  );
}
void test('true mesh keeps a courtyard between two towers and stairs extending toward the front', () => {
  // Coordinates map exactly to studs at resolution 20; no photo template involved.
  const mesh = boxes([
    [0, 0, 0, 20, 1, 20],
    [0, 1, 0, 5, 12, 6],
    [15, 1, 0, 5, 12, 6],
    [6, 1, 6, 8, 3, 3],
    [6, 1, 9, 8, 2, 3],
    [6, 1, 12, 8, 1, 3],
  ]);
  const m = meshToDesign(mesh, 20);
  assert.ok(m.depth >= 22);
  assert.equal(
    occupied(m, 10, 22, 4),
    false,
    'the courtyard must remain empty',
  );
  assert.equal(occupied(m, 3, 22, 4), true, 'left tower has volume');
  assert.equal(occupied(m, 18, 22, 4), true, 'right tower has volume');
  assert.equal(occupied(m, 10, 8, 8), true, 'upper stair projects forward');
  assert.equal(occupied(m, 10, 8, 15), false, 'front stair stays lower');
  assert.ok(
    m.bricks.some((b) => b.color === 7),
    'sand color must not turn bright yellow',
  );
  const check = validateModel(m);
  assert.equal(check.collisions, 0);
  assert.equal(check.unsupported, 0);
  assert.equal(check.connected, true);
  assert.equal(
    inventory(m.bricks).reduce((s, p) => s + p.quantity, 0),
    m.bricks.length,
  );
  assert.ok(m.assembly!.steps.length > 0);
  assert.equal(
    new Set(m.bricks.map((b) => b.step)).size,
    m.assembly!.steps.length,
  );
  const book = manualHTML(m, { start: 2, end: 4 });
  assert.equal(
    (book.match(/class="instruction-card"/g) || []).length,
    m.bricks.filter((b) => b.step! >= 2 && b.step! < 4).length,
  );
  assert.match(book, /本册：第 3–4 组/);
});
void test('mesh conversion rejects broken coordinates and flat image planes', () => {
  const mesh = boxes([[0, 0, 0, 4, 4, 4]]);
  mesh.positions[0] = NaN;
  assert.throws(() => meshToDesign(mesh), /无效坐标/);
  assert.throws(
    () =>
      meshToDesign({
        name: 'plane',
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        colors: new Uint8Array([255, 255, 255]),
      }),
    /三维体积/,
  );
});

void test('48-stud finishing keeps the occupied volume, connected tiled tops and exact inventory', () => {
  const model = meshToDesign(boxes([[0, 0, 0, 12, 3, 12]]), 48);
  assert.equal(model.meshDesign!.resolution, 48);
  assert.ok(model.meshDesign!.smoothTiles! > 0);
  assert.equal(
    model.bricks.filter((b) => ['3068b', '3069b', '3070b'].includes(b.part))
      .length,
    model.meshDesign!.smoothTiles,
  );
  assert.ok(model.bricks.filter((b) => b.y < 2).every((b) => b.color === 7));
  assert.equal(
    new Set(model.bricks.map((b) => b.id)).size,
    model.bricks.length,
  );
  const check = validateModel(model);
  assert.equal(check.connected, true);
  assert.equal(check.collisions + check.unsupported + check.invalidParts, 0);
  for (const b of model.bricks.filter(
    (b) => b.part.startsWith('306') || b.part === '3070b',
  )) {
    assert.equal(
      model.bricks.some(
        (above) =>
          above.y === b.y + 1 &&
          above.x < b.x + b.w &&
          above.x + above.w > b.x &&
          above.z < b.z + b.d &&
          above.z + above.d > b.z,
      ),
      false,
      'tiles never replace a required stud connection',
    );
  }
  assert.equal(
    inventory(model.bricks).reduce((s, p) => s + p.quantity, 0),
    model.bricks.length,
  );
});

void test('nonempty statue fallback initializes assembly before writing reference and exports instructions', () => {
  const mesh = boxes([[0,0,0,20,1,20],[0,1,0,3,8,3]]);
  mesh.statueFallback={width:2,height:5,depth:1,cells:[]};
  for(let x=9;x<11;x++) for(let y=3;y<8;y++) mesh.statueFallback.cells.push([x,y,10]);
  for(const model of [meshToDesign(mesh,20),meshToDesignAuto(mesh,20).model]) {
    assert.ok(model.assembly);
    assert.match(model.assembly.reference,/参考图提取的轮廓/);
    assert.match(manualHTML(model),/参考图提取的轮廓/);
    assert.ok(occupied(model,10,8,11));
    assert.equal(validateModel(model).unsupported,0);
  }
  delete mesh.statueFallback;
  assert.doesNotMatch(meshToDesign(mesh,20).assembly!.reference,/参考图提取的轮廓/);
});
