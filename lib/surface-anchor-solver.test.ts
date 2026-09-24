import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { solveSurfaceAnchor, applyAnchorResult } from './surface-anchor-solver.ts';
import type { ComponentRegion } from './semantic-components.ts';
import { meshToDesign } from './mesh-design.ts';

const mesh = JSON.parse(fs.readFileSync('outputs/local-3d/temple-mesh.json', 'utf8'));
mesh.positions = new Float32Array(mesh.positions);
mesh.colors = new Uint8Array(mesh.colors);
const image = JSON.parse(fs.readFileSync('outputs/local-3d/temple-raster.json', 'utf8'));
const model = JSON.parse(fs.readFileSync('outputs/components/position-locked.json', 'utf8'));

function element(id: string, category: 'statue' | 'brazier', anchorUV: [number, number]) {
  return {
    id,
    category,
    confidence: 1,
    anchorUV,
    imageBox: { x: anchorUV[0] - 0.04, y: anchorUV[1] - 0.1, width: 0.08, height: 0.2 },
    importance: category === 'statue' ? 'primary' as const : 'secondary' as const,
    mustRepresent: category === 'statue',
  };
}

test('Temple statue calibrates from image ray to a wall/cavity attachment', () => {
  const result = solveSurfaceAnchor(
    element('statue', 'statue', [0.5, 0.42]),
    mesh,
    image,
    model,
    model.resolution,
    { yaw: 15, pitch: 25, perspective: 0.25 },
  );
  assert.equal(result.attached, true);
  assert.equal(result.surface.detected, true);
  assert.ok(result.surface.supportBrickIds.length > 0);
  assert.equal(result.surfaceKind, 'wall');
  assert.ok(result.depthConfidence > 0.35);
  assert.ok(result.normalizedAnchor);
});

test('Temple brazier calibration returns a surface offset and support bricks', () => {
  const result = solveSurfaceAnchor(
    element('torch', 'brazier', [0.55, 0.4]),
    mesh,
    image,
    model,
    model.resolution,
    { yaw: 15, pitch: 25, perspective: 0.25 },
  );
  assert.equal(result.attached, true);
  assert.equal(result.surfaceKind, 'wall');
  assert.ok(result.worldAnchor.z > 0);
  assert.ok(result.surface.supportBrickIds.length > 0);
  assert.equal(result.placementMode, 'wall-mounted');
});

test('fixture-temple preserves statue bricks when calibration has no direct support', () => {
  const source = JSON.parse(fs.readFileSync('outputs/components/final-regions.json', 'utf8'))[0];
  const region: ComponentRegion = {
    ...source,
    placed: true,
    confirmed: true,
    anchorResult: {
      elementId: 'statue',
      imageAnchor: { x: 0.5, y: 0.42 },
      worldAnchor: { x: 18, y: 30, z: 16 },
      surface: { detected: false, normal: [0, 1, 0], supportBrickIds: [] },
      depthConfidence: 0.2,
      attached: false,
      placementMode: 'cavity-contained',
      placementScore: 0.2,
      failureReasons: ['surface unavailable in the central niche'],
    },
  };
  const result = meshToDesign(mesh, 36, [region]);
  assert.ok(result.bricks.filter((brick) => brick.section === 'component-statue').length > 0);

  const brazier = solveSurfaceAnchor(
    element('fixture-brazier', 'brazier', [0.55, 0.4]),
    mesh,
    image,
    model,
    model.resolution,
    { yaw: 15, pitch: 25, perspective: 0.25 },
  );
  assert.equal(brazier.attached, true);
  assert.equal(brazier.placementMode, 'wall-mounted');
});

test('statue falls back to a cavity-contained semantic volume without a platform', () => {
  const emptyModel = { ...model, bricks: [] };
  const result = solveSurfaceAnchor(
    element('cavity-statue', 'statue', [0.5, 0.42]),
    mesh,
    image,
    emptyModel,
    emptyModel.resolution,
    { yaw: 15, pitch: 25, perspective: 0.25 },
  );
  assert.equal(result.attached, false);
  assert.equal(result.placementMode, 'cavity-contained');
  assert.ok(result.normalizedAnchor);
});

test('anchor calibration updates the placement anchor without using imageBox directly', () => {
  const region: ComponentRegion = {
    id: 'statue',
    kind: 'statue',
    anchor: [0.5, 0.5, 0.5],
    width: 6,
    depth: 5,
    height: 23,
    rotation: 0,
    sceneElement: element('statue', 'statue', [0.5, 0.42]),
  };
  const result = solveSurfaceAnchor(region.sceneElement!, mesh, image, model, model.resolution, { yaw: 15, pitch: 25, perspective: 0.25 });
  const calibrated = applyAnchorResult(region, result);
  assert.deepEqual(calibrated.anchor, result.normalizedAnchor);
  assert.notDeepEqual(calibrated.anchor, [0.5, 0.5, 0.5]);
  assert.equal(calibrated.anchorResult?.attached, true);
});
