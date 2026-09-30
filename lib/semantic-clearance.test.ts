import test from 'node:test';
import assert from 'node:assert/strict';
import { brazierClearances } from './semantic-clearance.ts';
import { insideRegion, type ComponentRegion } from './semantic-components.ts';

const niche: ComponentRegion = {
  id: 'niche', kind: 'statue', anchor: [0.5, 0.4, 0.4],
  width: 6, depth: 5, height: 23, rotation: 2,
  anchorResult: {
    elementId: 'niche', imageAnchor: { x: 0.5, y: 0.4 }, worldAnchor: { x: 25, y: 42, z: 21 },
    surface: { detected: true, normal: [0, 1, 0], supportBrickIds: [] },
    depthConfidence: 0.9, attached: true, failureReasons: [],
    clearanceVolume: { min: [20, 42, 18], max: [30, 75, 49] }, clearanceAxis: 2,
  },
};
const flame: ComponentRegion = {
  id: 'flame', kind: 'brazier', anchor: [31 / 48, 45 / 91, 26 / 48],
  sourceAnchor: [31 / 48, 45 / 91, 25 / 48],
  autoRefinement: true, width: 4, depth: 4, height: 18, rotation: 0,
  sceneElement: { id: 'flame', category: 'brazier', confidence: 0.95,
    imageBox: { x: 0.62, y: 0.4, width: 0.025, height: 0.04 } },
  anchorResult: {
    elementId: 'flame', imageAnchor: { x: 0.63, y: 0.44 }, worldAnchor: { x: 32, y: 47, z: 27 },
    surface: { detected: true, normal: [0.4, 0.2, 0.85], supportBrickIds: [1] },
    depthConfidence: 0.9, attached: true, failureReasons: [],
  },
};

test('foreground flame clearance covers the original residual and prevents a new tall backing post', () => {
  const [box] = brazierClearances([niche, flame], [48, 91, 48]);
  assert.ok(insideRegion([31, 60, 24], box), 'the old flame backing is cleared');
  assert.ok(insideRegion([30, 70, 24], box), 'new lintel support columns are prohibited too');
  assert.equal(insideRegion([31, 60, 22], box), false, 'the rear facade is retained');
  assert.equal(insideRegion([31, 46, 26], box), false, 'the mounting platform is retained');
  assert.equal(insideRegion([36, 60, 24], box), false, 'other facade columns are retained');
});

test('unrelated, manual and uncertain flames cannot erase architecture', () => {
  assert.deepEqual(brazierClearances([flame], [48, 91, 48]), []);
  assert.deepEqual(brazierClearances([niche, { ...flame, autoRefinement: false }], [48, 91, 48]), []);
  assert.deepEqual(brazierClearances([niche, { ...flame, anchorResult: { ...flame.anchorResult!, depthConfidence: 0.2 } }], [48, 91, 48]), []);
  assert.deepEqual(brazierClearances([niche, { ...flame, sourceAnchor: [0.9, 0.4, 0.5] }], [48, 91, 48]), []);
});
