// Replay reference-region palette choices without mesh inference or conversion.
// Usage: node --experimental-strip-types scripts/benchmark-region-consensus.ts
//   [output-directory] [--prototype-results=path] [--palette-artifacts=directory]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  PALETTE,
  isOpaquePaletteColor,
  nearestColor,
  type PaletteColor,
  type Raster,
} from '../lib/brick-engine.ts';
import { colors, lab, match, rgb } from '../lib/material-color-space.ts';
import { referenceMask } from '../lib/reference-colors.ts';
import {
  referenceMaterials,
  type ReferenceMaterialRegion,
} from '../lib/reference-materials.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const args = process.argv.slice(2);
const directory = resolve(
  args.find((arg) => !arg.startsWith('--')) ||
    'outputs/region-consensus-calibration',
);
const option = (name: string) =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const prototypePath = option('prototype-results');
const paletteDirectory = option('palette-artifacts');
mkdirSync(directory, { recursive: true });

const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const root = new URL('../', import.meta.url);
const baselineRevision = 'd6844ec';
const revision = execFileSync('git', ['rev-parse', baselineRevision], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const pinned = (file: string) =>
  execFileSync('git', ['show', `${revision}:${file}`], {
    cwd: root,
    encoding: 'utf8',
  });
const baselineMaterialSource = pinned('lib/reference-materials.ts');
const baselineColorSource = pinned('lib/material-color-space.ts');
const baselineEngineSource = pinned('lib/brick-engine.ts');
const baselineReferenceSource = pinned('lib/reference-colors.ts');
const paletteSource = baselineEngineSource.match(
  /export const PALETTE = \[[\s\S]*?\n\];/,
)?.[0];
const maskStart = baselineReferenceSource.indexOf(
  'export function referenceMask(',
);
const maskEnd = baselineReferenceSource.indexOf('export type ReferenceCamera');
if (!paletteSource || maskStart < 0 || maskEnd <= maskStart)
  throw Error(
    'Pinned palette or foreground-mask source could not be extracted.',
  );

// Every runtime dependency of the baseline matcher is a pinned snapshot.
// The small palette module avoids loading the current brick engine by accident.
const paletteFile = join(directory, '.region-consensus-baseline-palette.ts');
const colorFile = join(directory, '.region-consensus-baseline-colors.ts');
const materialFile = join(directory, '.region-consensus-baseline-materials.ts');
writeFileSync(
  paletteFile,
  '// @ts-nocheck\n' +
    'export type Raster = { width: number; height: number; data: ArrayLike<number> };\n' +
    paletteSource +
    '\n',
);
writeFileSync(
  colorFile,
  '// @ts-nocheck\n' +
    baselineColorSource.replace(
      "from './brick-engine.ts'",
      `from '${pathToFileURL(paletteFile).href}'`,
    ),
);
const representativeAnchor = 'inferredIllumination: inferred,';
if (baselineMaterialSource.split(representativeAnchor).length !== 2)
  throw Error('Pinned representative instrumentation anchor changed.');
const snapshotSource =
  '// @ts-nocheck\n' +
  baselineMaterialSource
    .replace(
      "from './brick-engine.ts'",
      `from '${pathToFileURL(paletteFile).href}'`,
    )
    .replace(
      "from './material-color-space.ts'",
      `from '${pathToFileURL(colorFile).href}'`,
    )
    // Keep the original BFS/Float32 ordering and record its unquantized sample.
    // This adds evidence only; all baseline choices remain pinned source code.
    .replace(
      representativeAnchor,
      `${representativeAnchor}\n      representative,`,
    ) +
  '\n' +
  baselineReferenceSource.slice(maskStart, maskEnd);
writeFileSync(materialFile, snapshotSource);

type BaselineRegion = ReferenceMaterialRegion & {
  representative: [number, number, number];
};
type Materials = ReturnType<typeof referenceMaterials>;
type BaselineMaterials = Omit<Materials, 'design'> & {
  design: Omit<Materials['design'], 'regions'> & { regions: BaselineRegion[] };
};
const baseline = (await import(pathToFileURL(materialFile).href)) as {
  referenceMaterials: (
    image: Raster,
    mask: Uint8Array,
    normalize: boolean,
  ) => BaselineMaterials;
  referenceMask: typeof referenceMask;
};
const baselineColors = (await import(pathToFileURL(colorFile).href)) as {
  colors: number[][];
  rgb: number[][];
};
const baselinePalette = (await import(pathToFileURL(paletteFile).href)) as {
  PALETTE: PaletteColor[];
};
if (baselinePalette.PALETTE.length !== 14)
  throw Error('Pinned baseline must retain its original 14-color palette.');
const fingerprint = conversionFingerprint();
const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((value, i) => value === b[i]);
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
const chroma = (p: number[]) => Math.hypot(p[1], p[2]);
const hueDifference = (p: number[], c: number[]) =>
  (Math.acos(
    Math.max(
      -1,
      Math.min(1, Math.cos(Math.atan2(p[2], p[1]) - Math.atan2(c[2], c[1]))),
    ),
  ) *
    180) /
  Math.PI;
const weightedDistance = (p: number[], c: number[]) =>
  Math.hypot(Math.sqrt(0.5) * (p[0] - c[0]), p[1] - c[1], p[2] - c[2]);
const deltaE = (a: number[], b: number[]) =>
  Math.hypot(...a.map((value, i) => value - b[i]));
const labelBytes = (labels: Int32Array) =>
  new Uint8Array(labels.buffer, labels.byteOffset, labels.byteLength);
const canonicalRaster = (image: Raster) => {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(image.width, 0);
  header.writeUInt32LE(image.height, 4);
  return Buffer.concat([header, Uint8Array.from(image.data)]);
};
const paletteRaster = (
  image: Raster,
  mask: Uint8Array,
  palette: Uint8Array,
) => {
  const bytes = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) bytes.set([...rgb[palette[i]], 255], i * 4);
  return Buffer.concat([canonicalRaster(image).subarray(0, 8), bytes]);
};
const prototype = prototypePath
  ? (JSON.parse(readFileSync(resolve(prototypePath), 'utf8')) as {
      name: string;
      changedPixels: number;
      changes: {
        id: number;
        pixels: number;
        originalColor: number;
        color: number;
      }[];
    }[])
  : undefined;
