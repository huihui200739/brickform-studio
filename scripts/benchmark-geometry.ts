import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { detectRefinements } from '../lib/semantic-refinement.ts';
import { meshToDesignAuto } from '../lib/mesh-design.ts';
import { inventory, validateModel, type Raster } from '../lib/brick-engine.ts';
import {
  VisionSceneDetector,
  type VisionSceneResponse,
} from '../lib/scene/detectors/vision-detector.ts';
import type { TriangleMesh } from '../lib/mesh-types.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(process.argv[2] || 'outputs/geometry-calibration');
mkdirSync(directory, { recursive: true });
const fixture = (name: string) =>
  readFileSync(new URL(`../lib/fixtures/${name}`, import.meta.url));
const json = (name: string) => JSON.parse(gunzipSync(fixture(name)).toString());
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const rows: Record<string, unknown>[] = [];
let failed = false;
for (const name of ['original', 'standard']) {
  let source: TriangleMesh, image: Raster;
  if (name === 'original') {
    source = json('temple-original.mesh.json.gz');
    source.positions = new Float32Array(source.positions);
    source.colors = new Uint8Array(source.colors);
    image = json('temple-original.raster.json.gz');
  } else {
    const b = gunzipSync(fixture('temple-standard.glb.gz'));
    source = await readGLB(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
      'September 30 temple',
    );
    image = {
      width: 320,
      height: 320,
      data: gunzipSync(fixture('temple-standard.rgba.gz')),
    };
  }
  const mesh = colorFromReference(source, image);
  const camera =
    name === 'original'
      ? { yaw: 15, pitch: 25, perspective: 0.25 }
      : mesh.coloring!;
  const scene = JSON.parse(
    fixture(`temple-${name}.scene.json`).toString(),
  ) as VisionSceneResponse;
  for (const resolution of [28, 36, 48]) {
    const started = Date.now();
    const regions = await detectRefinements(
      mesh,
      image,
      resolution,
      undefined,
      camera,
      new VisionSceneDetector(async () => scene),
    );
    const result = meshToDesignAuto(mesh, resolution, regions, 48, {
      image,
      camera,
    });
    const validation = validateModel(result.model);
    const inventoryTotal = inventory(result.model.bricks).reduce(
      (n, p) => n + p.quantity,
      0,
    );
    const statue = result.applied.filter((r) => r.kind === 'statue');
    const flames = result.applied.filter((r) => r.kind === 'brazier');
    const passed =
      statue.length === 1 &&
      statue[0].representationResult?.visibleFromReference === true &&
      flames.length === 2 &&
      flames.every((r) => r.anchorResult?.attached === true) &&
      result.model.designGeometry?.validation?.passed === true &&
      result.model.platformDesign?.validation?.passed === true &&
      inventoryTotal === result.model.bricks.length &&
      validation.connected &&
      validation.collisions +
        validation.unsupported +
        validation.invalidParts ===
        0;
    if (!passed) failed = true;
    const row = {
      case: `temple-${name}`,
      resolution,
      passed,
      camera,
      imageSha256: sha(Uint8Array.from(image.data)),
      sourcePositionsSha256: sha(new Uint8Array(source.positions.buffer)),
      recordedSceneFingerprint: scene.engineFingerprint,
      bricks: result.model.bricks.length,
      steps: result.model.assembly?.steps.length,
      inventoryTotal,
      applied: result.applied.map((r) => ({
        id: r.id,
        kind: r.kind,
        visible: r.representationResult?.visibleFromReference,
        attached: r.anchorResult?.attached,
      })),
      geometry: result.model.designGeometry,
      platform: result.model.platformDesign,
      validation,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
    rows.push(row);
    writeFileSync(
      join(directory, `temple-${name}-${resolution}.json`),
      JSON.stringify(result.model),
    );
    console.log(JSON.stringify(row));
  }
}
writeFileSync(
  join(directory, 'results.json'),
  JSON.stringify(
    {
      date: '2026-10-01',
      conversionFingerprint: conversionFingerprint(),
      scope:
        'Two actual user-image/native-mesh failure fixtures, recorded learned observations, six complete conversions. Not a new native inference or physical build.',
      cases: rows,
      limits:
        'Recess walls use mesh-and-reference evidence; lower display platforms use reconstructed mesh normals and area consensus. Only declared patches are redesigned. Source material patterns, inferred back geometry, procurement, load strength and insertion paths remain unverified.',
    },
    null,
    2,
  ),
);
if (failed) process.exitCode = 1;
