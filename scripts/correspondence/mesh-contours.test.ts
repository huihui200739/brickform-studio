import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TriangleMesh } from '../../lib/mesh-types.ts';
import { referenceAlignment } from '../../lib/reference-colors.ts';
import { extractMeshContours } from './mesh-contours.ts';

type Point = [number, number, number];
const quad = (a: Point, b: Point, c: Point, d: Point) => [
  ...a,
  ...b,
  ...c,
  ...a,
  ...c,
  ...d,
];
const mesh = (positions: number[]): TriangleMesh => ({
  name: 'contour control',
  positions: Float32Array.from(positions),
  colors: new Uint8Array(positions.length / 3).fill(150),
});
const image = () => {
  const data = new Uint8Array(80 * 80 * 4);
  for (let y = 8; y <= 71; y++)
    for (let x = 8; x <= 71; x++)
      data.set([140, 150, 160, 255], (y * 80 + x) * 4);
  return { width: 80, height: 80, data };
};
const align = (m: TriangleMesh, yaw = 0, pitch = 0) =>
  referenceAlignment(m, image(), { yaw, pitch, perspective: 0 });
const step = () =>
  mesh([
    ...quad([-1, -1, 0], [0, -1, 0], [0, 1, 0], [-1, 1, 0]),
    ...quad([0, -1, 0], [0, -1, 1], [0, 1, 1], [0, 1, 0]),
    ...quad([0, -1, 1], [1, -1, 1], [1, 1, 1], [0, 1, 1]),
  ]);

void test('planar internal tessellation and reflective paint do not create geometry lines', () => {
  const p: number[] = [];
  for (let y = -1; y < 1; y += 0.25)
    for (let x = -1; x < 1; x += 0.25)
      p.push(
        ...quad(
          [x, y, 0],
          [x + 0.25, y, 0],
          [x + 0.25, y + 0.25, 0],
          [x, y + 0.25, 0],
        ),
      );
  const m = mesh(p),
    a = align(m),
    plain = extractMeshContours(m, a, [80, 80]);
  for (let i = 0; i < m.colors.length; i++) m.colors[i] = i % 6 < 3 ? 0 : 255;
  const reflective = extractMeshContours(m, a, [80, 80]);
  assert.deepEqual(reflective, plain);
  assert.equal(plain.summary.status, 'ok');
  assert.equal(
    plain.samples.length,
    0,
    'the only lines are exterior display boundaries',
  );
  assert.ok(plain.segments.every((s) => s.kind === 'boundary'));
});

void test('a supported visible step supplies internal creases in original raster pixels', () => {
  const m = step(),
    result = extractMeshContours(m, align(m, -25), [80, 80]);
  assert.equal(result.summary.status, 'ok');
  assert.ok(result.segments.some((s) => s.kind === 'crease'));
  assert.ok(result.samples.length > 30, JSON.stringify(result.summary));
  assert.ok(
    result.samples.every(
      (s) =>
        s.x >= 10 &&
        s.x <= 69 &&
        s.y >= 10 &&
        s.y <= 69 &&
        Number.isFinite(s.weight) &&
        s.weight > 0,
    ),
  );
  assert.ok(
    result.samples.every((s) => Math.abs(Math.hypot(s.tx, s.ty) - 1) < 1e-12),
  );
});

void test('an opaque foreground panel hides the step creases', () => {
  const m = step();
  m.positions = Float32Array.from([
    ...m.positions,
    ...quad([-2, -2, 3], [2, -2, 3], [2, 2, 3], [-2, 2, 3]),
  ]);
  m.colors = new Uint8Array(m.positions.length / 3).fill(150);
  const result = extractMeshContours(m, align(m, -25), [80, 80]);
  assert.equal(result.summary.status, 'ok');
  assert.equal(result.segments.filter((s) => s.kind === 'crease').length, 0);
  assert.ok(result.summary.occludedSamples > 0);
});

void test('camera changes preserve source edge-component group IDs', () => {
  const m = step();
  const a = extractMeshContours(m, align(m, -25), [80, 80]);
  const b = extractMeshContours(m, align(m, -60, 15), [80, 80]);
  const creaseGroups = (r: typeof a) =>
    [
      ...new Set(
        r.segments.filter((s) => s.kind === 'crease').map((s) => s.group),
      ),
    ].sort((a, b) => a - b);
  assert.equal(a.summary.status, 'ok');
  assert.equal(b.summary.status, 'ok');
  assert.ok(creaseGroups(a).length >= 2);
  assert.deepEqual(creaseGroups(b), creaseGroups(a));
  assert.notEqual(
    a.samples.length,
    b.samples.length,
    'the same source groups survive changed screen eligibility',
  );
});

void test('dense angular microcreases without stable plane support are rejected as noise', () => {
  const p: number[] = [],
    divisions = 32,
    d = 2 / divisions;
  const point = (x: number, y: number): Point => [
    -1 + x * d,
    -1 + y * d,
    (x + y) % 2 ? 0.06 : 0,
  ];
  for (let y = 0; y < divisions; y++)
    for (let x = 0; x < divisions; x++)
      p.push(
        ...quad(
          point(x, y),
          point(x + 1, y),
          point(x + 1, y + 1),
          point(x, y + 1),
        ),
      );
  const m = mesh(p),
    result = extractMeshContours(m, align(m), [80, 80]);
  assert.equal(result.summary.status, 'ok');
  assert.ok(result.summary.creaseCandidates > 100);
  assert.ok(result.summary.unsupportedCreases > 100);
  assert.equal(result.samples.length, 0);
  assert.equal(result.segments.length, 0);
});

void test('missing original raster stride fails closed instead of guessing mask dimensions', () => {
  const m = step(),
    result = extractMeshContours(m, align(m, -25));
  assert.equal(result.summary.status, 'rejected');
  assert.deepEqual(result.samples, []);
  assert.match(result.summary.reasons.join(' '), /raster dimensions/);
});

void test('a third incident face rejects the nonmanifold step edge', () => {
  const m = step();
  m.positions = Float32Array.from([
    ...m.positions,
    0,
    -1,
    0,
    0,
    1,
    0,
    -0.5,
    0,
    -0.5,
  ]);
  const result = extractMeshContours(m, align(m, -25), [80, 80]);
  assert.equal(result.summary.status, 'ok');
  assert.equal(result.summary.nonManifoldEdges, 1);
  assert.equal(
    new Set(
      result.segments.filter((s) => s.kind === 'crease').map((s) => s.group),
    ).size,
    1,
  );
});

void test('large overlapping projected faces fail the visibility work preflight', () => {
  const face = quad([-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]);
  const m = mesh(Array.from({ length: 1000 }, () => face).flat());
  const result = extractMeshContours(m, align(m), [80, 80]);
  assert.equal(result.summary.status, 'rejected');
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.segments, []);
  assert.match(result.summary.reasons.join(' '), /preflight/);
});
