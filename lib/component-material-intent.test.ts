import assert from 'node:assert/strict';
import test from 'node:test';
import { componentBricks } from './component-parts.ts';
import { bindComponentMaterial } from './component-materials.ts';
import { assignComponentMaterialIntent, type ComponentMaterialIntent, type ComponentMaterialRole } from './component-material-intent.ts';
import { choosePartColor } from './part-color-policy.ts';
import type { Brick, Raster } from './brick-engine.ts';
import type { SceneElementInstance } from './scene-elements.ts';

function stoneFigure(parts: readonly Brick[], patch: Partial<ComponentMaterialIntent> = {}): ComponentMaterialIntent {
  return {
    groupId: 'sculpture-design-group',
    materialIntent: 'monolithic-stone',
    paletteColor: 7,
    source: 'explicit-design',
    members: parts.map((part) => ({
      brickId: part.id,
      materialRole: part.part === '3022' ? 'mount'
        : ['3844', '3846', '4497'].includes(part.part) ? 'stone-gear' : 'body',
    })),
    ...patch,
  } as ComponentMaterialIntent;
}
function geometry(parts: readonly Brick[]) {
  return parts.map(({ color: _color, colorChoice: _choice, installation: _installation, ...part }) => part);
}
function ordinary(id: number, color: number, patch: Partial<Brick> = {}): Brick {
  return { id, part: '3005', color, x: id, y: 3, z: 0, w: 1, d: 1, h: 3, section: 'declared-domain', ...patch };
}
function reference(rgb: [number, number, number] = [215, 186, 140]) {
  const data = new Uint8ClampedArray(64 * 4);
  for (let p = 0; p < 64; p++) data.set([...rgb, 255], p * 4);
  const image: Raster = { width: 8, height: 8, data };
  const instance: SceneElementInstance = {
    id: 'bound-source-instance', category: 'statue', confidence: 1,
    imageMask: new Uint8Array(64).fill(1), imageMaskSize: [8, 8],
  };
  return { image, instance };
}

void test('explicit monolithic figure recolors actual body, helmet and shield, preserving reviewed spear by default', () => {
  const parts = componentBricks('statue'), before = structuredClone(parts);
  const result = assignComponentMaterialIntent(parts, [stoneFigure(parts)]);
  assert.equal(parts.length, 13);
  assert.equal(result.audit.changedBricks, 11);
  assert.deepEqual(parts, before);
  assert.deepEqual(geometry(result.bricks), geometry(parts));
  for (const id of ['3844', '3846']) {
    assert.equal(result.bricks.find((b) => b.part === id)!.color, 7);
    assert.equal(result.audit.entries.find((e) => e.part === id)!.catalogStatus, 'unverified');
  }
  const spear = parts.find((b) => b.part === '4497')!;
  assert.equal(spear.color, 1);
  assert.strictEqual(result.bricks.find((b) => b.id === spear.id), spear);
  assert.equal(result.audit.entries.find((e) => e.part === '4497')!.reason, 'reviewed-substitution');
  assert.strictEqual(result.bricks[0], parts[0], 'mounting plate preserved');
  assert.match(result.bricks.find((b) => b.part === '3626c')!.installation!, /无印刷沙色头部/);
});

