import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  selectAxisRegions,
  type AxisRegionInput,
  type AxisRegionResult,
} from './axis-regions.ts';

type Point = [number, number, number];
function quad(a: Point, b: Point, c: Point, d: Point) {
  return [...a, ...b, ...c, ...a, ...c, ...d];
}
function xy(x: number, y: number, width: number, height: number, z = 0) {
  return quad(
    [x, y, z],
    [x + width, y, z],
    [x + width, y + height, z],
    [x, y + height, z],
  );
}
function input(positions: number[]): AxisRegionInput {
  return {
    source: { positions: Float64Array.from(positions), complete: true },
  };
}
function enumerated(result: AxisRegionResult) {
  if (result.status === 'unavailable') assert.fail(result.reasons.join(', '));
  return result;
}

void test('a connected ring keeps all source faces and its hole is absent from projected area', () => {
  const positions: number[] = [];
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++)
      if (x !== 1 || y !== 1) positions.push(...xy(x, y, 1, 1));
  const result = enumerated(selectAxisRegions(input(positions)));
  assert.equal(result.status, 'selected');
  assert.equal(result.completeEnumeration, true);
  assert.equal(result.regions.length, 1);
  const region = result.regions[0];
  assert.equal(region.status, 'usable');
  assert.deepEqual(
    region.sourceFaceIds,
    Array.from({ length: 16 }, (_, id) => id),
  );
  assert.equal(region.axis, 2);
  assert.equal(region.direction, 1);
  assert.equal(region.area, 8);
  assert.equal(region.projectedArea, 8);
  assert.deepEqual(region.projectionBounds, {
    axes: [0, 1],
    min: [0, 0],
    max: [3, 3],
    span: [3, 3],
    cellSpan: [1, 0.4],
    cellArea: 0.4,
  });
  assert.equal(result.sourceTruthVerified, false);
});

void test('a manifold folded corner separates its axis regions and retains a steep rejected face', () => {
  const result = enumerated(
    selectAxisRegions(
      input([
        ...xy(0, 0, 2, 2, 2),
        ...quad([2, 0, 0], [2, 2, 0], [2, 2, 2], [2, 0, 2]),
        4,
        0,
        0,
        6,
        0,
        0.5,
        4,
        2,
        0,
      ]),
    ),
  );
  assert.equal(result.regions.length, 3);
  assert.deepEqual(
    result.regions.map((r) => [r.axis, r.direction, r.status]),
    [
      [2, 1, 'usable'],
      [0, 1, 'usable'],
      [2, 1, 'rejected'],
    ],
  );
  assert.deepEqual(
    result.regions.map((r) => r.sourceFaceIds),
    [[0, 1], [2, 3], [4]],
  );
  assert.ok(result.regions[2].reasons.includes('source_face_cos_below_0.98'));
  assert.ok(result.regions[2].minCos < 0.98);
  assert.ok(
    result.regions.every(
      (r) => !r.reasons.includes('same_direction_source_edge'),
    ),
  );
});

void test('opposite signs and arbitrarily thin parallel layers do not merge', () => {
  const reverse = xy(0, 0, 2, 2, 1);
  for (let at = 0; at < reverse.length; at += 9)
    for (let k = 0; k < 3; k++)
      [reverse[at + 3 + k], reverse[at + 6 + k]] = [
        reverse[at + 6 + k],
        reverse[at + 3 + k],
      ];
  const result = enumerated(
    selectAxisRegions(
      input([...xy(0, 0, 2, 2), ...xy(0, 0, 2, 2, 1e-12), ...reverse]),
    ),
  );
  assert.deepEqual(
    result.regions.map((r) => r.sourceFaceIds),
    [
      [0, 1],
      [2, 3],
      [4, 5],
    ],
  );
  assert.deepEqual(
    result.regions.map((r) => r.direction),
    [1, 1, -1],
  );
  assert.ok(result.regions.every((r) => r.status === 'usable'));
});

void test('a third off-axis incident source face makes the shared edge nonmanifold', () => {
  const result = enumerated(
    selectAxisRegions(input([...xy(0, 0, 2, 2), 0, 0, 0, 2, 2, 0, 1, 1, 1])),
  );
  assert.equal(result.regions.length, 3);
  assert.deepEqual(
    result.regions.map((r) => r.sourceFaceIds),
    [[0], [1], [2]],
  );
  assert.ok(result.regions.every((r) => r.status === 'rejected'));
  assert.ok(
    result.regions.every((r) => r.reasons.includes('non_manifold_source_edge')),
  );
  assert.ok(result.regions[2].reasons.includes('source_face_cos_below_0.98'));
});

void test('same-direction shared edges never merge even when both normals face the same axis', () => {
  const result = enumerated(
    selectAxisRegions(
      input([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0]),
    ),
  );
  assert.deepEqual(
    result.regions.map((r) => r.sourceFaceIds),
    [[0], [1]],
  );
  assert.ok(result.regions.every((r) => r.axis === 2 && r.direction === 1));
  assert.ok(
    result.regions.every((r) =>
      r.reasons.includes('same_direction_source_edge'),
    ),
  );
  assert.ok(result.regions.every((r) => r.status === 'rejected'));
});

void test('nearly matching coordinates and point-only contact are never welded', () => {
  const result = enumerated(
    selectAxisRegions(
      input([
        ...xy(0, 0, 2, 2),
        ...xy(2 + 1e-12, 0, 2, 2),
        ...xy(-2, -2, 2, 2),
      ]),
    ),
  );
  assert.equal(result.regions.length, 3);
  assert.deepEqual(
    result.regions.map((r) => r.sourceFaceIds),
    [
      [0, 1],
      [2, 3],
      [4, 5],
    ],
  );
  assert.ok(result.regions.every((r) => r.status === 'usable'));
});

