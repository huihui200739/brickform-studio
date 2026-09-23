import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceGroupConsistency } from './element-grouping.ts';
import type { ComponentRegion } from './semantic-components.ts';

function tree(id: string, x: number, templateId: string): ComponentRegion {
  return {
    id,
    kind: 'tree',
    anchor: [x, 0.2, 0.5],
    imageUV: [x, 0.5],
    width: 8,
    depth: 8,
    height: 16,
    rotation: 0,
    templateId,
    representation: templateId === 'tree-basic' ? 'component' : 'semantic-template',
    templateCandidates: ['tree-basic', 'tree-small-round'],
    sceneElement: {
      id,
      category: 'tree',
      confidence: 0.8,
      imageBox: { x, y: 0.4, width: 0.08, height: 0.2 },
      anchorUV: [x, 0.5],
    },
  };
}

test('repeated tree group propagates one executable template style', () => {
  const regions = [tree('tree-a', 0.2, 'tree-basic'), tree('tree-b', 0.5, 'tree-small-round'), tree('tree-c', 0.8, 'tree-basic')];
  const result = enforceGroupConsistency(regions);
  assert.equal(result.groups.length, 1);
  assert.equal(result.groups[0].styleLock, true);
  assert.deepEqual(regions.map((region) => region.templateId), ['tree-basic', 'tree-basic', 'tree-basic']);
  assert.ok(result.changed.includes('tree-b'));
  assert.ok(regions.every((region) => region.sceneElement?.groupId === result.groups[0].id));
});