void test('new explicit stone intent re-evaluates the actual black spear to unverified Tan, not fake catalog stock', () => {
  const parts = componentBricks('statue'), group = stoneFigure(parts, { reviewedSubstitutions: 're-evaluate' });
  const before = structuredClone({ parts, group });
  const result = assignComponentMaterialIntent(parts, [group]);
  assert.equal(result.audit.changedBricks, 12);
  assert.equal(result.audit.catalogBlocked, 0);
  assert.equal(result.audit.reviewRequired, true);
  assert.equal(result.audit.stockChecked, false);
  assert.equal(result.audit.intrinsicMaterialVerified, false);
  const gear = result.audit.entries.filter((e) => e.materialRole === 'stone-gear');
  assert.equal(gear.length, 3);
  assert.equal(gear.filter((e) => e.catalogStatus === 'unverified').length, 3);
  assert.equal(result.audit.entries.filter((e) => e.catalogStatus === 'unverified').length, 12);
  assert.ok(result.bricks.slice(1).every((part) => part.color === 7));
  const spear = result.bricks.find((b) => b.part === '4497')!;
  assert.equal(spear.colorChoice, undefined, 'old gray-to-black choice is not valid for the new target');
  assert.equal(result.audit.entries.find((e) => e.part === '4497')!.priorColorChoice?.requestedColor, 11);
  assert.deepEqual({ parts, group }, before);
  assert.deepEqual(geometry(result.bricks), geometry(parts));
  const repeated = assignComponentMaterialIntent(result.bricks, [group]);
  assert.equal(repeated.audit.changedBricks, 0);
  assert.deepEqual(repeated.bricks, result.bricks);
});

void test('real metal, accessories, colored figures and genuine accents never become stone just because they are gray', () => {
  const roles: ComponentMaterialRole[] = ['metal', 'accessory', 'accent', 'foliage', 'wood', 'flame', 'mount', 'unknown'];
  const parts = roles.map((_, i) => ordinary(i + 1, i % 2 ? 9 : 11));
  const group: ComponentMaterialIntent = {
    groupId: 'mixed-roles', materialIntent: 'monolithic-stone', source: 'explicit-design', paletteColor: 7,
    members: roles.map((materialRole, i) => ({ brickId: i + 1, materialRole })),
    reviewedSubstitutions: 're-evaluate',
  };
  assert.deepEqual(assignComponentMaterialIntent(parts, [group]).bricks, parts);
  const figure = componentBricks('statue').map((b, i) => ({ ...b, color: i % 2 ? 2 : 4 }));
  const mixed = assignComponentMaterialIntent(figure, [stoneFigure(figure, { materialIntent: 'multimaterial' })]);
  assert.deepEqual(mixed.bricks, figure);
  assert.equal(mixed.audit.changedBricks, 0);
  assert.ok(mixed.audit.entries.every((e) => e.reason === 'multimaterial-component'));
});

void test('exact-mask candidate plus declared monolithic plan is positive evidence; a box/hint or rejected binding is not', () => {
  const { image, instance } = reference(), bound = bindComponentMaterial(instance, image);
  assert.equal(bound.materialDesign!.status, 'candidate');
  const parts = componentBricks('statue');
  const group: ComponentMaterialIntent = {
    ...stoneFigure(parts), source: 'reference-binding', referenceBinding: bound.materialDesign!,
    reviewedSubstitutions: 're-evaluate',
  };
  const result = assignComponentMaterialIntent(parts, [group]);
  assert.equal(result.audit.changedBricks, 11);
  assert.equal(result.bricks.find((b) => b.part === '4497')!.color, 1, 'reference evidence cannot discard a reviewed substitution');
  assert.equal(result.bricks.find((b) => b.part === '3844')!.color, 7);
  const unbound = bindComponentMaterial({ ...instance, imageMask: undefined, imageBox: { x: 0, y: 0, width: 1, height: 1 }, colorHints: [7] }, image);
  for (const binding of [unbound.materialDesign!, { ...bound.materialDesign!, status: 'ambiguous' as const }, { ...bound.materialDesign!, targetColor: 0 }]) {
    const abstained = assignComponentMaterialIntent(parts, [{ ...group, referenceBinding: binding }]);
    assert.deepEqual(abstained.bricks, parts);
    assert.ok(abstained.audit.entries.every((e) => e.reason === 'unbound-reference'));
  }
  const mixed = assignComponentMaterialIntent(parts, [{ ...group, materialIntent: 'multimaterial' }]);
  assert.deepEqual(mixed.bricks, parts);
  assert.equal(instance.materialDesign, undefined);
});

