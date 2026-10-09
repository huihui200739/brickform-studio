import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { surfaceMaterials } from './surface-materials.ts';
import {
  snapshotNativeAppearance,
  SOURCE_COLOR_KIND,
  NATIVE_APPEARANCE_SOURCE,
} from './source-material-provenance.ts';

const quad = (
  x: number,
  y: number,
  z: number,
  w = 1,
  h = 1,
  reverse = false,
) => {
  const a = [x, y, z],
    b = [x + w, y, z],
    c = [x + w, y + h, z],
    d = [x, y + h, z];
  return reverse
    ? [...a, ...c, ...b, ...a, ...d, ...c]
    : [...a, ...b, ...c, ...a, ...c, ...d];
};

void test('opposite unknown walls use a wall consensus instead of the nearest brown recess or the blue roof default', () => {
  const result = surfaceMaterials(
    Float32Array.from([
      ...quad(-2, 0, 1, 1, 2), // observed gray exterior wall
      ...quad(0, 0, 0, 1, 2), // observed brown recess, nearest to rear
      ...quad(-1, 0, -0.1, 2, 2, true), // opposite unknown wall
      // Large horizontal blue canopy has most image votes, but is not a wall.
      -2,
      3,
      -1,
      -2,
      3,
      2,
      2,
      3,
      2,
      -2,
      3,
      -1,
      2,
      3,
      2,
      2,
      3,
      -1,
    ]),
    Int16Array.from([11, 11, 10, 10, -1, -1, 4, 4]),
    [
      ...Array(120).fill({ face: 0, color: 11 }),
      ...Array(30).fill({ face: 2, color: 10 }),
      ...Array(600).fill({ face: 6, color: 4 }),
    ],
    4,
  );
  assert.deepEqual(Array.from(result.colors), [11, 11, 10, 10, 11, 11, 4, 4]);
  const rear = result.design.regions[result.regionIds[4]];
  assert.equal(rear.source, 'inclination-consensus');
  assert.equal(rear.inferredSupport?.supportFraction, 0.8);
  assert.deepEqual(rear.donorRegionIds, [
    result.regionIds[0],
    result.regionIds[2],
  ]);
});

void test('a coplanar brown continuation stays brown even when other wall observations are mostly gray', () => {
  const result = surfaceMaterials(
    Float32Array.from([
      ...quad(0, 0, 0),
      ...quad(2, 0, 0), // disconnected but same-facing, same-plane continuation
      ...quad(0, 0, 4, 3, 2), // different plane has more gray image votes
    ]),
    Int16Array.from([9, 9, -1, -1, 11, 11]),
    [
      ...Array(30).fill({ face: 0, color: 9 }),
      ...Array(200).fill({ face: 4, color: 11 }),
    ],
    11,
  );
  assert.deepEqual(Array.from(result.colors), [9, 9, 9, 9, 11, 11]);
  const unknown = result.design.regions[result.regionIds[2]];
  assert.equal(unknown.source, 'compatible-surface');
  assert.deepEqual(unknown.donorRegionIds, [result.regionIds[0]]);
});

void test('dark gray wall observations remain valid when a brighter blue reference default dominates', () => {
  const result = surfaceMaterials(
    Float32Array.from([...quad(0, 0, 1), ...quad(0, 0, 0, 1, 1, true)]),
    Int16Array.from([12, 12, -1, -1]),
    Array(30).fill({ face: 0, color: 12 }),
    4,
  );
  assert.deepEqual(Array.from(result.colors), [12, 12, 12, 12]);
  assert.equal(
    result.design.regions[result.regionIds[2]].source,
    'inclination-consensus',
  );
});

