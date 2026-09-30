import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import type { Model } from '../lib/brick-engine.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

// Summarize actual completed conversions; do not infer visual quality from
// colour counts or normalization rates. Run the support/order audit first.
const directory = resolve(process.argv[2] || 'outputs/material-calibration');
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const current = conversionFingerprint();
const verified = read(join(directory, 'support-results.json'));
const baseline = read('benchmarks/image-support-2026-10-01.json');
if (verified.conversionFingerprint !== current || !verified.passed)
  throw Error('Replay current conversions and emitted-order audit first.');

const cases = verified.cases.map(
  (row: { id: string; resolution: number; modelSha256: string }) => {
    const path = row.id.startsWith('temple-')
      ? join(directory, `${row.id}-${row.resolution}.json`)
      : `outputs/image-benchmark/${row.id}/bricks-${row.resolution}.json`;
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== row.modelSha256)
      throw Error(`Model changed after audit: ${path}`);
    const model = JSON.parse(bytes.toString()) as Model;
    const design = model.materialDesign;
    if (!design?.projection || design.method !== 'reference-gradient-regions')
      throw Error(`Missing reference-material evidence: ${path}`);
    const projection = design.projection;
    if (
      projection.materialPixels.reduce((n, p) => n + p, 0) !==
      projection.projectedPixels
    )
      throw Error(`Projected-pixel voting total differs: ${path}`);
    const colors: Record<string, number> = {};
    for (const b of model.bricks) colors[b.color] = (colors[b.color] || 0) + 1;
    const old = baseline.cases.find((c: { id: string }) => c.id === row.id);
    return {
      id: row.id,
      resolution: row.resolution,
      modelSha256: row.modelSha256,
      baseline: old
        ? {
            conversionFingerprint: old.conversionFingerprint,
            bricks: old.bricks,
            supports: old.supports,
            colors: old.colors,
          }
        : undefined,
      bricks: model.bricks.length,
      supports: model.supportCount,
      colors,
      material: {
        method: design.method,
        sourceForegroundPixels: design.regions.reduce(
          (n, r) => n + r.pixels,
          0,
        ),
        regionCount: design.regions.length,
        inferredIlluminationRegions: design.regions.filter(
          (r) => r.inferredIllumination,
        ).length,
        normalizedPixels: design.normalizedPixels,
        projection,
        warnings: design.warnings,
      },
      structuralAuditPassed: true,
      appearance:
        'Draft; separately inspected using real catalog geometry. Not a material-accuracy or official-kit quality pass.',
    };
  },
);
const output = {
  date: '2026-10-01',
  conversionFingerprint: current,
  scope: verified.scope,
  method:
    'Continuous local chromaticity/lightness regions; visible projected pixels vote once, independent of triangle count. Abrupt colour boundaries are kept. Unknown surfaces still use inferred height bands.',
  cases,
  limits:
    'Region coherence is an illumination hypothesis, not intrinsic material recognition. Hard shadows, soft painted gradients and reflections remain ambiguous. Palette/part counts and structural gates do not establish appearance, purchasability, strength or physical buildability. Cached public engine examples are not independent real photographs.',
};
writeFileSync(
  join(directory, 'material-results.json'),
  JSON.stringify(output, null, 2),
);
console.log(
  JSON.stringify({
    cases: cases.length,
    structuralAuditPassed: true,
    appearancePassed: false,
    conversionFingerprint: current,
  }),
);
