import { conversionFingerprint } from './benchmark-evidence.ts';
// Replay the actual single-image engine -> reference colors -> semantic detection
// -> packing -> catalog connection validation. No synthetic mesh substitute.
// Copy manifest inputs into <output>/inputs, then use --native to infer missing
// meshes. Cached meshes let subsequent conversion audits avoid costly inference.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readGLB } from '../lib/read-glb.ts';
import { colorFromReference } from '../lib/reference-colors.ts';
import { detectRefinements } from '../lib/semantic-refinement.ts';
import { meshToDesign, meshToDesignAuto } from '../lib/mesh-design.ts';
import { validateModel, inventory, type Raster } from '../lib/brick-engine.ts';
import {
  VisionSceneDetector,
  type VisionSceneResponse,
} from '../lib/scene/detectors/vision-detector.ts';

const args = process.argv.slice(2);
const output = resolve(
  args.find((a) => !a.startsWith('--')) || 'outputs/image-benchmark',
);
const native = args.includes('--native');
const onlyCase = args.find((a) => a.startsWith('--case='))?.split('=')[1];
const sceneDirectory = args
  .find((a) => a.startsWith('--scene-dir='))
  ?.slice('--scene-dir='.length);
const resolution = Number(
  args.find((a) => a.startsWith('--resolution='))?.split('=')[1] || 28,
);
if (![28, 36, 48].includes(resolution))
  throw Error('Use resolution 28, 36 or 48.');
const manifest = JSON.parse(
  readFileSync(
    new URL('../benchmarks/image-cases.json', import.meta.url),
    'utf8',
  ),
);
if (onlyCase && !manifest.cases.some((c: { id: string }) => c.id === onlyCase))
  throw Error('Unknown benchmark case.');
