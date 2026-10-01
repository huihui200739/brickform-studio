import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { surfaceMaterials } from './surface-materials.ts';

void test('missing paint cannot merge two observed colors via a connected unobserved detour', () => {
  const p: number[] = [];
  // A six-triangle strip of one plane: paint at both ends, unknown in between.
  for (let x = 0; x < 3; x++)
    p.push(x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 0, 0, x + 1, 1, 0, x, 1, 0);
  const positions = Float32Array.from(p),
    observed = Int16Array.from([2, 2, -1, -1, 4, 4]);
  const before = positions.slice();
  const result = surfaceMaterials(
    positions,
    observed,
    [...Array(20)].flatMap(() => [
      { face: 0, color: 2 },
      { face: 5, color: 4 },
    ]),
    2,
  );
  assert.deepEqual(positions, before);
  for (const id of [0, 1, 4, 5])
    assert.equal(
      result.colors[id],
      observed[id],
      'observed paint is immutable',
    );
  assert.notEqual(
    result.regionIds[0],
    result.regionIds[5],
    'a detour must not erase the paint boundary',
  );
  assert.equal(
    result.design.regions.reduce((n, r) => n + r.faces, 0),
    6,
  );
  assert.equal(
    result.design.regions.reduce((n, r) => n + r.observedPixels, 0),
    40,
  );
});

void test('coincident edges connect, a real thin gap stays separate, and unsupported hidden paint is marked as a default', () => {
  const positions = Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0,
    // Same inclination but separated by a gap; no pixel observations.
    1.000001, 0, 0, 2, 0, 0, 2, 1, 0,
    // A far-away disconnected surface cannot inherit a local color.
    50, 0, 0, 51, 0, 0, 51, 1, 0,
  ]);
  const result = surfaceMaterials(
    positions,
    Int16Array.from([2, 2, -1, -1]),
    Array(16).fill({ face: 0, color: 2 }),
    7,
  );
  assert.equal(result.regionIds[0], result.regionIds[1]);
  assert.notEqual(result.regionIds[1], result.regionIds[2]);
  const far = result.design.regions[result.regionIds[3]];
  assert.equal(far.source, 'reference-default');
  assert.equal(far.color, 7);
  assert.deepEqual(far.donorRegionIds, []);
  assert.equal(result.colors[3], 7);
});

void test('a tiny observed orange ornament retains paint without coloring other unseen surfaces', () => {
  const p: number[] = [];
  const quad = (x: number, z: number, w: number, h: number) =>
    p.push(x, 0, z, x + w, 0, z, x + w, h, z, x, 0, z, x + w, h, z, x, h, z);
  quad(-1, 0, 1, 1); // Large sand surface.
  quad(0.1, 0.05, 0.02, 0.02); // Tiny orange ornament, nearest to the unknown panel.
  quad(0.2, 0, 1, 1); // Disconnected unknown panel.
  const observations = Int16Array.from([7, 7, 6, 6, -1, -1]);
  const pixels = [...Array(40)]
    .map(() => ({ face: 0, color: 7 }))
    .concat([...Array(500)].map(() => ({ face: 2, color: 6 })));
  const result = surfaceMaterials(
    Float32Array.from(p),
    observations,
    pixels,
    7,
  );
  assert.equal(result.colors[2], 6);
  assert.equal(result.colors[3], 6);
  assert.equal(
    result.colors[4],
    7,
    'small accent evidence cannot override wall material',
  );
  assert.equal(result.colors[5], 7);
  const region = result.design.regions[result.regionIds[4]];
  assert.ok(!region.donorRegionIds.includes(result.regionIds[2]));
});
