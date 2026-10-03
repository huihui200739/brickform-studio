import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { Raster } from './brick-engine.ts';
import {
  applyMaterialHypothesis,
  rasterSha256,
  type MaterialHypothesisCandidate,
} from './material-hypothesis.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import { colorFromReference } from './reference-colors.ts';

// An independent Node digest binds dimensions as well as every RGBA byte.
function sourceDigest(image: Raster) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(image.width, 0);
  header.writeUInt32LE(image.height, 4);
  return createHash('sha256')
    .update(header)
    .update(Uint8Array.from(image.data))
    .digest('hex');
}

function fixture() {
  const width = 24,
    height = 24,
    data = new Uint8Array(width * height * 4),
    positions: number[] = [];
  for (let y = 2; y < 22; y++)
    for (let x = 2; x < 22; x++)
      data.set(
        [
          ...(x < 12
            ? [110, 116, 78]
            : x >= 14 && x < 20 && y >= 8 && y < 16
              ? [53, 33, 0]
              : [215, 186, 140]),
          x === 2 ? 128 : 255,
        ],
        (y * width + x) * 4,
      );
  const panel = (left: number, right: number, z: number) =>
    positions.push(
      left,
      -1,
      z,
      right,
      -1,
      z,
      right,
      1,
      z,
      left,
      -1,
      z,
      right,
      1,
      z,
      left,
      1,
      z,
    );
  panel(-1, 0, 0.01);
  panel(0, 1, 0.01);
  panel(-1, 1, 0);
  // One visible face owns no projection-grid pixel, so its material comes from
  // the separate exact-centroid stream. The matching rear face is occluded.
  for (const z of [0.02, -0.01])
    positions.push(0.45, -0.1, z, 0.45001, -0.1, z, 0.45, -0.09999, z);
  const raster: Raster = { width, height, data };
  const mesh = colorFromReference(
    {
      name: 'small painted panels with microfaces',
      positions: Float32Array.from(positions),
      colors: new Uint8Array(positions.length / 3).fill(244),
    },
    raster,
    { yaw: 0, pitch: 0, perspective: 0.3 },
    false,
  );
  assert.ok(mesh.sourceObservations);
  assert.ok(mesh.features!.some((value) => value & MESH_FEATURE.foliage));
  assert.ok(mesh.materialEvidence!.observed.some((value) => value === 0));
  assert.ok(mesh.sourceObservations.projection.centroids.faces.includes(6));
  assert.ok(!mesh.sourceObservations.projection.centroids.faces.includes(7));
  return { raster, mesh };
}

type MutableTestCandidate = Omit<MaterialHypothesisCandidate, 'raster'> & {
  raster: { width: number; height: number; data: Uint8Array };
};

function candidateFor(raster: Raster): MutableTestCandidate {
  return {
    raster: { ...raster, data: Uint8Array.from(raster.data) },
    provenance: {
      method: 'marigold-iid-lighting',
      modelRevision: '08c3930bb641abf786ba44ce92547507ebefbc16',
      sourceSha256: sourceDigest(raster),
      engineFingerprint: 'a'.repeat(64),
      runtimeDtype: 'float32',
      steps: 4,
      processingResolution: 512,
      seed: 735,
    },
  };
}

function assertSourcePreserved(
  source: TriangleMesh,
  snapshot: TriangleMesh,
  result: TriangleMesh,
) {
  assert.deepEqual(
    source,
    snapshot,
    'Applying a candidate cannot edit its source',
  );
  assert.equal(result.positions, source.positions);
  assert.equal(result.name, source.name);
  assert.equal(result.features, source.features);
  assert.equal(result.coloring, source.coloring);
  assert.equal(result.sourceObservations, source.sourceObservations);
  assert.deepEqual(result.sourceObservations, snapshot.sourceObservations);
  assert.deepEqual(
    result.materialEvidence!.observed,
    source.materialEvidence!.observed,
  );
  assert.equal(
    result.materialDesign!.alignment,
    source.sourceObservations!.alignment,
  );
  assert.deepEqual(
    result.materialDesign!.alignment,
    source.materialDesign!.alignment,
  );
  const { materialPixels: sourcePixels, ...sourceProjection } =
    source.materialDesign!.projection!;
  const { materialPixels: resultPixels, ...resultProjection } =
    result.materialDesign!.projection!;
  assert.deepEqual(
    resultProjection,
    sourceProjection,
    'Coverage and visibility remain observations; material counts are candidate metadata',
  );
  assert.equal(
    resultPixels.reduce((sum, value) => sum + value, 0),
    sourcePixels.reduce((sum, value) => sum + value, 0),
  );
}

void test('source raster hash includes exact dimensions, raw RGB and alpha', async () => {
  const image: Raster = {
    width: 2,
    height: 2,
    data: Uint8Array.from([
      0, 1, 2, 0, 10, 20, 30, 128, 255, 200, 100, 255, 4, 5, 6, 64,
    ]),
  };
  const digest = await rasterSha256(image);
  assert.equal(digest, sourceDigest(image));
  assert.notEqual(
    digest,
    await rasterSha256({ ...image, width: 1, height: 4 }),
  );
  for (const byte of [4, 7]) {
    const changed = Uint8Array.from(image.data);
    changed[byte]++;
    assert.notEqual(digest, await rasterSha256({ ...image, data: changed }));
  }
});

