import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRepresentationResult,
  validateElementVisibility,
  type ReferenceView,
} from './representation/visibility-validation.ts';
import { forcedVoxelSilhouette, simplifiedStandingStatue } from './semantic-templates.ts';
import type { Model } from './brick-engine.ts';
import { isSemanticReservedCell } from './brick-engine.ts';
import { focalFallbackLabels } from './focal-preservation.ts';
import { applyRepresentationTransaction } from './composition/transaction.ts';

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
  assert.equal(checked.depthCheck?.warning, true);
  assert.ok(checked.failureReasons.some((reason) => reason.startsWith('warning:')));
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

test('focal fallback labels include relief, standing and forced silhouette stages', () => {
  const labels = focalFallbackLabels({
    id: 'statue-1',
    kind: 'statue',
    anchor: [0.5, 0.5, 0.5],
    width: 4,
    depth: 2,
    height: 8,
    rotation: 0,
    sceneElement: element,
  });
  assert.deepEqual(labels, [
    'component',
    'semantic-template',
    'relief',
    'simplified-standing-statue',
    'forced-voxel-silhouette',
  ]);
});

test('semantic reserved cells are queryable by later support and repair stages', () => {
  const m = model([]);
  m.semanticReservedCells = ['2,3,4'];
  assert.equal(isSemanticReservedCell(m, 2, 3, 4), true);
  assert.equal(isSemanticReservedCell(m, 2, 3, 5), false);
});

test('a failed relief transaction rolls back before the standing fallback commits', () => {
  type State = { representation: string; bricks: number };
  const current: State = { representation: 'original', bricks: 0 };
  const failed = applyRepresentationTransaction({
    currentState: current,
    plan: 'relief',
    cloneCurrentState: (state) => ({ ...state }),
    removeOriginalRegion: (state) => { state.representation = 'relief'; },
    addRepresentation: () => { throw Error('occluded relief'); },
    validate: () => ({ acceptable: false }),
  });
  assert.equal(failed.committed, false);
  assert.equal(failed.originalPreserved, true);
  assert.equal(failed.state, current);
  const standing = applyRepresentationTransaction({
    currentState: failed.state,
    plan: 'simplified-standing-statue',
    cloneCurrentState: (state) => ({ ...state }),
    removeOriginalRegion: (state) => { state.representation = 'simplified-standing-statue'; },
    addRepresentation: (state) => { state.bricks = simplifiedStandingStatue().length; },
    validate: (state) => ({ acceptable: state.bricks > 0 }),
  });
  assert.equal(standing.committed, true);
  assert.equal(standing.state.representation, 'simplified-standing-statue');
  assert.ok(standing.state.bricks > 0);
  assert.ok(forcedVoxelSilhouette().length > 0);
});
