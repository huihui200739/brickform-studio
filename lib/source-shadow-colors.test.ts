import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { coherentModelColors, cleanModelColors, designModelColors } from './clean-design-colors.ts';
import { sourceScalarRelation, sourceFactorMaterialKey } from './source-shadow-colors.ts';
import { createSceneSurfaceGraph } from './scene-surface-graph.ts';
import { referenceMaterials } from './reference-materials.ts';
import { PALETTE, type Model, type Raster } from './brick-engine.ts';
import { rgb } from './material-color-space.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import { ASSEMBLY_PARTS } from './assembly-catalog.ts';
import { choosePartColor } from './part-color-policy.ts';
import { procurementReport } from './purchase-inventory.ts';

type Point = [number, number, number];
const at = (x: number, z: number) => z * 28 + x;
const shade = (c: number, s: number) => rgb[c].map(v => Math.round(v * s)) as Point;
/** Explicit synthetic correspondences; no native generation or camera inference. */
function fixture(paint: (x: number, z: number) => { color: number; raw?: Point; feature?: number }, gap = 0, hole = -1) {
  const width = 28, positions: number[] = [], colors: number[] = [], features: number[] = [], bricks: Model['bricks'] = [], pixelList: number[] = [];
  const rgba = new Uint8Array(width * width * 4), pixelFaces = new Int32Array(width * width).fill(-1);
  for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    const p = paint(x, z), pixel = at(x, z);
    const point = (u: number, v: number): Point => x >= 14 ? [14 + gap, (u - 14) * 0.4, v] : [u, 0, v];
    rgba.set([...(p.raw ?? rgb[p.color]), 255], pixel * 4);
    if (z !== hole) {
      pixelFaces[pixel] = features.length;
      positions.push(...point(x, z), ...point(x, z + 1), ...point(x + 1, z + 1), ...point(x, z), ...point(x + 1, z + 1), ...point(x + 1, z));
      colors.push(...rgb[p.color], ...rgb[p.color]); features.push(p.feature ?? 0, p.feature ?? 0); pixelList.push(pixel, pixel);
    }
    bricks.push({ id: pixel + 1, part: '3070b', x: x >= 14 ? 15 : x + 1, y: x >= 14 ? x - 14 + 2 : 2, z: z + 1, w: 1, h: 1, d: 1, color: p.color, section: 'subject', support: false, pose: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [x * 20, -24, z * 20] } });
  }
  const mesh: TriangleMesh = { positions: Float32Array.from(positions), colors: Uint8Array.from(colors), features: Uint8Array.from(features), name: 'scalar-domain paired synthetic' };
  const image: Raster = { width, height: width, data: rgba }, mask = new Uint8Array(width * width).fill(1), materials = referenceMaterials(image, mask, true), camera = { yaw: 0, pitch: 90, perspective: 0 };
  const collector = createSceneSurfaceGraph({ positions: mesh.positions, image, mask, rawRegionIds: materials.labels, camera,
    alignment: { method: 'filled-triangle-silhouette', camera, source: 'explicit-camera', silhouetteIoU: 1, aspectPenalty: 0, ambiguous: false, alternative: undefined, limitations: 'synthetic source correspondence, not recognition' },
    projectionSize: width, pixelFaces, imageBounds: [0, 27, 0, 27], viewBounds: [0, 28, 0, 28], meshCenter: [14, 0, 14], extent: 28, depthTolerance: 1e-7,
  })!;
  for (let pixel = 0; pixel < width * width; pixel++) if (pixelFaces[pixel] >= 0) collector.recordPixel(pixel, pixel);
  pixelList.forEach((pixel, face) => { if (face % 2) collector.recordCentroid(face, pixel % width + 0.5, Math.floor(pixel / width) + 0.5, pixel, 0, { face, depth: 0 }); });
  mesh.sourceObservations = collector.finish(); mesh.materialEvidence = { regionIds: new Int32Array(features.length), observed: new Uint8Array(features.length).fill(1) };
  const model: Model = { name: 'source shade', bricks, width: 30, depth: 30, height: 3, levels: [2], supportCount: 0, source: 'image', resolution: 28, shape: 'sculpture' };
  return { mesh, model };
}
function assertActualLedger(original: Model, result: Model) {
  const actual = original.bricks.flatMap((b, i) => b.color === result.bricks[i].color ? [] : [{ brickId: b.id, from: b.color, to: result.bricks[i].color }]);
  assert.deepEqual(result.colorDesign!.changes.map(({ brickId, from, to }) => ({ brickId, from, to })), actual);
  assert.equal(result.colorDesign!.changedBricks, actual.length);
  assert.deepEqual(result.bricks.map(({ color: _color, ...b }) => b), original.bricks.map(({ color: _color, ...b }) => b));
  const counts = Array(PALETTE.length).fill(0); for (const b of result.bricks) counts[b.color]++;
  assert.deepEqual(result.colorDesign!.afterColorCounts, counts);
}
function factorSource(f: ReturnType<typeof fixture>, body: number, accent: number, isAccent: (face: number) => boolean) {
  const faces = f.mesh.positions.length / 9;
  f.mesh.nativeAppearance = {
    version: 1, method: 'glb-native-appearance', intrinsicMaterialVerified: false,
    originalRGB: Uint8Array.from(Array.from({ length: faces }, (_, face) => rgb[isAccent(face) ? accent : body]).flat()),
    materialIds: Int32Array.from({ length: faces }, (_, face) => isAccent(face) ? 1 : 0),
    faceSourceKinds: new Uint8Array(faces).fill(1), alpha: new Float32Array(faces).fill(1),
    materials: [body, accent].map((color, id) => ({ id, source: 'explicit-gltf-material', name: `authored fixture ${id}`, baseColorFactor: [...rgb[color].map(v => v / 255), 1] as [number, number, number, number], alphaMode: 'OPAQUE', alphaCutoff: 0.5, doubleSided: false })),
  };
}

