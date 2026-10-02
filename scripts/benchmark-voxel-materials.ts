import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { buildMeshVolume } from '../lib/mesh-design.ts';
import { designMeshSurfaces } from '../lib/surface-design.ts';
import { nearestColor, type Raster, type Model } from '../lib/brick-engine.ts';
import type { TriangleMesh } from '../lib/mesh-types.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(
  process.argv[2] || 'outputs/voxel-material-calibration',
);
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const audit = read(join(directory, 'support-results.json'));
const fingerprint = conversionFingerprint();
if (!audit.passed || audit.conversionFingerprint !== fingerprint)
  throw Error('Replay current conversions and emitted order first.');
const baselineRevision = '18d474a';
const baselineSource = execFileSync(
  'git',
  ['show', `${baselineRevision}:lib/mesh-design.ts`],
  { encoding: 'utf8' },
);
const baselinePath = join(directory, '.baseline-mesh-design.ts');
writeFileSync(
  baselinePath,
  '// @ts-nocheck\n' +
    baselineSource.replace(
      /from '(\.\/[^']+)'/g,
      (_s, ref: string) =>
        `from '${new URL(ref, new URL('../lib/mesh-design.ts', import.meta.url)).href}'`,
    ),
);
const baseline = (await import(pathToFileURL(baselinePath).href)) as {
  buildMeshVolume: typeof buildMeshVolume;
};
const fixture = (file: string) =>
  readFileSync(new URL(`../lib/fixtures/${file}`, import.meta.url));
const cache = new Map<string, TriangleMesh>();
const rows = [];
for (const row of audit.cases as {
  id: string;
  resolution: number;
  modelSha256: string;
}[]) {
  const file = row.id.startsWith('temple-')
    ? join(directory, `${row.id}-${row.resolution}.json`)
    : `outputs/image-benchmark/${row.id}/bricks-${row.resolution}.json`;
  const bytes = readFileSync(file),
    model = JSON.parse(bytes.toString()) as Model;
  if (sha(bytes) !== row.modelSha256)
    throw Error(`Model changed after order audit: ${file}`);
  let mesh = cache.get(row.id);
  if (!mesh) {
    let source: TriangleMesh, image: Raster;
    if (row.id === 'temple-original') {
      const raw = JSON.parse(
        gunzipSync(fixture('temple-original.mesh.json.gz')).toString(),
      );
      source = {
        ...raw,
        positions: Float32Array.from(raw.positions),
        colors: Uint8Array.from(raw.colors),
      };
      image = JSON.parse(
        gunzipSync(fixture('temple-original.raster.json.gz')).toString(),
      );
    } else {
      const b =
        row.id === 'temple-standard'
          ? gunzipSync(fixture('temple-standard.glb.gz'))
          : readFileSync(`outputs/image-benchmark/${row.id}/model.glb`);
      source = await readGLB(
        b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
        row.id,
      );
      const b2 =
        row.id === 'temple-standard'
          ? gunzipSync(fixture('temple-standard.rgba.gz'))
          : readFileSync(`outputs/identity-calibration/${row.id}.rgba`);
      image =
        row.id === 'temple-standard'
          ? { width: 320, height: 320, data: b2 }
          : {
              width: b2.readUInt32LE(0),
              height: b2.readUInt32LE(4),
              data: b2.subarray(8),
            };
    }
    mesh = colorFromReference(
      source,
      image,
      model.materialDesign!.alignment!.camera,
    );
    cache.set(row.id, mesh);
  }
  const positionsSha = sha(new Uint8Array(mesh.positions.buffer)),
    colorsSha = sha(mesh.colors);
  const current = buildMeshVolume(mesh, row.resolution),
    old = baseline.buildMeshVolume(mesh, row.resolution);
  const surface = designMeshSurfaces(mesh, row.resolution).mesh;
  const probePath = join(
    directory,
    `.voxel-materials-${row.id}-${row.resolution}.json`,
  );
  writeFileSync(
    probePath,
    JSON.stringify({
      positions: Array.from(surface.positions),
      resolution: row.resolution,
      colors: Array.from({ length: surface.positions.length / 9 }, (_, t) =>
        nearestColor(
          surface.colors[t * 3],
          surface.colors[t * 3 + 1],
          surface.colors[t * 3 + 2],
          true,
        ),
      ),
      design: current.voxelMaterialDesign,
    }),
  );
  const independent = JSON.parse(
    execFileSync(
      process.env.BRICKFORM_BENCH_PYTHON || 'python3',
      ['scripts/audit-voxel-materials.py', probePath],
      { encoding: 'utf8', timeout: 120000 },
    ),
  );
  let changedPaint = 0,
    addedCells = 0,
    removedCells = 0;
  for (const [key, value] of current.cells) {
    if (!old.cells.has(key)) addedCells++;
    else if (old.cells.get(key)!.color !== value.color) changedPaint++;
  }
  for (const key of old.cells.keys())
    if (!current.cells.has(key)) removedCells++;
  const sourcePreserved =
    sha(new Uint8Array(mesh.positions.buffer)) === positionsSha &&
    sha(mesh.colors) === colorsSha;
  const emittedEvidenceMatches =
    JSON.stringify(model.voxelMaterialDesign) ===
    JSON.stringify(current.voxelMaterialDesign);
  const passed =
    independent.passed &&
    sourcePreserved &&
    emittedEvidenceMatches &&
    addedCells === 0 &&
    removedCells === 0;
  rows.push({
    ...row,
    passed,
    sourcePreserved,
    sourcePositionsSha256: positionsSha,
    sourceColorsSha256: colorsSha,
    emittedEvidenceMatches,
    independent,
    design: current.voxelMaterialDesign,
    baselineCells: old.cells.size,
    currentCells: current.cells.size,
    changedPaint,
    addedCells,
    removedCells,
    bricks: model.bricks.length,
    supports: model.supportCount,
    appearance:
      'Draft; source-area correctness does not establish true material, source geometry or kit-quality appearance.',
  });
  console.log(
    JSON.stringify({
      id: row.id,
      resolution: row.resolution,
      passed,
      changedPaint,
      addedCells,
      removedCells,
    }),
  );
}
const result = {
  date: '2026-10-02',
  conversionFingerprint: fingerprint,
  baselineRevision,
  baselineSourceSha256: sha(baselineSource),
  scope: audit.scope,
  passed: rows.every((r) => r.passed),
  cases: rows,
  limits:
    'Independent physical source-area and per-material area conservation plus emitted-model evidence correspondence. Source paint/pose, sub-stud detail, geometry inference, full insertion paths, procurement and physical builds are unverified.',
};
writeFileSync(
  join(directory, 'voxel-material-results.json'),
  JSON.stringify(result, null, 2),
);
if (!result.passed) process.exitCode = 1;
