import test from 'node:test';
import assert from 'node:assert/strict';
import { bindComponentMaterial, materializeStatueBody, materializeStatueBodyWithAudit } from './component-materials.ts';
import { componentBricks } from './component-parts.ts';
import { COMPONENT_LIBRARY } from './component-library.ts';
import type { Brick, Raster } from './brick-engine.ts';
import type { SceneElementInstance } from './scene-elements.ts';

function fixture(rgb: [number, number, number] = [215, 186, 140]) {
  const data = new Uint8ClampedArray(64 * 4);
  for (let p = 0; p < 64; p++) data.set([...rgb, 255], p * 4);
  const image: Raster = { width: 8, height: 8, data };
  const instance: SceneElementInstance = {
    id: 'source-statue', category: 'statue', confidence: 1,
    imageMask: new Uint8Array(64).fill(1), imageMaskSize: [8, 8],
    scaleHint: { width: 4, depth: 2, height: 12 },
  };
  return { image, instance, data };
}
function geometry(parts: Brick[]) {
  return parts.map(({ color: _color, colorChoice: _choice, installation: _installation, ...part }) => part);
}

void test('material-first exact Tan mask yields uniform actual stone body and gear with a detached honest audit', () => {
  const { image, instance, data } = fixture();
  const imageBefore = data.slice(), maskBefore = instance.imageMask!.slice();
  const bound = bindComponentMaterial(instance, image, { materialFirst: true });
  assert.equal(bound.materialDesign?.materialIntent, 'monolithic');
  assert.equal(bound.materialDesign?.materialIntentEvidence?.intrinsicMaterialVerified, false);
  const parts = componentBricks('statue'), original = structuredClone(parts), boundBefore = structuredClone(bound);
  const result = materializeStatueBodyWithAudit(parts, bound);
  assert.equal(result.audit?.changedBricks, 12);
  assert.equal(result.audit?.stockChecked, false);
  assert.equal(result.audit?.referenceDesign.source, 'reference-mask');
  assert.equal(result.audit?.referenceDesign.intrinsicMaterialVerified, false);
  assert.ok(result.parts.slice(1).every(part => part.color === 7));
  assert.strictEqual(result.parts[0], parts[0]);
  const gear = result.audit!.entries.filter(entry => entry.materialRole === 'stone-gear');
  assert.equal(gear.length, 3);
  assert.ok(gear.every(entry => entry.catalogStatus === 'unverified'));
  assert.equal(gear.find(entry => entry.part === '4497')?.priorColorChoice?.requestedColor, 11);
  assert.equal(result.parts.find(part => part.part === '4497')?.colorChoice, undefined);
  assert.deepEqual(geometry(result.parts), geometry(parts));
  assert.deepEqual(parts, original);
  assert.deepEqual(bound, boundBefore);
  assert.deepEqual(image.data, imageBefore);
  assert.deepEqual(instance.imageMask, maskBefore);
  assert.equal(instance.materialDesign, undefined);
});

void test('legacy/faithful body-only binding remains byte-for-value identical without material-first opt-in', () => {
  const { image, instance } = fixture();
  const old = bindComponentMaterial(instance, image), disabled = bindComponentMaterial(instance, image, { materialFirst: false });
  assert.deepEqual(disabled, old);
  assert.equal(old.materialDesign?.materialIntent, undefined);
  const parts = componentBricks('statue'), changed = materializeStatueBody(parts, old);
  for (const id of ['3844', '3846', '4497']) {
    assert.deepEqual(changed.find(part => part.part === id), parts.find(part => part.part === id));
  }
  assert.equal(materializeStatueBodyWithAudit(parts, old).audit, undefined);
});

void test('real neutral/black metal-like and distinct chromatic accents disable monolithic planning', () => {
  for (const accent of [[150, 150, 150], [36, 36, 36], [0, 85, 191]] as [number, number, number][]) {
    const { image, instance, data } = fixture();
    const accentPixels = accent[2] === 191 ? 4 : 12;
    for (let p = 0; p < accentPixels; p++) data.set([...accent, 255], p * 4);
    const bound = bindComponentMaterial(instance, image, { materialFirst: true });
    assert.equal(bound.materialDesign?.materialIntent, undefined);
    const parts = componentBricks('statue'), changed = materializeStatueBody(parts, bound);
    for (const id of ['3844', '3846', '4497']) assert.deepEqual(changed.find(part => part.part === id), parts.find(part => part.part === id));
  }
});

