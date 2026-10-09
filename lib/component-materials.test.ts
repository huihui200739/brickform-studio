import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bindComponentMaterial,
  materializeStatueBody,
} from './component-materials.ts';
import { componentBricks } from './component-parts.ts';
import { COMPONENT_LIBRARY } from './component-library.ts';
import type { Raster, Brick } from './brick-engine.ts';
import type { SceneElementInstance } from './scene-elements.ts';

function fixture(rgb: [number, number, number], alpha = 255) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let p = 0; p < 64; p++) data.set([...rgb, alpha], p * 4);
  const image: Raster & { data: Uint8ClampedArray } = {
    width: 8,
    height: 8,
    data,
  };
  const instance: SceneElementInstance = {
    id: 'source-statue',
    category: 'statue',
    confidence: 1,
    imageMask: new Uint8Array(64).fill(1),
    imageMaskSize: [8, 8],
    scaleHint: { width: 4, depth: 2, height: 12 },
  };
  return { image, instance };
}
function withoutColor(parts: Brick[]) {
  return parts.map(
    ({ color: _color, installation: _installation, ...part }) => part,
  );
}

void test('template gray remains a declared default without explicit source binding', () => {
  const original = componentBricks('statue');
  assert.deepEqual(materializeStatueBody(original), original);
  assert.equal(original.filter((part) => part.color === 11).length, 11);
  assert.deepEqual(
    COMPONENT_LIBRARY.find(
      (template) => template.id === 'statue-standing',
    )!.build(),
    original,
  );
});

void test('masked tan statue rebinds neutral body without changing identity, pose, parts or accessories', () => {
  const { image, instance } = fixture([215, 186, 140]);
  const imageBefore = image.data.slice(),
    maskBefore = instance.imageMask!.slice();
  const bound = bindComponentMaterial(instance, image);
  assert.equal(bound.materialDesign?.targetColor, 7);
  assert.equal(bound.materialDesign?.source, 'reference-mask');
  assert.equal(bound.materialDesign?.approximation, true);
  assert.equal(instance.materialDesign, undefined);
  assert.deepEqual(image.data, imageBefore);
  assert.deepEqual(instance.imageMask, maskBefore);
  const original = componentBricks('statue');
  const changed = materializeStatueBody(original, bound);
  assert.deepEqual(withoutColor(changed), withoutColor(original));
  assert.equal(changed.filter((part) => part.color === 11).length, 2);
  for (const id of ['3844', '3846', '4497']) {
    const accessory = original.findIndex((part) => part.part === id);
    assert.deepEqual(changed[accessory], original[accessory], id);
    assert.equal(changed[accessory].color, id === '4497' ? 1 : 11, id);
  }
  for (const id of [
    '3816c',
    '3815b',
    '3817c',
    '973',
    '3818',
    '3819',
    '3820',
    '3626c',
  ])
    assert.ok(
      changed
        .filter((part) => part.part === id)
        .every((part) => part.color === 7),
      id,
    );
  assert.deepEqual(changed[0], original[0], 'mounting plate keeps its material');
  assert.match(
    changed.find((part) => part.part === '3626c')!.installation!,
    /无印刷沙色头部/,
  );
  assert.ok(
    !changed.some((part) => part.installation?.includes('无印刷灰色头部')),
  );
});

void test('upper masked exposure selects stone material instead of dark cast shade', () => {
  const { image, instance } = fixture([215, 186, 140]);
  for (let p = 0; p < 32; p++) image.data.set([54, 47, 35, 255], p * 4);
  const bound = bindComponentMaterial(instance, image);
  assert.equal(bound.materialDesign?.status, 'candidate');
  assert.equal(bound.materialDesign?.targetColor, 7);
});

void test('source gray remains gray and other component categories are not washed into a body color', () => {
  const { image, instance } = fixture([150, 150, 150]);
  const bound = bindComponentMaterial(instance, image);
  assert.equal(bound.materialDesign?.targetColor, 11);
  const original = componentBricks('statue');
  assert.deepEqual(materializeStatueBody(original, bound), original);
  for (const category of ['tree', 'brazier'] as const) {
    const other = { ...instance, category };
    assert.equal(bindComponentMaterial(other, image), other);
  }
});

void test('mismatched or missing masks, tiny samples and entirely dark samples abstain', () => {
  const { image, instance } = fixture([215, 186, 140]);
  for (const subject of [
    { ...instance, imageMask: undefined },
    { ...instance, imageMaskSize: [4, 16] as [number, number] },
  ]) {
    const bound = bindComponentMaterial(subject, image);
    assert.equal(bound.materialDesign?.status, 'unobserved');
    assert.equal(bound.materialDesign?.targetColor, undefined);
  }
  const tiny = { ...instance, imageMask: new Uint8Array(64) };
  tiny.imageMask[0] = 1;
  assert.equal(
    bindComponentMaterial(tiny, image).materialDesign?.status,
    'ambiguous',
  );
  const dark = fixture([2, 2, 2]);
  assert.equal(
    bindComponentMaterial(dark.instance, dark.image).materialDesign
      ?.targetColor,
    undefined,
  );
});

void test('distinct multicolor source and nonopaque image samples do not become a single material', () => {
  const { image, instance } = fixture([201, 26, 9]);
  for (let p = 0; p < 32; p++) image.data.set([0, 85, 191, 255], p * 4);
  assert.equal(
    bindComponentMaterial(instance, image).materialDesign?.status,
    'ambiguous',
  );
  const transparent = fixture([215, 186, 140], 127);
  assert.equal(
    bindComponentMaterial(transparent.instance, transparent.image)
      .materialDesign?.targetColor,
    undefined,
  );
});

void test('all statue fallbacks materialize only their body and keep their original geometry', () => {
  const { image, instance } = fixture([215, 186, 140]);
  const bound = bindComponentMaterial(instance, image);
  for (const template of COMPONENT_LIBRARY.filter(
    (template) => template.category === 'statue',
  )) {
    const original = template.build(instance),
      changed = template.build(bound);
    assert.deepEqual(
      withoutColor(changed),
      withoutColor(original),
      template.id,
    );
    original.forEach((part, index) => {
      if (['3844', '3846', '4497'].includes(part.part))
        assert.deepEqual(changed[index], part, `${template.id} ${part.part}`);
      else if (part.color === 11)
        assert.equal(changed[index].color, 7, `${template.id} ${part.part} body`);
      else
        assert.deepEqual(changed[index], part, `${template.id} base`);
    });
  }
});

void test('catalog-negative color blocks material target without manufacturing a substitution', () => {
  const { image, instance } = fixture([254, 138, 24]);
  const bound = bindComponentMaterial(instance, image);
  assert.equal(bound.materialDesign?.targetColor, 6);
  const part: Brick = {
    id: 1,
    part: '6126b',
    x: 0,
    y: 0,
    z: 0,
    w: 1,
    d: 1,
    h: 1,
    color: 11,
  };
  assert.deepEqual(materializeStatueBody([part], bound), [part]);
});
