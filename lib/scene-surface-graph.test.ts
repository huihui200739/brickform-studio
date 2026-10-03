import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { colorFromReference, referenceAlignment } from './reference-colors.ts';
import { referenceMaterials } from './reference-materials.ts';
import {
  createSceneSurfaceGraph,
  SOURCE_EDGE_KIND,
  SOURCE_OBSERVATION_LIMITS,
} from './scene-surface-graph.ts';
import type { Raster } from './brick-engine.ts';

const camera = { yaw: 0, pitch: 0, perspective: 0 };
const square = Float32Array.from([
  -1, -1, 0, 1, -1, 0, -1, 1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
]);
function raster(): Raster {
  const data = new Uint8Array(20 * 20 * 4);
  for (let y = 2; y < 18; y++)
    for (let x = 2; x < 18; x++)
      data.set(
        x < 10 ? [53 + y, 33 + y, y, 255] : [0, 85 + y, 191, 255],
        (y * 20 + x) * 4,
      );
  return { width: 20, height: 20, data };
}
function collector(positions = square, image = raster()) {
  const a = referenceAlignment(
    { positions, colors: new Uint8Array(positions.length / 3), name: 'source' },
    image,
    camera,
  );
  const m = referenceMaterials(image, a.mask, true);
  return createSceneSurfaceGraph({
    positions,
    image,
    mask: a.mask,
    rawRegionIds: m.labels,
    camera: a.camera,
    alignment: a.evidence,
    projectionSize: 2,
    pixelFaces: Int32Array.from([0, 1, -1, -1]),
    imageBounds: [a.left, a.right, a.top, a.bottom],
    viewBounds: [a.view.minX, a.view.maxX, a.view.minY, a.view.maxY],
    meshCenter: a.center as [number, number, number],
    extent: a.extent,
    depthTolerance: a.extent * 1e-7,
  })!;
}

void test('source graph retains every exact edge incidence and never welds nearby surfaces', () => {
  const graph = collector().finish(),
    e = graph.sharedEdges;
  assert.equal(e.offsets.length - 1, 5);
  assert.equal(
    e.kinds.filter((k) => k === SOURCE_EDGE_KIND.boundary).length,
    4,
  );
  const shared = e.faceEdgeIds[1];
  assert.equal(shared, e.faceEdgeIds[5]);
  assert.equal(e.kinds[shared], SOURCE_EDGE_KIND.manifold);
  assert.deepEqual(
    Array.from(e.faces.slice(e.offsets[shared], e.offsets[shared + 1])),
    [0, 1],
  );
  assert.deepEqual(
    Array.from(e.localEdges.slice(e.offsets[shared], e.offsets[shared + 1])),
    [1, 2],
  );
  assert.deepEqual(
    Array.from(graph.faceNormals, (v) => v || 0),
    [0, 0, 1, 0, 0, 1],
  );
  assert.deepEqual(Array.from(graph.faceAreas), [2, 2]);

  const separated = Float32Array.from([
    ...square,
    ...Array.from(square.slice(9)).map((v, k) => (k % 3 === 2 ? 1e-6 : v)),
  ]);
  assert.equal(collector(separated).finish().sharedEdges.offsets.length - 1, 8);
});

void test('non-manifold and degenerate edges retain incidence without becoming reliable continuation', () => {
  const positions = Float32Array.from([
    ...square,
    1,
    -1,
    0,
    -1,
    1,
    0,
    1,
    1,
    1,
    2,
    0,
    0,
    2,
    0,
    0,
    2,
    1,
    0,
  ]);
  const graph = collector(positions).finish(),
    e = graph.sharedEdges,
    shared = e.faceEdgeIds[1];
  assert.equal(e.kinds[shared], SOURCE_EDGE_KIND.nonManifold);
  assert.deepEqual(
    Array.from(e.faces.slice(e.offsets[shared], e.offsets[shared + 1])),
    [0, 1, 2],
  );
  assert.equal(
    e.faceEdgeIds[9],
    -1,
    'zero-length source edge stays degenerate',
  );
  assert.equal(
    e.kinds[e.faceEdgeIds[10]],
    SOURCE_EDGE_KIND.nonManifold,
    'two incidences of one degenerate face do not imply two adjacent faces',
  );
  assert.equal(graph.faceAreas[3], 0);
  assert.deepEqual(Array.from(graph.faceNormals.slice(9)), [0, 0, 0]);
});

