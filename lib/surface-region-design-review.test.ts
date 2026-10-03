import test from 'node:test';
import assert from 'node:assert/strict';
import { designRegionPlanes } from './surface-region-design.ts';
import { validateSurfaceClearance } from './surface-clearance.ts';
import type { TriangleMesh } from './mesh-types.ts';

function tiltedGrid(
  height: (x: number, y: number) => number,
  rows = Array.from({ length: 25 }, (_, i) => i * 0.5),
): TriangleMesh {
  const positions: number[] = [];
  const point = (x: number, y: number) => [x, y, 2 + 0.5 * y + height(x, y)];
  for (let j = 0; j < rows.length - 1; j++)
    for (let x = 0; x < 20; x += 0.5) {
      const a = point(x, rows[j]),
        b = point(x + 0.5, rows[j]),
        c = point(x + 0.5, rows[j + 1]),
        d = point(x, rows[j + 1]);
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
  return {
    name: 'inclined review control',
    positions: Float32Array.from(positions),
    colors: new Uint8Array(positions.length / 3),
  };
}

function bounds(positions: Float32Array) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], positions[i]);
  }
  return { lo, hi };
}

function surfaceHeight(
  positions: Float32Array,
  start: number,
  end: number,
  x: number,
  y: number,
) {
  for (let at = start; at < end; at += 9) {
    const ax = positions[at],
      ay = positions[at + 1],
      az = positions[at + 2],
      bx = positions[at + 3],
      by = positions[at + 4],
      bz = positions[at + 5],
      cx = positions[at + 6],
      cy = positions[at + 7],
      cz = positions[at + 8];
    const determinant = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(determinant) < 1e-12) continue;
    const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / determinant,
      b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / determinant,
      c = 1 - a - b;
    if (a >= -1e-9 && b >= -1e-9 && c >= -1e-9) return a * az + b * bz + c * cz;
  }
  throw new Error(`No triangle covers review ray ${x}, ${y}`);
}

const noise = (x: number, y: number) =>
  x && y && x < 20 && y < 12 ? 0.025 * Math.sin(x * 73.13 + y * 113.79) : 0;

void test('inclined plane candidates cannot create new global extrema', () => {
  const source = tiltedGrid(
    (x, y) =>
      x === 0 || x === 20 || y === 0 || y === 12
        ? 0
        : y === 0.1
          ? 0.01
          : -0.08 + 0.025 * Math.sin(x * 73.13 + y * 113.79),
    [0, 0.1, ...Array.from({ length: 24 }, (_, i) => (i + 1) * 0.5)],
  );
  const result = designRegionPlanes(source, 20),
    original = bounds(source.positions),
    candidate = bounds(result.mesh.positions);
  for (let axis = 0; axis < 3; axis++) {
    assert.ok(
      candidate.lo[axis] >= original.lo[axis],
      `Axis ${axis} minimum expanded: ${candidate.lo[axis]} < ${original.lo[axis]}`,
    );
    assert.ok(
      candidate.hi[axis] <= original.hi[axis],
      `Axis ${axis} maximum expanded: ${candidate.hi[axis]} > ${original.hi[axis]}`,
    );
  }
});

void test('independently fitted near sheets retain their positive separation', () => {
  const lower = tiltedGrid(noise),
    upper = tiltedGrid(
      (x, y) => noise(x, y) + 0.001 + 0.04 * Math.exp(-(((x - 1) / 0.5) ** 2)),
    );
  const split = lower.positions.length;
  const source: TriangleMesh = {
    name: 'two disconnected near sheets',
    positions: Float32Array.from([...lower.positions, ...upper.positions]),
    colors: Uint8Array.from([...lower.colors, ...upper.colors]),
  };
  const result = designRegionPlanes(source, 20),
    candidate = result.mesh.positions;
  assert.equal(
    result.clearance?.accepted,
    false,
    'Crossing candidate must be vetoed',
  );
  assert.equal(result.clearance?.reason, 'new-intersection');
  assert.equal(result.mesh, source, 'A veto returns the original mesh');
  assert.equal(result.patches.length, 0);
  for (const [x, y] of [
    [2, 5],
    [2.5, 6],
    [13.5, 6],
  ]) {
    const gap = (positions: Float32Array) =>
      surfaceHeight(positions, split, positions.length, x, y) -
      surfaceHeight(positions, 0, split, x, y);
    assert.ok(gap(source.positions) > 0, 'source sheets must be separated');
    assert.ok(gap(candidate) > 0, `Candidate sheets crossed at ${x}, ${y}`);
  }
});

