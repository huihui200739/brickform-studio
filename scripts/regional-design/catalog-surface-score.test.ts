import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { IDENTITY, type M3, type V3 } from '../../lib/assembly-catalog.ts';
import type { Brick } from '../../lib/brick-engine.ts';
import {
  loadCatalogGeometry,
  normalizeSourceMesh,
  scoreCatalogSurface,
  type SurfaceScoreInput,
  type SurfaceScore,
} from './catalog-surface-score.ts';

const catalog = loadCatalogGeometry();
const part = (
  id: number,
  name: string,
  position: V3,
  matrix: M3 = IDENTITY,
): Brick => ({
  id,
  part: name,
  x: 0,
  y: 0,
  z: 0,
  w: 1,
  d: 1,
  h: 1,
  color: 7,
  pose: { position, matrix },
});
function scored(result: SurfaceScore) {
  assert.equal(result.status, 'scored', JSON.stringify(result));
  if (result.status !== 'scored') throw Error('unavailable');
  return result;
}
function input(positions: number[], bricks: Brick[]): SurfaceScoreInput {
  return {
    source: { positions, completeOcclusionGeometry: true },
    model: { width: 4, depth: 4, bricks },
    completeCandidateOcclusionGeometry: true,
    views: [[0, 1, 0]],
    catalog,
    sampleSpacingStuds: 0.12,
    maxRayDistanceStuds: 8,
  };
}
function patch(x0: number, x1: number, z0: number, z1: number, y: number) {
  return [x0, y, z0, x0, y, z1, x1, y, z1, x0, y, z0, x1, y, z1, x1, y, z0];
}
/** Independently specified continuous 15068 radius profile, not copied catalog
 * triangles. The strip normals follow each actual analytic source chord. */
