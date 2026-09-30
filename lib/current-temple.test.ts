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

test('actual September 30 standard draft keeps statue and both fully connected braziers after image downsampling', async () => {
  const bytes = gunzipSync(
    readFileSync(new URL('./fixtures/temple-standard.glb.gz', import.meta.url)),
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
    28,
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
  const result = meshToDesignAuto(mesh, 28, regions, 48, {
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
  const check = validateModel(result.model);
  assert.equal(check.unsupported + check.collisions + check.invalidParts, 0);
  assert.equal(check.connected, true);
  assert.equal(
    inventory(result.model.bricks).reduce((n, p) => n + p.quantity, 0),
    result.model.bricks.length,
  );
  assert.ok(result.model.meshDesign!.adjustedPlatformCells! > 0);
});
