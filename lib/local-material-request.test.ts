import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  decodeMaterialRaster,
  encodeMaterialRaster,
  decodeMaterialCandidate,
  LOCAL_MATERIAL_MODEL,
} from './local-material-request.ts';

const source = {
  width: 2,
  height: 2,
  data: [30, 80, 130, 0, 60, 90, 140, 64, 70, 100, 150, 128, 80, 110, 160, 255],
};
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function candidate() {
  return {
    raster: { ...source, data: source.data.map((v, i) => (i % 4 === 3 ? v : 220)) },
    provenance: {
      method: LOCAL_MATERIAL_MODEL.method,
      modelRepo: LOCAL_MATERIAL_MODEL.repo,
      modelRevision: String(LOCAL_MATERIAL_MODEL.revision),
      modelLicense: LOCAL_MATERIAL_MODEL.license,
      sourceSha256: sha(encodeMaterialRaster(source)),
      engineFingerprint: 'a'.repeat(64),
      runtimeDtype: 'float32',
      device: 'mps',
      steps: 4,
      processingResolution: 512,
      ensembleSize: 1,
      seed: 735,
      inferenceHypothesis: true,
      originalAlphaPreserved: true,
      elapsedSeconds: 8.5,
      limits: ['Single-image paint and illumination remain ambiguous.'],
    },
  };
}

void test('canonical material raster preserves all alpha values and source bytes', () => {
  const before = structuredClone(source),
    decoded = decodeMaterialRaster(source),
    bytes = encodeMaterialRaster(decoded);
  assert.deepEqual(Array.from(bytes.slice(0, 8)), [2, 0, 0, 0, 2, 0, 0, 0]);
  assert.deepEqual(Array.from(bytes.slice(8)), source.data);
  assert.deepEqual(source, before);
  assert.notEqual(
    sha(bytes),
    sha(encodeMaterialRaster({ ...source, data: source.data.map((v, i) => (i === 3 ? 1 : v)) })),
    'Changing only alpha must invalidate a source fingerprint',
  );
  assert.equal(decodeMaterialRaster({ width: 320, height: 320, data: Array(320 * 320 * 4).fill(255) }).data.length, 409600);
});

void test('invalid and sparse request pixels never enter the material runtime', () => {
  for (const bad of [null, [], { ...source, width: 321 }, { ...source, height: 1 },
    { ...source, data: source.data.slice(1) }, { ...source, data: Array(16) },
    { ...source, data: source.data.map((v, i) => (i === 0 ? NaN : v)) },
    { ...source, data: source.data.map((v, i) => (i === 0 ? 256 : v)) },
    { ...source, data: source.data.map((v, i) => (i === 0 ? 0.5 : v)) }])
    assert.throws(() => decodeMaterialRaster(bad));
});

void test('a material candidate can change RGB while preserving the exact source and alpha', () => {
  const raw = candidate(), before = structuredClone(source);
  const decoded = decodeMaterialCandidate(raw, source, {
    sourceSha256: sha(encodeMaterialRaster(source)), engineFingerprint: 'a'.repeat(64),
  });
  assert.deepEqual(decoded.raster.data.filter((_, i) => i % 4 === 3), [0, 64, 128, 255]);
  assert.deepEqual(source, before);
  raw.raster.data[0] = 1;
  assert.equal(decoded.raster.data[0], 220, 'Returned pixels are an independent copy');
});

void test('misaligned, stale or nonfinite candidate metadata cannot be applied', () => {
  const changes = [
    (c: ReturnType<typeof candidate>) => { c.raster.width = 3; },
    (c: ReturnType<typeof candidate>) => { c.raster.data[3] = 255; },
    (c: ReturnType<typeof candidate>) => { c.provenance.sourceSha256 = 'b'.repeat(64); },
    (c: ReturnType<typeof candidate>) => { c.provenance.engineFingerprint = 'b'.repeat(64); },
    (c: ReturnType<typeof candidate>) => { c.provenance.modelRevision = 'unverified'; },
    (c: ReturnType<typeof candidate>) => { c.provenance.runtimeDtype = 'float16'; },
    (c: ReturnType<typeof candidate>) => { c.provenance.elapsedSeconds = NaN; },
    (c: ReturnType<typeof candidate>) => { c.provenance.limits = []; },
  ];
  for (const change of changes) {
    const c = candidate(); change(c);
    assert.throws(() => decodeMaterialCandidate(c, source, {
      sourceSha256: sha(encodeMaterialRaster(source)), engineFingerprint: 'a'.repeat(64),
    }));
  }
});
