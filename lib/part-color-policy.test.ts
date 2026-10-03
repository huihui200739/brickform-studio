import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePartColor } from './part-color-policy.ts';
import {
  nearestColor,
  isOpaquePaletteColor,
  toLDraw,
  type Model,
} from './brick-engine.ts';
import { match } from './material-color-space.ts';
import { referenceMaterials } from './reference-materials.ts';
import { positionedComponent } from './semantic-components.ts';

void test('unknown or unverified part-color combinations retain their semantic geometry choice', () => {
  for (const [part, color] of [
    ['unknown-part', 11],
    ['3010', 10],
    ['6126b', 11],
    ['__proto__', 7],
    ['4497', 999],
    ['4497', NaN],
  ] as const) {
    const choice = choosePartColor(part, color);
    assert.equal(choice.color, color);
    assert.equal(choice.substitution, undefined);
  }
  assert.deepEqual(choosePartColor('4497', 1), { color: 1 });
});

void test('catalog transparent color cannot enter ordinary RGB, Lab or reference-region matching', () => {
  assert.equal(isOpaquePaletteColor(14), false);
  assert.equal(isOpaquePaletteColor(999), false);
  for (let r = 200; r <= 255; r += 5)
    for (let g = 100; g <= 170; g += 5)
      for (let b = 0; b <= 50; b += 5) {
        assert.ok(isOpaquePaletteColor(nearestColor(r, g, b, true)));
        assert.ok(isOpaquePaletteColor(match(r, g, b)));
      }
  const data = new Uint8Array(144 * 4);
  for (let i = 0; i < 144; i++) data.set([240, 143, 28, 255], i * 4);
  for (const normalize of [false, true]) {
    const result = referenceMaterials(
      { width: 12, height: 12, data },
      new Uint8Array(144).fill(1),
      normalize,
    );
    assert.ok(
      result.design.regions.every((r) => isOpaquePaletteColor(r.color)),
    );
    assert.ok(Array.from(result.palette).every(isOpaquePaletteColor));
  }
});

void test('posed catalog flame and spear carry checked colors through LDraw without changing part poses', () => {
  const brazier = positionedComponent('brazier', [10, 0, 10], 0, {
    width: 30,
    depth: 30,
  });
  const statue = positionedComponent('statue', [15, 0, 10], 0, {
    width: 30,
    depth: 30,
  });
  assert.equal(brazier.length, 5);
  assert.equal(statue.length, 13);
  const flame = brazier.find((b) => b.part === '6126b')!;
  const spear = statue.find((b) => b.part === '4497')!;
  assert.equal(flame.color, 14);
  assert.equal(spear.color, 1);
  assert.equal(flame.colorChoice?.requestedColor, 6);
  assert.equal(spear.colorChoice?.requestedColor, 11);
  const bricks = [...brazier, ...statue];
  const model = {
    name: 'catalog color regression',
    bricks,
    width: 30,
    depth: 30,
    levels: [...new Set(bricks.map((b) => b.y))].sort((a, b) => a - b),
    assemblyStrategy: 'connector-graph',
  } as unknown as Model;
  const output = toLDraw(model);
  assert.ok(
    output.includes(
      `1 57 ${flame.pose!.position.join(' ')} ${flame.pose!.matrix.join(' ')} 6126b.dat`,
    ),
  );
  assert.ok(
    output.includes(
      `1 0 ${spear.pose!.position.join(' ')} ${spear.pose!.matrix.join(' ')} 4497.dat`,
    ),
  );
  assert.equal(output.split('\n').filter((l) => l.startsWith('1 ')).length, 18);
});
