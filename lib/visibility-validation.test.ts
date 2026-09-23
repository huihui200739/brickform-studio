import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRepresentationResult,
  validateElementVisibility,
  type ReferenceView,
} from './representation/visibility-validation.ts';
import { simplifiedStandingStatue } from './semantic-templates.ts';
import type { Model } from './brick-engine.ts';

const view: ReferenceView = {
  camera: { yaw: 0, pitch: 0, perspective: 0 },
  project: ([x, y, z]) => [x / 20, y / 20, z],
};

function model(bricks: Model['bricks']): Model {
  return {
    name: 'visibility-test',
    bricks,
    width: 20,
    depth: 20,
    height: 20,
    levels: [],
    supportCount: 0,
    source: 'sample',
    resolution: 20,
    shape: 'sculpture',
  };
}

const element = {
  id: 'statue-1',
  category: 'statue' as const,
  confidence: 1,
  imageBox: { x: 0, y: 0, width: 0.2, height: 0.2 },
  importance: 'primary' as const,
  mustRepresent: true,
};

test('metadata-only or zero-brick representations fail', () => {
  const m = model([]);
  const result = makeRepresentationResult(element, 'relief', 'relief', m, 'component-statue', 1);
  const checked = validateElementVisibility(element, result, view, m);
  assert.equal(checked.committed, false);
  assert.equal(checked.brickCount, 0);
  assert.ok(checked.failureReasons.includes('no final bricks for element'));
});

test('a representation hidden behind a wall fails visibility validation', () => {
  const m = model([
    { id: 1, part: '3003', x: 0, y: 0, z: 0, w: 4, d: 2, h: 3, color: 7, section: 'component-statue' },
    { id: 2, part: '3001', x: 0, y: 0, z: 2, w: 4, d: 2, h: 3, color: 7, section: 'wall' },
  ]);
  const result = makeRepresentationResult(element, 'semantic-template', 'semantic-template', m, 'component-statue', 1);
  const checked = validateElementVisibility(element, result, view, m);
  assert.equal(checked.visibleFromReference, false);
  assert.ok((checked.occlusionRatio || 0) > 0.9);
});

test('a visible simplified standing statue passes and exposes real brick ids', () => {
  assert.ok(simplifiedStandingStatue().length >= 6);
  const m = model([
    { id: 1, part: '3003', x: 0, y: 0, z: 0, w: 4, d: 2, h: 3, color: 7, section: 'component-statue' },
  ]);
  const result = makeRepresentationResult(element, 'semantic-template', 'semantic-template', m, 'component-statue', 2);
  const checked = validateElementVisibility(element, result, view, m);
  assert.equal(checked.brickIds.length, 1);
  assert.equal(checked.visibleFromReference, true);
  assert.equal(checked.committed, true);
  assert.ok((checked.projectedCoverage || 0) >= 0.25);
});
