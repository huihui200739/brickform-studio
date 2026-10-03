import assert from 'node:assert/strict';
import test from 'node:test';
import { PALETTE, isOpaquePaletteColor, nearestColor } from './brick-engine.ts';
import { match } from './material-color-space.ts';
import { purchaseInventory } from './purchase-inventory.ts';

void test('yellow-green photo radiance has a green brick option without repainting yellow, sand, brown or gray', () => {
  assert.equal(PALETTE[match(136, 209, 49)].lego, 119);
  assert.equal(PALETTE[match(110, 116, 78)].lego, 330);
  for (const [r, g, b, lego] of [
    [240, 200, 70, 24],
    [215, 186, 140, 5],
    [53, 33, 0, 308],
    [96, 104, 105, 199],
    [0, 85, 191, 23],
  ])
    assert.equal(PALETTE[match(r, g, b)].lego, lego);
  for (const index of [15, 16]) {
    assert.ok(isOpaquePaletteColor(index));
    const rgb = [1, 3, 5].map((at) =>
      parseInt(PALETTE[index].hex.slice(at, at + 2), 16),
    );
    assert.equal(nearestColor(rgb[0], rgb[1], rgb[2], true), index);
  }
});

void test('palette additions preserve saved model indices and do not imply checked part-color availability', () => {
  assert.deepEqual(
    PALETTE.slice(0, 15).map((color) => color.ldraw),
    [15, 0, 4, 14, 1, 2, 25, 19, 28, 70, 308, 71, 72, 378, 57],
  );
  assert.equal(PALETTE[14].opacity, 128 / 255);
  for (const [color, bricklinkColor] of [
    [15, 34],
    [16, 155],
  ]) {
    const line = purchaseInventory([
      { id: 1, part: '3001', color, x: 0, y: 0, z: 0, w: 4, d: 2, h: 3 },
    ])[0];
    assert.equal(line.bricklinkColor, bricklinkColor);
    assert.equal(line.status, 'unverified');
    assert.equal(line.quantity, 1);
  }
});