void test('a conflicting wall family remains explicitly unresolved instead of claiming material agreement', () => {
  const result = surfaceMaterials(
    Float32Array.from([
      ...quad(0, 0, 1),
      ...quad(2, 0, 1),
      ...quad(1, 0, 0, 1, 1, true),
    ]),
    Int16Array.from([7, 7, 9, 9, -1, -1]),
    [
      ...Array(20).fill({ face: 0, color: 7 }),
      ...Array(20).fill({ face: 2, color: 9 }),
    ],
    11,
  );
  assert.deepEqual(Array.from(result.colors.subarray(0, 4)), [7, 7, 9, 9]);
  const unknown = result.design.regions[result.regionIds[4]];
  assert.equal(unknown.source, 'reference-default');
  assert.equal(unknown.color, 11);
  assert.equal(unknown.inferredSupport, undefined);
  assert.equal(result.design.defaultFaces, 2);
});

void test('missing paint cannot merge two observed colors via a connected unobserved detour', () => {
  const p: number[] = [];
  // A six-triangle strip of one plane: paint at both ends, unknown in between.
  for (let x = 0; x < 3; x++)
    p.push(x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 0, 0, x + 1, 1, 0, x, 1, 0);
  const positions = Float32Array.from(p),
    observed = Int16Array.from([2, 2, -1, -1, 4, 4]);
  const before = positions.slice();
  const result = surfaceMaterials(
    positions,
    observed,
    [...Array(20)].flatMap(() => [
      { face: 0, color: 2 },
      { face: 5, color: 4 },
    ]),
    2,
  );
  assert.deepEqual(positions, before);
  for (const id of [0, 1, 4, 5])
    assert.equal(
      result.colors[id],
      observed[id],
      'observed paint is immutable',
    );
  assert.notEqual(
    result.regionIds[0],
    result.regionIds[5],
    'a detour must not erase the paint boundary',
  );
  assert.equal(
    result.design.regions.reduce((n, r) => n + r.faces, 0),
    6,
  );
  assert.equal(
    result.design.regions.reduce((n, r) => n + r.observedPixels, 0),
    40,
  );
});

void test('coincident edges connect, a real thin gap stays separate, and unsupported hidden paint is marked as a default', () => {
  const positions = Float32Array.from([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0,
    // Same inclination but separated by a gap; no pixel observations.
    1.000001, 0, 0, 2, 0, 0, 2, 1, 0,
    // A far-away disconnected surface cannot inherit a local color.
    50, 0, 0, 51, 0, 0, 51, 1, 0,
  ]);
  const result = surfaceMaterials(
    positions,
    Int16Array.from([2, 2, -1, -1]),
    Array(16).fill({ face: 0, color: 2 }),
    7,
  );
  assert.equal(result.regionIds[0], result.regionIds[1]);
  assert.notEqual(result.regionIds[1], result.regionIds[2]);
  const far = result.design.regions[result.regionIds[3]];
  assert.equal(far.source, 'reference-default');
  assert.equal(far.color, 7);
  assert.deepEqual(far.donorRegionIds, []);
  assert.equal(result.colors[3], 7);
});

void test('a tiny observed orange ornament retains paint without coloring other unseen surfaces', () => {
  const p: number[] = [];
  const quad = (x: number, z: number, w: number, h: number) =>
    p.push(x, 0, z, x + w, 0, z, x + w, h, z, x, 0, z, x + w, h, z, x, h, z);
  quad(-1, 0, 1, 1); // Large sand surface.
  quad(0.1, 0.05, 0.02, 0.02); // Tiny orange ornament, nearest to the unknown panel.
  quad(0.2, 0, 1, 1); // Disconnected unknown panel.
  const observations = Int16Array.from([7, 7, 6, 6, -1, -1]);
  const pixels = [...Array(40)]
    .map(() => ({ face: 0, color: 7 }))
    .concat([...Array(500)].map(() => ({ face: 2, color: 6 })));
  const result = surfaceMaterials(
    Float32Array.from(p),
    observations,
    pixels,
    7,
  );
  assert.equal(result.colors[2], 6);
  assert.equal(result.colors[3], 6);
  assert.equal(
    result.colors[4],
    7,
    'small accent evidence cannot override wall material',
  );
  assert.equal(result.colors[5], 7);
  const region = result.design.regions[result.regionIds[4]];
  assert.ok(!region.donorRegionIds.includes(result.regionIds[2]));
});

