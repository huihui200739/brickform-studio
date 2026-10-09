import test from 'node:test';
import assert from 'node:assert/strict';
import { coherentModelColors } from './clean-design-colors.ts';
import { createSceneSurfaceGraph } from './scene-surface-graph.ts';
import { referenceMaterials } from './reference-materials.ts';
import { PALETTE, type Model, type Raster } from './brick-engine.ts';
import { rgb } from './material-color-space.ts';
import type { TriangleMesh } from './mesh-types.ts';

type Point = [number, number, number];
type Paint = { color: number; raw?: Point };
type Options = {
  gapRow?: number;
  gapAfterX?: boolean;
  pixels?: (x: number, z: number) => boolean;
  sideAccent?: boolean;
};
const at = (x: number, z: number) => z * 28 + x;
const tanShade = (exposure: number) => rgb[7].map((v) => Math.round(v * exposure)) as Point;

/** A horizontal roof/paving plane with explicit synthetic correspondences.
 * Geometry, raster exposure and initial palette choices are separate inputs. */
function topPlane(paint: (x: number, z: number) => Paint, options: Options = {}) {
  const width = 30, height = 28, positions: number[] = [], colors: number[] = [];
  const bricks: Model['bricks'] = [], facePixels: number[] = [];
  const rgba = new Uint8ClampedArray(width * height * 4), mask = new Uint8Array(width * height);
  const pixelFaces = new Int32Array(width * width).fill(-1);
  for (let z = 0; z < 28; z++) for (let x = 0; x < 28; x++) {
    const p = paint(x, z), pixel = z * width + x;
    rgba.set([...(p.raw ?? rgb[p.color]), 255], pixel * 4); mask[pixel] = 1;
    if (z !== options.gapRow) {
      const shift = options.gapAfterX && x >= 14 ? 0.2 : 0;
      const point = (u: number, v: number): Point => [u + shift, 0, v];
      pixelFaces[pixel] = facePixels.length;
      positions.push(...point(x, z), ...point(x, z + 1), ...point(x + 1, z + 1), ...point(x, z), ...point(x + 1, z + 1), ...point(x + 1, z));
      colors.push(...rgb[p.color], ...rgb[p.color]); facePixels.push(pixel, pixel);
    }
    bricks.push({ id: at(x, z) + 1, part: '3070b', x: x + 1, y: 2, z: z + 1, w: 1, h: 1, d: 1, color: p.color, section: 'subject', support: false });
  }
  if (options.sideAccent) {
    // A real blue side face on the shaded boundary brick must lock that WHOLE
    // brick, even when all of the connected top radiance belongs to tan.
    const pixel = 27 * width + 28;
    rgba.set([...rgb[4], 255], pixel * 4); mask[pixel] = 1;
    pixelFaces[pixel] = facePixels.length;
    positions.push(20, 0, 28, 21, 0, 28, 21, 0.4, 28, 20, 0, 28, 21, 0.4, 28, 20, 0.4, 28);
    colors.push(...rgb[4], ...rgb[4]); facePixels.push(pixel, pixel);
  }
  const mesh: TriangleMesh = {
    positions: Float32Array.from(positions), colors: Uint8Array.from(colors),
    name: 'horizontal scalar source fixture',
  };
  const image: Raster = { width, height, data: rgba }, material = referenceMaterials(image, mask, true);
  const camera = { yaw: 0, pitch: 90, perspective: 0 };
  const collector = createSceneSurfaceGraph({
    positions: mesh.positions, image, mask, rawRegionIds: material.labels, camera,
    alignment: { method: 'filled-triangle-silhouette', camera, source: 'explicit-camera', silhouetteIoU: 1, aspectPenalty: 0, ambiguous: false, alternative: undefined, limitations: 'synthetic positive source witnesses, not recognition' },
    projectionSize: width, pixelFaces, imageBounds: [0, width - 1, 0, height - 1],
    viewBounds: [0, 28, 0, 28], meshCenter: [14, 0, 14], extent: 28, depthTolerance: 1e-7,
  })!;
  for (let pixel = 0; pixel < width * height; pixel++) {
    const x = pixel % width, z = Math.floor(pixel / width);
    if (pixelFaces[pixel] >= 0 && (!options.pixels || options.pixels(x, z))) collector.recordPixel(pixel, pixel);
  }
  facePixels.forEach((pixel, face) => {
    if (face % 2) collector.recordCentroid(face, pixel % width + 0.5, Math.floor(pixel / width) + 0.5, pixel, 0, { face, depth: 0 });
  });
  mesh.sourceObservations = collector.finish();
  const model: Model = { name: 'horizontal material evidence', bricks, width: 30, depth: 30, height: 3, levels: [2], supportCount: 0, source: 'image', resolution: 28, shape: 'sculpture' };
  return { model, mesh };
}
function actualLedger(model: Model, result: Model) {
  const changes = model.bricks.flatMap((b, i) => b.color === result.bricks[i].color ? [] : [{ brickId: b.id, from: b.color, to: result.bricks[i].color }]);
  assert.deepEqual(result.colorDesign!.changes.map(({ brickId, from, to }) => ({ brickId, from, to })), changes);
  assert.equal(result.colorDesign!.changedBricks, changes.length);
  assert.deepEqual(result.bricks.map(({ color: _color, ...b }) => b), model.bricks.map(({ color: _color, ...b }) => b));
  const counts = Array(PALETTE.length).fill(0); for (const b of result.bricks) counts[b.color]++;
  assert.deepEqual(result.colorDesign!.afterColorCounts, counts);
}
const horizontalShade = (x: number): Paint => x < 14 ? { color: 7 } : { color: 1, raw: tanShade(0.25) };

