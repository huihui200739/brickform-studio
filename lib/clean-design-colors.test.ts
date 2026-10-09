import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { cleanModelColors, coherentModelColors, designModelColors } from './clean-design-colors.ts';
import { createSceneSurfaceGraph } from './scene-surface-graph.ts';
import { referenceMaterials } from './reference-materials.ts';
import { PALETTE, toLDraw, inventory, type Model, type Raster } from './brick-engine.ts';
import { rgb } from './material-color-space.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import { ASSEMBLY_PARTS } from './assembly-catalog.ts';
import { choosePartColor } from './part-color-policy.ts';
import { procurementReport } from './purchase-inventory.ts';

type Point = [number, number, number];
function plane(paint: (x: number, z: number) => { color: number; raw?: Point; feature?: number; section?: string }, folded = false, seamGap = 0) {
  const width = 28, positions: number[] = [], colors: number[] = [], features: number[] = [], bricks: Model['bricks'] = [];
  const rgba = new Uint8Array(width * width * 4), pixelFaces = new Int32Array(width * width);
  for (let z = 0; z < width; z++) for (let x = 0; x < width; x++) {
    const p = paint(x, z), id = z * width + x;
    const point = (u: number, v: number): Point => folded && x >= 14 ? [14 + seamGap, (u - 14) * 0.4, v] : [u, 0, v];
    positions.push(...point(x, z), ...point(x, z + 1), ...point(x + 1, z + 1), ...point(x, z), ...point(x + 1, z + 1), ...point(x + 1, z));
    colors.push(...rgb[p.color], ...rgb[p.color]); features.push(p.feature ?? 0, p.feature ?? 0);
    rgba.set([...(p.raw ?? rgb[p.color]), 255], id * 4); pixelFaces[id] = id * 2;
    bricks.push({ id: id + 1, part: '3070b', x: folded && x >= 14 ? 15 : x + 1, y: folded && x >= 14 ? x - 14 + 2 : 2, z: z + 1, w: 1, h: 1, d: 1, color: p.color, section: p.section ?? 'subject', support: false, pose: { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [x * 20, -24, z * 20] } });
  }
  const mesh: TriangleMesh = { positions: Float32Array.from(positions), colors: Uint8Array.from(colors), features: Uint8Array.from(features), name: 'generic painted plane' };
  const image: Raster = { width, height: width, data: rgba }, mask = new Uint8Array(width * width).fill(1), materials = referenceMaterials(image, mask, true);
  const camera = { yaw: 0, pitch: 90, perspective: 0 };
  const collector = createSceneSurfaceGraph({ positions: mesh.positions, image, mask, rawRegionIds: materials.labels, camera,
    alignment: { method: 'filled-triangle-silhouette', camera, source: 'explicit-camera', silhouetteIoU: 1, aspectPenalty: 0, ambiguous: false, alternative: undefined, limitations: 'synthetic source correspondence fixture, not recognition' },
    projectionSize: width, pixelFaces, imageBounds: [0, width - 1, 0, width - 1], viewBounds: [0, width, 0, width], meshCenter: [14, 0, 14], extent: width, depthTolerance: 1e-7,
  })!;
  for (let i = 0; i < width * width; i++) {
    collector.recordPixel(i, i);
    const face = i * 2 + 1; collector.recordCentroid(face, i % width + 0.5, Math.floor(i / width) + 0.5, i, 0, { face, depth: 0 });
  }
  mesh.sourceObservations = collector.finish();
  mesh.materialEvidence = { regionIds: new Int32Array(features.length), observed: new Uint8Array(features.length).fill(1) };
  const model: Model = { name: 'plane', bricks, width: width + 2, depth: width + 2, height: 3, levels: [2], supportCount: 0, source: 'image', resolution: 28, shape: 'sculpture' };
  return { mesh, model };
}
const at = (x: number, z: number) => z * 28 + x;