function curvedSource() {
  const out: number[] = [];
  const height = (z: number) =>
    -(24.972 - 40.972 * Math.sqrt(1 - (((z - 2) * 20 - 20) / 56.56854) ** 2)) /
    20;
  for (let i = 0; i < 96; i++) {
    const z0 = 1 + i / 48,
      z1 = 1 + (i + 1) / 48;
    out.push(1, height(z0), z0, 1, height(z1), z1, 3, height(z1), z1);
    out.push(1, height(z0), z0, 3, height(z1), z1, 3, height(z0), z0);
  }
  return out;
}
void test('genuine curved catalog exterior beats independently constructed tile staircase', () => {
  const source = curvedSource();
  const curve = scored(
    scoreCatalogSurface(input(source, [part(1, '15068', [0, 0, 0])])),
  );
  // Same 2 x 2 projected footprint, two independent one-stud-depth levels.
  const steps = scored(
    scoreCatalogSurface(
      input(source, [
        part(1, '3069b', [0, -8, -10]),
        part(2, '3069b', [0, -16, 10]),
      ]),
    ),
  );
  assert.ok(curve.sourceToParts.coverage > 0.99);
  assert.ok(curve.symmetricRmsStuds < 0.025, JSON.stringify(curve));
  assert.ok(
    steps.symmetricRmsStuds > curve.symmetricRmsStuds + 0.08,
    JSON.stringify({ curve, steps }),
  );
  assert.ok(curve.sourceToParts.normalAgreement > 0.98);
  const turned = scored(
    scoreCatalogSurface(
      input(source, [
        part(1, '15068', [0, 0, 0], [-1, 0, 0, 0, 1, 0, 0, 0, -1]),
      ]),
    ),
  );
  assert.ok(turned.symmetricRmsStuds > curve.symmetricRmsStuds + 0.1);
});
void test('missing patch cannot win by matching only one part of a complete source', () => {
  const source = patch(1, 3, 1, 3, 0.4);
  const full = scored(
    scoreCatalogSurface(input(source, [part(1, '3068b', [0, -8, 0])])),
  );
  const missing = scored(
    scoreCatalogSurface(input(source, [part(1, '3069b', [0, -8, -10])])),
  );
  assert.ok(full.symmetricRmsStuds < 1e-7);
  assert.ok(missing.sourceToParts.coverage < 0.55);
  assert.ok(missing.symmetricRmsStuds > 3);
  assert.ok(missing.missingOrExtraArea);
});
void test('extra visible geometry is penalized even when all source samples fit', () => {
  const source = patch(1, 3, 1, 3, 0.4);
  const extra = scored(
    scoreCatalogSurface(
      input(source, [
        part(1, '3068b', [0, -8, 0]),
        part(2, '3070b', [40, -8, 0]),
      ]),
    ),
  );
  assert.equal(extra.sourceToParts.coverage, 1);
  assert.ok(extra.partsToSource.coverage < 0.9);
  assert.ok(extra.partsToSource.unmatchedAreaStudsSquared > 0.9);
  assert.ok(extra.symmetricRmsStuds > 2);
});
void test('a buried exact-match tile never supplies the final exterior fit', () => {
  const source = patch(1, 3, 1, 3, 0.4);
  const hidden = scored(
    scoreCatalogSurface(
      input(source, [
        part(1, '3068b', [0, -8, 0]),
        part(2, '3068b', [0, -16, 0]),
      ]),
    ),
  );
  assert.ok(
    Math.abs(hidden.sourceToParts.rmsStuds - 0.4) < 1e-8,
    JSON.stringify(hidden),
  );
  assert.ok(Math.abs(hidden.partsToSource.rmsStuds - 0.4) < 1e-8);
  // Only the upper surface contributes reverse area; hidden lower triangles do not.
  assert.ok(Math.abs(hidden.partsToSource.visibleAreaStudsSquared - 4) < 1e-7);
});
void test('poses and model normalization affect fit; invalid or absent poses are unavailable', () => {
  const source = patch(1, 3, 1, 3, 0.4),
    layout = [part(1, '3068b', [0, -8, 0])];
  assert.ok(
    scored(scoreCatalogSurface(input(source, layout))).symmetricMaxStuds < 1e-7,
  );
  const translated = scored(
    scoreCatalogSurface(input(source, [part(1, '3068b', [0, -12, 0])])),
  );
  assert.ok(Math.abs(translated.symmetricRmsStuds - 0.2) < 1e-8);
  const changedWidth = input(source, layout);
  changedWidth.model.width = 6;
  assert.ok(scored(scoreCatalogSurface(changedWidth)).symmetricRmsStuds > 1);
  const reflected = input(source, [
    part(1, '3068b', [0, -8, 0], [-1, 0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  assert.equal(scoreCatalogSurface(reflected).status, 'unavailable');
  const absent = input(source, [{ ...layout[0], pose: undefined }]);
  assert.equal(scoreCatalogSurface(absent).status, 'unavailable');
});
void test('coverage and finite work budgets are explicit; all inputs are immutable', () => {
  const fixture = input(curvedSource(), [part(1, '15068', [0, 0, 0])]);
  const snapshot = JSON.stringify(fixture);
  const a = scoreCatalogSurface(fixture),
    b = scoreCatalogSurface(fixture);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(fixture), snapshot);
  assert.equal(
    scoreCatalogSurface({
      ...fixture,
      source: { ...fixture.source, completeOcclusionGeometry: false },
    }).status,
    'unavailable',
  );
  assert.equal(
    scoreCatalogSurface({ ...fixture, limits: { samples: 1 } }).status,
    'unavailable',
  );
  assert.equal(
    scoreCatalogSurface({ ...fixture, limits: { rayTriangleTests: 1 } }).status,
    'unavailable',
  );
  assert.equal(
    scoreCatalogSurface({ ...fixture, limits: { triangles: 1 } }).status,
    'unavailable',
  );
  assert.equal(
    scoreCatalogSurface({ ...fixture, limits: { samples: 100001 } }).status,
    'unavailable',
  );
  assert.equal(
    scoreCatalogSurface({ ...fixture, maxRayDistanceStuds: 0.1 }).status,
    'unavailable',
  );
  const invalidFace = {
    ...fixture,
    source: { ...fixture.source, faceIds: [100000] },
  };
  assert.equal(scoreCatalogSurface(invalidFace).status, 'unavailable');
  const unknownPart = input(patch(1, 3, 1, 3, 0.4), [
    part(1, 'unavailable', [0, 0, 0]),
  ]);
  assert.equal(scoreCatalogSurface(unknownPart).status, 'unavailable');
  const original = new Float32Array([1, 2, 3, 2, 3, 4]);
  assert.deepEqual(
    [...normalizeSourceMesh(original, [1, 1, 1], 2)],
    [1, 2.8, 5, 3, 4.8, 7],
  );
  assert.deepEqual([...original], [1, 2, 3, 2, 3, 4]);
});

void test('conservative projection culling preserves full-scene metrics and never removes a distant occluder', () => {
  const base = input(patch(1, 3, 1, 3, 0.4), [part(1, '3068b', [0, -8, 0])]);
  base.contextBricks = [part(2, '3068b', [1000, -8, 0])];
  base.maxRayDistanceStuds = 100;
  const full = scored(scoreCatalogSurface(base));
  const culled = scored(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }),
  );
  assert.deepEqual(culled.sourceToParts, full.sourceToParts);
  assert.deepEqual(culled.partsToSource, full.partsToSource);
  assert.deepEqual(culled.contextCulling, {
    inputParts: 1,
    retainedParts: 0,
    inputSourceTriangles: 2,
    retainedSourceTriangles: 2,
  });
  base.contextBricks = [part(2, '3068b', [0, -1000, 0])];
  const distant = scored(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }),
  );
  assert.deepEqual(distant.contextCulling, {
    inputParts: 1,
    retainedParts: 1,
    inputSourceTriangles: 2,
    retainedSourceTriangles: 2,
  });
  assert.ok(distant.sourceToParts.coverage < 0.1);
  assert.equal(distant.partsToSource.visibleSamples, 0);
});
void test('a context part that can occlude any supplied view remains, regardless of nominal coordinates', () => {
  const base = input(patch(1, 3, 1, 3, 0.4), [part(1, '3068b', [0, -8, 0])]);
  base.views = [
    [0, 1, 0],
    [1, 0, 0],
  ];
  base.maxRayDistanceStuds = 100;
  base.contextBricks = [
    { ...part(2, '3068b', [1000, -8, 0]), x: -500, z: -500 },
  ];
  const result = scored(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }),
  );
  assert.deepEqual(result.contextCulling, {
    inputParts: 1,
    retainedParts: 1,
    inputSourceTriangles: 2,
    retainedSourceTriangles: 2,
  });
  base.contextBricks = [
    { ...part(2, '3068b', [1000, -8, 0]), pose: undefined },
  ];
  assert.equal(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }).status,
    'unavailable',
  );
  base.contextBricks = [part(2, 'missing-geometry', [1000, -8, 0])];
  assert.equal(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }).status,
    'unavailable',
  );
});
void test('explicit source-projection scope does not penalize preserved parts outside the target and remains visibly limited', () => {
  const base = input(patch(1, 2, 1, 2, 0.4), [part(1, '3068b', [0, -8, 0])]);
  const full = scored(scoreCatalogSurface(base));
  assert.equal(full.missingOrExtraArea, true);
  const scoped = scored(
    scoreCatalogSurface({
      ...base,
      partScoringFootprint: 'owned-source-projection',
    }),
  );
  assert.equal(scoped.scope, 'sampled-owned-projection-only');
  assert.ok(scoped.symmetricRmsStuds < 1e-8);
  assert.ok(scoped.sourceToParts.coverage > 0.99);
  // Scope cannot hide a protrusion in front of the actual owned projected region.
  base.model.bricks.push(part(2, '3070b', [-10, -16, -10]));
  const extra = scored(
    scoreCatalogSurface({
      ...base,
      partScoringFootprint: 'owned-source-projection',
    }),
  );
  assert.ok(extra.symmetricRmsStuds > 0.1);
});