void test('whole-cell area/span bounds use physical Y steps and retain small components', () => {
  const areaOnly = enumerated(
    selectAxisRegions(input([0, 0, 0, 1, 0, 0, 0, 0.4, 0])),
  ).regions[0];
  assert.equal(areaOnly.projectedArea, 0.2);
  assert.ok(areaOnly.reasons.includes('projected_area_below_cell'));
  assert.ok(!areaOnly.reasons.includes('projected_span_below_cell'));
  assert.deepEqual(areaOnly.sourceFaceIds, [0]);
  const narrow = enumerated(selectAxisRegions(input(xy(0, 0, 0.5, 2))))
    .regions[0];
  assert.equal(narrow.projectedArea, 1);
  assert.ok(narrow.reasons.includes('projected_span_below_cell'));
  assert.ok(!narrow.reasons.includes('projected_area_below_cell'));
  const y = enumerated(
    selectAxisRegions(input(quad([0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]))),
  ).regions[0];
  assert.equal(y.axis, 1);
  assert.equal(y.status, 'usable');
  assert.deepEqual(y.projectionBounds?.cellSpan, [1, 1]);
  assert.equal(y.projectionBounds?.cellArea, 1);
  const x = enumerated(
    selectAxisRegions(
      input(quad([0, 0, 0], [0, 0.4, 0], [0, 0.4, 1], [0, 0, 1])),
    ),
  ).regions[0];
  assert.equal(x.axis, 0);
  assert.equal(x.status, 'usable');
  assert.deepEqual(x.projectionBounds?.cellSpan, [0.4, 1]);
  assert.equal(x.projectionBounds?.cellArea, 0.4);
  const joined = enumerated(
    selectAxisRegions(input([...xy(0, 0, 2, 0.1), ...xy(0, 0.1, 2, 1.9)])),
  ).regions[0];
  assert.equal(joined.status, 'usable');
  assert.deepEqual(joined.sourceFaceIds, [0, 1, 2, 3]);
  const degenerate = enumerated(
    selectAxisRegions(input([0, 0, 0, 1, 0, 0, 2, 0, 0])),
  ).regions[0];
  assert.equal(degenerate.axis, null);
  assert.equal(degenerate.projectedArea, null);
  assert.equal(degenerate.status, 'rejected');
  assert.deepEqual(degenerate.sourceFaceIds, [0]);
  assert.ok(degenerate.reasons.includes('degenerate_source_face'));
});

void test('region face and usable region limits return all components with explicit unresolved reasons', () => {
  const large = enumerated(
    selectAxisRegions({
      ...input(xy(0, 0, 2, 2)),
      limits: { facesPerRegion: 1 },
    }),
  );
  assert.equal(large.status, 'unresolved');
  assert.equal(large.completeEnumeration, true);
  assert.deepEqual(large.regions[0].sourceFaceIds, [0, 1]);
  assert.equal(large.regions[0].status, 'unresolved');
  assert.ok(large.reasons.includes('region_face_limit_exceeded'));
  const many = enumerated(
    selectAxisRegions({
      ...input([...xy(0, 0, 2, 2), ...xy(4, 0, 2, 2)]),
      limits: { usableRegions: 1 },
    }),
  );
  assert.equal(many.status, 'unresolved');
  assert.equal(many.regions.length, 2);
  assert.deepEqual(
    many.regions.map((r) => r.sourceFaceIds),
    [
      [0, 1],
      [2, 3],
    ],
  );
  assert.ok(
    many.regions.every(
      (r) =>
        r.status === 'unresolved' &&
        r.reasons.includes('usable_region_limit_exceeded'),
    ),
  );
  assert.equal(many.stats.usableRegions, 0);
  assert.equal(many.stats.unresolvedRegions, 2);
  const sourceCap = enumerated(
    selectAxisRegions({ ...input(xy(0, 0, 2, 2)), limits: { faces: 1 } }),
  );
  assert.equal(sourceCap.status, 'unresolved');
  assert.equal(sourceCap.completeEnumeration, false);
  assert.equal(sourceCap.stats.sourceFaces, 2);
  assert.deepEqual(sourceCap.regions, []);
  assert.deepEqual(sourceCap.reasons, ['source_face_limit_exceeded']);
});

void test('incomplete, malformed, nonfinite and invalid-budget input never returns partial regions', () => {
  const valid = input(xy(0, 0, 2, 2));
  for (const invalid of [
    { ...valid, source: { ...valid.source, complete: false } },
    input([]),
    input([0, 0, 0]),
    input([NaN, 0, 0, 1, 0, 0, 0, 1, 0]),
    input([0, 0, 0, Infinity, 0, 0, 0, 1, 0]),
    { ...valid, limits: { facesPerRegion: 4097 } },
    { ...valid, limits: { usableRegions: 65 } },
    { ...valid, limits: { faces: 0 } },
  ]) {
    const result = selectAxisRegions(invalid);
    assert.equal(result.status, 'unavailable');
    assert.equal('regions' in result, false);
  }
});

void test('repeated enumeration is deterministic and never mutates original positions or input', () => {
  const original = input([...xy(0, 0, 2, 2), ...xy(0, 0, 2, 2, 1e-12)]);
  const before = JSON.stringify(original);
  const result = selectAxisRegions(original);
  assert.deepEqual(selectAxisRegions(original), result);
  assert.equal(JSON.stringify(original), before);
});