void test('warm scalar shadow is a same-family design candidate but gray never means metal or automatic Tan', () => {
  const shaded = fixture();
  for (let p = 0; p < 32; p++) shaded.data.set([54, 47, 35, 255], p * 4);
  const bound = bindComponentMaterial(shaded.instance, shaded.image, { materialFirst: true });
  assert.equal(bound.materialDesign?.materialIntent, 'monolithic');
  assert.equal(bound.materialDesign?.targetColor, 7);
  const gray = fixture([150, 150, 150]);
  const grayBound = bindComponentMaterial(gray.instance, gray.image, { materialFirst: true });
  assert.equal(grayBound.materialDesign?.targetColor, 11);
  const parts = componentBricks('statue'), result = materializeStatueBodyWithAudit(parts, grayBound);
  assert.deepEqual(result.parts, parts);
  assert.equal(result.audit?.catalogBlocked, 1, 'gray spear is genuinely catalog-negative; do not manufacture uniform gray');
});

void test('template fallback temporary IDs restore all original IDs, geometry, mounts and unrelated components', () => {
  const { image, instance } = fixture(), bound = bindComponentMaterial(instance, image, { materialFirst: true });
  for (const template of COMPONENT_LIBRARY.filter(template => template.category === 'statue')) {
    const old = template.build(instance), changed = template.build(bound);
    assert.deepEqual(geometry(changed), geometry(old), template.id);
    assert.deepEqual(changed.map(part => part.id), old.map(part => part.id), template.id);
    old.forEach((part, index) => {
      if (part.color === 7) assert.deepEqual(changed[index], part, template.id + ' pedestal/base');
    });
  }
  for (const category of ['tree', 'brazier'] as const) {
    const other = { ...instance, category };
    assert.strictEqual(bindComponentMaterial(other, image, { materialFirst: true }), other);
    assert.deepEqual(materializeStatueBody(componentBricks(category), bound), componentBricks(category));
  }
});

void test('human/unknown reviewed choices, supports and unknown parts stay protected in a monolithic template', () => {
  const { image, instance } = fixture(), bound = bindComponentMaterial(instance, image, { materialFirst: true });
  const parts = componentBricks('statue').map(part => part.part === '3844' ? {
    ...part, colorChoice: {
      requestedColor: 11, selectedColor: 11, reason: 'reviewed-unsupported-catalog-color' as const,
      source: { url: 'https://example.test/human-review', checkedAt: '2026-10-01', kind: 'bricklink-catalog' as const },
    },
  } : part.part === '973' ? { ...part, support: true } : part);
  const unknown: Brick = { ...parts[1], id: 0, part: 'unknown-part', color: 11 };
  parts.push(unknown);
  const result = materializeStatueBodyWithAudit(parts, bound);
  for (const id of ['3844', '973', 'unknown-part']) assert.deepEqual(result.parts.find(part => part.part === id), parts.find(part => part.part === id));
  const forgedSpear = parts.map(part => part.part === '4497' ? { ...part, colorChoice: { ...part.colorChoice!, source: { ...part.colorChoice!.source, url: 'https://example.test/custom-choice' } } } : part);
  const changed = materializeStatueBody(forgedSpear, bound);
  assert.deepEqual(changed.find(part => part.part === '4497'), forgedSpear.find(part => part.part === '4497'));
});

void test('a markup/hint or inexact mask cannot activate material-first source binding', () => {
  const { image, instance } = fixture();
  for (const subject of [
    { ...instance, imageMask: undefined, imageBox: { x: 0, y: 0, width: 1, height: 1 }, colorHints: [7] },
    { ...instance, imageMaskSize: [4, 16] as [number, number] },
  ]) {
    const bound = bindComponentMaterial(subject, image, { materialFirst: true });
    assert.equal(bound.materialDesign?.status, 'unobserved');
    assert.equal(bound.materialDesign?.materialIntent, undefined);
    assert.deepEqual(materializeStatueBody(componentBricks('statue'), bound), componentBricks('statue'));
  }
});
