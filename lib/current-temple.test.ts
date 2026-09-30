import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readGLB } from './read-glb.ts';
import { colorFromReference } from './reference-colors.ts';
import { detectRefinements } from './semantic-refinement.ts';
import { meshToDesignAuto } from './mesh-design.ts';
import { validateModel, inventory } from './brick-engine.ts';
import { connectors } from './assembly-validation.ts';
import {
  VisionSceneDetector,
  type VisionSceneResponse,
} from './scene/detectors/vision-detector.ts';

for (const resolution of [28, 36, 48])
  void test(`actual September 30 draft ${resolution} keeps a planar rear wall, statue and both connected braziers`, async () => {
    const bytes = gunzipSync(
      readFileSync(
        new URL('./fixtures/temple-standard.glb.gz', import.meta.url),
      ),
    );
    const image = {
      width: 320,
      height: 320,
      data: gunzipSync(
        readFileSync(
          new URL('./fixtures/temple-standard.rgba.gz', import.meta.url),
        ),
      ),
    };
    const source = await readGLB(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      'actual temple',
    );
    const mesh = colorFromReference(source, image, undefined, true);
    const regions = await detectRefinements(
      mesh,
      image,
      resolution,
      undefined,
      mesh.coloring,
      new VisionSceneDetector(
        async () =>
          JSON.parse(
            readFileSync(
              new URL('./fixtures/temple-standard.scene.json', import.meta.url),
              'utf8',
            ),
          ) as VisionSceneResponse,
      ),
    );
    const result = meshToDesignAuto(mesh, resolution, regions, 48, {
      image,
      camera: mesh.coloring,
    });
    assert.equal(result.applied.filter((r) => r.kind === 'statue').length, 1);
    const flames = result.applied.filter((r) => r.kind === 'brazier');
    assert.equal(
      flames.length,
      2,
      'both actual detected braziers must commit at standard resolution',
    );
    for (const r of flames) {
      assert.equal(r.anchorResult?.attached, true);
      assert.equal(r.representationResult?.visibleFromReference, true);
      const base = result.model.bricks.find(
        (b) => b.section === `component-${r.id}`,
      )!;
      const plugs = result.model.bricks
        .filter((b) => r.anchorResult!.surface.supportBrickIds.includes(b.id))
        .flatMap((b) => connectors(b).studs);
      assert.equal(connectors(base).sockets.length, 4);
      assert.ok(
        connectors(base).sockets.every((socket) =>
          plugs.some((plug) =>
            socket.point.every((v, i) => Math.abs(v - plug.point[i]) < 0.001),
          ),
        ),
      );
    }
    const geometry = result.model.designGeometry;
    assert.ok(
      geometry,
      'the observed recess must be fitted before brick selection',
    );
    assert.equal(geometry.planes.length, 1);
    assert.equal(geometry.validation?.passed, true);
    assert.ok(
      geometry.validation!.planes.every(
        (p) =>
          p.checkedCells > 100 &&
          p.missingCells === 0 &&
          p.materialMismatches === 0,
      ),
    );
    assert.equal(geometry.validation!.occupiedOpenings, 0);
    assert.equal(
      geometry.planes[0].material.color,
      7,
      'the shaded chamber inherits its locally observed sand masonry',
    );
    if (resolution === 48)
      assert.ok(
        geometry.openings[0].bounds.max[0] -
          geometry.openings[0].bounds.min[0] >
          10,
        'a larger aperture must not be shrunk to fit a single beam',
      );
    const check = validateModel(result.model);
    assert.equal(check.unsupported + check.collisions + check.invalidParts, 0);
    assert.equal(check.connected, true);
    assert.equal(
      inventory(result.model.bricks).reduce((n, p) => n + p.quantity, 0),
      result.model.bricks.length,
    );
    assert.ok(result.model.meshDesign!.adjustedPlatformCells! > 0);
  });