void test('the original raster candidate preserves colors, observations, camera, semantics and source RGBA', async () => {
  const { raster, mesh } = fixture(),
    snapshot = structuredClone(mesh),
    candidate = candidateFor(raster),
    beforeCandidate = structuredClone(candidate);
  const result = await applyMaterialHypothesis(mesh, candidate);
  assertSourcePreserved(mesh, snapshot, result);
  assert.deepEqual(result.colors, mesh.colors);
  assert.deepEqual(result.materialEvidence, mesh.materialEvidence);
  assert.deepEqual(
    result.materialDesign!.projection,
    mesh.materialDesign!.projection,
  );
  assert.deepEqual(result.sourceObservations!.raster.rgba, raster.data);
  assert.deepEqual(candidate, beforeCandidate);
  assert.equal(result.materialHypothesis!.changedFaces, 0);
  assert.equal(
    result.materialHypothesis!.totalFaces,
    mesh.positions.length / 9,
  );
  assert.equal(result.materialHypothesis!.sourceObservationsPreserved, true);
  assert.equal(result.materialHypothesis!.materialIdentityVerified, false);
});

void test('changed candidate RGB changes only the material hypothesis, including exact-centroid paint', async () => {
  const { raster, mesh } = fixture(),
    snapshot = structuredClone(mesh),
    candidate = candidateFor(raster);
  for (let at = 0; at < candidate.raster.data.length; at += 4) {
    candidate.raster.data[at] = 0;
    candidate.raster.data[at + 1] = 85;
    candidate.raster.data[at + 2] = 191;
  }
  const beforeCandidate = structuredClone(candidate),
    result = await applyMaterialHypothesis(mesh, candidate);
  assertSourcePreserved(mesh, snapshot, result);
  assert.notDeepEqual(result.colors, mesh.colors);
  assert.deepEqual(Array.from(result.colors.slice(6 * 3, 7 * 3)), [0, 85, 191]);
  assert.ok(
    result.features!.some((value) => value & MESH_FEATURE.foliage),
    'Blue candidate paint cannot replace source foliage semantics',
  );
  assert.deepEqual(candidate, beforeCandidate);
  assert.equal(
    result.materialHypothesis!.provenance.sourceSha256,
    sourceDigest(raster),
  );
  assert.notEqual(await rasterSha256(candidate.raster), sourceDigest(raster));
  let changedFaces = 0;
  for (let face = 0; face < mesh.positions.length / 9; face++)
    if (
      !result.colors
        .subarray(face * 3, face * 3 + 3)
        .every((value, channel) => value === mesh.colors[face * 3 + channel])
    )
      changedFaces++;
  assert.ok(changedFaces > 0);
  assert.equal(result.materialHypothesis!.changedFaces, changedFaces);
});

void test('a valid hash from another source and a modified raw ledger are rejected without editing source', async () => {
  const { raster, mesh } = fixture(),
    snapshot = structuredClone(mesh),
    otherSource = { ...raster, data: Uint8Array.from(raster.data) },
    candidate = candidateFor(raster);
  otherSource.data[(3 * raster.width + 3) * 4]++;
  candidate.provenance.sourceSha256 = sourceDigest(otherSource);
  await assert.rejects(applyMaterialHypothesis(mesh, candidate), /另一张图片/);
  assert.deepEqual(mesh, snapshot);
  const tampered = structuredClone(mesh);
  tampered.sourceObservations!.raster.rgba[(3 * raster.width + 3) * 4]++;
  await assert.rejects(
    applyMaterialHypothesis(tampered, candidateFor(raster)),
    /另一张图片/,
  );
  assert.deepEqual(mesh, snapshot);
});

void test('any alpha change is rejected, including a change that leaves foreground membership intact', async () => {
  const { raster, mesh } = fixture(),
    snapshot = structuredClone(mesh);
  for (const at of [3, (3 * raster.width + 2) * 4 + 3]) {
    const candidate = candidateFor(raster);
    candidate.raster.data[at]++;
    await assert.rejects(applyMaterialHypothesis(mesh, candidate), /透明轮廓/);
    assert.deepEqual(mesh, snapshot);
  }
});

void test('coordinate, source-face order and geometry length changes reject stale correspondence', async () => {
  const { raster, mesh } = fixture(),
    snapshot = structuredClone(mesh),
    moved = new Float32Array(mesh.positions),
    reordered = new Float32Array(mesh.positions);
  moved[0] += 0.0001;
  reordered.set(mesh.positions.subarray(9, 18), 0);
  reordered.set(mesh.positions.subarray(0, 9), 9);
  for (const positions of [moved, reordered, mesh.positions.slice(0, -9)])
    await assert.rejects(
      applyMaterialHypothesis({ ...mesh, positions }, candidateFor(raster)),
      /模型形状已改变/,
    );
  assert.deepEqual(mesh, snapshot);
});