void test('final-scene comparison includes retained target surfaces, but still penalizes missing or wrong-depth geometry', () => {
  const base = input(patch(1, 3, 1, 3, 0.4), [part(1, '3069b', [0, -8, -10])]);
  base.contextBricks = [part(2, '3069b', [0, -8, 10])];
  base.comparison = 'final-scene-owned-projection';
  base.partScoringFootprint = 'owned-source-projection';
  const complete = scored(scoreCatalogSurface(base));
  assert.equal(complete.scope, 'sampled-final-scene-owned-projection-only');
  assert.equal(complete.sourceToParts.coverage, 1);
  assert.ok(complete.symmetricRmsStuds < 1e-8);
  assert.ok(
    Math.abs(complete.partsToSource.visibleAreaStudsSquared - 4) < 1e-8,
  );
  const missing = scored(scoreCatalogSurface({ ...base, contextBricks: [] }));
  assert.ok(missing.sourceToParts.coverage < 0.55);
  assert.ok(missing.symmetricRmsStuds > 3);
  const displaced = scored(
    scoreCatalogSurface({
      ...base,
      contextBricks: [part(2, '3069b', [0, -28, 10])],
    }),
  );
  assert.equal(displaced.sourceToParts.coverage, 1);
  assert.ok(displaced.symmetricRmsStuds > 0.65);
  assert.equal(
    scoreCatalogSurface({ ...base, partScoringFootprint: undefined }).status,
    'unavailable',
  );
});

