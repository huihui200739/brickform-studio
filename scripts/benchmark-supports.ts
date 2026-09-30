import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { inventory, validateModel, type Model } from '../lib/brick-engine.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(process.argv[2] || 'outputs/support-calibration');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const current = conversionFingerprint();
const baseline = read('benchmarks/image-platform-2026-10-01.json');
const images = read('outputs/image-benchmark/results-28.json');
const geometry = read(join(directory, 'results.json'));
if (
  geometry.conversionFingerprint !== current ||
  images.cases.some(
    (r: { conversionFingerprint: string }) =>
      r.conversionFingerprint !== current,
  )
)
  throw Error(
    'Replay the image and geometry conversions against the current production code first.',
  );

// Independently replay the emitted order, rather than rerunning the planner.
// Catalog components use their own pose/connection checks and are not described
// by the upright grid-part approach contract measured here.
function emittedApproaches(model: Model) {
  const occupied = new Set<string>(),
    placed = new Set<number>();
  let tested = 0,
    upward = 0,
    failures = 0;
  const bricks = [...model.bricks].sort(
    (a, b) => a.step! - b.step! || a.id - b.id,
  );
  for (const b of bricks) {
    if (b.section?.startsWith('component-')) continue;
    const move = b.assemblyMove;
    if (!move) {
      failures++;
      continue;
    }
    tested++;
    if (move.direction === 'up') upward++;
    if (b.y > 0 && !move.parentIds.length) failures++;
    if (move.parentIds.some((id) => !placed.has(id))) failures++;
    const y = move.direction === 'down' ? b.y + b.h : b.y - 1;
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        if (occupied.has(`${x},${y},${z}`)) failures++;
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        for (let y = b.y; y < b.y + b.h; y++) occupied.add(`${x},${y},${z}`);
    placed.add(b.id);
  }
  return {
    tested,
    upward,
    failures,
    scope:
      'One-plate final grid approach; full insertion path, hands, forces and stability unverified.',
  };
}

let failed = false;
const cases = [];
for (const r of [...images.cases, ...geometry.cases]) {
  const image = !!r.id;
  const path = image
    ? `outputs/image-benchmark/${r.id}/bricks-28.json`
    : join(directory, `${r.case}-${r.resolution}.json`);
  const bytes = readFileSync(path),
    model = JSON.parse(bytes.toString()) as Model;
  const old = image
    ? baseline.cases.find((p: { id: string }) => p.id === r.id)
    : undefined;
  const validation = validateModel(model),
    approaches = emittedApproaches(model);
  const count = inventory(model.bricks).reduce((n, p) => n + p.quantity, 0);
  const passed =
    (image ? r.status === 'converted' && r.semanticGatePassed : r.passed) &&
    model.bricks.length === r.bricks &&
    count === r.bricks &&
    approaches.failures === 0 &&
    validation.connected &&
    validation.collisions + validation.unsupported + validation.invalidParts ===
      0;
  if (!passed) failed = true;
  cases.push({
    id: r.id || r.case,
    resolution: r.resolution,
    passed,
    inputSha256: r.inputSha256 || r.imageSha256,
    meshSha256: r.meshSha256 || r.sourcePositionsSha256,
    sceneEngineFingerprint:
      r.sceneEngineFingerprint || r.recordedSceneFingerprint,
    modelSha256: createHash('sha256').update(bytes).digest('hex'),
    baseline: old
      ? {
          bricks: old.bricks,
          supports: old.supports,
          steps: old.steps,
          conversionFingerprint: old.conversionFingerprint,
        }
      : undefined,
    bricks: model.bricks.length,
    supports: model.supportCount,
    steps: model.assembly!.steps.length,
    supportDesign: model.supportDesign,
    emittedApproaches: approaches,
    inventoryTotal: count,
    validation,
    applied: r.applied,
    platformPassed: model.platformDesign?.validation?.passed,
    geometryPassed: model.designGeometry?.validation?.passed,
    appearance:
      'Draft; catalog rendering reviewed separately, not an official-kit quality pass.',
  });
}
const output = {
  date: '2026-10-01',
  conversionFingerprint: current,
  scope:
    'Six public engine sample renders and two user Temple fixtures at three sizes. Replayed cached native meshes and actual learned observations; no new native inference or physical build.',
  cases,
  passed: !failed,
  limits:
    'Fewer support parts is not a strength result. Negative spaces, material regions, curve design, procurement, full paths, force/stability and human instructions trials remain incomplete. Public engine examples are not independent held-out photographs.',
};
writeFileSync(
  join(directory, 'support-results.json'),
  JSON.stringify(output, null, 2),
);
console.log(
  JSON.stringify({
    passed: !failed,
    cases: cases.length,
    approaches: cases.reduce((n, c) => n + c.emittedApproaches.tested, 0),
    upward: cases.reduce((n, c) => n + c.emittedApproaches.upward, 0),
  }),
);
if (failed) process.exitCode = 1;
