import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGLB } from '../lib/read-glb.ts';
import { referenceAlignment } from '../lib/reference-colors.ts';
import type { Raster, Model } from '../lib/brick-engine.ts';
import type { TriangleMesh } from '../lib/mesh-types.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(process.argv[2] || 'outputs/camera-calibration');
const sha = (b: Uint8Array | string) =>
  createHash('sha256').update(b).digest('hex');
const audit = JSON.parse(
  readFileSync(join(directory, 'support-results.json'), 'utf8'),
);
const fingerprint = conversionFingerprint();
if (!audit.passed || audit.conversionFingerprint !== fingerprint)
  throw Error('Replay current conversions and emitted order first.');
const baselineRevision = 'fbdf4e5';
const baselineSource = execFileSync(
  'git',
  ['show', `${baselineRevision}:lib/reference-colors.ts`],
  { encoding: 'utf8' },
);
const baselinePath = join(directory, '.baseline-camera.ts');
writeFileSync(
  baselinePath,
  '// @ts-nocheck\n' +
    baselineSource.replace(
      /from '(\.\/[^']+)'/g,
      (_s, ref: string) =>
        `from '${new URL(ref, new URL('../lib/reference-colors.ts', import.meta.url)).href}'`,
    ),
);
const baseline = (await import(pathToFileURL(baselinePath).href)) as {
  referenceAlignment: typeof referenceAlignment;
};
const rows: Record<string, unknown>[] = [];
const sources = new Map<string, Record<string, unknown>>();
const fixture = (name: string) =>
  readFileSync(new URL(`../lib/fixtures/${name}`, import.meta.url));
for (const c of audit.cases as {
  id: string;
  resolution: number;
  modelSha256: string;
}[]) {
  const file = c.id.startsWith('temple-')
    ? join(directory, `${c.id}-${c.resolution}.json`)
    : `outputs/image-benchmark/${c.id}/bricks-${c.resolution}.json`;
  const bytes = readFileSync(file),
    model = JSON.parse(bytes.toString()) as Model;
  if (sha(bytes) !== c.modelSha256)
    throw Error(`Model changed after order audit: ${file}`);
  const fitted = model.materialDesign?.alignment;
  if (!fitted || fitted.method !== 'filled-triangle-silhouette')
    throw Error(`No current camera evidence: ${file}`);
  let evidence = sources.get(c.id);
  if (!evidence) {
    let mesh: TriangleMesh, image: Raster;
    if (c.id === 'temple-original') {
      const raw = JSON.parse(
        gunzipSync(fixture('temple-original.mesh.json.gz')).toString(),
      );
      mesh = {
        ...raw,
        positions: Float32Array.from(raw.positions),
        colors: Uint8Array.from(raw.colors),
      };
      image = JSON.parse(
        gunzipSync(fixture('temple-original.raster.json.gz')).toString(),
      );
    } else {
      const b =
        c.id === 'temple-standard'
          ? gunzipSync(fixture('temple-standard.glb.gz'))
          : readFileSync(`outputs/image-benchmark/${c.id}/model.glb`);
      mesh = await readGLB(
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        c.id,
      );
      if (c.id === 'temple-standard')
        image = {
          width: 320,
          height: 320,
          data: gunzipSync(fixture('temple-standard.rgba.gz')),
        };
      else {
        const b = readFileSync(`outputs/identity-calibration/${c.id}.rgba`);
        image = {
          width: b.readUInt32LE(0),
          height: b.readUInt32LE(4),
          data: b.subarray(8),
        };
      }
    }
    const p = sha(new Uint8Array(mesh.positions.buffer)),
      colors = sha(mesh.colors);
    const old = baseline.referenceAlignment(mesh, image),
      current = referenceAlignment(mesh, image, fitted.camera);
    const target: number[] = [];
    for (let y = 0; y < 96; y++)
      for (let x = 0; x < 96; x++)
        target.push(
          current.mask[
            Math.round(
              current.top + (y / 95) * (current.bottom - current.top),
            ) *
              image.width +
              Math.round(
                current.left + (x / 95) * (current.right - current.left),
              )
          ],
        );
    const view = (a: ReturnType<typeof referenceAlignment>) => ({
      camera: a.camera,
      bounds: [a.view.minX, a.view.maxX, a.view.minY, a.view.maxY],
    });
    const dataPath = join(directory, `.camera-${c.id}.json`);
    writeFileSync(
      dataPath,
      JSON.stringify({
        positions: Array.from(mesh.positions),
        target,
        targetAspect:
          (current.right - current.left) / (current.bottom - current.top),
        baseline: view(old),
        current: view(current),
      }),
    );
    const measured = JSON.parse(
      execFileSync(
        process.env.BRICKFORM_BENCH_PYTHON || 'python3',
        ['scripts/audit-reference-camera.py', dataPath],
        { encoding: 'utf8', timeout: 120000 },
      ),
    );
    const geometryPreserved =
      p === sha(new Uint8Array(mesh.positions.buffer)) &&
      colors === sha(mesh.colors);
    const scoreResidual = Math.abs(measured.current.score - current.confidence);
    evidence = {
      sourcePositionsSha256: p,
      sourceColorsSha256: colors,
      geometryPreserved,
      baselineCamera: old.camera,
      currentCamera: fitted.camera,
      alignment: fitted,
      independent: measured,
      scoreResidual,
      passed:
        geometryPreserved &&
        scoreResidual < 0.001 &&
        measured.current.score >= measured.baseline.score - 0.005,
    };
    sources.set(c.id, evidence);
  }
  rows.push({
    ...c,
    ...evidence,
    passed:
      !!evidence.passed &&
      JSON.stringify(fitted.camera) === JSON.stringify(evidence.currentCamera),
  });
}
const passed = rows.every((r) => r.passed);
const result = {
  date: '2026-10-01',
  conversionFingerprint: fingerprint,
  baselineRevision,
  baselineSourceSha256: sha(baselineSource),
  passed,
  scope: audit.scope,
  cases: rows,
  limits:
    'Independent projected outline/aspect replay and final-model camera correspondence; no ground-truth pose, interior pixels, intrinsic materials, arbitrary-photo success rate, procurement, complete insertion path or physical build verification.',
};
writeFileSync(
  join(directory, 'camera-results.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({ passed, cases: rows.length, uniqueInputs: sources.size }),
);
if (!passed) process.exitCode = 1;