void test('coherent non-quadratic shallow curvature is retained', () => {
  const source = tiltedGrid((x) => 0.025 * Math.sin((x / 20) * Math.PI * 4)),
    result = designRegionPlanes(source, 20);
  assert.equal(
    result.patches.length,
    0,
    'A smooth sinusoidal bend is geometry',
  );
  assert.equal(result.mesh, source);
});

const triangleA = [0, 0, 0, 2, 0, 0, 0, 2, 0];

void test('surface clearance detects a new transverse collision without editing arrays', () => {
  const source = Float32Array.from([
      ...triangleA,
      0.5,
      0.5,
      0.1,
      0.5,
      1.5,
      0.1,
      0.5,
      0.5,
      0.2,
    ]),
    candidate = new Float32Array(source);
  candidate[11] = -0.1;
  const beforeSource = new Float32Array(source),
    beforeCandidate = new Float32Array(candidate);
  const result = validateSurfaceClearance(source, candidate, 2);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'new-intersection');
  assert.deepEqual(result.firstFaces, [1, 0]);
  assert.deepEqual(source, beforeSource);
  assert.deepEqual(candidate, beforeCandidate);
});

void test('surface clearance detects coplanar overlap but accepts disjoint triangles with overlapping boxes', () => {
  const source = Float32Array.from([
      ...triangleA,
      2.1,
      0,
      0,
      3.1,
      0,
      0,
      2.1,
      1,
      0,
    ]),
    candidate = new Float32Array(source);
  for (let at = 9; at < candidate.length; at += 3) candidate[at] -= 0.2;
  assert.equal(
    validateSurfaceClearance(source, candidate, 3.1).reason,
    'new-intersection',
  );
  const apart = Float32Array.from([
      ...triangleA,
      1.1,
      1.1,
      0.1,
      2,
      1.1,
      0.1,
      1.1,
      2,
      0.1,
    ]),
    samePlane = new Float32Array(apart);
  for (let at = 11; at < samePlane.length; at += 3) samePlane[at] = 0;
  assert.equal(validateSurfaceClearance(apart, samePlane, 2).accepted, true);
});

void test('surface clearance retains positive close gaps and excludes preexisting source intersections', () => {
  const parallel = Float32Array.from([
      ...triangleA,
      0.2,
      0.2,
      0.0001,
      1.2,
      0.2,
      0.0001,
      0.2,
      1.2,
      0.0001,
    ]),
    translated = new Float32Array(parallel);
  for (let at = 9; at < translated.length; at += 3) translated[at] += 0.01;
  assert.equal(
    validateSurfaceClearance(parallel, translated, 2).accepted,
    true,
  );
  const intersecting = Float32Array.from([
      ...triangleA,
      0.5,
      0.5,
      -0.1,
      0.5,
      1.5,
      0.1,
      0.5,
      0.5,
      0.2,
    ]),
    stillIntersecting = new Float32Array(intersecting);
  stillIntersecting[11] = -0.05;
  assert.equal(
    validateSurfaceClearance(intersecting, stillIntersecting, 2).accepted,
    true,
  );
});

void test('a tiny positive source gap is not mistaken for preexisting contact', () => {
  const source = Float32Array.from([
      ...triangleA,
      0.5,
      0.5,
      1e-10,
      1.5,
      0.5,
      1e-10,
      0.5,
      1.5,
      1e-10,
    ]),
    candidate = new Float32Array(source);
  candidate[11] = -0.1;
  assert.equal(
    validateSurfaceClearance(source, candidate, 2).reason,
    'new-intersection',
  );
});

void test('surface clearance fails closed for invalid geometry, excessive movement or spatial work', () => {
  assert.equal(
    validateSurfaceClearance(new Float32Array(8), new Float32Array(8), 2)
      .reason,
    'invalid-input',
  );
  const source = Float32Array.from(triangleA),
    far = new Float32Array(source);
  far[2] = 0.3;
  assert.equal(validateSurfaceClearance(source, far, 2).reason, 'motion-limit');
  const broad = new Float32Array(source);
  broad[2] = 0.001;
  assert.equal(
    validateSurfaceClearance(source, broad, 64).reason,
    'spatial-budget',
  );
  assert.equal(validateSurfaceClearance(source, source, 64).accepted, true);
});