void test('a hidden owned source cannot authorize scoring the exterior of another original object', () => {
  const source = [...patch(1, 3, 1, 3, 0.4), ...patch(2, 3, 1, 3, 1.4)];
  const base = input(source, [
    part(1, '3069b', [-10, -8, 0], [0, 0, 1, 0, 1, 0, -1, 0, 0]),
  ]);
  base.source.faceIds = [0, 1];
  base.contextBricks = [
    part(2, '3069b', [10, -28, 0], [0, 0, 1, 0, 1, 0, -1, 0, 0]),
  ];
  base.comparison = 'final-scene-owned-projection';
  base.partScoringFootprint = 'owned-source-projection';
  const result = scored(scoreCatalogSurface(base));
  assert.ok(result.symmetricRmsStuds < 1e-8);
  assert.ok(Math.abs(result.sourceToParts.visibleAreaStudsSquared - 2) < 0.1);
  assert.ok(Math.abs(result.partsToSource.visibleAreaStudsSquared - 2) < 1e-8);
});

void test('lateral source culling preserves exact metrics, bounded work and complete input validation', () => {
  const source = patch(1, 3, 1, 3, 0.4);
  for (let i = 0; i < 1000; i++) source.push(...patch(100, 102, 100, 102, 0.4));
  const base = input(source, [part(1, '3068b', [0, -8, 0])]);
  base.source.faceIds = [0, 1];
  const full = scored(scoreCatalogSurface(base));
  const culled = scored(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }),
  );
  assert.deepEqual(culled.sourceToParts, full.sourceToParts);
  assert.deepEqual(culled.partsToSource, full.partsToSource);
  assert.equal(culled.contextCulling?.inputSourceTriangles, 2002);
  assert.equal(culled.contextCulling?.retainedSourceTriangles, 2);
  const limits = { triangles: catalog['3068b'].positions.length / 9 + 2 };
  assert.equal(scoreCatalogSurface({ ...base, limits }).status, 'unavailable');
  assert.equal(
    scoreCatalogSurface({ ...base, limits, cullDisjointContext: true }).status,
    'scored',
  );
  source[source.length - 1] = NaN;
  assert.equal(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }).status,
    'unavailable',
  );
});

void test('triangle-level lateral context culling keeps the full visible final-scene metrics under a tighter geometry budget', () => {
  const base = input(patch(1, 3, 1, 3, 0.4), [part(1, '3068b', [0, -8, 0])]);
  base.contextBricks = [part(2, '3001', [0, -48, 20])];
  base.comparison = 'final-scene-owned-projection';
  base.partScoringFootprint = 'owned-source-projection';
  const full = scored(scoreCatalogSurface(base));
  const cropped = scored(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }),
  );
  assert.deepEqual(cropped.sourceToParts, full.sourceToParts);
  assert.deepEqual(cropped.partsToSource, full.partsToSource);
  const triangles =
    2 +
    catalog['3068b'].positions.length / 9 +
    catalog['3001'].positions.length / 9 -
    1;
  assert.equal(
    scoreCatalogSurface({ ...base, limits: { triangles } }).status,
    'unavailable',
  );
  assert.equal(
    scoreCatalogSurface({
      ...base,
      limits: { triangles },
      cullDisjointContext: true,
    }).status,
    'scored',
  );
});

void test('disconnected owned patches exclude irrelevant gap surfaces from sampling without changing visible errors', () => {
  const base = input(
    [...patch(1, 2, 1, 2, 0.4), ...patch(4, 5, 1, 2, 0.4)],
    [part(1, '3070b', [-10, -8, -10]), part(2, '3070b', [50, -8, -10])],
  );
  // Real catalog tile surfaces occupy the gap between the owned patches.
  // They are still scene occluders, but do not lie in the owned projection.
  base.contextBricks = Array.from({ length: 16 }, (_, i) =>
    part(3 + i, '3070b', [20, -8 - i * 8, -10]),
  );
  base.comparison = 'final-scene-owned-projection';
  base.partScoringFootprint = 'owned-source-projection';
  const full = scored(scoreCatalogSurface(base));
  const cropped = scored(
    scoreCatalogSurface({ ...base, cullDisjointContext: true }),
  );
  assert.deepEqual(cropped.sourceToParts, full.sourceToParts);
  assert.deepEqual(cropped.partsToSource, full.partsToSource);
  assert.ok(cropped.samples < full.samples / 2);
  const limits = { samples: cropped.samples };
  assert.equal(scoreCatalogSurface({ ...base, limits }).status, 'unavailable');
  assert.equal(
    scoreCatalogSurface({ ...base, limits, cullDisjointContext: true }).status,
    'scored',
  );
});