// New coherent-only source fixtures; the original twelve clean fixtures remain
// unchanged. Correspondence is explicit synthetic evidence, never recognition.
function rebindSource(fixture: ReturnType<typeof plane>, keep: (face: number) => boolean, sideFaces = false) {
  const { mesh, model } = fixture, source = mesh.sourceObservations!, width = 28;
  const positions: number[] = [], colors: number[] = [], features: number[] = [], pixels: number[] = [];
  for (let face = 0; face < mesh.positions.length / 9; face++) if (keep(face)) {
    positions.push(...mesh.positions.subarray(face * 9, face * 9 + 9)); colors.push(...mesh.colors.subarray(face * 3, face * 3 + 3));
    features.push(mesh.features![face]); pixels.push(Math.floor(face / 2));
  }
  if (sideFaces) for (let x = 0; x < width; x++) {
    const pixel = at(x, 27), color = rgb[model.bricks[pixel].color];
    positions.push(x, 0, 28, x + 1, 0, 28, x + 1, 0.4, 28, x, 0, 28, x + 1, 0.4, 28, x, 0.4, 28);
    colors.push(...color, ...color); features.push(0, 0); pixels.push(pixel, pixel);
  }
  const changed: TriangleMesh = { ...mesh, positions: Float32Array.from(positions), colors: Uint8Array.from(colors), features: Uint8Array.from(features) };
  const pixelFaces = new Int32Array(width * width).fill(-1);
  pixels.forEach((pixel, face) => { if (pixelFaces[pixel] < 0) pixelFaces[pixel] = face; });
  const camera = { yaw: 0, pitch: 90, perspective: 0 }, image = { width, height: width, data: source.raster.rgba };
  const collector = createSceneSurfaceGraph({ positions: changed.positions, image, mask: source.raster.foregroundMask, rawRegionIds: source.raster.rawRegionIds, camera,
    alignment: { ...source.alignment, camera }, projectionSize: width, pixelFaces, imageBounds: [0, 27, 0, 27], viewBounds: [0, 28, 0, 28], meshCenter: [14, 0, 14], extent: 28, depthTolerance: 1e-7,
  })!;
  for (let pixel = 0; pixel < width * width; pixel++) if (pixelFaces[pixel] >= 0) collector.recordPixel(pixel, pixel);
  pixels.forEach((pixel, face) => collector.recordCentroid(face, pixel % width + 0.5, Math.floor(pixel / width) + 0.5, pixel, 0, { face, depth: 0 }));
  changed.sourceObservations = collector.finish();
  changed.materialEvidence = { regionIds: new Int32Array(features.length), observed: new Uint8Array(features.length).fill(1) };
  return { mesh: changed, model };
}

void test('explicit clean repairs a source-compatible singleton without changing geometry or observations', () => {
  const { mesh, model } = plane((x, z) => ({ color: x === 12 && z === 12 ? 8 : 7, raw: rgb[7] as Point }));
  const original = structuredClone(model), source = structuredClone(mesh.sourceObservations), observed = mesh.materialEvidence!.observed.slice();
  assert.equal(designModelColors(model, mesh, 28), model, 'legacy default is faithful');
  assert.equal(designModelColors(model, mesh, 28, { colorMode: 'faithful' }), model);
  const clean = cleanModelColors(model, mesh);
  assert.equal(clean.bricks[at(12, 12)].color, 7);
  assert.equal(clean.colorDesign!.changedBricks, 1);
  assert.equal(clean.colorDesign!.approximation, true);
  assert.deepEqual(clean.bricks.map(({ color: _c, ...b }) => b), model.bricks.map(({ color: _c, ...b }) => b));
  assert.deepEqual(model, original, 'source Model is not mutated');
  assert.deepEqual(mesh.sourceObservations, source, 'raw RGB, edges and positions are not changed');
  assert.deepEqual(mesh.materialEvidence!.observed, observed, 'observed must not become invented confidence');
  assert.equal(inventory(clean.bricks).find((line) => line.color === 8), undefined);
  assert.equal(toLDraw(clean).includes(`1 ${PALETTE[8].ldraw} `), false, 'LDraw uses the changed model, not a shader');
});

