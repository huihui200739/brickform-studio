import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshStandardMaterial } from 'three';
import { paletteMaterial, paletteOverlayMaterial } from './palette-rendering.ts';

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

void test('confirmed and manual draft overlays retain palette alpha; candidates multiply the same alpha', () => {
  const colors = [
    { hex: '#D7BA8C' },
    { hex: '#F08F1C', opacity: 128 / 255 },
  ];
  for (const color of colors) {
    const actual = new MeshStandardMaterial(paletteMaterial(color));
    const confirmed = new MeshStandardMaterial(paletteOverlayMaterial(color, true));
    const candidate = new MeshStandardMaterial(paletteOverlayMaterial(color, false));
    assert.equal(confirmed.color.getHexString(), actual.color.getHexString());
    assert.equal(confirmed.opacity, actual.opacity);
    assert.equal(confirmed.transparent, actual.transparent);
    assert.equal(confirmed.depthWrite, actual.depthWrite);
    assert.equal(candidate.color.getHexString(), actual.color.getHexString());
    assert.equal(candidate.opacity, actual.opacity * 0.35);
    assert.equal(candidate.transparent, true);
    assert.equal(candidate.depthTest, true);
    assert.equal(candidate.depthWrite, false);
    actual.dispose();
    confirmed.dispose();
    candidate.dispose();
  }
});