function nativeFaces(ids: number[]) {
  return snapshotNativeAppearance({
    version: 1,
    method: 'glb-native-appearance',
    intrinsicMaterialVerified: false,
    originalRGB: Uint8Array.from(ids.flatMap(() => [255, 0, 255])),
    materialIds: Int32Array.from(ids),
    faceSourceKinds: new Uint8Array(ids.length).fill(1),
    alpha: new Float32Array(ids.length).fill(1),
    materials: [...new Set(ids)].map((id) => ({
      id,
      source:
        id < 0
          ? ('gltf-default-material' as const)
          : ('explicit-gltf-material' as const),
      name: 'authored synthetic material',
      baseColorFactor: [1, 0, 1, 1] as const,
      alphaMode: 'OPAQUE' as const,
      alphaCutoff: 0.5,
      doubleSided: false,
    })),
  });
}
function assertSourcePaths(
  p: Float32Array,
  result: ReturnType<typeof surfaceMaterials>,
  observed: Int16Array,
  pixels: { face: number; color: number }[],
) {
  const edges = new Map<string, number[]>();
  for (let f = 0; f < p.length / 9; f++)
    for (let e = 0; e < 3; e++) {
      const points = [e, (e + 1) % 3].map((v) =>
        Array.from(p.slice(f * 9 + v * 3, f * 9 + v * 3 + 3)).join(','),
      );
      const key = points.sort().join('|'),
        list = edges.get(key) ?? [];
      list.push(f);
      edges.set(key, list);
    }
  const parents = result.topologyParentFaces!;
  for (let f = 0; f < parents.length; f++)
    if (
      result.perFaceSourceKind[f] === SOURCE_COLOR_KIND.sourceTopologyInferred
    ) {
      let current = f;
      const seen = new Set<number>();
      while (parents[current] !== current) {
        assert.ok(!seen.has(current), 'source path cannot cycle');
        seen.add(current);
        const next = parents[current];
        assert.ok(next >= 0);
        assert.ok(
          [...edges.values()].some(
            (faces) =>
              faces.length === 2 &&
              faces.includes(current) &&
              faces.includes(next),
          ),
          'each path step is an exact manifold shared edge',
        );
        assert.equal(
          result.sourceDomainIds![current],
          result.sourceDomainIds![next],
        );
        current = next;
      }
      assert.ok(
        observed[current] >= 0,
        'a source path ends at an actual observed face',
      );
      assert.ok(
        pixels.some((pixel) => pixel.face === current),
        'the root has positive reference-pixel support, not only a centroid',
      );
      assert.equal(result.colors[f], observed[current]);
    }
}

void test('topology-only rejects disconnected coplanar and inclination donors while legacy remains byte-compatible', () => {
  for (const p of [
    Float32Array.from([...quad(0, 0, 0), ...quad(2, 0, 0)]),
    Float32Array.from([...quad(0, 0, 0), ...quad(0, 0, -3, 1, 1, true)]),
  ]) {
    const observed = Int16Array.from([9, 9, -1, -1]),
      pixels = Array(30).fill({ face: 0, color: 9 });
    const before = p.slice(),
      native = nativeFaces([4, 4, 4, 4]),
      snapshot = structuredClone(native);
    const legacy = surfaceMaterials(p, observed, pixels, 7);
    const explicitLegacy = surfaceMaterials(p, observed, pixels, 7, {
      unobservedPolicy: 'legacy',
      nativeAppearance: native,
    });
    const result = surfaceMaterials(p, observed, pixels, 7, {
      unobservedPolicy: 'source-topology-only',
      nativeAppearance: native,
    });
    assert.deepEqual(Array.from(legacy.colors), [9, 9, 9, 9]);
    assert.deepEqual(explicitLegacy.colors, legacy.colors);
    assert.deepEqual(Array.from(legacy.disconnectedInference), [0, 0, 1, 1]);
    assert.deepEqual(Array.from(result.colors), [9, 9, 7, 7]);
    assert.deepEqual(Array.from(result.perFaceSourceKind), [2, 2, 7, 7]);
    assert.equal(result.design.defaultFaces, 2);
    assert.equal(
      result.design.regions[result.regionIds[2]].source,
      'reference-default',
    );
    assert.equal(result.topologyParentFaces![2], -1);
    assert.deepEqual(p, before);
    assert.deepEqual(native, snapshot);
  }
});

