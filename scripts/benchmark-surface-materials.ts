import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readGLB } from '../lib/read-glb.ts';
import {
  colorFromReference,
  referenceAlignment,
} from '../lib/reference-colors.ts';
import { referenceVisibility } from '../lib/reference-visibility.ts';
import { referenceMaterials } from '../lib/reference-materials.ts';
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
// Pin the old visibility and face-center sampling rules. Both versions share
// current alignment; paint changes are measured, not treated as regressions.
// New visibility is checked separately by independent 3D ray intersections.
const baselineRevision = 'ddf9d98';
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
    let removedObservations = 0,
      gainedObservations = 0;
    let changedObserved = 0,
      changedObservedFeatures = 0,
      incorrectInferred = 0,
      changedUnobserved = 0;
    for (let t = 0; t < evidence.regionIds.length; t++) {
      const id = evidence.regionIds[t];
      if (old.materialEvidence!.observed[t] && !evidence.observed[t])
        removedObservations++;
      if (!old.materialEvidence!.observed[t] && evidence.observed[t])
        gainedObservations++;
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
    const aligned = referenceAlignment(mesh, image, camera);
    const coords = new Float64Array(mesh.positions.length);
    const v = aligned.view;
    for (let i = 0; i < coords.length; i += 3) {
      const q = v.point(
        mesh.positions[i],
        mesh.positions[i + 1],
        mesh.positions[i + 2],
      );
      coords[i] = ((q[0] - v.minX) / (v.maxX - v.minX)) * 191;
      coords[i + 1] = ((v.maxY - q[1]) / (v.maxY - v.minY)) * 191;
      coords[i + 2] = q[2];
    }
    const visibility = referenceVisibility(
      coords,
      aligned.extent,
      aligned.camera.perspective,
      192,
    );
    const palette = referenceMaterials(image, aligned.mask, true).palette;
    const faceVotes = new Uint32Array(evidence.observed.length * rgb.length);
    const faceSamples = new Uint32Array(evidence.observed.length);
    const imagePixel = (x: number, y: number) => {
      const px = Math.round(
        aligned.left + (x / 191) * (aligned.right - aligned.left),
      );
      const py = Math.round(
        aligned.top + (y / 191) * (aligned.bottom - aligned.top),
      );
      if (px < 0 || px >= image.width || py < 0 || py >= image.height)
        return -1;
      const k = py * image.width + px;
      return aligned.mask[k] ? k : -1;
    };
    const groups: Record<
      string,
      {
        x: number;
        y: number;
        expectedFace: number;
        expectedDepth: number;
        kind: string;
      }[]
    > = {
      'visible-pixel': [],
      'visible-microface-centroid': [],
      'occluded-centroid': [],
    };
    for (let y = 0; y < 192; y++)
      for (let x = 0; x < 192; x++) {
        const face = visibility.pixelFace[y * 192 + x],
          k = imagePixel(x + 0.5, y + 0.5);
        if (face < 0 || k < 0) continue;
        faceVotes[face * rgb.length + palette[k]]++;
        faceSamples[face]++;
        groups['visible-pixel'].push({
          x: x + 0.5,
          y: y + 0.5,
          expectedFace: face,
          expectedDepth: visibility.depthAt(face, x + 0.5, y + 0.5),
          kind: 'visible-pixel',
        });
      }
    let incorrectObserved = 0,
      incorrectPaint = 0;
    for (let t = 0; t < faceSamples.length; t++) {
      if (!faceSamples[t]) {
        const i = t * 9;
        const x = (coords[i] + coords[i + 3] + coords[i + 6]) / 3;
        const y = (coords[i + 1] + coords[i + 4] + coords[i + 7]) / 3;
        const z = visibility.depthAt(t, x, y),
          k = imagePixel(x, y);
        if (!Number.isFinite(z) || k < 0) continue;
        const nearest = visibility.frontAt(x, y);
        const visible = z >= nearest.depth - visibility.tolerance;
        const kind = visible
          ? 'visible-microface-centroid'
          : 'occluded-centroid';
        groups[kind].push({
          x,
          y,
          expectedFace: nearest.face,
          expectedDepth: nearest.depth,
          kind,
        });
        if (visible) {
          faceVotes[t * rgb.length + palette[k]]++;
          faceSamples[t]++;
        }
      }
      if (!!faceSamples[t] !== !!evidence.observed[t]) incorrectObserved++;
      if (!faceSamples[t]) continue;
      let color = 0;
      for (let c = 1; c < rgb.length; c++)
        if (faceVotes[t * rgb.length + c] > faceVotes[t * rgb.length + color])
          color = c;
      if (rgb[color].some((value, k) => value !== result.colors[t * 3 + k]))
        incorrectPaint++;
    }
    const queries = Object.values(groups).flatMap((group) =>
      Array.from(
        { length: Math.min(32, group.length) },
        (_, i) =>
          group[Math.floor((i * group.length) / Math.min(32, group.length))],
      ),
    );
    const queryPath = join(directory, `.visibility-${row.id}.json`);
    writeFileSync(
      queryPath,
      JSON.stringify({
        positions: Array.from(mesh.positions),
        camera: aligned.camera,
        bounds: [v.minX, v.maxX, v.minY, v.maxY],
        queries,
      }),
    );
    const independentVisibility = JSON.parse(
      execFileSync(
        process.env.BRICKFORM_BENCH_PYTHON || 'python3',
        ['scripts/audit-reference-visibility.py', queryPath],
        { encoding: 'utf8', timeout: 120000 },
      ),
    );
    const geometryPreserved =
      result.positions === mesh.positions &&
      sha(new Uint8Array(mesh.positions.buffer)) === positionsSha &&
      sha(mesh.colors) === colorsSha;
    const passed =
      geometryPreserved &&
      independentVisibility.passed &&
      !incorrectObserved &&
      !incorrectPaint &&
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
      removedObservations,
      gainedObservations,
      independentVisibility,
      incorrectObserved,
      incorrectPaint,
      visibility: projection,
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
    'Independent 3D rays sample visible pixels, subpixel face centroids and occluded centroids (up to 32 each per source). All face observation/paint votes and inferred provenance are replayed using the production projection; rays are not exhaustive. Old paint and foliage changes are reported, not required to be zero. No true pose, intrinsic/hidden-material ground truth, arbitrary-photo success rate, procurement, forces or physical build verification.',
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