void test('positively observed same-domain horizontal tan scalar shading is not locked as a paving pattern', () => {
  const { model, mesh } = topPlane(horizontalShade), original = structuredClone(model), source = structuredClone(mesh);
  const result = coherentModelColors(model, mesh);
  assert.equal(new Set(model.bricks.map((b) => b.color)).size, 2);
  assert.ok(result.bricks.every((b) => b.color === 7));
  assert.equal(result.colorDesign!.changedBricks, 392);
  assert.ok(result.colorDesign!.changes.every((c) => c.reason === 'source-scalar-shadow-design'));
  assert.equal(result.colorDesign!.protectionReasons!['observed-horizontal-pattern'] ?? 0, 0);
  assert.equal(result.colorDesign!.materialMetrics!.scalarShadowMismatchAreaAfter, 0);
  assert.equal(result.colorDesign!.materialMetrics!.protectedObservedMaterialChangedArea, 0);
  actualLedger(model, result); assert.deepEqual(model, original); assert.deepEqual(mesh, source);
});

void test('true gray, blue and warm horizontal mosaics still protect whole paving bricks', () => {
  for (const accent of [11, 4, 10]) {
    const { model, mesh } = topPlane((x, z) => ({ color: x % 7 === 0 || z % 7 === 0 ? accent : 7 }));
    const result = coherentModelColors(model, mesh);
    assert.deepEqual(result.bricks, model.bricks, `real palette material ${accent}`);
    assert.equal(result.colorDesign!.protectionReasons!['observed-horizontal-pattern'], 784);
    actualLedger(model, result);
  }
});

void test('source holes and disconnected horizontal scalar domains cannot license a packed paving detour', () => {
  for (const options of [{ gapRow: 14 }, { gapAfterX: true }]) {
    const { model, mesh } = topPlane(horizontalShade, options), source = structuredClone(mesh);
    const result = coherentModelColors(model, mesh);
    assert.deepEqual(result.bricks, model.bricks);
    assert.equal(result.colorDesign!.protectionReasons!['observed-horizontal-pattern'], 784);
    assert.deepEqual(mesh, source); actualLedger(model, result);
  }
});

void test('centroid-only, tiny bright anchors and unobserved dark exposure cannot unlock horizontal patterns', () => {
  const options = [
    { pixels: () => false },
    { pixels: (x: number, z: number) => z === 0 && x < 1 },
    { pixels: (x: number, z: number) => z === 0 && x < 11 },
    { pixels: (x: number) => x < 14 },
  ];
  for (const option of options) {
    const { model, mesh } = topPlane(horizontalShade, option), result = coherentModelColors(model, mesh);
    assert.deepEqual(result.bricks, model.bricks);
    assert.equal(result.colorDesign!.protectionReasons!['observed-horizontal-pattern'], 784);
  }
  const { model, mesh } = topPlane((x, z) => x === 0 && z === 0 ? { color: 7 } : { color: 1, raw: tanShade(0.25) });
  assert.deepEqual(coherentModelColors(model, mesh).bricks, model.bricks, 'one bright tile cannot become a material anchor for a whole roof');
});

void test('scalar-authorized horizontal top still abstains for an incompatible observed side on the same brick', () => {
  const { model, mesh } = topPlane(horizontalShade, { sideAccent: true }), result = coherentModelColors(model, mesh);
  assert.equal(result.bricks[at(20, 27)].color, 1);
  assert.ok(result.colorDesign!.protectionReasons!['whole-brick-material-conflict'] >= 1);
  assert.equal(result.colorDesign!.changedBricks, 391);
  assert.ok(result.colorDesign!.changes.every((c) => c.reason === 'source-scalar-shadow-design'));
  actualLedger(model, result);
});