void test('topology-only has a checkable positive source path for coplanar continuation', () => {
  const p = Float32Array.from([
    ...quad(0, 0, 0),
    ...quad(1, 0, 0),
    ...quad(2, 0, 0),
  ]);
  const observed = Int16Array.from([11, 11, -1, -1, -1, -1]),
    original = observed.slice();
  const pixels = Array(30).fill({ face: 0, color: 11 });
  const result = surfaceMaterials(p, observed, pixels, 4, {
    unobservedPolicy: 'source-topology-only',
  });
  assert.deepEqual(Array.from(result.colors), [11, 11, 11, 11, 11, 11]);
  assert.equal(result.design.defaultFaces, 0);
  assert.ok(result.design.regions.some((r) => r.source === 'source-topology'));
  assertSourcePaths(p, result, observed, pixels);
  assert.deepEqual(
    observed,
    original,
    'inferred paint never becomes an observation',
  );
});

const crease = () =>
  Float32Array.from([
    ...quad(0, 0, 0),
    1,
    0,
    0,
    1,
    0,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    1,
    1,
    1,
    1,
    1,
    0,
  ]);
void test('connected same native material supports multiple surfaces across a real crease, not a different material or missing default', () => {
  const p = crease(),
    observed = Int16Array.from([7, 7, -1, -1]),
    pixels = Array(30).fill({ face: 0, color: 7 });
  const native = nativeFaces([4, 4, 4, 4]);
  const result = surfaceMaterials(p, observed, pixels, 12, {
    unobservedPolicy: 'source-topology-only',
    nativeAppearance: native,
  });
  assert.deepEqual(Array.from(result.colors), [7, 7, 7, 7]);
  const side = result.design.regions[result.regionIds[2]];
  assert.equal(side.source, 'source-topology');
  assert.deepEqual(side.topologySupport?.nativeMaterialIds, [4]);
  assert.equal(side.topologySupport?.inference, true);
  assert.equal(side.observedFaces, 0);
  assert.equal(side.observedPixels, 0);
  assertSourcePaths(p, result, observed, pixels);
  for (const candidate of [
    undefined,
    nativeFaces([-1, -1, -1, -1]),
    nativeFaces([4, 4, 5, 5]),
    nativeFaces([4, 4, -1, -1]),
  ]) {
    const unknown = surfaceMaterials(p, observed, pixels, 12, {
      unobservedPolicy: 'source-topology-only',
      nativeAppearance: candidate,
    });
    assert.deepEqual(Array.from(unknown.colors), [7, 7, 12, 12]);
    assert.equal(unknown.topologyParentFaces![2], -1);
    assert.equal(
      unknown.perFaceSourceKind[2],
      SOURCE_COLOR_KIND.referenceDefault,
    );
  }
});

function unsupportedCreaseAppearances() {
  const native = nativeFaces([4, 4, 4, 4]);
  return {
    'single white proxy': snapshotNativeAppearance({
      ...native,
      originalRGB: new Uint8Array(12).fill(255),
      materials: native.materials.map((m) => ({
        ...m, baseColorFactor: [1, 1, 1, 1] as const,
      })),
    }),
    'single near-white proxy': snapshotNativeAppearance({
      ...native,
      materials: native.materials.map((m) => ({
        ...m, baseColorFactor: [0.95, 0.96, 1, 1] as const,
      })),
    }),
    'baked vertex colour': snapshotNativeAppearance({
      ...native,
      faceSourceKinds: new Uint8Array(4).fill(NATIVE_APPEARANCE_SOURCE.materialFactor | NATIVE_APPEARANCE_SOURCE.vertexColor),
    }),
    'baked texture': snapshotNativeAppearance({
      ...native,
      faceSourceKinds: new Uint8Array(4).fill(NATIVE_APPEARANCE_SOURCE.materialFactor | NATIVE_APPEARANCE_SOURCE.textureSample),
    }),
    'only the target is texture-baked': snapshotNativeAppearance({
      ...native,
      faceSourceKinds: Uint8Array.from([1, 1, 5, 5]),
    }),
    'default material source': snapshotNativeAppearance({
      ...native,
      materials: native.materials.map((m) => ({
        ...m, source: 'gltf-default-material' as const,
      })),
    }),
    'default face sample': snapshotNativeAppearance({
      ...native,
      faceSourceKinds: new Uint8Array(4).fill(NATIVE_APPEARANCE_SOURCE.defaultMaterial),
    }),
    'missing material': nativeFaces([-1, -1, -1, -1]),
    'alpha blend': snapshotNativeAppearance({
      ...native,
      materials: native.materials.map((m) => ({
        ...m, alphaMode: 'BLEND' as const,
      })),
    }),
    'alpha mask': snapshotNativeAppearance({
      ...native,
      materials: native.materials.map((m) => ({
        ...m, alphaMode: 'MASK' as const,
      })),
    }),
  };
}