void test('gradually connected shading can be designed consistently, while a true grey frame and dark stripe stay', () => {
  const { mesh, model } = plane((x, z) => {
    if (x === 2 || z === 2 || x === 25 || z === 25) return { color: 11, raw: rgb[11] as Point };
    if (z === 18) return { color: 10, raw: rgb[10] as Point };
    if (x >= 8 && x < 12) return { color: 8, raw: rgb[7].map((c) => Math.round(c * (x === 9 || x === 10 ? 0.85 : 0.89))) as Point };
    return { color: 7, raw: rgb[7] as Point };
  });
  const clean = cleanModelColors(model, mesh);
  assert.ok(clean.colorDesign!.changes.some((c) => c.reason === 'continuous-radiance-design'));
  for (let i = 0; i < model.bricks.length; i++) if ([10, 11].includes(model.bricks[i].color)) assert.equal(clean.bricks[i].color, model.bricks[i].color, 'sharp real painted boundaries are immutable');
});

void test('one-pixel black eyes, yellow beaks, orange fire and olive foliage are not deleted as small islands', () => {
  const markers = new Map<string, number>([['8,8', 1], ['9,8', 3], ['18,18', 6], ['20,20', 16]]);
  const { mesh, model } = plane((x, z) => ({ color: markers.get(`${x},${z}`) ?? 7, feature: x === 20 && z === 20 ? MESH_FEATURE.foliage : 0 }));
  const clean = cleanModelColors(model, mesh);
  for (const [k, color] of markers) { const [x, z] = k.split(',').map(Number); assert.equal(clean.bricks[at(x, z)].color, color); }
  assert.equal(clean.colorDesign!.changedBricks, 0);
});

void test('components, reserved cells, support, catalog substitutions and special parts cannot be colour donors or targets', () => {
  const { mesh, model } = plane((x, z) => ({ color: x === 12 && z === 12 ? 8 : 7, raw: rgb[7] as Point }));
  const index = at(12, 12), source = model.bricks[index];
  for (const patch of [{ section: 'component-duck-eye' }, { support: true }, { part: '4497' }]) {
    const trial = { ...model, bricks: model.bricks.map((b, i) => i === index ? { ...b, ...patch } : b) };
    assert.equal(cleanModelColors(trial, mesh).bricks[index].color, 8);
  }
  assert.equal(cleanModelColors({ ...model, semanticReservedCells: [`${source.x},${source.y},${source.z}`] }, mesh).bricks[index].color, 8);
  const colorChoice = { requestedColor: 11, selectedColor: 8, reason: 'reviewed-unsupported-catalog-color' as const, source: { url: 'https://example.test/catalog', checkedAt: '2026-10-02', kind: 'bricklink-catalog' as const } };
  const trial = { ...model, bricks: model.bricks.map((b, i) => i === index ? { ...b, colorChoice } : b) };
  assert.deepEqual(cleanModelColors(trial, mesh).bricks[index], { ...source, colorChoice });
});

void test('a uniformly shaded connected crease records orientation tone, not an invented radiance gradient', () => {
  const { mesh, model } = plane((x) => ({ color: x >= 14 ? 8 : 7, raw: (x >= 14 ? rgb[7].map((v) => Math.round(v * 0.72)) : rgb[7]) as Point }), true);
  const clean = cleanModelColors(model, mesh);
  assert.ok(clean.colorDesign!.changedBricks >= 300, 'whole column side, not just singleton repairs');
  assert.ok(clean.colorDesign!.changes.every((c) => c.reason === 'orientation-tone-design'));
  assert.equal(clean.bricks[at(20, 10)].color, 7);
  assert.deepEqual(mesh.materialEvidence!.observed, new Uint8Array(mesh.features!.length).fill(1));
});

void test('internally varying shade has distinct shaded-region evidence and sharp warm paint stays independent', () => {
  const shaded = plane((x, z) => ({ color: x >= 14 ? 8 : 7, raw: (x >= 14 ? rgb[7].map((v) => Math.round(v * (0.62 + z / 27 * 0.16))) : rgb[7]) as Point }), true);
  const result = cleanModelColors(shaded.model, shaded.mesh);
  assert.ok(result.colorDesign!.changedBricks >= 300);
  assert.ok(result.colorDesign!.changes.some((c) => c.reason === 'shaded-region-design'));
  assert.ok(result.colorDesign!.changes.every((c) => c.reason !== 'orientation-tone-design'));
  const painted = plane((x) => ({ color: x >= 14 ? 10 : 7 }), true);
  assert.equal(cleanModelColors(painted.model, painted.mesh).colorDesign!.changedBricks, 0, 'strong separate deep-brown paint is not a tone design');
});

