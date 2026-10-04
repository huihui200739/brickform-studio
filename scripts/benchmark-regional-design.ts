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
import { validateModel, type Brick, type Model } from '../lib/brick-engine.ts';
import { detectRefinements } from '../lib/semantic-refinement.ts';
import { meshToDesignAuto } from '../lib/mesh-design.ts';
import {
  VisionSceneDetector,
  type VisionSceneResponse,
} from '../lib/scene/detectors/vision-detector.ts';
import {
  proposeUprightLayouts,
  type UprightLayoutInput,
} from './regional-design/upright-layout.ts';
import { normalizeSourceMesh } from './regional-design/catalog-surface-score.ts';
import { procurementReport } from '../lib/purchase-inventory.ts';
import { proposeExteriorVoid } from './regional-design/exterior-void.ts';
import {
  auditLayoutAssembly,
  supportInterfaceParts,
} from './regional-design/layout-assembly.ts';

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
const withLayouts = process.argv.includes('--layouts');
const reuseBaseline = process.argv.includes('--reuse-baseline');
const repackBoundary = process.argv.includes('--repack-boundary');
const sourceExterior = process.argv.includes('--source-exterior');
if (sourceExterior && !repackBoundary)
  throw Error('--source-exterior requires --repack-boundary and --layouts.');
if (repackBoundary && !withLayouts)
  throw Error('--repack-boundary requires --layouts.');
if (reuseBaseline && !withLayouts)
  throw Error('--reuse-baseline requires --layouts.');
const productionFingerprint = conversionFingerprint();
const cachedRun = reuseBaseline
  ? (JSON.parse(readFileSync(`${directory}/summary.json`, 'utf8')) as {
      conversionFingerprint: string;
      cases: {
        id: string;
        resolution: number;
        sourceGLBSha256: string;
        sourceRGBASha256: string;
        camera: ReferenceCamera;
        finalModel?: { modelSha256: string; recordedSceneSha256: string };
      }[];
    })
  : undefined;
