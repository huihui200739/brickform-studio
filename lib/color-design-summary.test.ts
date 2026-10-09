import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { colorDesignSummary } from './color-design-summary.ts';
import type { ColorDesign } from './clean-design-colors.ts';

function design(overrides: Partial<ColorDesign> = {}): ColorDesign {
  return {
    method: 'source-aware-planar-colour-cleanup', mode: 'coherent', approximation: true,
    changedBricks: 13, eligibleBricks: 15, planarPatches: 14,
    protectedBricks: 1970, catalogBlocked: 0,
    beforeColorCounts: [], afterColorCounts: [], changes: [], limitations: [],
    ...overrides,
  };
}

void test('coherent summary separates actual changes, scalar evidence and manual approximations from unresolved colours', () => {
  const source = design({ uncertainBricks: 2861, materialMetrics: {
    domainInconsistentAreaBefore: 0, domainInconsistentAreaAfter: 0,
    scalarShadowMismatchAreaBefore: 0, scalarShadowMismatchAreaAfter: 0,
    protectedObservedMaterialChangedArea: 0,
    scalarDesignBricks: 0, localApproximationBricks: 13,
  } });
  const before = structuredClone(source), result = colorDesignSummary(source);
  assert.match(result.heading, /已调整 13 块/);
  assert.match(result.details, /源标量阴影整理 0 块.*人工局部材料近似 13 块/);
  assert.match(result.uncertainty!, /2861 块.*保留原色待核对.*并非所有阴影与杂色都已解决/);
  assert.deepEqual(source, before);
});

void test('zero changes is insufficient evidence, not absence of shadows or warm-only eligibility', () => {
  const result = colorDesignSummary(design({ changedBricks: 0, uncertainBricks: 28 }));
  assert.match(result.heading, /未发现有足够来源证据/);
  assert.doesNotMatch(result.heading, /主体暖色|已修复|全部/);
  assert.match(result.uncertainty!, /28 块/);
});

void test('legacy and clean summaries do not invent missing uncertainty metrics or catalog completion', () => {
  for (const mode of ['clean', 'coherent'] as const) {
    const result = colorDesignSummary(design({ mode, changedBricks: 0, catalogBlocked: 2 }));
    assert.equal(result.uncertainty, undefined);
    assert.doesNotMatch(result.details, /源标量阴影整理/);
    assert.match(result.details, /2 块因目录颜色限制保留原色/);
  }
  assert.equal(colorDesignSummary(design({ uncertainBricks: 0 })).uncertainty, undefined);
});
