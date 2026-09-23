import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { solveSurfaceAnchor, applyAnchorResult } from './surface-anchor-solver.ts';
import type { ComponentRegion } from './semantic-components.ts';

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