const filter = process.argv
  .slice(2)
  .filter(
    (arg) =>
      ![
        '--layouts',
        '--reuse-baseline',
        '--repack-boundary',
        '--source-exterior',
      ].includes(arg),
  );
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
  let finalModel: Model | undefined;
  let sceneSha256: string | undefined;
  if (withLayouts) {
    const sceneBytes = readFileSync(
      c.id === 'temple-standard'
        ? 'lib/fixtures/temple-standard.scene.json'
        : 'outputs/identity-calibration/house.scene.json',
    );
    sceneSha256 = sha(sceneBytes);
    if (reuseBaseline) {
      const entry = cachedRun?.cases.find((row) => row.id === c.id);
      const bytes = readFileSync(`${directory}/${c.id}-baseline-current.json`);
      if (
        cachedRun?.conversionFingerprint !== productionFingerprint ||
        !entry?.finalModel ||
        entry.resolution !== c.resolution ||
        entry.sourceGLBSha256 !== sha(glb) ||
        entry.sourceRGBASha256 !== sha(image.data) ||
        JSON.stringify(entry.camera) !== JSON.stringify(c.camera) ||
        entry.finalModel.recordedSceneSha256 !== sceneSha256 ||
        entry.finalModel.modelSha256 !== sha(bytes)
      )
        throw Error(
          'Baseline provenance differs; rerun --layouts without cache reuse.',
        );
      finalModel = JSON.parse(bytes.toString()) as Model;
    } else {
      const scene = JSON.parse(sceneBytes.toString()) as VisionSceneResponse;
      const refinements = await detectRefinements(
        source,
        image,
        c.resolution,
        undefined,
        c.camera,
        new VisionSceneDetector(async () => scene),
      );
      finalModel = meshToDesignAuto(source, c.resolution, refinements, 48, {
        image,
        camera: c.camera,
      }).model;
      writeFileSync(
        `${directory}/${c.id}-baseline-current.json`,
        JSON.stringify(finalModel),
      );
    }
  }
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
      baselineParts: finalModel?.bricks,
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
    const normalizedSource = normalizeSourceMesh(
      source.positions,
      ledger.normalization.min,
      ledger.normalization.scale,
    );
    const component =
      target.components.length === 1 ? target.components[0] : undefined;
    const axis = component?.normal
      .map(Math.abs)
      .indexOf(Math.max(...component.normal.map(Math.abs))) as
      | 0
      | 1
      | 2
      | undefined;
    const exterior =
      sourceExterior && finalModel && component && axis !== undefined
        ? proposeExteriorVoid({
            source: {
              positions: normalizedSource,
              faceIds: target.sourceFaceIds,
              complete: true,
            },
            model: finalModel,
            axis,
            direction: component.normal[axis] > 0 ? 1 : -1,
          })
        : undefined;
    const deletes = new Set(
      exterior?.status === 'candidate' ? exterior.emptyBodyCells : [],
    );
    const lockedIDs = new Set(target.lockedParts.map((part) => part.id));
    const reconstructSupportIds = new Set<number>();
    const editable = new Set(target.editableShell);
    const intended = new Map<string, { color: number }>();
    if (sourceExterior && finalModel) {
      // A source void cannot override active construction or protected joints.
      for (const b of finalModel.bricks) {
        let touchesVoid = false;
        for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
          for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
            for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++)
              if (deletes.has(`${x},${y},${z}`)) touchesVoid = true;
        const rebuildSupport =
          !!b.support &&
          touchesVoid &&
          !b.construction &&
          !b.installation &&
          !b.colorChoice &&
          !b.section?.startsWith('component-') &&
          ['brick', 'plate'].includes(ASSEMBLY_PARTS[b.part]?.kind);
        if (rebuildSupport) reconstructSupportIds.add(b.id);
        const protectedPart =
          (lockedIDs.has(b.id) && !rebuildSupport) ||
          (b.support && !rebuildSupport) ||
          b.construction ||
          b.installation ||
          b.colorChoice ||
          b.section?.startsWith('component-') ||
          !['brick', 'plate'].includes(ASSEMBLY_PARTS[b.part]?.kind);
        for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
          for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
            for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++) {
              const k = `${x},${y},${z}`;
              if (protectedPart || volume.protectedCells.has(k))
                deletes.delete(k);
            }
      }
      for (const k of deletes) editable.add(k);
      for (const b of finalModel.bricks)
        for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.w); x++)
          for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.h); y++)
            for (let z = Math.floor(b.z); z < Math.ceil(b.z + b.d); z++) {
              const k = `${x},${y},${z}`;
              if (editable.has(k) && !deletes.has(k))
                intended.set(k, { color: b.color });
            }
    }
    const layoutInput: UprightLayoutInput | undefined =
      finalModel && (target.status === 'ready-for-layout' || deletes.size > 0)
        ? {
            source: {
              positions: normalizedSource,
              faceIds: target.sourceFaceIds,
              completeOcclusionGeometry: true,
            },
            baselineModel: finalModel,
            editableCells: editable,
            ...(sourceExterior ? { intendedCells: intended } : {}),
            lockedCells: new Set(target.lockedShell.map((cell) => cell.key)),
            lockedPartIds: lockedIDs,
            reconstructSupportIds,
            boundaryPolicy: repackBoundary
              ? 'repack-complete-parts'
              : 'preserve-parts',
            views: [
              [0, 0, 1],
              [1, 0, 0],
              [0, 1, 0],
            ],
            maxCandidates: 3,
            scoreOptions: {
              maxRayDistanceStuds: 100,
              sampleSpacingStuds: 0.2,
              cullDisjointContext: repackBoundary,
              comparison: repackBoundary
                ? 'final-scene-owned-projection'
                : 'regional-parts',
              partScoringFootprint: repackBoundary
                ? 'owned-source-projection'
                : 'all-regional-parts',
            },
          }
        : undefined;
    let layout = layoutInput ? proposeUprightLayouts(layoutInput) : undefined;
    let finalist: Record<string, unknown> | undefined;
    const improvingLayouts = () =>
      layout?.candidates
        .filter(
          (c) =>
            c.score.status === 'scored' &&
            c.baselineScore.status === 'scored' &&
            c.baselineScore.sourceToParts.rmsStuds -
              c.score.sourceToParts.rmsStuds >
              0.05 &&
            c.baselineScore.symmetricRmsStuds - c.score.symmetricRmsStuds >
              0.05 &&
            c.score.symmetricP95Studs <=
              c.baselineScore.symmetricP95Studs + 0.02 &&
            !c.score.missingOrExtraArea,
        )
        .sort(
          (a, b) =>
            (a.score.status === 'scored'
              ? a.score.symmetricRmsStuds
              : Infinity) -
            (b.score.status === 'scored'
              ? b.score.symmetricRmsStuds
              : Infinity),
        );
    let interfaceRetry: Record<string, unknown> | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const improving = improvingLayouts();
      if (!improving?.length || !finalModel) break;
      const chosen = improving[0];
      const audit = auditLayoutAssembly(finalModel, chosen);
      if (
        pass === 0 &&
        sourceExterior &&
        layoutInput &&
        audit.status === 'rejected' &&
        audit.unresolvedPartIds
      ) {
        const interfaces = supportInterfaceParts(
          finalModel,
          audit.unresolvedPartIds,
        );
        if (interfaces) {
          interfaceRetry = {
            firstRejection: audit,
            interfacePartIds: [...interfaces.interfacePartIds],
            reason:
              'same-color existing support interface; outside occupancy/color frozen',
          };
          layout = proposeUprightLayouts({
            ...layoutInput,
            ...interfaces,
            reconstructSupportIds: new Set([
              ...reconstructSupportIds,
              ...interfaces.reconstructSupportIds,
            ]),
          });
          continue;
        }
      }
      const path = `${directory}/${c.id}-${r.regionId}-exterior-finalist.json`;
      if (audit.status === 'audited')
        writeFileSync(path, JSON.stringify(audit.model));
      finalist = {
        strategy: chosen.strategy,
        ...audit,
        model: undefined,
        ...(audit.status === 'audited'
          ? { modelPath: path, modelSha256: sha(readFileSync(path)) }
          : {}),
        accepted: false,
        appearanceAccepted: false,
      };
      break;
    }
    if (layout)
      writeFileSync(
        `${directory}/${c.id}-${r.regionId}-layouts.json`,
        JSON.stringify(layout),
      );
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
      ...(exterior
        ? {
            exteriorVoid: {
              ...exterior,
              eligibleExteriorCells: deletes.size,
              blockedExteriorCells:
                exterior.status === 'candidate'
                  ? exterior.emptyBodyCells.length - deletes.size
                  : 0,
            },
            finalist,
            interfaceRetry,
          }
        : {}),
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
      ownedDepth: {
        status: target.ownedDepth.queryPlan.status,
        queries: target.ownedDepth.queryPlan.queries.length,
        unresolvedCells: target.ownedDepth.queryPlan.unresolvedCells.length,
        uniqueRays: target.ownedDepth.queryIndices.length
          ? Math.max(...target.ownedDepth.queryIndices) + 1
          : 0,
        raysStatus: target.ownedDepth.rays?.status ?? 'not-requested',
        ambiguousRays:
          target.ownedDepth.rays?.status === 'collected'
            ? target.ownedDepth.rays.columns.filter(
                (column) => column.ambiguous,
              ).length
            : null,
      },
      layout: layout
        ? {
            status: layout.status,
            reasons: layout.reasons,
            candidates: layout.candidates.map((candidate) => ({
              strategy: candidate.strategy,
              removedParts: candidate.removedIDs.length,
              addedParts: candidate.addedIDs.length,
              reconstructedSupportIDs: candidate.reconstructedSupportIDs,
              changedCells: candidate.changedCells.length,
              boundary: candidate.boundary,
              baselineScore: candidate.baselineScore,
              score: candidate.score,
              assemblyAudited: false,
              accepted: false,
            })),
          }
        : withLayouts
          ? { status: 'not-proposed', reason: 'source target unresolved' }
          : undefined,
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
    finalModel: finalModel
      ? {
          brickCount: finalModel.bricks.length,
          modelSha256: sha(
            readFileSync(`${directory}/${c.id}-baseline-current.json`),
          ),
          recordedSceneSha256: sceneSha256,
          cachedInferenceOnly: true,
          baselineReused: reuseBaseline,
          validation: validateModel(finalModel),
          procurement: (() => {
            const p = procurementReport(finalModel);
            return {
              unverified: p.unverified,
              unsupportedColors: p.unsupportedColors,
              requiresReview: p.requiresReview,
            };
          })(),
        }
      : undefined,
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
  boundaryRepacking: repackBoundary,
  sourceExterior,
  conversionFingerprint: productionFingerprint,
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
    withLayouts
      ? 'Current converter replay and bounded upright catalog layout proposals; no candidate committed or physically accepted.'
      : 'Only source targets evaluated; no final layout, packing, procurement, assembly or physical acceptance.',
    'Stored raw and designed mesh snapshots are separate; source ray pairs retain gaps and ambiguous crossings.',
    withLayouts
      ? 'Final deliberate construction, support, installed and semantic pieces supplied as locks; source-exterior explicitly reconstructs ordinary generated supports only after whole-model assembly audit. Unchanged observations do not establish material identity.'
      : 'Baseline protected cells applied; final construction/component constraints require final model input and are not certified by this source-only replay.',
  ],
};
writeFileSync(`${directory}/summary.json`, JSON.stringify(summary, null, 2));
console.log(`Saved ${directory}/summary.json`);
