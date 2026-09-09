import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { ASSEMBLY_PARTS, IDENTITY, curveTopY } from './assembly-catalog.ts';
import { connectors, validateAssembly } from './assembly-validation.ts';
import { envelope } from './duck-designer.ts';
import { roundedDuck } from './rounded-duck.ts';
import { toLDraw } from './brick-engine.ts';
import type { Brick } from './brick-engine.ts';
import { partThumbnail } from './build-instructions.ts';
import { orientationLabel } from './assembly-diagram.ts';

void test('new curved parts use their actual stepped seating rows and baked bounds', () => {
  const meshes = JSON.parse(
    readFileSync(
      new URL('../public/parts/geometry.json', import.meta.url),
      'utf8',
    ),
  );
  for (const [part, rows] of Object.entries({
    '88930': [0, 0],
    '93606': [24, 24, 16, 8],
    '93273': [0, -8, -8, 0],
    '49307': [0],
  })) {
    const p = ASSEMBLY_PARTS[part],
      pose = {
        matrix: IDENTITY,
        position: [0, 0, 0] as [number, number, number],
      };
    const b: Brick = { part, id: 1, color: 3, pose, ...envelope(part, pose) };
    const c = connectors(b);
    assert.equal(c.studs.length, 0);
    assert.equal(c.sockets.length, p.w * p.d);
    assert.deepEqual(
      c.sockets.slice(0, p.d).map((s) => s.point[1]),
      rows,
    );
    assert.ok(Math.abs(meshes[part].min[1] - (p.bottom - p.h * 8)) < 0.001);
    assert.ok(Math.abs(meshes[part].max[1] - p.bottom) < 0.001);
    assert.equal(meshes[part].max[2] - meshes[part].min[2], p.d * 20);
    assert.ok(!partThumbnail(b).includes('NaN'));
  }
  assert.ok(Math.abs(curveTopY(ASSEMBLY_PARTS['93273'], 0) + 16) < 0.001);
  assert.equal(curveTopY(ASSEMBLY_PARTS['93606'], 40), 0);
  assert.equal(curveTopY(ASSEMBLY_PARTS['49307'], 0), -16);
  assert.equal(curveTopY(ASSEMBLY_PARTS['49307'], 10), -6);
});
void test('continuous shells export real parts and reject intersecting duplicates', () => {
  const model = roundedDuck();
  for (const part of ['88930', '93606', '93273', '49307'])
    assert.ok(model.bricks.some((b) => b.part === part));
  assert.match(
    orientationLabel(model.bricks.find((b) => b.part === '49307')!),
    /圆弧顶朝上/,
  );
  assert.equal(model.bricks.filter((b) => b.part === '88930').length, 8);
  assert.ok(
    model.bricks.some((b) => b.part === '88930' && b.pose!.matrix[7] === 1),
  );
  assert.equal(validateAssembly(model).collisions, 0);
  assert.equal(validateAssembly(model).unsupported, 0);
  const piece = model.bricks.find((b) => b.part === '93606')!;
  const bad = {
    ...model,
    bricks: [...model.bricks, { ...piece, id: model.bricks.length + 1 }],
  };
  assert.ok(validateAssembly(bad).collisions > 0);
  assert.equal(
    toLDraw(model)
      .split('\n')
      .filter((l) => l.startsWith('1 ')).length,
    model.bricks.length,
  );
});
