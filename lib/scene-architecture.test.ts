import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRepresentationTransaction,
} from './composition/transaction.ts';
import { groupSceneElements } from './scene/scene-grouping.ts';
import { DefaultRepresentationRouter } from './representation/representation-router.ts';
import type { SceneElementInstance } from './scene/scene-types.ts';

test('scene grouping keeps every detected tree as an independent member', () => {
  const elements: SceneElementInstance[] = [0.15, 0.35, 0.65].map((x, index) => ({
    id: `tree-${index + 1}`,
    category: 'tree' as const,
    confidence: 0.9,
    imageBox: { x, y: 0.7, width: 0.08, height: 0.18 },
  }));
  const groups = groupSceneElements(elements);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].members, ['tree-1', 'tree-2', 'tree-3']);
  assert.equal(groups[0].styleLock, true);
  assert.ok(elements.every((element) => element.groupId === groups[0].id));
});

test('representation router returns a plan without mutating the instance', () => {
  const instance = {
    id: 'brazier-1',
    category: 'brazier' as const,
    confidence: 0.92,
  };
  const before = JSON.stringify(instance);
  const plan = new DefaultRepresentationRouter().route(instance);
  assert.equal(plan.elementId, instance.id);
  assert.equal(plan.kind, 'generic-geometry');
  assert.equal(JSON.stringify(instance), before);
});

test('failed representation transactions preserve the original state', () => {
  const state = { cells: ['source'] };
  const result = applyRepresentationTransaction({
    currentState: state,
    plan: 'tree-1',
    cloneCurrentState: (current) => ({ cells: [...current.cells] }),
    removeOriginalRegion: (trial) => {
      trial.cells.length = 0;
    },
    addRepresentation: (trial) => {
      trial.cells.push('component');
    },
    validate: () => ({ acceptable: false, reasons: ['not seated'] }),
  });
  assert.equal(result.committed, false);
  assert.equal(result.originalPreserved, true);
  assert.deepEqual(result.state, state);
  assert.deepEqual(state.cells, ['source']);
});