const engine = resolve('work/local-3d');
const python = process.env.BRICKFORM_BENCH_PYTHON || 'python3';
const rows: Record<string, unknown>[] = [];
for (const item of manifest.cases as {
  id: string;
  image: string;
  category: string;
  sha256: string;
  forbiddenComponentKinds: string[];
}[]) {
  if (onlyCase && item.id !== onlyCase) continue;
  const dir = join(output, item.id),
    input = join(output, 'inputs', item.image);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const row: Record<string, unknown> = { ...item, resolution };
  try {
    const bytes = readFileSync(input);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== item.sha256)
      throw Error('Input checksum differs from the pinned benchmark image.');
    const seed = parseInt(sha256.slice(0, 8), 16);
    const file = join(dir, 'model.glb'),
      cutout = join(dir, 'reference.png');
    const provenanceFile = join(dir, 'inference.json');
    const provenance = {
      sha256,
      seed,
      steps: 30,
      octree: 128,
      engine: 'Hunyuan3D mini / local Swift',
    };
    const cached =
      existsSync(file) &&
      existsSync(cutout) &&
      existsSync(provenanceFile) &&
      JSON.stringify(JSON.parse(readFileSync(provenanceFile, 'utf8'))) ===
        JSON.stringify(provenance);
    row.inputSha256 = sha256;
    row.seed = seed;
    if (!cached) {
      if (!native)
        throw Error(
          'No matching cached native mesh; supply --native to reconstruct this input.',
        );
      writeFileSync(cutout, bytes);
      try {
        execFileSync(join(engine, 'prepare-image'), [input, cutout], {
          cwd: engine,
          timeout: 60000,
        });
      } catch {
        writeFileSync(cutout, bytes);
      }
      const log = execFileSync(
        join(engine, 'hy3d'),
        [
          'shape',
          cutout,
          '-o',
          file,
          '--weights',
          join(engine, 'weights'),
          '--steps',
          '30',
          '--octree',
          '128',
          '--seed',
          String(seed),
        ],
        { cwd: engine, timeout: 12 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 },
      );
      writeFileSync(join(dir, 'inference.log'), log);
      writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2));
    }
    row.inferenceCached = cached;
    const rasterData = execFileSync(python, [
      '-c',
      'from PIL import Image; import sys,struct; im=Image.open(sys.argv[1]).convert("RGBA"); im.thumbnail((320,320),Image.Resampling.BILINEAR); sys.stdout.buffer.write(struct.pack("<II",*im.size)+im.tobytes())',
      cutout,
    ]);
    const raster: Raster = {
      width: rasterData.readUInt32LE(0),
      height: rasterData.readUInt32LE(4),
      data: new Uint8ClampedArray(rasterData.subarray(8)),
    };
    const glb = readFileSync(file);
    row.meshSha256 = createHash('sha256').update(glb).digest('hex');
    const raw = await readGLB(
      glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength),
      item.id,
    );
    const mesh = colorFromReference(raw, raster, undefined, true);
    row.camera = mesh.coloring;
    row.triangles = mesh.positions.length / 9;
    const semanticRoot = resolve('work/semantic-engine');
    const ready = readFileSync(join(semanticRoot, 'ready.json'));
    const sceneRunner = resolve('scripts/local-scene-analysis.py');
    const sceneFingerprint = createHash('sha256')
      .update(ready)
      .update(readFileSync(sceneRunner))
      .digest('hex');
    const rasterHash = createHash('sha256').update(rasterData).digest('hex');
    const sceneFile = sceneDirectory
      ? join(sceneDirectory, `${item.id}.scene.json`)
      : join(dir, 'scene/reference.scene.json');
    if (
      !sceneDirectory &&
      (!existsSync(sceneFile) ||
        JSON.parse(readFileSync(sceneFile, 'utf8')).engineFingerprint !==
          sceneFingerprint ||
        JSON.parse(readFileSync(sceneFile, 'utf8')).imageSha256 !== rasterHash)
    ) {
      const sceneDir = join(dir, 'scene');
      mkdirSync(sceneDir, { recursive: true });
      const inputRaster = join(sceneDir, 'reference.rgba');
      writeFileSync(inputRaster, rasterData);
      execFileSync(
        join(semanticRoot, '.venv/bin/python'),
        [sceneRunner, inputRaster, '--output', sceneDir],
        { timeout: 180000 },
      );
    }
    const scene = JSON.parse(
      readFileSync(sceneFile, 'utf8'),
    ) as VisionSceneResponse & { imageSha256: string };
    if (
      scene.engineFingerprint !== sceneFingerprint ||
      scene.imageSha256 !== rasterHash
    )
      throw Error(
        'Learned observations differ from the input or current inference code.',
      );
    row.sceneEngineFingerprint = scene.engineFingerprint;
    row.conversionFingerprint = conversionFingerprint();
    row.observedObjects = scene.elements.map((e) => ({
      category: e.category,
      label: e.label,
      identityScore: e.identityScore,
      identitySupported: e.identitySupported,
    }));
    const regions = await detectRefinements(
      mesh,
      raster,
      resolution,
      undefined,
      mesh.coloring,
      new VisionSceneDetector(async () => scene),
    );
    row.detected = regions.map((r) => ({
      id: r.id,
      kind: r.kind,
      confidence: r.confidence,
    }));
    const result = regions.length
      ? meshToDesignAuto(mesh, resolution, regions, 48, {
          image: raster,
          camera: mesh.coloring,
        })
      : {
          model: meshToDesign(mesh, resolution, [], {
            image: raster,
            camera: mesh.coloring,
          }),
          applied: [],
          dropped: [],
        };
    const model = result.model;
    row.status = 'converted';
    row.bricks = model.bricks.length;
    row.steps = model.assembly?.steps.length;
    row.supports = model.supportCount;
    row.partTypes = new Set(model.bricks.map((b) => b.part)).size;
    row.partColorTypes = inventory(model.bricks).length;
    row.structureCategory = model.structureCategory;
    row.structureConfidence = model.structureConfidence;
    row.platform = model.platformDesign;
    row.applied = result.applied.map((r) => ({ id: r.id, kind: r.kind }));
    row.dropped = result.dropped.map((r) => ({ id: r.id, kind: r.kind }));
    row.semanticFalsePositives = result.applied
      .filter((r) => item.forbiddenComponentKinds.includes(r.kind))
      .map((r) => r.id);
    row.semanticGatePassed =
      (row.semanticFalsePositives as string[]).length === 0;
    row.validation = validateModel(model);
    row.inventoryTotal = inventory(model.bricks).reduce(
      (n, p) => n + p.quantity,
      0,
    );
    row.colors = Object.fromEntries(
      [...new Set(model.bricks.map((b) => b.color))].map((c) => [
        c,
        model.bricks.filter((b) => b.color === c).length,
      ]),
    );
    writeFileSync(
      join(dir, `bricks-${resolution}.json`),
      JSON.stringify(model),
    );
  } catch (e) {
    row.status = 'failed';
    row.error = e instanceof Error ? e.message : String(e);
  }
  row.elapsedSeconds = Math.round((Date.now() - started) / 100) / 10;
  rows.push(row);
  writeFileSync(
    join(output, `results-${resolution}${onlyCase ? `-${onlyCase}` : ''}.json`),
    JSON.stringify(
      {
        scope: manifest.note,
        resolution,
        cases: rows,
        limits:
          'Bilinear offline downsample approximates canvas; no browser UI, load stability, or physical build was tested. Connection checks are not visual quality scores.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(row));
}
if (
  rows.some((r) => r.status !== 'converted' || r.semanticGatePassed === false)
)
  process.exitCode = 1;
