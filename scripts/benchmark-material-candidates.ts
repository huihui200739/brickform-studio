// Replay reviewed local albedo estimates through the actual production converter.
// No inference/download: the response cache must match the current pinned runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { applyMaterialHypothesis } from '../lib/material-hypothesis.ts';
import { decodeMaterialCandidate } from '../lib/local-material-request.ts';
import { detectRefinements } from '../lib/semantic-refinement.ts';
import { meshToDesignAuto } from '../lib/mesh-design.ts';
import { VisionSceneDetector } from '../lib/scene/detectors/vision-detector.ts';
import {
  validateModel,
  inventory,
  type Model,
  type Raster,
} from '../lib/brick-engine.ts';
import { procurementReport } from '../lib/purchase-inventory.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const output = resolve(
  process.argv[2] || 'outputs/material-candidate-calibration',
);
mkdirSync(output, { recursive: true });
const sha = (v: Uint8Array | string) =>
  createHash('sha256').update(v).digest('hex');
const engineFingerprint = sha(
  Buffer.concat([
    readFileSync('work/intrinsic-engine/ready.json'),
    readFileSync('scripts/local-material-analysis.py'),
  ]),
);
const fingerprint = conversionFingerprint();
const caches = readdirSync('work/intrinsic-engine/jobs').map((id) =>
  join('work/intrinsic-engine/jobs', id, 'material-analysis.json'),
);

// Independent replay of emitted grid approaches; catalog poses have their own
// connection checks. This is not a full insertion/hand-clearance or force test.
function emittedOrder(model: Model) {
  const placed = new Set<number>(),
    occupied = new Set<string>();
  let checked = 0,
    failures = 0;
  for (const b of [...model.bricks].sort(
    (a, b) => a.step! - b.step! || a.id - b.id,
  )) {
    if (b.section?.startsWith('component-')) continue;
    const move = b.assemblyMove;
    if (!move) {
      failures++;
      continue;
    }
    checked++;
    if (b.y > 0 && !move.parentIds.length) failures++;
    if (move.parentIds.some((id) => !placed.has(id))) failures++;
    const y = move.direction === 'down' ? b.y + b.h : b.y - 1;
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++) {
        if (occupied.has(`${x},${y},${z}`)) failures++;
        for (let layer = b.y; layer < b.y + b.h; layer++)
          occupied.add(`${x},${layer},${z}`);
      }
    placed.add(b.id);
  }
  return {
    checked,
    failures,
    scope:
      'Final one-plate grid approach; full paths, hands and stability unverified.',
  };
}

