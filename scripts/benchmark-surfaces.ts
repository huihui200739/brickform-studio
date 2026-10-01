import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { readGLB } from '../lib/read-glb.ts';
import { designMeshSurfaces } from '../lib/surface-design.ts';
import type { TriangleMesh } from '../lib/mesh-types.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(process.argv[2] || 'outputs/surface-calibration');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const verified = read(join(directory, 'support-results.json'));
const baseline = read('benchmarks/material-2026-10-01.json');
const current = conversionFingerprint();
if (!verified.passed || verified.conversionFingerprint !== current)
  throw Error('Replay current conversions and emitted-order audit first.');

function normal(p: Float32Array, i: number) {
  const a = [0, 1, 2].map((k) => p[i + 3 + k] - p[i + k]),
    b = [0, 1, 2].map((k) => p[i + 6 + k] - p[i + k]);
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function bounds(p: Float32Array) {
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a], p[i]);
    max[a] = Math.max(max[a], p[i]);
  }
  return { min, max };
}

let failed = false;
const cases = [];
for (const row of verified.cases) {
  let mesh: TriangleMesh;
  if (row.id === 'temple-original') {
    const raw = readFileSync('lib/fixtures/temple-original.mesh.json.gz');
    mesh = JSON.parse(gunzipSync(raw).toString());
    mesh.positions = Float32Array.from(mesh.positions);
    mesh.colors = Uint8Array.from(mesh.colors);
  } else {
    const bytes =
      row.id === 'temple-standard'
        ? gunzipSync(readFileSync('lib/fixtures/temple-standard.glb.gz'))
        : readFileSync(`outputs/image-benchmark/${row.id}/model.glb`);
    mesh = await readGLB(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      row.id,
    );
  }
  const original = sha(new Uint8Array(mesh.positions.buffer)),
    started = Date.now();
  const result = designMeshSurfaces(mesh, row.resolution),
    p = mesh.positions,
    out = result.mesh.positions;
  const sourceBounds = bounds(p),
    scale =
      row.resolution /
      Math.max(...sourceBounds.max.map((v, a) => v - sourceBounds.min[a]));
  const moved = new Set<string>(),
    copies = new Map<string, string>(),
    newVertices = new Map<string, string>();
  let seams = 0,
    aliases = 0,
    maxDisplacementStuds = 0,
    changedFaces = 0,
    minNormalCosine = 1,
    minAreaRatio = 1;
  for (let i = 0; i < p.length; i += 3) {
    const key = Array.from(p.slice(i, i + 3)).join(','),
      target = Array.from(out.slice(i, i + 3)).join(',');
    if (copies.has(key) && copies.get(key) !== target) seams++;
    if (newVertices.has(target) && newVertices.get(target) !== key) aliases++;
    copies.set(key, target);
    newVertices.set(target, key);
    const distance =
      Math.hypot(...[0, 1, 2].map((a) => out[i + a] - p[i + a])) * scale;
    if (distance > 0) moved.add(key);
    maxDisplacementStuds = Math.max(maxDisplacementStuds, distance);
  }
  for (let i = 0; i < p.length; i += 9) {
    if (out.slice(i, i + 9).every((v, k) => v === p[i + k])) continue;
    changedFaces++;
    const a = normal(p, i),
      b = normal(out, i),
      aa = Math.hypot(...a),
      bb = Math.hypot(...b);
    minNormalCosine = Math.min(
      minNormalCosine,
      a.reduce((n, v, k) => n + v * b[k], 0) / (aa * bb),
    );
    minAreaRatio = Math.min(minAreaRatio, bb / aa);
  }
  const modelPath = row.id.startsWith('temple-')
    ? join(directory, `${row.id}-${row.resolution}.json`)
    : `outputs/image-benchmark/${row.id}/bricks-${row.resolution}.json`;
  const bytes = readFileSync(modelPath),
    model = JSON.parse(bytes.toString());
  const old = baseline.cases.find(
    (c: { id: string; resolution: number }) =>
      c.id === row.id && c.resolution === row.resolution,
  );
  const passed =
    sha(bytes) === row.modelSha256 &&
    JSON.stringify(model.surfaceDesign) === JSON.stringify(result.design) &&
    original === sha(new Uint8Array(p.buffer)) &&
    result.mesh.colors === mesh.colors &&
    JSON.stringify(bounds(out)) === JSON.stringify(sourceBounds) &&
    seams === 0 &&
    aliases === 0 &&
    moved.size === result.design.adjustedVertices &&
    maxDisplacementStuds <= 0.25001 &&
    minNormalCosine >= 0.5 - 1e-6 &&
    minAreaRatio > 0 &&
    result.design.patches.every(
      (p) => p.residualAfterStuds < p.residualBeforeStuds,
    );
  if (!passed) failed = true;
  cases.push({
    id: row.id,
    resolution: row.resolution,
    passed,
    modelSha256: row.modelSha256,
    inputSha256: row.inputSha256,
    sourcePositionsSha256: original,
    designedPositionsSha256: sha(new Uint8Array(out.buffer)),
    sourceBounds,
    boundsPreserved:
      JSON.stringify(bounds(out)) === JSON.stringify(sourceBounds),
    sourceColorsPreserved: result.mesh.colors === mesh.colors,
    seamFailures: seams,
    vertexAliases: aliases,
    adjustedVertices: moved.size,
    maxDisplacementStuds,
    changedFaces,
    minNormalCosine,
    minAreaRatio,
    design: result.design,
    baseline: old ? { bricks: old.bricks, supports: old.supports } : undefined,
    bricks: model.bricks.length,
    supports: model.supportCount,
    finalStructuralAuditPassed: true,
    elapsedSeconds: (Date.now() - started) / 1000,
    appearance:
      'Draft; inspect catalog render separately, not an official-kit quality pass.',
  });
}
const output = {
  date: '2026-10-01',
  conversionFingerprint: current,
  passed: !failed,
  scope: verified.scope,
  cases,
  limits:
    'Only connected nearly axis-aligned planes with small residuals are redesigned. No hole filling or global repaint. Mesh connectivity and orientation checks do not establish exact photo similarity, curved-part design, procurement, full insertion paths, strength or physical buildability.',
};
writeFileSync(
  join(directory, 'surface-results.json'),
  JSON.stringify(output, null, 2),
);
console.log(
  JSON.stringify({
    passed: !failed,
    cases: cases.length,
    adjustedVertices: cases.reduce((n, c) => n + c.adjustedVertices, 0),
  }),
);
if (failed) process.exitCode = 1;