void test('raw scalar relation accepts deep tan despite low chroma, rejects gray/black and chromatically different warm paint', () => {
  for (const exposure of [0.15, 0.25, 0.5]) assert.ok(sourceScalarRelation(shade(7, exposure), rgb[7]));
  for (const raw of [[60, 60, 60], [36, 36, 36], [112, 68, 26], rgb[10], rgb[16]]) assert.equal(sourceScalarRelation(raw, rgb[7]), undefined);
});

void test('low-signal equality permits source continuity but not extrapolation from a dark anchor', () => {
  assert.ok(sourceScalarRelation([23, 23, 23], [23, 23, 23]));
  assert.equal(sourceScalarRelation([12, 12, 12], [23, 23, 23]), undefined);
  assert.equal(sourceScalarRelation([4, 4, 4], [23, 23, 23]), undefined);
  assert.ok(sourceScalarRelation([23, 23, 23], rgb[11]));
});

void test('an exact black radiance match without a licensed material clue remains uncertain, not verified paint', () => {
  const f = fixture(x => ({ color: x >= 14 ? 1 : 0 }));
  const result = coherentModelColors(f.model, f.mesh);
  assert.equal(result.colorDesign!.changedBricks, 0);
  assert.ok(result.colorDesign!.uncertainBricks! > 300);
  assert.equal(result.colorDesign!.protectionReasons!['observed-distinct-paint'], undefined);
  assertActualLedger(f.model, result);
});