void test('deep continuous warm shading is not locked as neutral paint by an absolute chroma floor', () => {
  const {mesh, model} = plane((x, z) => ({color:x >= 14 ? 10 : 7, raw:(x >= 14 ? rgb[7].map(v => Math.round(v * (0.45 + z / 27 * 0.13))) : rgb[7]) as Point}), true);
  const source = structuredClone(mesh.sourceObservations), evidence = structuredClone(mesh.materialEvidence);
  const clean = cleanModelColors(model, mesh);
  assert.ok(clean.colorDesign!.changedBricks >= 300, 'deep shade is a broad coherent face, not isolated colour noise');
  assert.ok(clean.colorDesign!.changes.every(c => c.reason === 'shaded-region-design'));
  assert.deepEqual(mesh.sourceObservations, source);
  assert.deepEqual(mesh.materialEvidence, evidence);
  const grey = plane(x => ({color:x >= 14 ? 12 : 7}), true);
  assert.equal(cleanModelColors(grey.model, grey.mesh).colorDesign!.changedBricks, 0, 'true low-chroma grey is not a deep warm shade');
});

void test('nearby warm planes across a real source gap do not become material donors', () => {
  const {mesh, model} = plane((x) => ({color:x >= 14 ? 8 : 7, raw:(x >= 14 ? rgb[7].map(v => Math.round(v * 0.72)) : rgb[7]) as Point}), true, 0.2);
  assert.equal(cleanModelColors(model, mesh).colorDesign!.changedBricks, 0, 'normal mapping cannot manufacture shared source edges across a hole');
});

void test('regular floor inlays and black/white identity marks stay even with ambiguous warm samples', () => {
  const patterned = plane((x, z) => ({color:x % 7 === 0 || z % 7 === 0 ? 8 : 7}));
  assert.deepEqual(cleanModelColors(patterned.model, patterned.mesh).bricks.map(b => b.color), patterned.model.bricks.map(b => b.color), 'repeated sharp-source floor layout is not palette noise');
  const identity = plane((x, z) => ({color:z === 12 && x === 12 ? 1 : z === 12 && x === 13 ? 0 : 7, raw:rgb[7] as Point}));
  const clean = cleanModelColors(identity.model, identity.mesh);
  assert.equal(clean.bricks[at(12, 12)].color, 1);
  assert.equal(clean.bricks[at(13, 12)].color, 0);
  assert.equal(clean.colorDesign!.changedBricks, 0);
});

void test('a reviewed negative catalog combination remains blocked even if a future regular part exposes it', () => {
  const {mesh, model} = plane((x, z) => ({color:x === 12 && z === 12 ? 12 : 11, raw:rgb[11] as Point}));
  const index = at(12, 12), source = model.bricks[index];
  assert.notEqual(choosePartColor('4497', 11).color, 11, 'real checked catalog omission');
  // Today this part is separately locked as a tree. Exercise the catalog guard
  // independently with a temporary regular-kind fixture; restore it synchronously.
  const part = ASSEMBLY_PARTS['4497'], kind = part.kind;
  try {
    part.kind = 'tile';
    const trial = {...model, bricks:model.bricks.map((b, i) => i === index ? {...b, part:'4497'} : b)};
    const clean = cleanModelColors(trial, mesh);
    assert.equal(clean.bricks[index].color, source.color);
    assert.equal(clean.colorDesign!.catalogBlocked, 1);
    assert.equal(clean.colorDesign!.changedBricks, 0);
  } finally { part.kind = kind; }
});

void test('a completed clean design is idempotent and cannot accumulate colour-only metadata', () => {
  const {mesh, model} = plane((x, z) => ({color:x === 12 && z === 12 ? 8 : 7, raw:rgb[7] as Point}));
  const clean = cleanModelColors(model, mesh), snapshot = structuredClone(clean);
  assert.equal(cleanModelColors(clean, mesh), clean);
  assert.deepEqual(clean, snapshot);
  assert.equal(clean.colorDesign!.changes.length, 1);
});

