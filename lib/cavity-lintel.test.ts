import test from 'node:test';
import assert from 'node:assert/strict';
import { installCavityLintel } from './cavity-lintel.ts';
import {
  finishModel,
  inventory,
  toLDraw,
  validateModel,
  type Brick,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { connectedBelow } from './build-instructions.ts';
import { optimizeAestheticPacking } from './aesthetic-packing.ts';

function withoutConstruction({ construction: _construction, ...brick }: Brick) {
  return brick;
}

void test('optional construction provenance leaves every lintel layout and cell write unchanged', () => {
  for (const span of [6, 7, 10, 11, 12, 13, 14, 16])
    for (const axis of [0, 2] as const) {
      const source = new Map<string, { color: number; support: boolean }>();
      for (let x = 0; x < 26; x++)
        for (let z = 0; z < 26; z++)
          for (const y of [2, 14])
            source.set(`${x},${y},${z}`, { color: 7, support: false });
      const box =
        axis === 2
          ? {
              min: [4, 3, 2] as [number, number, number],
              max: [4 + span, 12, 5] as [number, number, number],
            }
          : {
              min: [2, 3, 4] as [number, number, number],
              max: [5, 12, 4 + span] as [number, number, number],
            };
      const legacyCells = new Map(source),
        tracedCells = new Map(source);
      const legacy = installCavityLintel(legacyCells, source, box, axis, 7);
      const opening = { openingId: 'observed-opening', regionId: 'statue' };
      const traced = installCavityLintel(
        tracedCells,
        source,
        box,
        axis,
        7,
        undefined,
        opening,
      );
      assert.deepEqual(traced.map(withoutConstruction), legacy);
      assert.deepEqual(tracedCells, legacyCells);
      assert.ok(legacy.every((brick) => !Object.hasOwn(brick, 'construction')));
      const roles =
        span > 10
          ? ['corbel', 'corbel', 'bridge', 'bridge', 'bond']
          : span > 6
            ? ['corbel', 'corbel', 'bridge']
            : ['bridge'];
      assert.deepEqual(
        traced.map((brick) => brick.construction),
        [...roles, ...roles].map((role) => ({
          ...opening,
          origin: 'cavity-lintel',
          role,
        })),
      );
    }
});

for (const axis of [0, 2] as const)
  void test(`construction provenance survives packing, poses, ordering and model JSON, axis ${axis}`, () => {
    const source = new Map<string, { color: number; support: boolean }>();
    for (let x = 0; x < 24; x++)
      for (let z = 0; z < 24; z++)
        for (const y of [2, 14])
          source.set(`${x},${y},${z}`, { color: 7, support: false });
    const box =
      axis === 2
        ? {
            min: [4, 3, 2] as [number, number, number],
            max: [16, 12, 4] as [number, number, number],
          }
        : {
            min: [2, 3, 4] as [number, number, number],
            max: [4, 12, 16] as [number, number, number],
          };
    const build = (provenance: boolean) => {
      const cells = new Map(source);
      const fixed = installCavityLintel(
        cells,
        source,
        box,
        axis,
        7,
        undefined,
        provenance ? { openingId: 'local-opening' } : undefined,
      );
      const model = finishModel(
        cells,
        24,
        18,
        24,
        'image',
        'wide opening',
        20,
        7,
        (x, y, z) =>
          [x, y, z].every(
            (value, i) => value >= box.min[i] && value < box.max[i],
          ),
        fixed,
      );
      optimizeAestheticPacking(model, 8);
      return groupImageAssembly(model);
    };
    const legacy = build(false),
      traced = build(true);
    assert.deepEqual(
      { ...traced, bricks: traced.bricks.map(withoutConstruction) },
      legacy,
    );
    assert.deepEqual(inventory(traced.bricks), inventory(legacy.bricks));
    assert.equal(toLDraw(traced), toLDraw(legacy));
    const fixed = traced.bricks.filter((brick) => brick.construction);
    assert.equal(fixed.length, 5);
    assert.ok(
      fixed.every(
        (brick) => brick.pose && brick.construction?.regionId === undefined,
      ),
    );
    assert.deepEqual(JSON.parse(JSON.stringify(traced)).bricks, traced.bricks);
    assert.equal(validateModel(traced).unsupported, 0);
  });

for (const axis of [0, 2] as const)
  void test(`a ten-stud cavity has a counted lintel supported at both ends, axis ${axis}`, () => {
    const source = new Map<string, { color: number; support: boolean }>();
    for (let x = 0; x < 20; x++)
      for (let z = 0; z < 20; z++)
        for (const y of [2, 14])
          source.set(`${x},${y},${z}`, { color: 7, support: false });
    const cells = new Map(source);
    const box =
      axis === 2
        ? {
            min: [4, 3, 2] as [number, number, number],
            max: [14, 12, 4] as [number, number, number],
          }
        : {
            min: [2, 3, 4] as [number, number, number],
            max: [4, 12, 14] as [number, number, number],
          };
    const fixed = installCavityLintel(cells, source, box, axis, 7);
    assert.equal(fixed.filter((b) => b.part === '3020').length, 2);
    assert.equal(fixed.filter((b) => b.part === '3034').length, 1);
    const blocked = (x: number, y: number, z: number) =>
      [x, y, z].every((v, i) => v >= box.min[i] && v < box.max[i]);
    const model = groupImageAssembly(
      finishModel(cells, 20, 17, 20, 'image', 'niche', 20, 7, blocked, fixed),
    );
    const check = validateModel(model);
    assert.equal(check.collisions, 0);
    assert.equal(check.unsupported, 0);
    assert.equal(check.connected, true);
    const beam = model.bricks.find((b) => b.part === '3034' && b.y === 13)!;
    const bearings = connectedBelow(model, beam);
    assert.equal(bearings.length, 2);
    assert.ok(bearings.every((b) => b.part === '3020'));
    assert.ok(model.bricks.every((b) => !blocked(b.x, b.y, b.z)));
  });

void test('a lintel cannot invent bearing pillars in a foreground semantic clearance', () => {
  const source = new Map<string, { color: number; support: boolean }>();
  for (let x = 0; x < 20; x++)
    for (let z = 2; z < 4; z++)
      for (const y of [2, 14])
        source.set(`${x},${y},${z}`, { color: 7, support: false });
  const cells = new Map(source);
  const before = new Map(cells);
  const fixed = installCavityLintel(
    cells,
    source,
    { min: [4, 3, 2], max: [14, 12, 4] },
    2,
    7,
    (x, y) => x >= 14 && y >= 4 && y < 12,
  );
  assert.deepEqual(fixed, []);
  assert.deepEqual(
    cells,
    before,
    'a rejected bearing must leave no partial pillars',
  );
});

for (const span of [11, 12, 13, 14, 16])
  for (const axis of [0, 2] as const)
    void test(`a ${span}-stud observed opening uses joined catalog plates without narrowing, axis ${axis}`, () => {
      const source = new Map<string, { color: number; support: boolean }>();
      for (let x = 0; x < 24; x++)
        for (let z = 0; z < 24; z++)
          for (const y of [2, 14])
            source.set(`${x},${y},${z}`, { color: 7, support: false });
      const cells = new Map(source);
      const box =
        axis === 2
          ? {
              min: [4, 3, 2] as [number, number, number],
              max: [4 + span, 12, 4] as [number, number, number],
            }
          : {
              min: [2, 3, 4] as [number, number, number],
              max: [4, 12, 4 + span] as [number, number, number],
            };
      const blocked = (x: number, y: number, z: number) =>
        [x, y, z].every((v, i) => v >= box.min[i] && v < box.max[i]);
      const fixed = installCavityLintel(cells, source, box, axis, 7);
      assert.equal(fixed.length, 5);
      const model = groupImageAssembly(
        finishModel(
          cells,
          24,
          18,
          24,
          'image',
          'wide opening',
          20,
          7,
          blocked,
          fixed,
        ),
      );
      const check = validateModel(model);
      assert.equal(
        check.collisions + check.unsupported + check.invalidParts,
        0,
      );
      assert.equal(check.connected, true);
      assert.ok(
        model.bricks.every(
          (b) =>
            ![0, 1, 2].every(
              (a) =>
                [b.x, b.y, b.z][a] < box.max[a] &&
                [b.x + b.w, b.y + b.h, b.z + b.d][a] > box.min[a],
            ),
        ),
      );
      const upper = model.bricks.find((b) => b.y === 14 && b.part === '3034')!;
      assert.ok(
        connectedBelow(model, upper).length >= 2,
        'the upper bridge bonds to both side beams',
      );
    });