void test('coherent v2 repairs tan ×.15/.25/.5 across black/olive IDs; real gray/black/olive/warm paint stays', () => {
  for (const [exposure, color] of [[0.15, 1], [0.25, 1], [0.5, 16]]) {
    const { mesh, model } = fixture(x => ({ color: x >= 14 ? color : 7, raw: x >= 14 ? shade(7, exposure) : rgb[7] as Point }));
    const original = structuredClone(model), source = structuredClone(mesh), result = coherentModelColors(model, mesh);
    for (let z = 0; z < 28; z++) for (let x = 14; x < 28; x++) assert.equal(result.bricks[at(x, z)].color, 7, `known authored scalar shade ${exposure} at ${x},${z}; changes ${result.colorDesign!.changedBricks}; ${JSON.stringify(result.colorDesign!.protectionReasons)}`);
    assert.equal(result.colorDesign!.policyVersion, 'provenance-material-v2');
    assert.ok(result.colorDesign!.changes.every(c => c.reason === 'source-scalar-shadow-design'));
    assert.ok(result.colorDesign!.materialMetrics!.scalarShadowMismatchAreaBefore > 150);
    assert.equal(result.colorDesign!.materialMetrics!.scalarShadowMismatchAreaAfter, 0);
    assert.equal(result.colorDesign!.materialMetrics!.domainInconsistentAreaAfter, 0);
    assert.equal(result.colorDesign!.materialMetrics!.protectedObservedMaterialChangedArea, 0);
    assertActualLedger(model, result); assert.deepEqual(model, original); assert.deepEqual(mesh, source);
    assert.equal(coherentModelColors(result, mesh), result); assert.equal(cleanModelColors(result, mesh), result);
    assert.equal(designModelColors(model, mesh, 28), model, 'faithful default unchanged');
  }
  for (const [color, raw] of [[12, [60, 60, 60]], [1, [36, 36, 36]], [16, rgb[16]], [10, rgb[10]]] as [number, Point][]) {
    const { mesh, model } = fixture(x => ({ color: x >= 14 ? color : 7, raw: x >= 14 ? raw : rgb[7] as Point })), result = coherentModelColors(model, mesh);
    assert.equal(result.colorDesign!.changedBricks, 0, `real painted ${raw.join(',')} is not tan scalar radiance`);
    assert.equal(result.colorDesign!.materialMetrics!.scalarShadowMismatchAreaBefore, 0);
    assert.equal(result.colorDesign!.materialMetrics!.protectedObservedMaterialChangedArea, 0);
  }
});

void test('source scalar design supports low-L blue/red bodies while real black and fresh accent stripes stay', () => {
  for (const body of [4, 2]) {
    const { mesh, model } = fixture((x, z) => x < 14 ? { color: body } : z === 12 ? { color: 1, raw: [36, 36, 36] } : z === 20 ? { color: 3 } : { color: 1, raw: shade(body, 0.15) });
    const result = coherentModelColors(model, mesh);
    for (let z = 0; z < 28; z++) for (let x = 14; x < 28; x++) assert.equal(result.bricks[at(x, z)].color, z === 12 ? 1 : z === 20 ? 3 : body);
    assert.ok(result.colorDesign!.materialMetrics!.scalarDesignBricks > 300);
    assert.equal(result.colorDesign!.materialMetrics!.localApproximationBricks, 0); assertActualLedger(model, result);
  }
});

void test('white/gray scalar shade requires a restricted material clue; intended neutral lines/proxy white/baked materials remain', () => {
  for (const body of [0, 11]) {
    const f = fixture((x, z) => x < 14 ? { color: body } : z === 12 ? { color: 12, raw: [60, 60, 60] } : { color: 1, raw: shade(body, 0.15) });
    const uncertain = coherentModelColors(f.model, f.mesh);
    assert.equal(uncertain.colorDesign!.changedBricks, 0, 'neutral scalar without same-material evidence abstains');
    assert.ok(uncertain.colorDesign!.uncertainBricks! > 300);
    factorSource(f, body, 12, face => Math.floor(face / 2) % 28 >= 14 && Math.floor(Math.floor(face / 2) / 28) === 12);
    const source = structuredClone(f.mesh), result = coherentModelColors(f.model, f.mesh);
    for (let z = 0; z < 28; z++) for (let x = 14; x < 28; x++) assert.equal(result.bricks[at(x, z)].color, z === 12 ? 12 : body);
    assert.deepEqual(f.mesh, source); assertActualLedger(f.model, result);
    const proxy = structuredClone(f.mesh); proxy.nativeAppearance!.materialIds.fill(0);
    proxy.nativeAppearance = { ...proxy.nativeAppearance!, materials: [proxy.nativeAppearance!.materials[0]] };
    if (body === 0) assert.equal(coherentModelColors(f.model, proxy).colorDesign!.changedBricks, 0, 'one all-white proxy slot is not identity');
    const baked = structuredClone(f.mesh); baked.nativeAppearance!.faceSourceKinds.fill(5);
    assert.equal(coherentModelColors(f.model, baked).colorDesign!.changedBricks, 0, 'texture-baked single slot cannot license neutral shade');
    const missing = structuredClone(f.mesh); missing.nativeAppearance!.materialIds.fill(-1);
    assert.equal(sourceFactorMaterialKey(missing, 0), -1);
    assert.equal(coherentModelColors(f.model, missing).colorDesign!.changedBricks, 0);
  }
});

