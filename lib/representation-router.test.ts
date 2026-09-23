import test from 'node:test';
import assert from 'node:assert/strict';
import { focalPriority } from './focal-priority.ts';
import { routeRepresentation } from './representation-router.ts';
import { retrieveComponentForInstance } from './component-retrieval.ts';

test('primary statue keeps a visible fallback representation', () => {
  const instance = {
    id: 'statue-1',
    category: 'statue' as const,
    confidence: 0.82,
    imageBox: { x: 0.43, y: 0.2, width: 0.12, height: 0.25 },
  };
  const priority = focalPriority(instance);
  assert.equal(priority.importance, 'primary');
  const decision = routeRepresentation(instance, retrieveComponentForInstance(instance));
  assert.equal(decision.kind, 'voxel');
  assert.match(decision.reason, /保留主体/);
});

test('a confident tree routes to a real component per instance', () => {
  const instance = {
    id: 'tree-1',
    category: 'tree' as const,
    confidence: 0.92,
    imageBox: { x: 0.08, y: 0.55, width: 0.14, height: 0.25 },
    scaleHint: { width: 8, depth: 8, height: 16 },
  };
  const matches = retrieveComponentForInstance(instance);
  assert.equal(routeRepresentation(instance, matches).kind, 'component');
  assert.ok(routeRepresentation(instance, matches).templateId);
});

