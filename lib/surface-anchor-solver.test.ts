import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  VisionSceneDetector,
  type VisionSceneResponse,
} from './scene/detectors/vision-detector.ts';
import {
  solveSurfaceAnchor,
  applyAnchorResult,
} from './surface-anchor-solver.ts';
import type { ComponentRegion } from './semantic-components.ts';
import { meshToDesign } from './mesh-design.ts';
import { meshToDesignAuto } from './mesh-design.ts';
import { detectRefinements } from './semantic-refinement.ts';
import { validateModel } from './brick-engine.ts';
import { colorFromReference } from './reference-colors.ts';
import { connectors } from './assembly-validation.ts';

function fixture(name: string) {
  return JSON.parse(
    gunzipSync(
      fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)),
    ).toString(),
  );
}
const mesh = fixture('temple-original.mesh.json.gz');
mesh.positions = new Float32Array(mesh.positions);
mesh.colors = new Uint8Array(mesh.colors);
const image = fixture('temple-original.raster.json.gz');
const model = fixture('temple-original.model.json.gz');

function element(
  id: string,
  category: 'statue' | 'brazier',
  anchorUV: [number, number],
) {
  return {
    id,
    category,
    confidence: 1,
    anchorUV,
    imageBox: {
      x: anchorUV[0] - 0.04,
      y: anchorUV[1] - 0.1,
      width: 0.08,
      height: 0.2,
    },
    importance:
      category === 'statue' ? ('primary' as const) : ('secondary' as const),
    mustRepresent: category === 'statue',
  };
}

test('Temple statue calibrates from image ray to a pedestal attachment', () => {
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
  assert.equal(result.surfaceKind, 'platform');
  assert.equal(result.placementMode, 'pedestal-mounted');
  assert.deepEqual(result.surface.normal, [0, 1, 0]);
  assert.ok(result.worldAnchor.y > 2);
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
  const source = JSON.parse(
    fs.readFileSync(
      new URL('./fixtures/temple-original.regions.json', import.meta.url),
      'utf8',
    ),
  )[0];
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
  assert.ok(
    result.bricks.filter((brick) => brick.section === 'component-statue')
      .length > 0,
  );

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
  const result = solveSurfaceAnchor(
    region.sceneElement!,
    mesh,
    image,
    model,
    model.resolution,
    { yaw: 15, pitch: 25, perspective: 0.25 },
  );
  const calibrated = applyAnchorResult(region, result);
  assert.deepEqual(calibrated.anchor, result.normalizedAnchor);
  assert.deepEqual(calibrated.sourceAnchor, region.anchor);
  assert.notDeepEqual(calibrated.anchor, [0.5, 0.5, 0.5]);
  assert.equal(calibrated.anchorResult?.attached, true);
});