void test('no source ledger is not permission for majority paint and invalid modes are rejected', () => {
  const { mesh, model } = plane((x, z) => ({ color: x === 12 && z === 12 ? 8 : 7, raw: rgb[7] as Point }));
  const result = cleanModelColors(model, { ...mesh, sourceObservations: undefined });
  assert.equal(result.bricks, model.bricks);
  assert.equal(result.colorDesign!.changedBricks, 0);
  assert.match(result.colorDesign!.limitations.at(-1)!, /No compatible/);
  assert.throws(() => designModelColors(model, mesh, 28, { colorMode: 'invented' } as never), /options are invalid/);
});

void test('coherent is a distinct explicit material choice for an uncertain warm structural wall stripe', () => {
  const { mesh, model } = plane(x => ({ color: x >= 14 ? 10 : 7, raw: (x >= 14 ? [112, 68, 26] : rgb[7]) as Point }), true);
  const source = structuredClone(mesh), original = structuredClone(model);
  const conservative = cleanModelColors(model, mesh), coherent = designModelColors(model, mesh, 28, { colorMode: 'coherent' });
  assert.equal(conservative.colorDesign!.changedBricks, 0, 'uncertain strong warm band is not relabelled as conservative evidence');
  assert.ok(coherent.colorDesign!.changedBricks >= 300, 'material choice unifies a structural face, not just tiny islands');
  assert.equal(coherent.colorDesign!.mode, 'coherent');
  assert.ok(coherent.colorDesign!.changes.every(c => c.reason === 'source-local-material-design'));
  assert.equal(coherent.bricks[at(20, 10)].color, 7);
  assert.match(coherent.colorDesign!.limitations.join(' '), /user-selected.*NOT single-image/);
  assert.deepEqual(model, original); assert.deepEqual(mesh, source);
  assert.deepEqual(coherent.bricks.map(({ color: _c, ...b }) => b), model.bricks.map(({ color: _c, ...b }) => b));
  const actual = model.bricks.flatMap((b, i) => b.color === coherent.bricks[i].color ? [] : [{ brickId: b.id, from: b.color, to: coherent.bricks[i].color }]);
  assert.deepEqual(coherent.colorDesign!.changes.map(({ brickId, from, to }) => ({ brickId, from, to })), actual);
  assert.equal(coherent.colorDesign!.changedBricks, actual.length);
  for (const b of coherent.bricks) assert.equal(choosePartColor(b.part, b.color).color, b.color);
  const procurement = procurementReport(coherent);
  assert.equal(procurement.unsupportedColors, 0);
  assert.equal(procurement.stockChecked, false, 'catalog acceptance does not invent current stock');
  assert.ok(procurement.unverified > 0, 'fixture tile colours remain honestly unverified');
  assert.equal(coherentModelColors(coherent, mesh), coherent);
  assert.equal(cleanModelColors(coherent, mesh), coherent, 'designed colours do not become source evidence when switching modes');
});

void test('coherent preserves actual neutral/colored/stable warm paint and regular horizontal paving', () => {
  for (const color of [0, 1, 2, 6, 11, 12, 16, 10]) {
    const { mesh, model } = plane(x => ({ color: x >= 14 ? color : 7 }), true);
    assert.equal(coherentModelColors(model, mesh).colorDesign!.changedBricks, 0, `real palette paint ${color} is retained`);
  }
  // A warm quantization ID cannot overrule neutral or saturated source paint.
  for (const raw of [rgb[12], rgb[2]]) {
    const { mesh, model } = plane(x => ({ color: x >= 14 ? 8 : 7, raw: (x >= 14 ? raw : rgb[7]) as Point }), true);
    assert.equal(coherentModelColors(model, mesh).colorDesign!.changedBricks, 0);
  }
  const { mesh, model } = plane((x, z) => ({ color: x % 7 === 0 || z % 7 === 0 ? 8 : 7, raw: [112, 68, 26] }));
  assert.deepEqual(coherentModelColors(model, mesh).bricks, model.bricks, 'floor mosaics are not exterior-wall votes');
});

