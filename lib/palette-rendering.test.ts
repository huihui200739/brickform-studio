import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshStandardMaterial } from 'three';
import { paletteMaterial } from './palette-rendering.ts';

void test('opaque surfaces keep depth writes while LDraw translucent previews retain the background', () => {
  const opaque = new MeshStandardMaterial(paletteMaterial({ hex: '#D7BA8C' })),
    flame = new MeshStandardMaterial(
      paletteMaterial({ hex: '#F08F1C', opacity: 128 / 255 }),
    );
  assert.equal(opaque.transparent, false);
  assert.equal(opaque.opacity, 1);
  assert.equal(opaque.depthWrite, true);
  assert.equal(flame.transparent, true);
  assert.equal(flame.depthTest, true);
  assert.equal(flame.depthWrite, false);
  assert.equal(flame.opacity, 128 / 255);
  assert.equal(flame.color.getHexString(), 'f08f1c');
  opaque.dispose();
  flame.dispose();
});