const ids = [
  'house',
  'locomotive',
  'horse',
  'sculpture-head',
  'wizard-hat',
  'costumed-figure',
  'temple-standard',
  'temple-original',
];
const cases = [];
const baselinePaletteLength = baselinePalette.PALETTE.length;
const prefixPalettePreserved =
  JSON.stringify(PALETTE.slice(0, baselinePaletteLength)) ===
  JSON.stringify(baselinePalette.PALETTE);
const prefixRGBPreserved =
  JSON.stringify(rgb.slice(0, baselinePaletteLength)) ===
  JSON.stringify(baselineColors.rgb);
const appendedCatalogOnlyColors = PALETTE.slice(baselinePaletteLength).map(
  (color, offset) => {
    const index = baselinePaletteLength + offset;
    const [r, g, b] = rgb[index];
    return {
      index,
      ...color,
      opaqueInferenceEligible: isOpaquePaletteColor(index),
      rgbMatch: nearestColor(r, g, b, true),
      labMatch: match(r, g, b),
    };
  },
);
const appendedColorsExcluded = appendedCatalogOnlyColors.every(
  (color) =>
    !color.opaqueInferenceEligible &&
    isOpaquePaletteColor(color.rgbMatch) &&
    isOpaquePaletteColor(color.labMatch),
);
const opaqueCandidates = colors.flatMap((color, index) =>
  isOpaquePaletteColor(index) ? [{ index, lab: color }] : [],
);
const palettePreserved =
  prefixPalettePreserved &&
  prefixRGBPreserved &&
  baselinePalette.PALETTE.every((_, index) => isOpaquePaletteColor(index)) &&
  appendedColorsExcluded;