void test('proxy, baked, default and nonopaque native samples cannot license unseen colour across a crease', () => {
  const p = crease(), observed = Int16Array.from([7, 7, -1, -1]);
  const pixels = Array(30).fill({ face: 0, color: 7 });
  const original = { p: p.slice(), observed: observed.slice(), pixels: structuredClone(pixels) };
  const legacy = surfaceMaterials(p, observed, pixels, 12);
  for (const [name, native] of Object.entries(unsupportedCreaseAppearances())) {
    const snapshot = structuredClone(native);
    const result = surfaceMaterials(p, observed, pixels, 12, {
      unobservedPolicy: 'source-topology-only', nativeAppearance: native,
    });
    assert.deepEqual(Array.from(result.colors), [7, 7, 12, 12], name);
    assert.deepEqual(Array.from(result.perFaceSourceKind), [2, 2, 7, 7], name);
    assert.equal(result.topologyParentFaces![2], -1, name);
    assert.equal(result.topologyParentFaces![3], -1, name);
    assert.equal(result.design.defaultFaces, 2, name);
    assert.deepEqual(result.design.regions[result.regionIds[2]].donorRegionIds, [], name);
    assertSourcePaths(p, result, observed, pixels);
    assert.deepEqual(surfaceMaterials(p, observed, pixels, 12, { unobservedPolicy: 'legacy', nativeAppearance: native }), legacy, `${name}: legacy bytes/metadata unchanged`);
    assert.deepEqual(native, snapshot, `${name}: native provenance unchanged`);
  }
  assert.deepEqual(p, original.p);
  assert.deepEqual(observed, original.observed);
  assert.deepEqual(pixels, original.pixels);
});

void test('restricting crease clues retains exact coplanar paths and distinct native-slot negative boundaries', () => {
  const p = Float32Array.from([...quad(0, 0, 0), ...quad(1, 0, 0)]);
  const observed = Int16Array.from([7, 7, -1, -1]);
  const pixels = Array(30).fill({ face: 0, color: 7 });
  for (const [name, native] of Object.entries(unsupportedCreaseAppearances())) {
    const result = surfaceMaterials(p, observed, pixels, 12, {
      unobservedPolicy: 'source-topology-only', nativeAppearance: native,
    });
    assert.deepEqual(Array.from(result.colors), [7, 7, 7, 7], `${name}: coplanar inference needs no crease clue`);
    assertSourcePaths(p, result, observed, pixels);
  }
  for (const kind of [NATIVE_APPEARANCE_SOURCE.materialFactor, NATIVE_APPEARANCE_SOURCE.materialFactor | NATIVE_APPEARANCE_SOURCE.textureSample]) {
    const distinct = nativeFaces([4, 4, 5, 5]);
    const native = snapshotNativeAppearance({ ...distinct, faceSourceKinds: new Uint8Array(4).fill(kind) });
    const result = surfaceMaterials(p, observed, pixels, 12, {
      unobservedPolicy: 'source-topology-only', nativeAppearance: native,
    });
    assert.deepEqual(Array.from(result.colors), [7, 7, 12, 12]);
    assert.equal(result.topologyParentFaces![2], -1);
    assert.notEqual(result.sourceDomainIds![0], result.sourceDomainIds![2]);
  }
});

