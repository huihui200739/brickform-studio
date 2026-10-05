import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { readGLB } from '../lib/read-glb.ts';
import {
  colorFromReference,
  type ReferenceCamera,
} from '../lib/reference-colors.ts';
import { buildMeshVolume } from '../lib/mesh-design.ts';
import type { Model } from '../lib/brick-engine.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';
import { selectAxisRegions } from './regional-design/axis-regions.ts';
import { normalizeSourceMesh } from './regional-design/catalog-surface-score.ts';
import {
  proposeExteriorLayouts,
  type ExteriorLayoutResult,
} from './regional-design/exterior-layout.ts';

// Replays existing native GLBs and complete models. No image/native inference,
// production edits or arbitrary face-prefix truncation occur in this command.
const sha = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
const selectionsPath = 'benchmarks/regional-design-selections-2026-10-04.json';
const selections = JSON.parse(readFileSync(selectionsPath, 'utf8')) as {
  cases: {
    id: string;
    resolution: number;
    sourceGLBSha256: string;
    sourceRGBASha256: string;
    camera: ReferenceCamera;
    regions: { regionId: string; sourceFaceIds: number[] }[];
  }[];
};
const baselineArgument = process.argv
  .slice(2)
  .find((arg) => arg.startsWith('--baseline-evidence='));
const priorPath = baselineArgument
  ? baselineArgument.slice('--baseline-evidence='.length)
  : 'benchmarks/regional-exterior-layout-2026-10-04.json';
const prior = JSON.parse(readFileSync(priorPath, 'utf8')) as {
  conversionFingerprint: string;
  cases: {
    id: string;
    resolution: number;
    sourceGLBSha256: string;
    sourceRGBASha256: string;
    sourcePositionSha256: string;
    camera: ReferenceCamera;
    finalModel: { modelSha256: string; recordedSceneSha256: string };
  }[];
};
const productionFingerprint = conversionFingerprint();
const experimentFiles = [
  'scripts/benchmark-exterior-regions.ts',
  ...readdirSync('scripts/regional-design')
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => `scripts/regional-design/${f}`),
].sort();
const experimentHash = createHash('sha256').update('automatic-exterior-v1\0');
for (const file of experimentFiles)
  experimentHash
    .update(file)
    .update('\0')
    .update(readFileSync(file))
    .update('\0');
const directory = 'outputs/automatic-exterior-calibration';
mkdirSync(directory, { recursive: true });
const filter = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith('--baseline-evidence='));
if (filter.some((id) => !selections.cases.some((c) => c.id === id)))
  throw Error('Unknown exterior case.');
