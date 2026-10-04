import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { TriangleMesh } from '../../lib/mesh-types.ts';
import {
  collectSourceDepth,
  type MeshSurfaceOwnershipNormalization,
  type SourceDepthInput,
  type SourceDepthResult,
} from './source-depth.ts';

type P = [number, number, number];
function box(lo: P, hi: P) {
  const [x, y, z] = lo,
    [X, Y, Z] = hi,
    out: number[] = [];
  const quad = (a: P, b: P, c: P, d: P) =>
    out.push(...a, ...b, ...c, ...a, ...c, ...d);
  quad([x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]); // -X
  quad([X, y, z], [X, Y, z], [X, Y, Z], [X, y, Z]); // +X
  quad([x, y, z], [X, y, z], [X, y, Z], [x, y, Z]); // -Y
  quad([x, Y, z], [x, Y, Z], [X, Y, Z], [X, Y, z]); // +Y
  quad([x, y, z], [x, Y, z], [X, Y, z], [X, y, z]); // -Z
  quad([x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]); // +Z
  return out;
}
function fixture(
  positions: number[],
  axis: 0 | 1 | 2 = 0,
  columns: [number, number][] = [[2, 1]],
): SourceDepthInput {
  const source: TriangleMesh = {
    name: 'raw',
    positions: Float32Array.from(positions),
    colors: new Uint8Array(positions.length / 3),
  };
  const min: P = [Infinity, Infinity, Infinity],
    max: P = [-Infinity, -Infinity, -Infinity];
  source.positions.forEach((v, i) => {
    min[i % 3] = Math.min(min[i % 3], v);
    max[i % 3] = Math.max(max[i % 3], v);
  });
  const normalization: MeshSurfaceOwnershipNormalization = {
    min,
    scale: 1,
    gridOffset: [1, 2, 1],
    plateHeight: 0.4,
    gridSize: max.map((v, i) =>
      Math.ceil((v - min[i]) / (i === 1 ? 0.4 : 1)),
    ) as P,
  };
  return { source, normalization, axis, columns };
}
function collected(result: SourceDepthResult) {
  if (result.status !== 'collected') assert.fail(result.reason);
  return result;
}
void test('whole-source ray retains both separated intervals and their gap', () => {
  const input = fixture([
    ...box([0, 0, 0], [1, 1, 1]),
    ...box([2, 0, 0], [3, 1, 1]),
  ]);
  const row = collected(collectSourceDepth(input)).columns[0];
  assert.equal(row.ambiguous, false);
  assert.deepEqual(
    row.intervals.map(({ min, max }) => [min, max]),
    [
      [1, 2],
      [3, 4],
    ],
  );
  assert.equal(row.crossings.length, 4);
  assert.deepEqual(
    row.crossings.map(({ direction }) => direction),
    [-1, 1, -1, 1],
  );
});
void test('equal-depth contributors are unioned without dropping face IDs', () => {
  const positions = box([0, 0, 0], [1, 1, 1]);
  positions.push(...positions.slice(0, 18)); // Duplicate planar entry surface.
  const row = collected(collectSourceDepth(fixture(positions))).columns[0];
  assert.equal(row.ambiguous, false);
  assert.equal(row.crossings[0].faceIds.length, 2);
  assert.deepEqual(row.crossings[0].signs, [-1, -1]);
});
void test('selected face IDs annotate relevance without filtering hidden or outside faces', () => {
  const input = fixture([
    ...box([0, 0, 0], [1, 1, 1]),
    ...box([2, 0, 0], [3, 1, 1]),
  ]);
  const full = collected(collectSourceDepth(input));
  const marked = collected(
    collectSourceDepth({ ...input, selectedSourceFaceIds: [4] }),
  ); // Y face not hit by X ray.
  assert.deepEqual(marked.columns[0].intervals, full.columns[0].intervals);
  assert.equal(
    marked.columns[0].crossings.flatMap((c) => c.selectedFaceIds).length,
    0,
  );
});
void test('Y ray uses plate heights while X/Z use studs and original grid offsets', () => {
  const input = fixture(box([10, 20, 30], [11, 22, 31]), 1, [[1, 1]]);
  const result = collected(collectSourceDepth(input));
  assert.deepEqual(result.columnAxes, [0, 2]);
  assert.deepEqual(
    result.columns[0].intervals.map(({ min, max }) => [min, max]),
    [[2, 7]],
  );
  const x = collected(
    collectSourceDepth({ ...input, axis: 0, columns: [[2, 1]] }),
  );
  assert.deepEqual(
    x.columns[0].intervals.map(({ min, max }) => [min, max]),
    [[1, 2]],
  );
});
void test('overlapping volumes and missing or reversed source faces remain ambiguous', () => {
  const overlapping = fixture([
    ...box([0, 0, 0], [2, 1, 1]),
    ...box([1, 0, 0], [3, 1, 1]),
  ]);
  const overlap = collected(collectSourceDepth(overlapping)).columns[0];
  assert.equal(overlap.ambiguous, true);
  assert.deepEqual(overlap.intervals, []);
  const open = box([0, 0, 0], [1, 1, 1]).slice(18);
  const missing = collected(collectSourceDepth(fixture(open))).columns[0];
  assert.equal(missing.ambiguous, true);
  assert.deepEqual(missing.intervals, []);
  const reverse = box([0, 0, 0], [1, 1, 1]);
  for (let i = 0; i < 18; i += 9)
    for (let a = 0; a < 3; a++)
      [reverse[i + 3 + a], reverse[i + 6 + a]] = [
        reverse[i + 6 + a],
        reverse[i + 3 + a],
      ];
  const reversed = collected(collectSourceDepth(fixture(reverse))).columns[0];
  assert.equal(reversed.ambiguous, true);
  assert.deepEqual(reversed.intervals, []);
});
void test('touching volumes retain opposite equal-depth signs and cannot pair across the contact', () => {
  const row = collected(
    collectSourceDepth(
      fixture([...box([0, 0, 0], [1, 1, 1]), ...box([1, 0, 0], [2, 1, 1])]),
    ),
  ).columns[0];
  assert.equal(row.ambiguous, true);
  assert.deepEqual(row.intervals, []);
  assert.equal(row.crossings[1].direction, 0);
  assert.deepEqual(
    [...row.crossings[1].signs].sort((a, b) => a - b),
    [-1, 1],
  );
  assert.equal(row.crossings[1].faceIds.length, 2);
});
void test('nearly coincident overlapping volumes cannot hide their distinct entries in a tie', () => {
  const input = fixture([
    ...box([0, 0, 0], [1, 100, 100]),
    ...box([1e-7, 0, 0], [1 + 1e-7, 100, 100]),
  ]);
  input.normalization.scale = 0.01;
  input.normalization.gridSize = [1, 3, 1];
  const row = collected(collectSourceDepth(input)).columns[0];
  assert.equal(row.ambiguous, true);
  assert.deepEqual(row.intervals, []);
  assert.equal(row.crossings.length, 4);
  assert.ok(row.reasons.some((r) => r.includes('within depth tolerance')));
});
void test('a source side exactly on the interior query ray is conservatively tangent', () => {
  const positions = box([0, 0, 0], [1, 1, 1]);
  // Plane parallel to X, at the independently specified Y sample coordinate.
  // The frame scale maps the Float32 source value to the jittered plate ray.
  const u = 2 + 0.500013,
    sourceY = (u - 2) * 0.4;
  const y = Float32Array.of(sourceY)[0];
  positions.push(0, y, 0, 1, y, 0, 1, y, 1);
  const tangentInput = fixture(positions);
  // Normalization scale is adjusted so the extra plane lands on the query ray.
  // Preserve min/grid agreement and query columns while hitting the side.
  tangentInput.normalization.scale = sourceY / y;
  tangentInput.normalization.gridSize = [0, 1, 2].map((a) =>
    Math.ceil(tangentInput.normalization.scale / (a === 1 ? 0.4 : 1)),
  ) as P;
  const row = collected(collectSourceDepth(tangentInput)).columns[0];
  assert.equal(row.ambiguous, true);
  assert.deepEqual(row.intervals, []);
  assert.ok(row.reasons.some((r) => r.includes('tangent')));
});
void test('finite workload limits return unavailable without partial results', () => {
  const input = fixture(box([0, 0, 0], [1, 1, 1]));
  for (const limits of [
    { faces: 1 },
    { bboxColumnTests: 1 },
    { rayTriangleTests: 1 },
    { rawCrossings: 1 },
  ]) {
    const result = collectSourceDepth({ ...input, limits });
    assert.equal(result.status, 'unavailable');
    assert.equal('columns' in result, false);
  }
});
void test('raw source/frame validation and repeated calls never mutate inputs', () => {
  const input = fixture(box([0, 0, 0], [1, 1, 1]));
  const snapshot = JSON.stringify(input);
  assert.deepEqual(collectSourceDepth(input), collectSourceDepth(input));
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(
    collectSourceDepth({
      ...input,
      normalization: { ...input.normalization, min: [-1, 0, 0] },
    }).status,
    'unavailable',
  );
  assert.equal(
    collectSourceDepth({
      ...input,
      normalization: { ...input.normalization, gridSize: [2, 3, 1] },
    }).status,
    'unavailable',
  );
  assert.equal(
    collectSourceDepth({ ...input, columns: [[100, 1]] }).status,
    'unavailable',
  );
  assert.equal(
    collectSourceDepth({ ...input, selectedSourceFaceIds: [999] }).status,
    'unavailable',
  );
  const bad = fixture(box([0, 0, 0], [1, 1, 1]));
  bad.source.positions[0] = NaN;
  assert.equal(collectSourceDepth(bad).status, 'unavailable');
});