for (const id of ids) {
  const source =
    id === 'temple-standard'
      ? 'lib/fixtures/temple-standard.rgba.gz'
      : id === 'temple-original'
        ? 'lib/fixtures/temple-original.raster.json.gz'
        : `outputs/identity-calibration/${id}.rgba`;
  const inputBytes = readFileSync(new URL(source, root));
  let image: Raster;
  if (id === 'temple-standard')
    image = { width: 320, height: 320, data: gunzipSync(inputBytes) };
  else if (id === 'temple-original')
    image = JSON.parse(gunzipSync(inputBytes).toString()) as Raster;
  else
    image = {
      width: inputBytes.readUInt32LE(0),
      height: inputBytes.readUInt32LE(4),
      data: inputBytes.subarray(8),
    };
  if (image.data.length !== image.width * image.height * 4)
    throw Error(`Invalid actual raster: ${source}`);
  const originalRaster = canonicalRaster(image);
  const maskResult = referenceMask(image);
  const baselineMask = baseline.referenceMask(image);
  const mask = maskResult.mask;
  const originalMask = mask.slice();
  const old = baseline.referenceMaterials(image, mask, true);
  const oldOff = baseline.referenceMaterials(image, mask, false);
  const current = referenceMaterials(image, mask, true);
  const currentOff = referenceMaterials(image, mask, false);
  const foregroundPixels = mask.reduce(
    (total, value) => total + Number(!!value),
    0,
  );
  const minimumWitnessPixels = Math.max(64, foregroundPixels * 0.01);
  const sourceLabs = old.design.regions.map((region) =>
    lab(...region.representative),
  );
  const witnesses = old.design.regions.filter(
    (region) =>
      region.inferredIllumination &&
      region.pixels >= minimumWitnessPixels &&
      chroma(sourceLabs[region.id]) >= 25 &&
      chroma(colors[region.color]) >= 20 &&
      hueDifference(sourceLabs[region.id], colors[region.color]) <= 30,
  );
  const failures: string[] = [];
  const fail = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  fail(
    palettePreserved,
    'Pinned palette prefix changed or an appended color entered opaque inference.',
  );
  const opaqueRegionChoices = [current, currentOff].every(
    (materials) =>
      materials.design.regions.every((region) =>
        isOpaquePaletteColor(region.color),
      ) &&
      Array.from(materials.palette).every(
        (color, pixel) => !mask[pixel] || isOpaquePaletteColor(color),
      ),
  );
  fail(
    opaqueRegionChoices,
    'A catalog-only color entered ordinary reference-region inference.',
  );
  fail(
    same(mask, baselineMask.mask),
    'Foreground mask differs from pinned mask.',
  );
  fail(
    same(mask, originalMask),
    'A material function mutated the foreground mask.',
  );
  fail(
    same(canonicalRaster(image), originalRaster),
    'Source image pixels were mutated.',
  );
  fail(same(current.labels, old.labels), 'Normalized region labels changed.');
  fail(
    same(currentOff.labels, oldOff.labels),
    'Normalization-off labels changed.',
  );
  fail(
    same(currentOff.palette, oldOff.palette),
    'Normalization-off palette changed.',
  );
  fail(
    currentOff.design.normalizedPixels === 0,
    'Normalization-off altered pixels.',
  );
  fail(
    current.design.regions.length === old.design.regions.length,
    'Region count changed.',
  );
  let changedPixels = 0;
  let countedNormalizedPixels = 0;
  let changedUndocumentedPixels = 0;
  const materialTransitions = new Map<string, number>();
  const changedRegionPixels = new Map<number, number>();
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    if (current.palette[i] !== oldOff.palette[i]) countedNormalizedPixels++;
    if (current.palette[i] === old.palette[i]) continue;
    changedPixels++;
    const region = current.design.regions[current.labels[i]];
    if (!region?.quantization || current.palette[i] !== region.color)
      changedUndocumentedPixels++;
    const transition = `${old.palette[i]}->${current.palette[i]}`;
    materialTransitions.set(
      transition,
      (materialTransitions.get(transition) || 0) + 1,
    );
    changedRegionPixels.set(
      region.id,
      (changedRegionPixels.get(region.id) || 0) + 1,
    );
  }
  fail(
    changedUndocumentedPixels === 0,
    'Changed pixels lack a quantization record.',
  );
  fail(
    countedNormalizedPixels === current.design.normalizedPixels,
    'Normalized pixel count does not match the raw palette comparison.',
  );
  const changes = [];
  for (const region of current.design.regions) {
    const prior = old.design.regions[region.id];
    fail(
      !!prior &&
        prior.pixels === region.pixels &&
        prior.inferredIllumination === region.inferredIllumination &&
        same(prior.lightnessRange, region.lightnessRange) &&
        prior.chromaticityResidual === region.chromaticityResidual,
      `Region ${region.id}: source segmentation or illumination evidence changed.`,
    );
    if (!prior) continue;
    const p = sourceLabs[region.id];
    const eligibleTarget =
      prior.inferredIllumination &&
      chroma(p) >= 25 &&
      chroma(colors[prior.color]) < 5;
    const originalDistance = weightedDistance(p, colors[prior.color]);
    const candidates = opaqueCandidates
      .map(({ lab: color, index }) => ({
        color: index,
        distance: weightedDistance(p, color),
        hueDifference: hueDifference(p, color),
        witnesses: witnesses.filter(
          (witness) =>
            witness.color === index && deltaE(p, sourceLabs[witness.id]) <= 4,
        ),
      }))
      .filter(
        (candidate) =>
          eligibleTarget &&
          chroma(colors[candidate.color]) >= 20 &&
          candidate.hueDifference <= 30 &&
          candidate.distance <= originalDistance + 3 &&
          candidate.witnesses.length > 0,
      )
      .sort((a, b) => a.distance - b.distance || a.color - b.color);
    const selected = candidates[0];
    fail(
      region.color === (selected?.color ?? prior.color),
      `Region ${region.id}: palette choice differs from deterministic baseline-witness choice.`,
    );
    const q = region.quantization;
    fail(
      !!q === !!selected,
      `Region ${region.id}: missing or unexpected quantization record.`,
    );
    if (!q || !selected) continue;
    fail(
      q.method === 'chromatic-near-tie-with-region-witness' &&
        q.originalColor === prior.color &&
        same(q.representative, prior.representative) &&
        close(q.originalDistance, originalDistance) &&
        close(q.selectedDistance, selected.distance) &&
        close(q.hueDifference, selected.hueDifference) &&
        q.maximumWitnessDeltaE === 4 &&
        q.minimumWitnessPixels === minimumWitnessPixels &&
        q.inference === true &&
        same(
          q.witnessRegionIds,
          selected.witnesses.map((witness) => witness.id),
        ),
      `Region ${region.id}: quantization provenance does not match frozen source evidence.`,
    );
    fail(
      changedRegionPixels.get(region.id) === region.pixels,
      `Region ${region.id}: documented material change does not cover its source pixels.`,
    );
    changes.push({
      id: region.id,
      pixels: region.pixels,
      originalColor: prior.color,
      color: region.color,
      representative: prior.representative,
      sourceChroma: chroma(p),
      originalDistance,
      selectedDistance: selected.distance,
      hueDifference: selected.hueDifference,
      witnesses: selected.witnesses.map((witness) => ({
        id: witness.id,
        pixels: witness.pixels,
        color: witness.color,
        representative: witness.representative,
        sourceDeltaE: deltaE(p, sourceLabs[witness.id]),
        sourcePaletteHueDifference: hueDifference(
          sourceLabs[witness.id],
          colors[witness.color],
        ),
      })),
    });
  }
  const witnessIds = new Set(witnesses.map((witness) => witness.id));
  let changedWitnessPixels = 0;
  for (let i = 0; i < mask.length; i++)
    if (
      mask[i] &&
      witnessIds.has(old.labels[i]) &&
      current.palette[i] !== old.palette[i]
    )
      changedWitnessPixels++;
  fail(changedWitnessPixels === 0, 'Frozen witness material pixels changed.');
  fail(
    witnesses.every(
      (witness) =>
        current.design.regions[witness.id].color === witness.color &&
        !current.design.regions[witness.id].quantization,
    ),
    'A corrected region was admitted as a witness.',
  );
  const oldPaletteBytes = paletteRaster(image, mask, old.palette);
  const currentPaletteBytes = paletteRaster(image, mask, current.palette);
  writeFileSync(join(directory, `${id}.baseline.rgba`), oldPaletteBytes);
  writeFileSync(join(directory, `${id}.current.rgba`), currentPaletteBytes);
  const artifactCheck = (suffix: string, expected: Buffer) => {
    if (!paletteDirectory) return undefined;
    const file = join(resolve(paletteDirectory), `${id}.${suffix}.rgba`);
    if (!existsSync(file)) return { present: false, file };
    const bytes = readFileSync(file);
    const exact = same(bytes, expected);
    fail(exact, `Historical palette artifact differs: ${file}`);
    return { present: true, file, sha256: sha(bytes), exact };
  };
  const historicalBaselinePalette = artifactCheck('palette', oldPaletteBytes);
  const historicalPrototypePalette = artifactCheck(
    'prototype-v4',
    currentPaletteBytes,
  );
  const expectedPrototype = prototype?.find((item) => item.name === id);
  if (prototype) {
    fail(!!expectedPrototype, `No frozen prototype result for ${id}.`);
    if (expectedPrototype)
      fail(
        expectedPrototype.changedPixels === changedPixels &&
          JSON.stringify(
            expectedPrototype.changes.map(
              ({ id, pixels, originalColor, color }) => ({
                id,
                pixels,
                originalColor,
                color,
              }),
            ),
          ) ===
            JSON.stringify(
              changes.map(({ id, pixels, originalColor, color }) => ({
                id,
                pixels,
                originalColor,
                color,
              })),
            ),
        `Changed regions differ from the frozen prototype result for ${id}.`,
      );
  }
  cases.push({
    id,
    passed: failures.length === 0,
    source,
    sourceFileSha256: sha(inputBytes),
    rasterSha256: sha(originalRaster),
    width: image.width,
    height: image.height,
    foregroundPixels,
    foregroundMaskSha256: sha(mask),
    baselinePaletteSha256: sha(old.palette),
    currentPaletteSha256: sha(current.palette),
    baselineLabelsSha256: sha(labelBytes(old.labels)),
    currentLabelsSha256: sha(labelBytes(current.labels)),
    normalizedPixels: current.design.normalizedPixels,
    changedPixels,
    materialTransitions: Object.fromEntries(materialTransitions),
    frozenWitnessRegions: witnesses.length,
    changedWitnessPixels,
    minimumWitnessPixels,
    changes,
    invariants: {
      sourcePixelsPreserved: same(canonicalRaster(image), originalRaster),
      foregroundMaskPreserved:
        same(mask, originalMask) && same(mask, baselineMask.mask),
      regionLabelsPreserved: same(current.labels, old.labels),
      normalizeOffPalettePreserved: same(currentOff.palette, oldOff.palette),
      normalizeOffLabelsPreserved: same(currentOff.labels, oldOff.labels),
      normalizeOffUnmodified: currentOff.design.normalizedPixels === 0,
      normalizedPixelCountExact:
        countedNormalizedPixels === current.design.normalizedPixels,
      witnessPixelsPreserved: changedWitnessPixels === 0,
      changedPixelsDocumented: changedUndocumentedPixels === 0,
      opaqueRegionChoices,
      deterministicChoicesAndWitnesses: failures.length === 0,
    },
    historicalBaselinePalette,
    historicalPrototypePalette,
    frozenPrototypeResultsMatched: prototype
      ? failures.length === 0
      : undefined,
    failures,
  });
}
const fingerprintStable = conversionFingerprint() === fingerprint;
const result = {
  date: new Date().toISOString().slice(0, 10),
  passed: fingerprintStable && cases.every((item) => item.passed),
  conversionFingerprint: fingerprint,
  fingerprintStable,
  auditSourceSha256: sha(readFileSync(new URL(import.meta.url))),
  baselineRevision,
  baselineCommit: revision,
  baselineSourceSha256: sha(baselineMaterialSource),
  baselineColorSourceSha256: sha(baselineColorSource),
  baselinePaletteSourceSha256: sha(paletteSource),
  baselineForegroundSourceSha256: sha(
    baselineReferenceSource.slice(maskStart, maskEnd),
  ),
  baselineInstrumentedSourceSha256: sha(snapshotSource),
  baselineRuntimeDependencies:
    'Pinned material inference, color matching, palette and foreground mask; no current referenceMaterials import in the baseline module.',
  palettePreserved,
  paletteGate: {
    baselinePaletteLength,
    currentPaletteLength: PALETTE.length,
    preservedPrefixIndices: baselinePalette.PALETTE.map((_, index) => index),
    prefixPalettePreserved,
    prefixRGBPreserved,
    appendedColorsExcluded,
    opaqueCandidateIndices: opaqueCandidates.map((color) => color.index),
    appendedCatalogOnlyColors,
  },
  prototypeResultsSha256: prototypePath
    ? sha(readFileSync(resolve(prototypePath)))
    : undefined,
  consensusRule: {
    targets:
      'Accepted illumination regions whose frozen baseline palette match is neutral.',
    minimumSourceChroma: 25,
    maximumNeutralPaletteChromaExclusive: 5,
    minimumChromaticPaletteChroma: 20,
    maximumSourcePaletteHueDifference: 30,
    maximumWeightedDistanceExcess: 3,
    maximumWitnessDeltaE: 4,
    minimumWitnessPixels: 'max(64, 0.01 * foregroundPixels)',
    witnesses:
      'Frozen baseline matches; corrected regions never become witnesses.',
    candidates:
      'Opaque palette colors only; appended catalog-only colors excluded.',
  },
  scope:
    'Six cached public engine sample renders plus two exact user Temple raster fixtures. Region-palette replay only; no mesh inference, projection, conversion, purchasing or physical build.',
  cases,
  limits:
    'Frozen same-radiance region witnesses constrain a palette-choice hypothesis. They do not establish intrinsic material identity, correct hidden paint, generalization to real photographs, geometry fidelity or kit-quality appearance. Public sample renders are not held-out real photos. Unchanged colors are recorded, not certified as ground truth.',
};
writeFileSync(
  join(directory, 'region-consensus-results.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    passed: result.passed,
    conversionFingerprint: fingerprint,
    cases: cases.length,
    changedPixels: cases.reduce((total, item) => total + item.changedPixels, 0),
    changedRegions: cases.reduce(
      (total, item) => total + item.changes.length,
      0,
    ),
    failures: cases.flatMap((item) =>
      item.failures.map((failure) => `${item.id}: ${failure}`),
    ),
  }),
);
if (!result.passed) process.exitCode = 1;
