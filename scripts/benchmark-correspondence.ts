import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { readGLB } from '../lib/read-glb.ts';
import {
  referenceAlignment,
  type ReferenceCamera,
} from '../lib/reference-colors.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';
import { extractMeshContours } from './correspondence/mesh-contours.ts';
import { extractImageContours } from './correspondence/image-contours.ts';
import { evaluateContourCameras } from './correspondence/calibration.ts';

// Offline, bounded calibration experiment. Requires the cached public House
// input or the checked-in Temple fixture. It never runs the reconstruction ML
// engine, repacks bricks, recolours surfaces or rewrites a production camera.
const out = 'outputs/interior-camera-calibration';
const requested = process.argv.slice(2);
const ids = requested.length ? requested : ['house', 'temple-standard'];
if (
  ids.some((id) => !['house', 'temple-standard'].includes(id)) ||
  ids.length > 2
)
  throw Error('Use at most the cached house and temple-standard cases.');
mkdirSync(out, { recursive: true });
const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const productionFingerprint = conversionFingerprint();
const scriptFiles = [
  'scripts/benchmark-correspondence.ts',
  'scripts/correspondence/mesh-contours.ts',
  'scripts/correspondence/image-contours.ts',
  'scripts/correspondence/calibration.ts',
];
const experimentFingerprint = sha(
  scriptFiles.map((file) => `${file}\0${sha(readFileSync(file))}`).join('\0'),
);
const reports = [];
for (const id of ids) {
  const started = performance.now();
  const temple = id === 'temple-standard';
  const glb = temple
    ? gunzipSync(readFileSync('lib/fixtures/temple-standard.glb.gz'))
    : readFileSync('outputs/image-benchmark/house/model.glb');
  const raw = temple
    ? gunzipSync(readFileSync('lib/fixtures/temple-standard.rgba.gz'))
    : readFileSync('outputs/identity-calibration/house.rgba').subarray(8);
  const image = { width: 320, height: 320, data: Uint8Array.from(raw) };
  assert.equal(raw.length, 320 * 320 * 4);
  const header = Buffer.alloc(8);
  header.writeUInt32LE(image.width, 0);
  header.writeUInt32LE(image.height, 4);
  const sourceSha256 = sha(Buffer.concat([header, raw]));
  const mesh = await readGLB(
    glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
    id,
  );
  const meshPositionsSha256 = sha(
    new Uint8Array(
      mesh.positions.buffer,
      mesh.positions.byteOffset,
      mesh.positions.byteLength,
    ),
  );
  const baseline = referenceAlignment(mesh, image);
  const photo = extractImageContours(image, baseline.mask);
  const cameras: ReferenceCamera[] = [baseline.camera];
  for (const yawDelta of [-5, 0, 5])
    for (const pitchDelta of [-5, 0, 5]) {
      const camera = {
        ...baseline.camera,
        yaw: baseline.camera.yaw + yawDelta,
        pitch: Math.max(0, baseline.camera.pitch + pitchDelta),
      };
      if (
        !cameras.some(
          (c) =>
            c.yaw === camera.yaw &&
            c.pitch === camera.pitch &&
            c.perspective === camera.perspective,
        )
      )
        cameras.push(camera);
    }
  if (baseline.evidence.alternative)
    cameras.push(baseline.evidence.alternative.camera);
  const candidates = cameras.map((camera, index) => {
    const alignment = index
      ? referenceAlignment(mesh, image, camera)
      : baseline;
    const geometry = extractMeshContours(mesh, alignment, [
      image.width,
      image.height,
    ]);
    const candidate = {
      id: `pose-${index}`,
      camera,
      silhouetteIoU: alignment.evidence.silhouetteIoU,
      samples: geometry.samples,
    };
    return { candidate, geometry };
  });
  const decision = evaluateContourCameras(
    candidates.map((c) => c.candidate),
    photo.samples,
    'pose-0',
    [image.width, image.height],
  );
  assert.equal(sha(image.data), sha(raw));
  assert.equal(
    sha(
      new Uint8Array(
        mesh.positions.buffer,
        mesh.positions.byteOffset,
        mesh.positions.byteLength,
      ),
    ),
    meshPositionsSha256,
  );
  const caseReport = {
    id,
    sourceSha256,
    sourceMeshSha256: sha(glb),
    meshPositionsSha256,
    baseline: baseline.evidence,
    imageContours: photo.summary,
    geometryContours: candidates.map((c) => ({
      id: c.candidate.id,
      ...c.geometry.summary,
    })),
    decision,
    elapsedMs: performance.now() - started,
    sourceRasterUnchanged: true,
    sourceMeshUnchanged: true,
    productionCameraChanged: false,
    modelAppearanceImproved: false,
  };
  const details = {
    ...caseReport,
    imageSize: [image.width, image.height],
    imageSamples: photo.samples,
    candidates: candidates.map((c) => ({
      ...c.candidate,
      segments: c.geometry.segments,
    })),
  };
  const detailedText = JSON.stringify(details);
  writeFileSync(`${out}/${id}.json`, detailedText);
  writeFileSync(`${out}/${id}.rgba`, Buffer.concat([header, raw]));
  reports.push({ ...caseReport, detailedEvidenceSha256: sha(detailedText) });
  console.log(
    JSON.stringify({
      id,
      status: decision.status,
      reasons: decision.reasons,
      proposedId: decision.proposedId,
      elapsedMs: Math.round(caseReport.elapsedMs),
    }),
  );
}
assert.equal(conversionFingerprint(), productionFingerprint);
assert.equal(
  sha(
    scriptFiles.map((file) => `${file}\0${sha(readFileSync(file))}`).join('\0'),
  ),
  experimentFingerprint,
  'Experiment files changed during replay.',
);
const completedAt = new Date().toISOString();
const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
writeFileSync(
  `${out}/report.json`,
  JSON.stringify(
    {
      version: 1,
      date,
      completedAt,
      productionFingerprint,
      experimentFingerprint,
      cases: reports,
      inferenceCalls: 0,
      downloadedWeights: false,
      productionChanged: false,
      physicalBuildabilityVerified: false,
      scope:
        'Two cached failure inputs; bounded silhouette-neighbour camera search plus one silhouette competitor. Persistent grayscale image contours are radiance evidence, not material or geometry truth. Scores and leave-one-out stability are not calibrated probabilities or camera identifiability proofs.',
    },
    null,
    2,
  ) + '\n',
);
