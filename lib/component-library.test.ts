import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackRepresentation,
  retrieveComponent,
  COMPONENT_LIBRARY,
  type SceneElement,
} from './component-library.ts';
import { instanceId, repeatedGroups } from './scene-elements.ts';

test('component retrieval selects registered templates instead of object-specific branches', () => {
  const element: SceneElement = {
    id: 'tree-1',
    category: 'tree',
    confidence: 0.9,
    scaleHint: { width: 8, depth: 8, height: 16 },
  };
  const match = retrieveComponent(element);
  assert.equal(match?.template.id, 'tree-basic');
  assert.equal(fallbackRepresentation(element, match), 'component');
});
test('low confidence elements use the generic fallback ladder', () => {
  const statue: SceneElement = { id: 's', category: 'statue', confidence: 0.2 };
  const match = retrieveComponent(statue);
  assert.equal(match?.template.id, 'statue-simplified');
  // A relief template is only executable when the detector supplied a mask;
  // without one the safe fallback is the original voxel geometry.
  assert.equal(fallbackRepresentation(statue, { ...match!, score: 0.4 }), 'voxel');
  assert.ok(COMPONENT_LIBRARY.some((t) => t.category === 'brazier'));
});
test('same-category detections remain independent instances and form a repeat group', () => {
  const trees: SceneElement[] = [0.1, 0.3, 0.5, 0.7].map((x) => ({
    id: instanceId('tree', { x, y: 0.5, width: 0.05, height: 0.1 }),
    category: 'tree' as const,
    confidence: 0.9,
    imageBox: { x, y: 0.5, width: 0.05, height: 0.1 },
    anchorUV: [x + 0.025, 0.6] as [number, number],
  }));
  const group = repeatedGroups(trees);
  assert.equal(new Set(trees.map((t) => t.id)).size, 4);
  assert.equal(group.length, 1);
  assert.deepEqual(group[0].members, trees.map((t) => t.id).sort());
  assert.ok(trees.every((t) => t.groupId === group[0].id));
  assert.equal(group[0].styleLocked, true);
});