void test('scalar cast shade/creases/recesses use local evidence without filling source holes or geometry', () => {
  const f = fixture((x, z) => x < 14 ? { color: 4 } : z < 6 ? { color: 7 } : { color: 1, raw: shade(7, 0.25) });
  const source = structuredClone(f.mesh), result = coherentModelColors(f.model, f.mesh);
  for (let z = 6; z < 28; z++) for (let x = 14; x < 28; x++) assert.equal(result.bricks[at(x, z)].color, 7, 'local same-plane anchor, not global inclination/majority');
  assert.deepEqual(f.mesh, source); assertActualLedger(f.model, result);
  const gap = fixture(x => ({ color: x >= 14 ? 1 : 7, raw: x >= 14 ? shade(7, 0.25) : rgb[7] as Point }), 0.2);
  assert.equal(coherentModelColors(gap.model, gap.mesh).colorDesign!.changedBricks, 0);
  const hole = fixture(x => ({ color: x >= 14 ? 1 : 7, raw: x >= 14 ? shade(7, 0.25) : rgb[7] as Point }), 0, 14), holeResult = coherentModelColors(hole.model, hole.mesh);
  assert.ok(holeResult.colorDesign!.changedBricks > 300);
  for (let x = 14; x < 28; x++) assert.equal(holeResult.bricks[at(x, 14)].color, 1, 'packed source gap is unknown, not a bridge');
  const recess = fixture(x => ({ color: x >= 14 ? 1 : 7, raw: x >= 14 ? shade(7, 0.25) : rgb[7] as Point }));
  const model = { ...recess.model, bricks: [...recess.model.bricks, { id: 9001, part: '3005', x: 12, y: 3, z: 1, w: 1, h: 13, d: 28, color: 1, section: 'subject', support: false }] }, recessed = coherentModelColors(model, recess.mesh);
  assert.equal(recessed.bricks[at(20, 10)].color, 7, 'positive same-material radiance need not be manufactured as dark bricks');
  assert.equal(recessed.bricks.at(-1)!.color, 1); assertActualLedger(model, recessed);
});

void test('centroid-only/tiny pixel witnesses cannot anchor either scalar or warm approximation', () => {
  for (const warm of [false, true]) {
    const f = fixture(x => ({ color: x >= 14 ? warm ? 10 : 1 : 7, raw: x >= 14 ? warm ? [112, 68, 26] : shade(7, 0.15) : rgb[7] as Point }));
    for (const witnessCount of [0, 1]) {
      const mesh = structuredClone(f.mesh); mesh.sourceObservations!.projection.observed.fill(0);
      for (let i = 0; i < witnessCount; i++) mesh.sourceObservations!.projection.observed[i] = 1;
      const result = coherentModelColors(f.model, mesh);
      assert.equal(result.colorDesign!.changedBricks, 0, `only ${witnessCount} raster witnesses; centroids are not positive coverage`);
      assert.ok(result.colorDesign!.uncertainBricks! > 0);
    }
  }
});

