import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { rgb } from '../lib/material-color-space.ts';
import type { Raster, Model } from '../lib/brick-engine.ts';
import type { TriangleMesh } from '../lib/mesh-types.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(
  process.argv[2] || 'outputs/surface-material-calibration',
);
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const audit = read(join(directory, 'support-results.json'));
const current = conversionFingerprint();
if (!audit.passed || audit.conversionFingerprint !== current)
  throw Error('Replay the current conversions and emitted order first.');
// Keep the comparison implementation pinned to the last height-band version.
// Compare paint at the SAME current alignment. Camera changes legitimately
// move samples, so the baseline alignment is replaced explicitly, while its
// original face colors, features and height-band inference are preserved.
const baselineRevision = '12a4064';
const baselineSource = execFileSync(
  'git',
  ['show', `${baselineRevision}:lib/reference-colors.ts`],
  { encoding: 'utf8' },
);
const baselineFile = join(directory, '.baseline-reference-colors.ts');
writeFileSync(
  baselineFile,
  '// @ts-nocheck\n' +
    `import { referenceAlignment } from '${new URL('../lib/reference-colors.ts', import.meta.url).href}';\n` +
    baselineSource
      .replace(
        'export function referenceAlignment(',
        'function legacyReferenceAlignment(',
      )
      .replace(
        /from '(\.\/[^']+)'/g,
        (_s, ref: string) =>
          `from '${new URL(ref, new URL('../lib/reference-colors.ts', import.meta.url)).href}'`,
      ),
);
const baseline = (await import(pathToFileURL(baselineFile).href)) as {
  colorFromReference: typeof colorFromReference;
};
const cache = new Map<string, Record<string, unknown>>();
let failed = false;
const cases: (Record<string, unknown> & { id: string; passed: boolean })[] = [];
for (const row of audit.cases as {
  id: string;
  resolution: number;
  modelSha256: string;
}[]) {
  const modelPath = row.id.startsWith('temple-')
    ? join(directory, `${row.id}-${row.resolution}.json`)
    : `outputs/image-benchmark/${row.id}/bricks-${row.resolution}.json`;
  const bytes = readFileSync(modelPath),
    model = JSON.parse(bytes.toString()) as Model;
  if (sha(bytes) !== row.modelSha256)
    throw Error(`Model changed after emitted-order audit: ${modelPath}`);
  let sourceEvidence = cache.get(row.id);
  if (!sourceEvidence) {
    let mesh: TriangleMesh, image: Raster;
    const fixture = (name: string) =>
      readFileSync(new URL(`../lib/fixtures/${name}`, import.meta.url));
    if (row.id === 'temple-original') {
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
      const glb =
        row.id === 'temple-standard'
          ? gunzipSync(fixture('temple-standard.glb.gz'))
          : readFileSync(`outputs/image-benchmark/${row.id}/model.glb`);
      mesh = await readGLB(
        glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
        row.id,
      );
      if (row.id === 'temple-standard')
        image = {
          width: 320,
          height: 320,
          data: gunzipSync(fixture('temple-standard.rgba.gz')),
        };
      else {
        const rgba = readFileSync(
          `outputs/identity-calibration/${row.id}.rgba`,
        );
        image = {
          width: rgba.readUInt32LE(0),
          height: rgba.readUInt32LE(4),
          data: rgba.subarray(8),
        };
      }
    }
    const positionsSha = sha(new Uint8Array(mesh.positions.buffer)),
      colorsSha = sha(mesh.colors);
    const camera = model.materialDesign?.alignment?.camera;
    const old = baseline.colorFromReference(mesh, image, camera),
      result = colorFromReference(mesh, image, camera);
    const regions = result.materialDesign!.surfaces!.regions,
      evidence = result.materialEvidence!;
    const inferredCounts = Array(regions.length).fill(0),
      observedCounts = Array(regions.length).fill(0);
    let changedObserved = 0,
      changedObservedFeatures = 0,
      incorrectInferred = 0,
      changedUnobserved = 0;
    for (let t = 0; t < evidence.regionIds.length; t++) {
      const id = evidence.regionIds[t];
      if (evidence.observed[t]) {
        observedCounts[id]++;
        if (
          [0, 1, 2].some(
            (k) => result.colors[t * 3 + k] !== old.colors[t * 3 + k],
          )
        )
          changedObserved++;
        if (result.features![t] !== old.features![t]) changedObservedFeatures++;
      } else {
        inferredCounts[id]++;
        if (
          [0, 1, 2].some(
            (k) => result.colors[t * 3 + k] !== rgb[regions[id].color][k],
          )
        )
          incorrectInferred++;
        if (
          [0, 1, 2].some(
            (k) => result.colors[t * 3 + k] !== old.colors[t * 3 + k],
          )
        )
          changedUnobserved++;
      }
    }
    const incorrectCounts = regions.filter(
      (r) =>
        r.observedFaces !== observedCounts[r.id] ||
        r.inferredFaces !== inferredCounts[r.id],
    ).length;
    const lo = [Infinity, Infinity, Infinity],
      hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < mesh.positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], mesh.positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], mesh.positions[i]);
    }
    const extent = Math.max(...hi.map((v, k) => v - lo[k]));
    const incorrectDonors = regions.filter(
      (r) =>
        r.source === 'compatible-surface' &&
        (!r.donorRegionIds.length ||
          r.donorRegionIds.some((id) => {
            const d = regions[id];
            return (
              !d ||
              d.observedPixels < 8 ||
              d.area < extent * extent * 0.001 ||
              Math.abs(Math.abs(r.normal[1]) - Math.abs(d.normal[1])) >
                0.120001 ||
              r.normal[1] * d.normal[1] < -0.100001 ||
              Math.hypot(...r.center.map((v, k) => v - d.center[k])) / extent >=
                0.800001
            );
          })),
    ).length;
    const pixels = regions.reduce((n, r) => n + r.observedPixels, 0),
      materialPixels = Array(rgb.length).fill(0);
    for (const r of regions)
      for (let c = 0; c < materialPixels.length; c++)
        materialPixels[c] += r.materialPixels[c];
    const projection = result.materialDesign!.projection!;
    const geometryPreserved =
      result.positions === mesh.positions &&
      sha(new Uint8Array(mesh.positions.buffer)) === positionsSha &&
      sha(mesh.colors) === colorsSha;
    const passed =
      geometryPreserved &&
      !changedObserved &&
      !changedObservedFeatures &&
      !incorrectInferred &&
      !incorrectCounts &&
      !incorrectDonors &&
      pixels === projection.projectedPixels &&
      materialPixels.every((v, i) => v === projection.materialPixels[i]);
    sourceEvidence = {
      passed,
      sourcePositionsSha256: positionsSha,
      sourceColorsSha256: colorsSha,
      triangles: mesh.positions.length / 9,
      geometryPreserved,
      changedObserved,
      changedObservedFeatures,
      changedUnobserved,
      incorrectInferred,
      incorrectCounts,
      incorrectDonors,
      observedFaces: projection.observedFaces,
      inferredFaces: projection.inferredFaces,
      projectedPixels: pixels,
      regions: regions.length,
      localInferenceFaces: regions
        .filter((r) => r.source === 'local-observation')
        .reduce((n, r) => n + r.inferredFaces, 0),
      compatibleInferenceFaces: regions
        .filter((r) => r.source === 'compatible-surface')
        .reduce((n, r) => n + r.inferredFaces, 0),
      defaultFaces: result.materialDesign!.surfaces!.defaultFaces,
    };
    cache.set(row.id, sourceEvidence);
  }
  const passed =
    !!sourceEvidence.passed &&
    model.materialDesign?.surfaces?.method === 'connected-surface-materials' &&
    model.materialDesign.surfaces.inferredFaces ===
      sourceEvidence.inferredFaces;
  if (!passed) failed = true;
  cases.push({
    ...row,
    ...sourceEvidence,
    passed,
    bricks: model.bricks.length,
    supports: model.supportCount,
    appearance:
      'Draft; inferred surface color is not ground-truth material or kit-quality verification.',
  });
}
const result = {
  date: '2026-10-01',
  conversionFingerprint: current,
  baselineRevision,
  baselineSourceSha256: sha(baselineSource),
  comparisonAlignment:
    'Current alignment and final-model camera shared by both paint implementations; historical camera selection is not replayed.',
  scope: audit.scope,
  passed: !failed,
  cases,
  limits:
    'Preservation of valid observed colors, source geometry, pixel votes and inferred material provenance; no hidden-material ground truth. Hard shadows, reflections, pose errors, native geometry errors, procurement, forces and physical build remain unverified.',
};
writeFileSync(
  join(directory, 'surface-material-results.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: !failed,
    cases: cases.length,
    uniqueInputs: cache.size,
    changedObserved: cases.reduce((n, c) => n + Number(c.changedObserved), 0),
  }),
);
if (failed) process.exitCode = 1;
