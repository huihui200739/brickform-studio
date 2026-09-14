import test from 'node:test';
import assert from 'node:assert/strict';
import {
  placementCandidates,
  placementDelta,
  mountingPoint,
  reportPlacement,
} from './placement-policy.ts';
import {
  COMPONENT_SIZES,
  type ComponentRegion,
} from './semantic-components.ts';
import type { V3 } from './assembly-catalog.ts';
const grid: V3 = [48, 75, 48];
const region: ComponentRegion = {
  id: 'tree',
  kind: 'tree',
  anchor: [0.25, 0.2, 0.7],
  ...COMPONENT_SIZES.tree,
  rotation: 0,
  placed: true,
};
void test('candidate movements stay bounded in real stud and plate coordinates at multiple resolutions', () => {
  for (const g of [[20, 35, 20], grid, [96, 150, 64]] as V3[]) {
    const candidates = placementCandidates(
      { ...region, fallbackAnchors: [[0.8, 0.9, 0.1]] },
      g,
    );
    assert.ok(candidates.length > 1);
    assert.deepEqual(mountingPoint(candidates[0], g), mountingPoint(region, g));
    for (const candidate of candidates) {
      const [x, y, z] = placementDelta(candidate, g);
      assert.ok(Math.hypot(x, z) <= 1);
      assert.ok(Math.abs(y) <= 1);
    }
  }
});
void test('repeated preview/conversion cannot turn one-stud corrections into drifting placements', () => {
  const first = placementCandidates(region, grid);
  const expected = first.map((r) => mountingPoint(r, grid).join(',')).sort();
  for (const accepted of first) {
    let current = accepted;
    for (let retry = 0; retry < 4; retry++) {
      const next = placementCandidates(current, grid);
      assert.deepEqual(
        next.map((r) => mountingPoint(r, grid).join(',')).sort(),
        expected,
      );
      assert.deepEqual(next[0].referenceAnchor, region.anchor);
      current = next[next.length - 1];
    }
  }
});
void test('manual position lock prevents both horizontal and vertical search', () => {
  const candidates = placementCandidates(
    { ...region, positionLocked: true },
    grid,
  );
  assert.equal(candidates.length, 1);
  assert.deepEqual(
    mountingPoint(candidates[0], grid),
    mountingPoint(region, grid),
  );
  assert.equal(
    reportPlacement(region, candidates[0], grid, '树').status,
    'kept',
  );
});
void test('failure reports distinguish a pending user point from an exhausted search', () => {
  assert.equal(
    reportPlacement({ ...region, placed: false }, undefined, grid, '树', true)
      .status,
    'unpositioned',
  );
  assert.equal(
    reportPlacement(region, undefined, grid, '树', true).status,
    'budget',
  );
  assert.equal(
    reportPlacement(region, undefined, grid, '树').status,
    'conflict',
  );
});