void test('raw snapshots and centroid records are detached from mutable inputs and clone safely', () => {
  const p = square.slice(),
    image = raster(),
    original = Uint8Array.from(image.data),
    c = collector(p, image);
  c.recordPixel(0, 2 * 20 + 3);
  c.recordCentroid(1, 0.123456789012345, 0.75, 3 * 20 + 12, 0, {
    face: 1,
    depth: 0,
  });
  p.fill(100);
  (image.data as Uint8Array).fill(0);
  const graph = c.finish();
  assert.deepEqual(graph.sourcePositions, square);
  assert.deepEqual(graph.raster.rgba, original);
  assert.deepEqual(
    Array.from(graph.projection.rawRGB.slice(0, 3)),
    [55, 35, 2],
  );
  assert.deepEqual(
    Array.from(graph.projection.sourcePixelXY.slice(0, 2)),
    [3, 2],
  );
  assert.deepEqual(Array.from(graph.projection.centroids.rawRGB), [0, 88, 191]);
  assert.deepEqual(
    Array.from(graph.projection.centroids.projectedXY),
    [0.123456789012345, 0.75],
  );
  assert.deepEqual(Array.from(graph.projection.centroids.faces), [1]);
  assert.deepEqual(Array.from(graph.projection.centroids.frontFaces), [1]);
  assert.deepEqual(Array.from(graph.projection.centroids.depths), [0, 0]);
  assert.equal(c.finish(), graph);
  assert.throws(() => c.recordPixel(1, 2 * 20 + 12), /finalized/);
  assert.ok(Object.isFrozen(graph));
  const clone = structuredClone(graph);
  assert.deepEqual(clone, graph);
  assert.notEqual(clone.sourcePositions.buffer, graph.sourcePositions.buffer);
  const arrays: ArrayBufferView[] = [];
  const walk = (v: unknown) => {
    if (ArrayBuffer.isView(v)) arrays.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(clone);
  assert.equal(
    arrays.reduce((n, v) => n + v.byteLength, 0),
    graph.arrayBytes,
  );
  assert.ok(graph.arrayBytes < SOURCE_OBSERVATION_LIMITS.maximumArrayBytes);
});

void test('recording limits omit the ledger without changing the legacy color path', () => {
  const image = raster(),
    a = referenceAlignment(
      { positions: square, colors: new Uint8Array(6), name: 'limit' },
      image,
      camera,
    );
  const base = {
    positions: square,
    image: { ...image, width: 321, height: 320 },
    mask: a.mask,
    rawRegionIds: new Int32Array(400),
    camera,
    alignment: a.evidence,
    projectionSize: 2,
    pixelFaces: new Int32Array(4),
    imageBounds: [2, 17, 2, 17] as [number, number, number, number],
    viewBounds: [-1, 1, -1, 1] as [number, number, number, number],
    meshCenter: [0, 0, 0] as [number, number, number],
    extent: 2,
    depthTolerance: 2e-7,
  };
  assert.equal(createSceneSurfaceGraph(base), undefined);
  assert.equal(
    createSceneSurfaceGraph({
      ...base,
      image,
      positions: new Float32Array(
        (SOURCE_OBSERVATION_LIMITS.maximumFaces + 1) * 9,
      ),
    }),
    undefined,
  );
});

void test('projection ledger preserves exact source pixels and raw-region boundaries across palette hypotheses', () => {
  const image = raster(),
    sourceRGB = Uint8Array.from(image.data),
    mesh = { positions: square, colors: new Uint8Array(6), name: 'pixels' };
  const on = colorFromReference(mesh, image, camera, true),
    off = colorFromReference(mesh, image, camera, false);
  const graph = on.sourceObservations!;
  assert.deepEqual(
    graph,
    off.sourceObservations,
    'normalization changes the palette hypothesis, never the original observation',
  );
  const p = graph.projection,
    [left, right, top, bottom] = p.transform.imageBounds;
  let count = 0;
  for (let k = 0; k < p.observed.length; k++) {
    if (!p.observed[k]) continue;
    count++;
    assert.ok(p.pixelFaces[k] >= 0);
    const x = Math.round(
      left + (((k % p.size) + 0.5) / (p.size - 1)) * (right - left),
    );
    const y = Math.round(
      top + ((Math.floor(k / p.size) + 0.5) / (p.size - 1)) * (bottom - top),
    );
    assert.deepEqual(Array.from(p.sourcePixelXY.slice(k * 2, k * 2 + 2)), [
      x,
      y,
    ]);
    assert.deepEqual(
      Array.from(p.rawRGB.slice(k * 3, k * 3 + 3)),
      Array.from(
        sourceRGB.slice(
          (y * image.width + x) * 4,
          (y * image.width + x) * 4 + 3,
        ),
      ),
    );
    assert.equal(
      p.rawRegionIds[k],
      graph.raster.rawRegionIds[y * image.width + x],
    );
  }
  assert.equal(count, on.materialDesign!.projection!.projectedPixels);
  assert.deepEqual(p.transform.rasterSampleOffset, [0.5, 0.5]);
  assert.equal(p.transform.gridDenominator, 191);
  assert.ok(
    graph.raster.regionBoundaryBits[5 * 20 + 9] & 1,
    'raw brown/blue boundary remains recorded',
  );
  assert.ok(graph.raster.regionBoundaryBits[5 * 20 + 10] & 4);
});