const rows: Record<string, unknown>[] = [];
const summarize = (result: ExteriorLayoutResult) => ({
  ...result,
  model: undefined,
  candidates: result.candidates.map((c) => ({
    attempt: c.attempt,
    improvement: c.improvement,
    softwareCandidate: c.softwareCandidate,
    layout: {
      strategy: c.layout.strategy,
      removedIDs: c.layout.removedIDs,
      addedIDs: c.layout.addedIDs,
      reconstructedSupportIDs: c.layout.reconstructedSupportIDs,
      changedCells: c.layout.changedCells,
      boundary: c.layout.boundary,
      baselineScore: c.layout.baselineScore,
      score: c.layout.score,
    },
    audit: c.audit ? { ...c.audit, model: undefined } : undefined,
  })),
});
for (const c of selections.cases) {
  if (filter.length && !filter.includes(c.id)) continue;
  const started = Date.now();
  const temple = c.id === 'temple-standard';
  const glbPath = temple
    ? 'lib/fixtures/temple-standard.glb.gz'
    : 'outputs/image-benchmark/house/model.glb';
  const rgbaPath = temple
    ? 'lib/fixtures/temple-standard.rgba.gz'
    : 'outputs/identity-calibration/house.rgba';
  const scenePath = temple
    ? 'lib/fixtures/temple-standard.scene.json'
    : 'outputs/identity-calibration/house.scene.json';
  const modelPath = `outputs/regional-design-calibration/${c.id}-baseline-current.json`;
  if (![glbPath, rgbaPath, scenePath, modelPath].every(existsSync)) {
    rows.push({
      id: c.id,
      status: 'unavailable',
      reasons: ['complete matched local replay inputs absent'],
    });
    continue;
  }
  const glb = temple
    ? gunzipSync(readFileSync(glbPath))
    : readFileSync(glbPath);
  const rgba = readFileSync(rgbaPath);
  const image = temple
    ? { width: 320, height: 320, data: gunzipSync(rgba) }
    : {
        width: rgba.readUInt32LE(0),
        height: rgba.readUInt32LE(4),
        data: rgba.subarray(8),
      };
  const modelBytes = readFileSync(modelPath);
  const sceneBytes = readFileSync(scenePath);
  const old = prior.cases.find((row) => row.id === c.id);
  if (
    !old ||
    prior.conversionFingerprint !== productionFingerprint ||
    old.resolution !== c.resolution ||
    sha(glb) !== c.sourceGLBSha256 ||
    sha(glb) !== old.sourceGLBSha256 ||
    sha(image.data) !== c.sourceRGBASha256 ||
    sha(image.data) !== old.sourceRGBASha256 ||
    image.width !== 320 ||
    image.height !== 320 ||
    image.data.length !== 320 * 320 * 4 ||
    JSON.stringify(c.camera) !== JSON.stringify(old.camera) ||
    sha(sceneBytes) !== old.finalModel.recordedSceneSha256 ||
    sha(modelBytes) !== old.finalModel.modelSha256
  )
    throw Error('Frozen baseline/source/camera provenance changed.');
  const raw = await readGLB(
    glb.buffer.slice(
      glb.byteOffset,
      glb.byteOffset + glb.byteLength,
    ) as ArrayBuffer,
    c.id,
  );
  const positionsSha256 = sha(
    new Uint8Array(
      raw.positions.buffer,
      raw.positions.byteOffset,
      raw.positions.byteLength,
    ),
  );
  if (positionsSha256 !== old.sourcePositionSha256)
    throw Error('Complete original positions differ.');
  const min = [Infinity, Infinity, Infinity] as [number, number, number];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < raw.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], raw.positions[i]);
    max[i % 3] = Math.max(max[i % 3], raw.positions[i]);
  }
  const scale = c.resolution / Math.max(...max.map((v, i) => v - min[i]));
  const positions = normalizeSourceMesh(raw.positions, min, scale);
  const baseline = JSON.parse(modelBytes.toString()) as Model;
  const volume = buildMeshVolume(
    colorFromReference(raw, image, c.camera),
    c.resolution,
  );
  const preservedCells = [...volume.protectedCells].sort();
  const enumeration = selectAxisRegions({
    source: { positions, complete: true },
  });
  if (
    enumeration.status === 'unavailable' ||
    !enumeration.completeEnumeration
  ) {
    rows.push({ id: c.id, status: 'unresolved', enumeration });
    continue;
  }
  // The enumeration cap is not raised. Explicit sequential batches resolve
  // ONLY the scheduling reason, retaining all other geometry/face limits.
  const eligible = enumeration.regions.filter(
    (r) =>
      r.status === 'usable' ||
      (r.status === 'unresolved' &&
        r.reasons.length === 1 &&
        r.reasons[0] === 'usable_region_limit_exceeded'),
  );
  const batches = Array.from(
    { length: Math.ceil(eligible.length / 64) },
    (_, i) => eligible.slice(i * 64, (i + 1) * 64),
  );
  const reasonCounts: Record<string, number> = {};
  for (const r of enumeration.regions)
    for (const reason of r.reasons)
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
  const regional: Record<string, unknown>[] = [];
  const manifest = eligible.map((r) => ({
    ...r,
    schedulingStatus: 'explicit-batch',
    batch: Math.floor(eligible.indexOf(r) / 64),
  }));
  const manifestPath = `${directory}/${c.id}-selection.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const run = (
    name: string,
    faceIds: number[],
    axis: 0 | 1 | 2,
    direction: -1 | 1,
    compound: boolean,
    batch: number | null,
  ) => {
    const t = Date.now();
    const result = proposeExteriorLayouts({
      source: { positions, faceIds, complete: true },
      axis,
      direction,
      ...(compound
        ? { coverageMode: 'piecewise-exterior-envelope' as const }
        : {}),
      baselineModel: baseline,
      preserveCells: volume.protectedCells,
    });
    let finalist: { modelPath: string; modelSha256: string } | undefined;
    if (result.status === 'software-candidate') {
      const candidatePath = `${directory}/${c.id}-${name}-candidate.json`;
      writeFileSync(candidatePath, JSON.stringify(result.model));
      finalist = {
        modelPath: candidatePath,
        modelSha256: sha(readFileSync(candidatePath)),
      };
    }
    const row = {
      name,
      batch,
      selection: compound
        ? 'manual-compound-control'
        : 'automatic-complete-source-region',
      axis,
      direction,
      sourceFaces: faceIds.length,
      sourceFaceIdsSha256: sha(JSON.stringify(faceIds)),
      ...summarize(result),
      finalist,
      elapsedSeconds: (Date.now() - t) / 1000,
    };
    regional.push(row);
    writeFileSync(
      `${directory}/${c.id}-${name}-result.json`,
      JSON.stringify(row),
    );
    if (result.candidates.length || result.status === 'software-candidate')
      console.log(
        JSON.stringify({
          case: c.id,
          name,
          status: result.status,
          editableCells: result.editableCells.length,
          improving: result.candidates.filter(
            (r) => r.improvement.status === 'improving',
          ).length,
          softwareCandidates: result.softwareCandidateIndices.length,
          seconds: row.elapsedSeconds,
        }),
      );
  };
  // Compound controls are not promoted into the automatic selector.
  if (temple)
    for (const r of c.regions)
      run(`compound-${r.regionId}`, r.sourceFaceIds, 2, 1, true, null);
  for (let batch = 0; batch < Math.min(batches.length, 4); batch++) {
    for (const r of batches[batch])
      run(
        `axis-${r.sourceFaceIds[0]}`,
        r.sourceFaceIds,
        r.axis!,
        r.direction!,
        false,
        batch,
      );
    console.log(
      JSON.stringify({
        case: c.id,
        finishedBatch: batch + 1,
        totalBatches: batches.length,
      }),
    );
  }
  if (
    positionsSha256 !==
      sha(
        new Uint8Array(
          raw.positions.buffer,
          raw.positions.byteOffset,
          raw.positions.byteLength,
        ),
      ) ||
    sha(modelBytes) !== sha(readFileSync(modelPath))
  )
    throw Error('Replay mutated its source or baseline.');
  const statusCounts: Record<string, number> = {};
  for (const r of regional)
    statusCounts[String(r.status)] = (statusCounts[String(r.status)] ?? 0) + 1;
  rows.push({
    id: c.id,
    status: 'evaluated',
    resolution: c.resolution,
    sourceGLBSha256: sha(glb),
    sourceRGBASha256: sha(image.data),
    sourcePositionSha256: positionsSha256,
    camera: c.camera,
    baselineModelSha256: sha(modelBytes),
    recordedSceneSha256: sha(sceneBytes),
    baselineParts: baseline.bricks.length,
    normalization: {
      min,
      scale,
      physicalOffset: [1, 0.8, 1],
      plateHeight: 0.4,
    },
    preserveCells: {
      count: preservedCells.length,
      sha256: sha(JSON.stringify(preservedCells)),
    },
    enumeration: {
      status: enumeration.status,
      completeEnumeration: enumeration.completeEnumeration,
      stats: enumeration.stats,
      reasons: enumeration.reasons,
      reasonCounts,
    },
    scheduling: {
      mode: 'explicit-sequential-batches',
      regionsPerBatch: 64,
      maxBatches: 4,
      batches: batches.length,
      processedAutomaticRegions: regional.filter(
        (r) => r.selection !== 'manual-compound-control',
      ).length,
      unprocessedSeeds: batches
        .slice(4)
        .flat()
        .map((r) => r.sourceFaceIds[0]),
      allGeometryEligibleProcessed: batches.length <= 4,
      selectionPath: manifestPath,
      selectionSha256: sha(readFileSync(manifestPath)),
    },
    statusCounts,
    regions: regional,
    elapsedSeconds: (Date.now() - started) / 1000,
  });
  writeFileSync(
    `${directory}/summary.json`,
    JSON.stringify({
      conversionFingerprint: productionFingerprint,
      experimentalCodeFingerprint: experimentHash.copy().digest('hex'),
      cases: rows,
    }),
  );
  console.log(
    JSON.stringify({
      case: c.id,
      eligibleRegions: eligible.length,
      statusCounts,
      seconds: (Date.now() - started) / 1000,
    }),
  );
}
writeFileSync(
  `${directory}/summary.json`,
  JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    conversionFingerprint: productionFingerprint,
    experimentalCodeFingerprint: experimentHash.digest('hex'),
    selectionInputSha256: sha(readFileSync(selectionsPath)),
    priorEvidenceSha256: sha(readFileSync(priorPath)),
    cases: rows,
    scope: 'independent-source-defined-exterior-candidates',
    cachedInferenceOnly: true,
    productionGenerationChanged: false,
    candidatesCombined: false,
    sourceTruthVerified: false,
    appearanceAccepted: false,
    fullInsertionPathVerified: false,
    physicalBuildVerified: false,
    accepted: false,
    userPhysicalTrialPreference: 'deferred; complete software first',
  }),
);
