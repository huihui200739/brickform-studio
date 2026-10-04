import {
  readFileSync,
  readdirSync,
  mkdirSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { buildMeshVolume } from '../lib/mesh-design.ts';
import type { ReferenceCamera } from '../lib/reference-colors.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';
import { proposeRegionalTarget } from './regional-design/source-target.ts';
import { scoreCatalogSurface } from './regional-design/catalog-surface-score.ts';
import { IDENTITY, ASSEMBLY_PARTS } from '../lib/assembly-catalog.ts';
import type { Brick } from '../lib/brick-engine.ts';

const selectionPath = 'benchmarks/regional-design-selections-2026-10-04.json';
const selections = JSON.parse(readFileSync(selectionPath, 'utf8')) as {
  cases: {
    id: string;
    resolution: number;
    sourceGLBSha256: string;
    /** SHA of decoded RGBA bytes, dimensions are separately fixed by the cache. */
    sourceRGBASha256: string;
    camera: ReferenceCamera;
    regions: { regionId: string; sourceFaceIds: number[] }[];
  }[];
};
const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const directory = 'outputs/regional-design-calibration';
mkdirSync(directory, { recursive: true });
const filter = process.argv.slice(2);
if (filter.some((id) => !selections.cases.some((c) => c.id === id)))
  throw Error('Unknown regional diagnostic case.');
const rows: Record<string, unknown>[] = [];
for (const c of selections.cases) {
  if (filter.length && !filter.includes(c.id)) continue;
  const started = Date.now();
  let glb: Uint8Array,
    image: { width: number; height: number; data: Uint8Array };
  if (c.id === 'temple-standard') {
    glb = gunzipSync(readFileSync('lib/fixtures/temple-standard.glb.gz'));
    image = {
      width: 320,
      height: 320,
      data: gunzipSync(readFileSync('lib/fixtures/temple-standard.rgba.gz')),
    };
  } else {
    const modelPath = 'outputs/image-benchmark/house/model.glb',
      imagePath = 'outputs/identity-calibration/house.rgba';
    if (!existsSync(modelPath) || !existsSync(imagePath)) {
      rows.push({
        id: c.id,
        status: 'unavailable',
        reason: 'Optional House source cache absent.',
      });
      continue;
    }
    glb = readFileSync(modelPath);
    const bytes = readFileSync(imagePath);
    image = {
      width: bytes.readUInt32LE(0),
      height: bytes.readUInt32LE(4),
      data: bytes.subarray(8),
    };
  }
  if (sha(glb) !== c.sourceGLBSha256)
    throw Error('Frozen diagnostic source changed.');
  if (
    image.width !== 320 ||
    image.height !== 320 ||
    image.data.length !== image.width * image.height * 4 ||
    sha(image.data) !== c.sourceRGBASha256
  )
    throw Error('Frozen diagnostic reference raster changed.');
  const raw = await readGLB(
    glb.buffer.slice(
      glb.byteOffset,
      glb.byteOffset + glb.byteLength,
    ) as ArrayBuffer,
    c.id,
  );
  const source = colorFromReference(raw, image, c.camera);
  const volume = buildMeshVolume(source, c.resolution, {
    surfaceOwnership: { regions: c.regions },
  });
  const ledger = volume.surfaceOwnership!;
  const originalPositions = sha(
    new Uint8Array(
      source.positions.buffer,
      source.positions.byteOffset,
      source.positions.byteLength,
    ),
  );
  const regions = c.regions.map((r) => {
    const target = proposeRegionalTarget({
      sourceMesh: source,
      ownership: ledger,
      regionId: r.regionId,
      preserveCells: volume.protectedCells,
    });
    const arrayHash = (positions: Float32Array) =>
      sha(
        new Uint8Array(
          positions.buffer,
          positions.byteOffset,
          positions.byteLength,
        ),
      );
    // The pinned GLB reproduces complete geometry; do not duplicate whole
    // scenes as multi-megabyte numeric JSON arrays for each small patch.
    writeFileSync(
      `${directory}/${c.id}-${r.regionId}.json`,
      JSON.stringify({
        ...target,
        source: {
          positionSha256: arrayHash(target.source.positions),
          colorSha256: sha(target.source.colors),
          faces: target.source.positions.length / 9,
          observationsPresent: target.source.observationsPresent,
        },
        voxelSource: {
          positionSha256: arrayHash(target.voxelSource.positions),
          colorSha256: sha(target.voxelSource.colors),
          faces: target.voxelSource.positions.length / 9,
        },
      }),
    );
    const depth = target.depth;
    return {
      id: r.regionId,
      status: target.status,
      sourceFaces: target.sourceFaceIds.length,
      components: target.components.length,
      planeComponents: target.components.filter((p) => p.kind === 'plane')
        .length,
      boundaries: target.components
        .flatMap((p) => p.boundaries)
        .map((b) => ({
          kind: b.kind,
          vertices: b.vertices.length,
          outsideInterfaceFaces: b.interfaceSourceFaceIds.length,
        })),
      editableShellCells: target.editableShell.length,
      lockedShellCells: target.lockedShell.length,
      observations: target.observations
        ? {
            gridSamples: target.observations.gridSamples.length,
            observedGridSamples: target.observations.gridSamples.filter(
              (s) => s.observed,
            ).length,
            centroidSamples: target.observations.centroidSamples.length,
            internalCorrespondenceVerified:
              target.observations.internalCorrespondenceVerified,
          }
        : { status: 'absent' },
      depth:
        depth.status === 'collected'
          ? {
              status: depth.status,
              columns: depth.columns.length,
              crossings: depth.stats.rawCrossings,
              intervals: depth.columns.reduce(
                (n, column) => n + column.intervals.length,
                0,
              ),
              ambiguousColumns: depth.columns.filter(
                (column) => column.ambiguous,
              ).length,
              stats: depth.stats,
            }
          : depth,
      warnings: target.warnings,
      permissions: target.permissions,
    };
  });
  if (
    originalPositions !==
    sha(
      new Uint8Array(
        source.positions.buffer,
        source.positions.byteOffset,
        source.positions.byteLength,
      ),
    )
  )
    throw Error('Diagnostic mutated original geometry.');
  rows.push({
    id: c.id,
    resolution: c.resolution,
    status: 'evaluated',
    sourceGLBSha256: sha(glb),
    sourceRGBASha256: sha(image.data),
    sourcePositionSha256: originalPositions,
    camera: c.camera,
    cells: volume.cells.size,
    sparseOwnershipCells: ledger.cells.size,
    sparseContributors: ledger.contributorCount,
    regions,
    elapsedSeconds: (Date.now() - started) / 1000,
  });
  console.log(JSON.stringify({ case: c.id, regions }));
}
// A known analytic surface tests the scorer; it is neither an image-derived
// regional repair nor a buildability result. Catalog samples are not the source.
const curveSource: number[] = [];
const height = (z: number) =>
  -(24.972 - 40.972 * Math.sqrt(1 - (((z - 2) * 20 - 20) / 56.56854) ** 2)) /
  20;
for (let i = 0; i < 96; i++) {
  const z0 = 1 + i / 48,
    z1 = 1 + (i + 1) / 48;
  curveSource.push(
    1,
    height(z0),
    z0,
    1,
    height(z1),
    z1,
    3,
    height(z1),
    z1,
    1,
    height(z0),
    z0,
    3,
    height(z1),
    z1,
    3,
    height(z0),
    z0,
  );
}
const posedPart = (
  id: number,
  part: string,
  position: [number, number, number],
): Brick => ({
  id,
  part,
  x: 0,
  y: 0,
  z: 0,
  w: ASSEMBLY_PARTS[part].w,
  d: ASSEMBLY_PARTS[part].d,
  h: ASSEMBLY_PARTS[part].h,
  color: 7,
  pose: { position, matrix: [...IDENTITY] },
});
const scoreControl = (bricks: Brick[]) =>
  scoreCatalogSurface({
    source: { positions: curveSource, completeOcclusionGeometry: true },
    model: { width: 4, depth: 4, bricks },
    completeCandidateOcclusionGeometry: true,
    views: [[0, 1, 0]],
    sampleSpacingStuds: 0.12,
    maxRayDistanceStuds: 8,
  });
const catalogControl = {
  curve: scoreControl([posedPart(1, '15068', [0, 0, 0])]),
  staircase: scoreControl([
    posedPart(1, '3069b', [0, -8, -10]),
    posedPart(2, '3069b', [0, -16, 10]),
  ]),
};
if (
  catalogControl.curve.status !== 'scored' ||
  catalogControl.staircase.status !== 'scored' ||
  !(
    catalogControl.curve.symmetricRmsStuds + 0.08 <
    catalogControl.staircase.symmetricRmsStuds
  )
)
  throw Error('Known curved-part scoring control failed.');
const experimentalFiles = [
  'scripts/benchmark-regional-design.ts',
  ...readdirSync('scripts/regional-design')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => `scripts/regional-design/${f}`),
].sort();
const experimentHash = createHash('sha256').update('regional-design-v1\0');
for (const file of experimentalFiles)
  experimentHash
    .update(file)
    .update('\0')
    .update(readFileSync(file))
    .update('\0');
const summary = {
  date: '2026-10-04',
  conversionFingerprint: conversionFingerprint(),
  experimentalCodeFingerprint: experimentHash.digest('hex'),
  selectionSha256: sha(readFileSync(selectionPath)),
  cases: rows,
  catalogControl,
  catalogGeometrySha256: sha(readFileSync('public/parts/geometry.json')),
  generationChanged: false,
  appearanceAccepted: false,
  softwareLayoutAccepted: false,
  scope: [
    'Frozen diagnostic face regions; no detection, neural inference, material model or camera refit.',
    'Source ownership is a necessary constraint, not noise identity or permission to edit.',
    'Only source targets evaluated; no final layout, packing, procurement, assembly or physical acceptance.',
    'Stored raw and designed mesh snapshots are separate; source ray pairs retain gaps and ambiguous crossings.',
    'Baseline protected cells applied; final construction/component constraints require final model input and are not certified by this source-only replay.',
  ],
};
writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
console.log(`Saved ${directory}/summary.json`);