void test('coherent requires an exact connected source anchor and protects dark cavity/back planes', () => {
  const paint = (x: number) => ({ color: x >= 14 ? 10 : 7, raw: (x >= 14 ? [112, 68, 26] : rgb[7]) as Point });
  const gap = plane(paint, true, 0.2);
  assert.equal(coherentModelColors(gap.model, gap.mesh).colorDesign!.changedBricks, 0, 'nearby disconnected source planes stay independent');
  const cavity = plane(paint, true);
  // An outer skin in the face's normal direction makes the uncertain warm
  // vertical plane a cavity back, rather than the outside material domain.
  const back = { ...cavity.model, bricks: [...cavity.model.bricks, { id: 9001, part: '3005', x: 12, y: 3, z: 1, w: 1, h: 13, d: 28, color: 1, section: 'subject', support: false }] };
  assert.equal(coherentModelColors(back, cavity.mesh).colorDesign!.changedBricks, 0);
  const noSource = coherentModelColors(cavity.model, { ...cavity.mesh, sourceObservations: undefined });
  assert.equal(noSource.colorDesign!.mode, 'coherent'); assert.equal(noSource.colorDesign!.changedBricks, 0);
});

void test('coherent locks features, reserved/support/components/specialparts and catalog choices', () => {
  const { mesh, model } = plane(x => ({ color: x >= 14 ? 10 : 7, raw: (x >= 14 ? [112, 68, 26] : rgb[7]) as Point }), true);
  const index = at(20, 10), source = model.bricks[index];
  for (const patch of [{ section: 'component-tree-trunk' }, { support: true }, { part: '4497' }, { colorChoice: { requestedColor: 11, selectedColor: 10, reason: 'reviewed-unsupported-catalog-color' as const, source: { url: 'https://example.test/catalog', checkedAt: '2026-10-02', kind: 'bricklink-catalog' as const } } }]) {
    const trial = { ...model, bricks: model.bricks.map((b, i) => i === index ? { ...b, ...patch } : b) };
    assert.equal(coherentModelColors(trial, mesh).bricks[index].color, 10);
  }
  assert.equal(coherentModelColors({ ...model, semanticReservedCells: [`${source.x},${source.y},${source.z}`] }, mesh).bricks[index].color, 10);
  const leafy = plane(x => ({ color: x >= 14 ? 10 : 7, raw: (x >= 14 ? [112, 68, 26] : rgb[7]) as Point, feature: x >= 14 ? MESH_FEATURE.foliage : 0 }), true);
  assert.equal(coherentModelColors(leafy.model, leafy.mesh).colorDesign!.changedBricks, 0, 'warm foliage/timber-shaped source cannot become sand');
});

void test('coherent preserves whole regular paving bricks whose warm side faces are source-anchored too', () => {
  const original = plane(x => ({ color: x % 7 === 0 ? 10 : 7, raw: (x % 7 === 0 ? [112, 68, 26] : rgb[7]) as Point }));
  const { mesh, model } = rebindSource(original, () => true, true);
  const result = coherentModelColors(model, mesh);
  assert.deepEqual(result.bricks, model.bricks, 'observed mixed broad top layout locks the whole brick, not just its top face');
  assert.equal(result.colorDesign!.changedBricks, 0);
});

void test('coherent cannot use unknown packed-cell detours to fill a real source surface gap', () => {
  const original = plane((x, z) => ({ color: x >= 14 && z >= 14 ? 10 : 7, raw: (x >= 14 && z >= 14 ? [112, 68, 26] : rgb[7]) as Point }), true);
  // The Model deliberately retains the gap-row bricks: it is connected built
  // geometry, while the two source surface domains have no shared exact edge.
  const { mesh, model } = rebindSource(original, face => Math.floor(Math.floor(face / 2) / 28) !== 14);
  const snapshot = structuredClone(mesh), result = coherentModelColors(model, mesh);
  assert.ok(result.colorDesign!.changedBricks > 0, 'independently anchored observed domains may still be designed');
  for (let x = 14; x < 28; x++) assert.equal(result.bricks[at(x, 14)].color, 10, 'unobserved packed bridge is not source connectivity');
  assert.deepEqual(mesh, snapshot, 'the source hole and observation flags are unchanged');
});