void test('palette is a declared choice, not all statues Tan; stone gray and white remain legitimate designs', () => {
  const parts = componentBricks('statue');
  for (const target of [0, 12]) {
    const result = assignComponentMaterialIntent(parts, [stoneFigure(parts, { paletteColor: target, reviewedSubstitutions: 're-evaluate' })]);
    assert.ok(result.bricks.slice(1).every((part) => part.color === target));
    assert.deepEqual(geometry(result.bricks), geometry(parts));
  }
  assert.deepEqual(assignComponentMaterialIntent(parts, []).bricks, parts);
});

void test('architectural stone groups remove selected brown variants without painting unrelated groups/support/reserved bricks', () => {
  const parts = [ordinary(1, 9), ordinary(2, 10), ordinary(3, 9), ordinary(4, 11, { support: true }), ordinary(5, 10), ordinary(6, 9)];
  const group: ComponentMaterialIntent = {
    groupId: 'declared-masonry-design', materialIntent: 'monolithic-stone', source: 'explicit-design', paletteColor: 7,
    members: [
      { brickId: 1, materialRole: 'stone' }, { brickId: 2, materialRole: 'stone' },
      { brickId: 3, materialRole: 'wood' }, { brickId: 4, materialRole: 'stone' },
      { brickId: 5, materialRole: 'stone', reserved: true },
    ],
  };
  const result = assignComponentMaterialIntent(parts, [group]);
  assert.deepEqual(result.bricks.map((b) => b.color), [7, 7, 9, 11, 10, 9]);
  assert.equal(result.audit.changedBricks, 2);
  assert.equal(result.audit.reviewRequired, false, 'ordinary 3005 Tan has positive catalog evidence');
  assert.deepEqual(geometry(result.bricks), geometry(parts));
  assert.equal(result.audit.entries.find((e) => e.brickId === 4)!.reason, 'support');
  assert.equal(result.audit.entries.find((e) => e.brickId === 5)!.reason, 'reserved');
});

void test('actual unavailable gray spear is blocked rather than silently applying catalog black as stone material', () => {
  const spear = componentBricks('statue').find((b) => b.part === '4497')!;
  assert.equal(choosePartColor('4497', 11).color, 1);
  const result = assignComponentMaterialIntent([spear], [stoneFigure([spear], { paletteColor: 11, reviewedSubstitutions: 're-evaluate' })]);
  assert.strictEqual(result.bricks[0], spear);
  assert.equal(result.audit.catalogBlocked, 1);
  const entry = result.audit.entries[0];
  assert.equal(entry.status, 'blocked');
  assert.equal(entry.catalogStatus, 'unsupported-color');
  assert.equal(entry.rejectedSubstitution?.selectedColor, 1);
  assert.equal(result.audit.reviewRequired, true);
  for (const paletteColor of [14, 999, NaN]) {
    const parts = [ordinary(1, 11)];
    const invalid = assignComponentMaterialIntent(parts, [stoneFigure(parts, { paletteColor })]);
    assert.deepEqual(invalid.bricks, parts);
    assert.equal(invalid.audit.entries[0].reason, 'invalid-opaque-palette');
  }
});

void test('ambiguous group ownership, missing members and duplicate IDs cannot accidentally broaden recoloring', () => {
  const parts = [ordinary(1, 11)], group = stoneFigure(parts);
  assert.throws(() => assignComponentMaterialIntent(parts, [group, { ...group, groupId: 'other' }]), /ambiguous group ownership/);
  assert.throws(() => assignComponentMaterialIntent(parts, [group, group]), /unique and nonempty/);
  assert.throws(() => assignComponentMaterialIntent(parts, [{ ...group, members: [{ brickId: 404, materialRole: 'body' }] }]), /does not exist/);
  assert.throws(() => assignComponentMaterialIntent([parts[0], parts[0]], [group]), /unique brick IDs/);
});