void test('an observed connected rim can infer around a real source hole without filling or jumping across it', () => {
  const points: number[] = [];
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 3; x++)
      if (x !== 1 || y !== 1) points.push(...quad(x, y, 0));
  const p = Float32Array.from(points),
    before = p.slice();
  const observed = new Int16Array(16).fill(-1);
  observed[0] = observed[1] = 7;
  const pixels = Array(30).fill({ face: 0, color: 7 });
  const result = surfaceMaterials(p, observed, pixels, 4, {
    unobservedPolicy: 'source-topology-only',
  });
  assert.equal(
    result.colors.length,
    16,
    'no face is invented in the central missing quad',
  );
  assert.ok(result.colors.every((color) => color === 7));
  assert.equal(result.design.defaultFaces, 0);
  assertSourcePaths(p, result, observed, pixels);
  assert.deepEqual(p, before, 'the real hole and rim positions remain exact');
});

void test('real tiny gaps and non-manifold edges cannot be healed by native material identity', () => {
  const gap = Float32Array.from([...quad(0, 0, 0), ...quad(1.000001, 0, 0)]);
  const observed = Int16Array.from([7, 7, -1, -1]),
    pixels = Array(30).fill({ face: 0, color: 7 });
  const result = surfaceMaterials(gap, observed, pixels, 4, {
    unobservedPolicy: 'source-topology-only',
    nativeAppearance: nativeFaces([0, 0, 0, 0]),
  });
  assert.deepEqual(Array.from(result.colors), [7, 7, 4, 4]);
  const p = Float32Array.from([...crease(), 1, 0, 0, 1, 1, 0, 2, 0, 0]);
  const nonmanifold = surfaceMaterials(
    p,
    Int16Array.from([7, 7, -1, -1, -1]),
    pixels,
    4,
    {
      unobservedPolicy: 'source-topology-only',
      nativeAppearance: nativeFaces([0, 0, 0, 0, 0]),
    },
  );
  assert.deepEqual(Array.from(nonmanifold.colors), [7, 7, 4, 4, 4]);
});

void test('unknown detours with conflicting observed paint, no observations or centroid-only evidence stay explicit defaults', () => {
  const p = Float32Array.from([
    ...quad(0, 0, 0),
    ...quad(1, 0, 0),
    ...quad(2, 0, 0),
  ]);
  const mixed = Int16Array.from([2, 2, -1, -1, 4, 4]);
  const pixels = [...Array(20)].flatMap(() => [
    { face: 0, color: 2 },
    { face: 5, color: 4 },
  ]);
  const result = surfaceMaterials(p, mixed, pixels, 11, {
    unobservedPolicy: 'source-topology-only',
  });
  assert.deepEqual(Array.from(result.colors), [2, 2, 11, 11, 4, 4]);
  assert.equal(result.topologyParentFaces![2], -1);
  const absent = surfaceMaterials(p, new Int16Array(6).fill(-1), [], 7, {
    unobservedPolicy: 'source-topology-only',
  });
  assert.ok(absent.colors.every((c) => c === 7));
  assert.equal(absent.design.defaultFaces, 6);
  assert.ok(absent.topologyParentFaces!.every((f) => f === -1));
  const centroids = surfaceMaterials(
    p,
    Int16Array.from([7, 7, -1, -1, -1, -1]),
    [],
    4,
    { unobservedPolicy: 'source-topology-only' },
  );
  assert.deepEqual(Array.from(centroids.colors), [7, 7, 4, 4, 4, 4]);
  assert.equal(centroids.design.defaultFaces, 4);
  assert.throws(
    () =>
      surfaceMaterials(p, mixed, pixels, 7, {
        unobservedPolicy: 'invented' as never,
      }),
    /policy is invalid/,
  );
  assert.throws(
    () =>
      surfaceMaterials(p, mixed, pixels, 7, {
        nativeAppearance: nativeFaces([0]),
      }),
    /does not match source faces/,
  );
});