void test('scalar candidates retain source foliage, raw tree parts, reserved/components/support/reviewed catalog choices, even black IDs', () => {
  const f = fixture(x => ({ color: x >= 14 ? 1 : 7, raw: x >= 14 ? shade(7, 0.15) : rgb[7] as Point })), index = at(20, 10), source = f.model.bricks[index];
  for (const patch of [{ section: 'component-tree-trunk' }, { support: true }, { part: '4497' }, { colorChoice: { requestedColor: 11, selectedColor: 1, reason: 'reviewed-unsupported-catalog-color' as const, source: { url: 'https://example.test/catalog', checkedAt: '2026-10-02', kind: 'bricklink-catalog' as const } } }]) {
    const model = { ...f.model, bricks: f.model.bricks.map((b, i) => i === index ? { ...b, ...patch } : b) }, result = coherentModelColors(model, f.mesh);
    assert.equal(result.bricks[index].color, 1); assert.ok(result.colorDesign!.protectedBricks >= 1); assertActualLedger(model, result);
  }
  const reserved = coherentModelColors({ ...f.model, semanticReservedCells: [`${source.x},${source.y},${source.z}`] }, f.mesh);
  assert.equal(reserved.bricks[index].color, 1); assert.equal(reserved.colorDesign!.protectionReasons!['reserved-cell'], 1);
  const leafy = fixture(x => ({ color: x >= 14 ? 1 : 7, raw: x >= 14 ? shade(7, 0.15) : rgb[7] as Point, feature: x >= 14 ? MESH_FEATURE.foliage : 0 })), leafResult = coherentModelColors(leafy.model, leafy.mesh);
  assert.equal(leafResult.colorDesign!.changedBricks, 0); assert.ok(leafResult.colorDesign!.protectionReasons!['source-foliage'] >= 392);
  const noDonors = { ...f.model, bricks: f.model.bricks.map((b, i) => i % 28 < 14 ? { ...b, section: 'component-source-anchor' } : b) };
  assert.equal(coherentModelColors(noDonors, f.mesh).colorDesign!.changedBricks, 0, 'component appearance cannot donate body material');
});

void test('whole-brick real blue and shaded tan face conflict abstains instead of majority recolouring', () => {
  const f = fixture((x, z) => x < 14 ? { color: 7 } : x === 20 && z === 11 ? { color: 4 } : { color: 1, raw: shade(7, 0.15) });
  const first = at(20, 10), second = at(20, 11), merged = { ...f.model.bricks[first], d: 2 }, model = { ...f.model, bricks: f.model.bricks.flatMap((b, i) => i === second ? [] : [i === first ? merged : b]) }, result = coherentModelColors(model, f.mesh);
  assert.equal(result.bricks.find(b => b.id === merged.id)!.color, 1);
  assert.ok(result.colorDesign!.protectionReasons!['whole-brick-material-conflict'] >= 1);
  assert.ok(result.colorDesign!.changedBricks > 300); assertActualLedger(model, result);
});

void test('scalar target uses exact catalog gate and never promises stock', () => {
  const f = fixture(x => ({ color: x >= 14 ? 1 : 11, raw: x >= 14 ? shade(11, 0.15) : rgb[11] as Point })), index = at(20, 10), part = ASSEMBLY_PARTS['4497'], kind = part.kind;
  factorSource(f, 11, 12, () => false);
  assert.notEqual(choosePartColor('4497', 11).color, 11);
  try {
    part.kind = 'tile';
    const model = { ...f.model, bricks: f.model.bricks.map((b, i) => i === index ? { ...b, part: '4497' } : b) }, result = coherentModelColors(model, f.mesh);
    assert.equal(result.bricks[index].color, 1); assert.ok(result.colorDesign!.catalogBlocked >= 1);
    assert.equal(result.colorDesign!.protectionReasons!['target-catalog-blocked'], 1);
    for (const c of result.colorDesign!.changes) assert.equal(choosePartColor(model.bricks.find(b => b.id === c.brickId)!.part, c.to).color, c.to);
    assert.equal(procurementReport(result).stockChecked, false); assertActualLedger(model, result);
  } finally { part.kind = kind; }
});