for (const resolution of [28, 36, 48])
  test(`fixture-temple ${resolution} seats front-facing components and replaces projected flames`, async () => {
    // Exercise the real browser pipeline: projection changes the packed source
    // colours and previously left a second flame painted on the rear masonry.
    const colored = colorFromReference(mesh, image);
    const regions = await detectRefinements(
      colored,
      image,
      resolution,
      undefined,
      { yaw: 15, pitch: 25, perspective: 0.25 },
      new VisionSceneDetector(
        async () =>
          JSON.parse(
            fs.readFileSync(
              new URL('./fixtures/temple-original.scene.json', import.meta.url),
              'utf8',
            ),
          ) as VisionSceneResponse,
      ),
    );
    const result = meshToDesignAuto(colored, resolution, regions, 48, {
      image,
      camera: { yaw: 15, pitch: 25, perspective: 0.25 },
    });
    const statue = result.applied.find((region) => region.kind === 'statue');
    const braziers = result.applied.filter(
      (region) => region.kind === 'brazier',
    );
    assert.ok(statue, 'the primary statue is retained as a component');
    assert.equal(statue.rotation, 2);
    const opening = statue.anchorResult?.clearanceVolume;
    assert.ok(opening, 'the detected niche must reserve its opening');
    assert.ok(
      result.model.bricks.every(
        (b) =>
          b.section?.startsWith('component-') ||
          ![0, 1, 2].every(
            (axis) =>
              [b.x, b.y, b.z][axis] < opening.max[axis] &&
              [b.x + b.w, b.y + b.h, b.z + b.d][axis] > opening.min[axis],
          ),
      ),
      'no pillar, source remnant or automatic support may fill the opening',
    );
    assert.ok((statue?.representationResult?.brickCount || 0) > 0);
    assert.equal(statue?.representationResult?.visibleFromReference, true);
    assert.equal(
      statue.templateId,
      'statue-standing',
      'all detail levels retain the catalog figure',
    );
    assert.equal(statue.representationResult?.brickCount, 13);
    assert.equal(statue.representationResult?.fallbackLevel, 0);
    assert.ok(
      statue.representationResult!.bbox3d!.max[1] <= opening.max[1],
      'the complete figure must fit below the lintel',
    );
    assert.equal(braziers.length, 2);
    assert.equal(
      result.model.clearanceVolumes?.length,
      3,
      'the entry and both foreground flame spaces are reserved',
    );
    assert.ok(
      result.model.bricks.every(
        (b) =>
          b.section?.startsWith('component-') ||
          result.model.clearanceVolumes!.every(
            (box) =>
              ![0, 1, 2].every(
                (axis) =>
                  [b.x, b.y, b.z][axis] < box.max[axis] &&
                  [b.x + b.w, b.y + b.h, b.z + b.d][axis] > box.min[axis],
              ),
          ),
      ),
      'ordinary bricks and support posts cannot reappear behind the flames',
    );
    assert.ok(braziers.every((region) => region.anchorResult?.attached));
    assert.ok(
      braziers.every(
        (region) => region.representationResult?.visibleFromReference,
      ),
    );
    for (const region of braziers) {
      const base = result.model.bricks.find(
        (b) => b.section === `component-${region.id}`,
      )!;
      const sockets = connectors(base).sockets;
      const mountingStuds = result.model.bricks
        .filter((b) =>
          region.anchorResult!.surface.supportBrickIds.includes(b.id),
        )
        .flatMap((b) => connectors(b).studs);
      assert.equal(sockets.length, 4);
      assert.ok(
        sockets.every((socket) =>
          mountingStuds.some((stud) =>
            socket.point.every(
              (value, i) => Math.abs(value - stud.point[i]) < 0.001,
            ),
          ),
        ),
        'all four base sockets must be seated',
      );
      for (let dy = 1; dy <= 6; dy++)
        for (let x = base.x; x < base.x + base.w; x++)
          for (let z = base.z; z < base.z + base.d; z++)
            assert.ok(
              result.model.bricks.some(
                (b) =>
                  !b.section?.startsWith('component-') &&
                  x >= b.x &&
                  x < b.x + b.w &&
                  z >= b.z &&
                  z < b.z + b.d &&
                  base.y - dy >= b.y &&
                  base.y - dy < b.y + b.h,
              ),
              'the brazier foundation must not have gaps below the base',
            );
    }
    assert.equal(
      result.model.bricks.filter(
        (b) =>
          !b.section?.startsWith('component-') && [2, 3, 6].includes(b.color),
      ).length,
      0,
      'fixture flames are represented only by the catalog components',
    );
    const check = validateModel(result.model);
    assert.equal(
      new Set(result.model.bricks.map((b) => b.id)).size,
      result.model.bricks.length,
    );
    for (const region of result.applied) {
      const section = result.model.bricks.filter(
        (b) => b.section === `component-${region.id}`,
      );
      assert.deepEqual(
        region.representationResult?.brickIds,
        section.map((b) => b.id),
      );
      assert.ok(
        region.anchorResult?.surface.supportBrickIds.every((id) =>
          result.model.bricks.some((b) => b.id === id),
        ),
      );
    }
    assert.equal(check.collisions, 0);
    assert.equal(check.unsupported, 0);
    assert.equal(check.connected, true);
  });