const cases = [];
for (const id of ['temple-standard', 'house']) {
  const temple = id === 'temple-standard',
    resolution = temple ? 48 : 28;
  const glb = temple
    ? gunzipSync(readFileSync('lib/fixtures/temple-standard.glb.gz'))
    : readFileSync('outputs/image-benchmark/house/model.glb');
  const pixels = temple
    ? gunzipSync(readFileSync('lib/fixtures/temple-standard.rgba.gz'))
    : readFileSync('outputs/identity-calibration/house.rgba').subarray(8);
  const image: Raster = {
    width: 320,
    height: 320,
    data: Uint8Array.from(pixels),
  };
  const header = Buffer.alloc(8);
  header.writeUInt32LE(320, 0);
  header.writeUInt32LE(320, 4);
  const inputSha256 = sha(Buffer.concat([header, pixels]));
  let response: unknown;
  for (const file of caches) {
    try {
      const value = JSON.parse(readFileSync(file, 'utf8'));
      if (
        value.candidate?.provenance?.sourceSha256 === inputSha256 &&
        value.candidate?.provenance?.engineFingerprint === engineFingerprint
      ) {
        response = value.candidate;
        break;
      }
    } catch {
      /* Other pending jobs are not cached estimates. */
    }
  }
  assert.ok(
    response,
    `Run the current local material endpoint for ${id} first.`,
  );
  const candidate = decodeMaterialCandidate(response, image, {
    sourceSha256: inputSha256,
    engineFingerprint,
  });
  const source = await readGLB(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
    id,
  );
  const reference = colorFromReference(source, image);
  const mesh = await applyMaterialHypothesis(reference, candidate);
  assert.equal(mesh.positions, reference.positions);
  assert.equal(mesh.features, reference.features);
  assert.equal(mesh.coloring, reference.coloring);
  assert.equal(mesh.sourceObservations, reference.sourceObservations);
  assert.deepEqual(
    mesh.materialEvidence!.observed,
    reference.materialEvidence!.observed,
  );
  assert.deepEqual(mesh.sourceObservations!.raster.rgba, image.data);
  const scene = JSON.parse(
    readFileSync(
      temple
        ? 'lib/fixtures/temple-standard.scene.json'
        : 'outputs/identity-calibration/house.scene.json',
      'utf8',
    ),
  );
  assert.equal(scene.imageSha256, inputSha256);
  const semanticFingerprint = sha(
    Buffer.concat([
      readFileSync('work/semantic-engine/ready.json'),
      readFileSync('scripts/local-scene-analysis.py'),
    ]),
  );
  assert.equal(scene.engineFingerprint, semanticFingerprint);
  const regions = await detectRefinements(
    mesh,
    image,
    resolution,
    undefined,
    mesh.coloring,
    new VisionSceneDetector(async () => scene),
  );
  const result = meshToDesignAuto(mesh, resolution, regions, 48, {
    image,
    camera: mesh.coloring,
  });
  const model = result.model,
    bytes = JSON.stringify(model),
    validation = validateModel(model);
  const order = emittedOrder(model),
    purchase = procurementReport(model);
  const inventoryTotal = inventory(model.bricks).reduce(
    (n, line) => n + line.quantity,
    0,
  );
  assert.equal(inventoryTotal, model.bricks.length);
  assert.equal(
    validation.collisions + validation.unsupported + validation.invalidParts,
    0,
  );
  assert.equal(validation.connected, true);
  assert.equal(order.failures, 0);
  assert.deepEqual(model.materialHypothesis, mesh.materialHypothesis);
  const applied = result.applied.map((r) => ({
    id: r.id,
    kind: r.kind,
    attached: r.anchorResult?.attached,
    visible: r.representationResult?.visibleFromReference,
  }));
  if (temple) {
    assert.equal(
      applied.filter((r) => r.kind === 'statue' && r.attached && r.visible)
        .length,
      1,
    );
    assert.equal(
      applied.filter((r) => r.kind === 'brazier' && r.attached && r.visible)
        .length,
      2,
    );
  }
  writeFileSync(join(output, `${id}-candidate.json`), bytes);
  const row = {
    id,
    resolution,
    inputSha256,
    meshSha256: sha(glb),
    modelSha256: sha(bytes),
    conversionFingerprint: fingerprint,
    materialHypothesis: model.materialHypothesis,
    sourceGeometryCameraFeaturesRGBAAndCoveragePreserved: true,
    bricks: model.bricks.length,
    supports: model.supportCount,
    steps: model.assembly?.steps.length,
    applied,
    validation,
    order,
    inventoryTotal,
    procurement: {
      requiresReview: purchase.requiresReview,
      sourceBrickCount: purchase.sourceBrickCount,
      purchaseQuantity: purchase.purchaseQuantity,
      catalogConfirmed: purchase.catalogConfirmed,
      unverified: purchase.unverified,
      unsupportedColors: purchase.unsupportedColors,
      assemblyStepsRequireReview: purchase.assemblyStepsRequireReview,
      stockChecked: purchase.stockChecked,
    },
    surfaceDesign: model.surfaceDesign,
    appearance:
      'Actual catalog render reviewed separately; no kit-quality or physical-build pass.',
  };
  cases.push(row);
  console.log(
    JSON.stringify({
      id,
      bricks: row.bricks,
      changedFaces: mesh.materialHypothesis!.changedFaces,
      validation,
      order,
    }),
  );
}
assert.equal(conversionFingerprint(), fingerprint);
writeFileSync(
  join(output, 'candidate-results.json'),
  JSON.stringify(
    {
      date: new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
      }).format(new Date()),
      completedAt: new Date().toISOString(),
      conversionFingerprint: fingerprint,
      engineFingerprint,
      cases,
      scope:
        'Two existing failed source rasters; optional reviewed material estimates. Not held-out photographs or physical builds.',
      passed: true,
    },
    null,
    2,
  ),
);
