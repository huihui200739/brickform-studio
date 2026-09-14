import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import {
  COMPONENT_SIZES,
  meshFrame,
  suggestComponents,
  validateRegions,
  type ComponentRegion,
} from './semantic-components.ts';
import { meshToDesign, meshToDesignAuto } from './mesh-design.ts';
import { validateModel } from './brick-engine.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';

// The fixtures are deliberately geometric: nothing here is a temple template.
function shapes(
  items: { box: number[]; color: number[]; segments?: number[] }[],
): TriangleMesh {
  const positions: number[] = [],
    colors: number[] = [];
  for (const { box, color, segments } of items) {
    const [x, y, z, w, h, d] = box,
      g = new BoxGeometry(w, h, d, ...((segments || [1, 1, 1]) as number[]))
        .toNonIndexed()
        .translate(x + w / 2, y + h / 2, z + d / 2);
    positions.push(...g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count / 3; i++)
      colors.push(...color);
    g.dispose();
  }
  return {
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    name: '自动组件测试',
  };
}
const SAND = [215, 186, 140],
  FOLIAGE = [60, 140, 60],
  FLAME = [254, 138, 24],
  DARK = [48, 44, 40],
  GREY = [100, 100, 100];
void test('two flames on opposite sides are seated as one mirrored pair', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [9, 1, 4, 2, 8, 2], color: SAND, segments: [2, 4, 2] },
    { box: [3, 1, 5, 1, 2, 1], color: FLAME, segments: [2, 2, 2] },
    { box: [16, 1, 5, 1, 2, 1], color: FLAME, segments: [2, 2, 2] },
  ]);
  const hints = suggestComponents(mesh, 20, { statue: false }).filter(
    (h) => h.kind === 'brazier',
  );
  assert.equal(hints.length, 2);
  const auto = meshToDesignAuto(mesh, 20, hints);
  assert.equal(auto.dropped.length, 0);
  const [a, b] = auto.applied;
  assert.equal(a.anchor[1], b.anchor[1], 'the pair shares one height');
  assert.equal(a.anchor[2], b.anchor[2], 'the pair shares one depth');
  assert.ok(
    Math.abs(a.anchor[0] + b.anchor[0] - 1) < 1e-9,
    'the pair mirrors about the model centre',
  );
  assert.equal(validateModel(auto.model).connected, true);
});
void test('a low compact dark mass reads as a tree while a facade recess does not', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [2, 1, 2, 2, 3, 2], color: DARK, segments: [2, 3, 2] },
    { box: [10, 8, 10, 1, 6, 4], color: DARK, segments: [2, 6, 2] },
  ]);
  const hints = suggestComponents(mesh, 20, { statue: false });
  const trees = hints.filter((h) => h.kind === 'tree');
  assert.equal(
    trees.length,
    1,
    'the wall recess must not be offered as a tree',
  );
  assert.equal(trees[0].source, 'guess');
  assert.ok(
    Math.abs(trees[0].anchor[0] - 0.15) < 0.12,
    'the tree stands on the low dark mass, not on the recess',
  );
});
void test('two flames put the figure between them at the entrance', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [3, 1, 5, 1, 2, 1], color: FLAME, segments: [2, 2, 2] },
    { box: [16, 1, 5, 1, 2, 1], color: FLAME, segments: [2, 2, 2] },
    { box: [9, 1, 8, 2, 5, 2], color: DARK, segments: [2, 5, 2] },
  ]);
  const hints = suggestComponents(mesh, 20, { statue: true });
  const flames = hints.filter((h) => h.kind === 'brazier'),
    statue = hints.find((h) => h.kind === 'statue');
  assert.equal(flames.length, 2);
  assert.ok(statue, 'a figure is still offered');
  assert.equal(statue.source, 'guess');
  assert.ok(
    Math.abs(
      statue.anchor[0] - (flames[0].anchor[0] + flames[1].anchor[0]) / 2,
    ) < 1e-6,
    'the figure stands between the two flames',
  );
});
void test('detection separates foliage and flames from sand, grey and white bricks', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [2, 1, 2, 4, 4, 4], color: FOLIAGE, segments: [2, 2, 2] },
    { box: [16, 1, 16, 1, 2, 1], color: FLAME },
    { box: [13, 1, 13, 1, 2, 1], color: GREY },
    { box: [10, 1, 10, 2, 6, 2], color: DARK, segments: [3, 8, 3] },
  ]);
  const hints = suggestComponents(mesh, 20);
  const kinds = hints.map((h) => h.kind);
  assert.ok(kinds.includes('tree'), 'green foliage becomes a tree candidate');
  assert.ok(
    kinds.includes('brazier'),
    'orange flame becomes a brazier candidate',
  );
  assert.ok(
    kinds.includes('statue'),
    'a dark upright mass becomes a person guess',
  );
  assert.equal(
    hints.find((h) => h.kind === 'statue')!.source,
    'guess',
    'the person is always labelled a guess, never a colour detection',
  );
  assert.equal(hints.length, new Set(hints.map((h) => h.id)).size);
  // Candidates must never overlap, otherwise conversion rejects the whole set.
  assert.doesNotThrow(() =>
    validateRegions(
      hints.map((h) => ({ ...h, placed: true })),
      meshFrame(mesh, 20).grid,
    ),
  );
  const auto = meshToDesignAuto(
    mesh,
    20,
    hints.map((h) => ({ ...h, placed: true })),
  );
  assert.equal(auto.applied.length + auto.dropped.length, hints.length);
});
void test('a colour centroid that cannot be seated is nudged to a working bottom position', () => {
  // A thin partition splits the floor: cutting into it leaves the wall above
  // unsupported, so the raw centroid fails while a nearby position succeeds.
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [9, 1, 4, 2, 10, 12], color: SAND },
  ]);
  const region: ComponentRegion = {
    id: 'flame',
    kind: 'brazier',
    placed: true,
    anchor: [0.6, 1 / 14, 0.5],
    ...COMPONENT_SIZES.brazier,
    rotation: 0,
  };
  assert.throws(
    () => meshToDesign(mesh, 20, [region]),
    /干涉|连接/,
    'the raw centroid really is rejected by the strict conversion',
  );
  const auto = meshToDesignAuto(mesh, 20, [region]);
  assert.equal(auto.applied.length, 1, 'the component is still placed');
  assert.equal(auto.dropped.length, 0);
  assert.notDeepEqual(
    auto.applied[0].anchor,
    region.anchor,
    'the placed anchor moved away from the failing centroid',
  );
  assert.equal(auto.applied[0].placed, true);
  assert.equal(auto.model.semanticDesign!.autoPlaced, true);
  assert.equal(auto.model.semanticDesign!.components.length, 1);
  const check = validateModel(auto.model);
  assert.equal(check.collisions, 0);
  assert.equal(check.unsupported, 0);
  assert.equal(check.connected, true);
});
void test('a tree the palette paints sand is still seated, because the picture saw leaves', () => {
  // The reference's olive canopy and its sand planter become the same brick
  // colour, so a colour reading on its own finds nothing here. The foliage flag
  // read from the photograph is what survives the quantisation.
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [2, 1, 2, 4, 5, 4], color: SAND, segments: [2, 5, 2] },
  ]);
  assert.equal(
    suggestComponents(mesh, 20, { statue: false }).filter(
      (h) => h.kind === 'tree',
    ).length,
    0,
    'without the flag the sand-coloured canopy is invisible',
  );
  mesh.features = new Uint8Array(mesh.positions.length / 9);
  for (let t = 0; t < mesh.features.length; t++) {
    const [x, y, z] = [0, 1, 2].map(
      (a) =>
        (mesh.positions[t * 9 + a] +
          mesh.positions[t * 9 + 3 + a] +
          mesh.positions[t * 9 + 6 + a]) /
        3,
    );
    if (x > 1.9 && x < 6.1 && y >= 1 && z > 1.9 && z < 6.1)
      mesh.features[t] = MESH_FEATURE.foliage;
  }
  const hints = suggestComponents(mesh, 20, { statue: false });
  const trees = hints.filter((h) => h.kind === 'tree');
  assert.equal(trees.length, 1, 'the flagged canopy becomes one tree');
  assert.equal(trees[0].source, 'color');
  assert.ok(
    Math.abs(trees[0].anchor[0] - 0.2) < 0.12 &&
      Math.abs(trees[0].anchor[2] - 0.2) < 0.12,
    'the tree stands on the flagged canopy, not elsewhere',
  );
  const auto = meshToDesignAuto(
    mesh,
    20,
    hints.map((h) => ({ ...h, placed: true })),
  );
  assert.equal(auto.dropped.length, 0, 'the tree is seated');
  assert.equal(validateModel(auto.model).connected, true);
});
void test('a component that cannot be seated never blocks the finished product', () => {
  // A roof bridged across two towers loses its support if the courtyard volume
  // below is removed, so this component has nowhere valid to go.
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [0, 1, 0, 6, 12, 20], color: SAND },
    { box: [14, 1, 0, 6, 12, 20], color: SAND },
    { box: [0, 13, 0, 20, 1, 20], color: SAND },
  ]);
  const region: ComponentRegion = {
    id: 'canopy',
    kind: 'tree',
    placed: true,
    anchor: [0.5, 1 / 14, 0.5],
    ...COMPONENT_SIZES.tree,
    rotation: 0,
  };
  assert.throws(() => meshToDesign(mesh, 20, [region]));
  const base = meshToDesign(mesh, 20),
    auto = meshToDesignAuto(mesh, 20, [region]);
  assert.equal(auto.applied.length, 0);
  assert.equal(auto.dropped.length, 1);
  assert.equal(
    auto.model.bricks.length,
    base.bricks.length,
    'the conversion falls back to the plain grid model',
  );
  assert.equal(auto.model.semanticDesign, undefined);
  assert.match(auto.model.assembly!.reference, /保留原网格/);
  const check = validateModel(auto.model);
  assert.equal(check.connected, true);
  assert.equal(check.collisions + check.unsupported, 0);
});
void test('a tree in the courtyard must not be moved to an available roof', () => {
  // A roof bridged across two towers: nowhere inside the courtyard can take a
  // tree, but the flat roof above it can.
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [0, 1, 0, 6, 12, 20], color: SAND },
    { box: [14, 1, 0, 6, 12, 20], color: SAND },
    { box: [0, 13, 0, 20, 1, 20], color: SAND },
  ]);
  const region: ComponentRegion = {
    id: 'guess',
    kind: 'tree',
    anchor: [0.5, 1 / 14, 0.5],
    fallbackAnchors: [[0.5, 13.5 / 14, 0.5]],
    ...COMPONENT_SIZES.tree,
    rotation: 0,
  };
  assert.throws(() => meshToDesign(mesh, 20, [region]));
  assert.equal(
    meshToDesignAuto(mesh, 20, [{ ...region, fallbackAnchors: undefined }])
      .dropped.length,
    1,
    'without the alternative the guess is dropped',
  );
  const auto = meshToDesignAuto(mesh, 20, [region]);
  assert.equal(auto.dropped.length, 1);
  assert.equal(auto.applied.length, 0);
  assert.equal(auto.reports[0].status, 'conflict');
  assert.deepEqual(auto.dropped[0].anchor, region.anchor);
  assert.equal(validateModel(auto.model).connected, true);
});
void test('an unplaced manual component retains its pending state without blocking conversion', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [8, 1, 8, 4, 12, 4], color: SAND },
  ]);
  const region: ComponentRegion = {
    id: 'manual',
    kind: 'tree',
    placed: false,
    anchor: [0.25, 0, 0.25],
    ...COMPONENT_SIZES.tree,
    rotation: 0,
  };
  assert.throws(() => meshToDesign(mesh, 20, [region]), /定位/);
  const auto = meshToDesignAuto(mesh, 20, [region]);
  assert.equal(auto.applied.length, 0);
  assert.equal(auto.dropped[0].placed, false);
  assert.equal(auto.reports[0].status, 'unpositioned');
  assert.equal(auto.model.semanticDesign, undefined);
  const check = validateModel(auto.model);
  assert.equal(check.connected, true);
  assert.equal(check.collisions + check.unsupported, 0);
});
void test('preview and conversion preserve accepted poses and export their placement audit', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [8, 1, 8, 4, 12, 4], color: SAND },
  ]);
  const region: ComponentRegion = {
    id: 'tree',
    kind: 'tree',
    anchor: [0.25, 0, 0.25],
    ...COMPONENT_SIZES.tree,
    rotation: 0,
    placed: true,
  };
  const first = meshToDesignAuto(mesh, 20, [region]);
  assert.equal(first.applied.length, 1);
  const again = meshToDesignAuto(mesh, 20, first.applied);
  assert.deepEqual(again.applied, first.applied);
  assert.deepEqual(
    again.model.componentPlacement,
    first.model.componentPlacement,
  );
  assert.match(again.model.assembly!.reference, /组件位置检查/);
  assert.deepEqual(again.model.bricks, first.model.bricks);
});
void test('a later impossible component cannot erase an earlier accepted component when budget runs out', () => {
  const mesh = shapes([
    { box: [0, 0, 0, 20, 1, 20], color: SAND },
    { box: [8, 1, 8, 4, 12, 4], color: SAND },
  ]);
  const good: ComponentRegion = {
    id: 'tree',
    kind: 'tree',
    anchor: [0.25, 0, 0.25],
    ...COMPONENT_SIZES.tree,
    rotation: 0,
    placed: true,
  };
  const seated = meshToDesignAuto(mesh, 20, [good]).applied[0];
  const fixed = {
    ...seated,
    referenceAnchor: seated.anchor,
    positionLocked: true,
  };
  const bad: ComponentRegion = { ...fixed, id: 'bad' }; // Same mounting point: collides.
  const auto = meshToDesignAuto(mesh, 20, [fixed, bad], 2);
  assert.equal(auto.attempts, 2);
  assert.deepEqual(
    auto.applied.map((r) => r.id),
    ['tree'],
  );
  assert.deepEqual(
    auto.dropped.map((r) => r.id),
    ['bad'],
  );
  assert.equal(auto.reports[1].status, 'budget');
  assert.equal(auto.model.semanticDesign!.components.length, 1);
  assert.equal(validateModel(auto.model).connected, true);
});
