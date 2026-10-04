import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { BoxGeometry } from 'three';
import type { TriangleMesh } from '../../lib/mesh-types.ts';
import type { Brick } from '../../lib/brick-engine.ts';
import { buildMeshVolume } from '../../lib/mesh-design.ts';
import {
  prepareMeshSurfaceOwnership,
  recordSurfaceOwnershipContribution,
} from '../../lib/mesh-surface-ownership.ts';
import { triangleMaterialAreas } from '../../lib/voxel-materials.ts';
import { proposeRegionalTarget } from './source-target.ts';
import { colorFromReference } from '../../lib/reference-colors.ts';

function box(w = 20, h = 4, d = 20): TriangleMesh {
  const g = new BoxGeometry(w, h, d).toNonIndexed();
  g.translate(w / 2, h / 2, d / 2);
  const positions = Float32Array.from(g.attributes.position.array),
    colors = new Uint8Array(positions.length / 3).fill(140);
  g.dispose();
  return { name: 'independent box', positions, colors };
}
const frontIds = (m: TriangleMesh, z: number) =>
  Array.from({ length: m.positions.length / 9 }, (_, f) => f).filter((f) =>
    [2, 5, 8].every((j) => m.positions[f * 9 + j] === z),
  );

function captureRaw(mesh: TriangleMesh, faces: number[], designedMesh = mesh) {
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  mesh.positions.forEach((v, i) => {
    lo[i % 3] = Math.min(lo[i % 3], v);
    hi[i % 3] = Math.max(hi[i % 3], v);
  });
  const normalization = {
    min: lo as [number, number, number],
    scale: 1,
    gridOffset: [1, 2, 1] as [1, 2, 1],
    plateHeight: 0.4 as const,
    gridSize: hi.map((v, a) =>
      Math.max(1, Math.ceil((v - lo[a]) / (a === 1 ? 0.4 : 1))),
    ) as [number, number, number],
  };
  const ledger = prepareMeshSurfaceOwnership(
    designedMesh,
    normalization,
    { regions: [{ regionId: 'test', sourceFaceIds: faces }] },
    mesh,
  );
  for (let f = 0; f < mesh.positions.length / 9; f++) {
    const triangle = [0, 1, 2].map(
      (j) =>
        [0, 1, 2].map(
          (a) =>
            (designedMesh.positions[f * 9 + j * 3 + a] - lo[a]) /
            (a === 1 ? 0.4 : 1),
        ) as [number, number, number],
    );
    triangleMaterialAreas(triangle, normalization.gridSize, (x, y, z, area) =>
      recordSurfaceOwnershipContribution(
        ledger,
        `${x + 1},${y + 2},${z + 1}`,
        f,
        area,
      ),
    );
  }
  return ledger;
}

function withFrontTriangles(positions: number[]): TriangleMesh {
  const source = box();
  return {
    ...source,
    positions: Float32Array.from([...source.positions, ...positions]),
    colors: new Uint8Array(
      (source.positions.length + positions.length) / 3,
    ).fill(140),
  };
}

void test('an owned subcell face missed by the center ray cannot borrow an unrelated solid interval', () => {
  const mesh = withFrontTriangles([
    4.1, 1.64, 10, 4.2, 1.64, 10, 4.1, 1.68, 10,
  ]);
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, [12]),
    regionId: 'test',
    depthAxis: 2,
  });
  assert.ok(target.editableShell.includes('5,6,11'));
  assert.equal(target.status, 'unresolved');
  assert.ok(
    target.warnings.includes(
      'editable-source-column-without-selected-crossing',
    ),
  );
  assert.equal(target.depth.status, 'collected');
  if (target.depth.status === 'collected') {
    assert.ok(
      target.depth.columns.every((column) => column.intervals.length === 1),
    );
    assert.ok(
      target.depth.columns.every((column) =>
        column.crossings.every((crossing) => !crossing.selectedFaceIds.length),
      ),
    );
  }
  assert.equal(target.permissions.commit, false);
});

void test('a selected crossing at another layer cannot validate an owned cell from a different face', () => {
  const mesh = withFrontTriangles([
    4.1, 1.64, 10, 4.2, 1.64, 10, 4.1, 1.68, 10,
  ]);
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, [8, 9, 12]),
    regionId: 'test',
    depthAxis: 2,
  });
  assert.equal(target.status, 'unresolved');
  assert.ok(
    target.warnings.includes(
      'editable-source-cell-without-corresponding-depth-crossing',
    ),
  );
  assert.equal(target.depth.status, 'collected');
  if (target.depth.status === 'collected') {
    const column = target.depth.columns.find(
      (column) => column.column.join(',') === '5,6',
    )!;
    assert.ok(
      column.crossings.some((crossing) => crossing.selectedFaceIds.length),
    );
    assert.ok(
      column.crossings.every(
        (crossing) => !crossing.selectedFaceIds.includes(12),
      ),
    );
  }
});

void test('even the same selected face must cross the closed depth interval of its designed owned cell', () => {
  const mesh = box(),
    ids = frontIds(mesh, 20);
  const designed = { ...mesh, positions: mesh.positions.slice() };
  for (const id of ids)
    for (const offset of [2, 5, 8]) designed.positions[id * 9 + offset] -= 2;
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, ids, designed),
    regionId: 'test',
    depthAxis: 2,
  });
  assert.equal(target.status, 'unresolved');
  assert.ok(
    target.warnings.includes(
      'editable-source-cell-without-corresponding-depth-crossing',
    ),
  );
  assert.deepEqual(target.depthCorrespondence, {
    method: 'owned-face-center-ray-in-closed-cell',
    toleranceGridUnits: 1e-8,
    surfaceDesignDisplacementAllowanceGridUnits: 0,
  });
});

for (const [name, triangles] of [
  [
    'crossing',
    [4, 1.2, 20, 14, 1.2, 20, 9, 3.6, 20, 14, 3.2, 20, 4, 3.2, 20, 9, 0.8, 20],
  ],
  ['contained', [4.1, 1.64, 20, 10.1, 1.64, 20, 4.1, 2.84, 20]],
] as const)
  void test(`${name} independent coplanar source regions cannot provide trusted overlapping outer loops`, () => {
    const mesh = withFrontTriangles([...triangles]);
    const faces = [
      8,
      9,
      ...Array.from({ length: triangles.length / 9 }, (_, id) => 12 + id),
    ];
    const target = proposeRegionalTarget({
      sourceMesh: mesh,
      ownership: captureRaw(mesh, faces),
      regionId: 'test',
      depthAxis: 2,
    });
    assert.equal(target.status, 'unresolved');
    assert.ok(
      target.warnings.includes('overlapping-coplanar-source-components'),
    );
    assert.ok(
      target.components.every((component) =>
        component.boundaries.every(
          (boundary) => boundary.kind === 'unclassified',
        ),
      ),
    );
    assert.equal(target.permissions.commit, false);
  });

void test('a topologically linked planar fan with a self-crossing boundary cannot certify an outer loop', () => {
  const a = [4, 1, 20],
    b = [16, 1, 20],
    c = [4, 3, 20],
    d = [3.9, 1.01, 20],
    e = [4.01, 0.9995, 20];
  const mesh = withFrontTriangles([
    ...a,
    ...b,
    ...c,
    ...a,
    ...c,
    ...d,
    ...a,
    ...d,
    ...e,
  ]);
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, [8, 9, 12, 13, 14]),
    regionId: 'test',
    depthAxis: 2,
  });
  assert.equal(target.status, 'unresolved');
  assert.ok(target.warnings.includes('self-intersecting-source-boundary'));
  const fan = target.components.find((component) =>
    component.sourceFaceIds.includes(12),
  )!;
  assert.equal(fan.kind, 'plane');
  assert.equal(fan.boundaries[0].kind, 'unclassified');
});

void test('compound source loops remain 3D unclassified topology without a whole-component planar projection claim', () => {
  const mesh = withFrontTriangles([
    4.1, 1.64, 20, 4.2, 1.68, 20, 4.1, 1.68, 20, 4.1, 1.64, 20, 4.1, 1.68, 20,
    4.2, 1.64, 20,
  ]);
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, [8, 9, 12, 13]),
    regionId: 'test',
    depthAxis: 2,
  });
  const compound = target.components.find((component) =>
    component.sourceFaceIds.includes(12),
  )!;
  assert.equal(compound.kind, 'compound');
  assert.ok(compound.boundaries.length > 0);
  assert.ok(
    compound.boundaries.every((boundary) => boundary.kind === 'unclassified'),
  );
  assert.equal(
    target.boundaryScope,
    'validated-plane-loops-and-unclassified-3d-compound-loops',
  );
});

void test('positive cell volume overlap protects fractional boxes and nominal component bounds, while mere contact does not', () => {
  const mesh = box();
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, frontIds(mesh, 20)),
    regionId: 'test',
    baselineParts: [
      {
        id: 1,
        part: '3005',
        x: 10.75,
        y: 6,
        z: 20,
        w: 0.2,
        d: 1,
        h: 1,
        color: 7,
        section: 'component-review',
      },
    ],
    exclusions: [
      {
        min: [11.75, 6, 20],
        max: [11.95, 7, 21],
        reason: 'fractional-protection',
      },
    ],
  });
  assert.ok(
    target.lockedShell
      .find((cell) => cell.key === '10,6,20')
      ?.reasons.includes('locked-construction-or-component'),
  );
  assert.ok(
    target.lockedShell
      .find((cell) => cell.key === '11,6,20')
      ?.reasons.includes('fractional-protection'),
  );
  assert.ok(
    target.editableShell.includes('10,5,20'),
    'a cell merely touching the lower nominal component boundary has no positive overlap',
  );
  assert.ok(
    target.editableShell.includes('12,6,20'),
    'a neighboring cell outside the fractional protection remains available',
  );
  assert.equal(target.protectionScope, 'provided-upright-nominal-grid-bounds');
  assert.equal(target.permissions.commit, false);
});

void test('a genuine closed-source panel has one exact outer loop and complete ray intervals', () => {
  const mesh = box(),
    ids = frontIds(mesh, 20);
  const volume = buildMeshVolume(mesh, 20, {
    surfaceOwnership: { regions: [{ regionId: 'front', sourceFaceIds: ids }] },
  });
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: volume.surfaceOwnership!,
    regionId: 'front',
  });
  assert.equal(target.status, 'ready-for-layout');
  assert.equal(target.components.length, 1);
  assert.equal(target.components[0].kind, 'plane');
  assert.equal(target.components[0].boundaries.length, 1);
  assert.equal(target.components[0].boundaries[0].kind, 'outer');
  assert.equal(target.components[0].boundaries[0].vertices.length, 4);
  assert.ok(
    target.components[0].boundaries[0].interfaceSourceFaceIds.length > 0,
  );
  assert.ok(target.editableShell.length > 0);
  assert.equal(target.permissions.commit, false);
  assert.equal(target.depth.status, 'collected');
  if (target.depth.status === 'collected')
    assert.ok(
      target.depth.columns.every(
        (c) => c.intervals.length === 1 && c.crossings.length === 2,
      ),
    );
});

void test('exact ring topology retains its inner hole without convex or box filling', () => {
  const vertices = [
    [0, 0],
    [8, 0],
    [8, 8],
    [0, 8],
    [3, 3],
    [5, 3],
    [5, 5],
    [3, 5],
  ];
  const ps: number[] = [];
  for (const [a, b, c, d] of [
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ])
    for (const j of [a, b, c, a, c, d]) ps.push(...vertices[j], 2);
  const extra = box(1, 1, 1);
  extra.positions.forEach((v, i) => {
    if (i % 3 === 0) extra.positions[i] = v + 10;
  });
  const mesh: TriangleMesh = {
    name: 'open ring and independent volume',
    positions: Float32Array.from([...ps, ...extra.positions]),
    colors: new Uint8Array((ps.length + extra.positions.length) / 3).fill(140),
  };
  const ledger = captureRaw(mesh, [0, 1, 2, 3, 4, 5, 6, 7]);
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: ledger,
    regionId: 'test',
    depthAxis: 2,
  });
  assert.deepEqual(target.components[0].boundaries.map((b) => b.kind).sort(), [
    'hole',
    'outer',
  ]);
  const hole = target.components[0].boundaries.find((b) => b.kind === 'hole')!;
  assert.equal(hole.vertices.length, 4);
  assert.equal(
    target.status,
    'unresolved',
    'an open face ring cannot prove an enclosed solid',
  );
  assert.ok(target.warnings.includes('ambiguous-source-depth-crossings'));
  assert.equal(target.permissions.commit, false);
});

void test('non-manifold outside incidence cannot become safe by selecting only two faces', () => {
  const base = box(),
    ids = frontIds(base, 20);
  const p = base.positions.slice(ids[0] * 9, ids[0] * 9 + 9);
  const mesh = {
    ...base,
    positions: Float32Array.from([...base.positions, ...p]),
    colors: new Uint8Array((base.positions.length + p.length) / 3).fill(140),
  };
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: captureRaw(mesh, ids),
    regionId: 'test',
  });
  assert.equal(target.status, 'unresolved');
  assert.ok(target.warnings.includes('degenerate-or-non-manifold-source-edge'));
});

void test('opening beams without source overlap, supports and semantic pieces remain locked', () => {
  const mesh = box(),
    ids = frontIds(mesh, 20),
    ledger = captureRaw(mesh, ids);
  const make = (id: number, extra: Partial<Brick>): Brick => ({
    id,
    part: '3005',
    x: 8,
    y: 6,
    z: 20,
    w: 1,
    d: 1,
    h: 3,
    color: 7,
    ...extra,
  });
  const parts = [
    make(1, {
      x: 100,
      construction: {
        origin: 'cavity-lintel',
        openingId: 'niche',
        role: 'bridge',
      },
    }),
    make(2, { support: true }),
    make(3, { section: 'component-statue' }),
  ];
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: ledger,
    regionId: 'test',
    baselineParts: parts,
    preserveCells: new Set(['10,6,20']),
    exclusions: [
      { min: [11, 4, 19], max: [12, 8, 21], reason: 'declared-opening' },
    ],
  });
  assert.deepEqual(
    target.lockedParts.map((b) => b.id),
    [1, 2, 3],
  );
  assert.match(target.lockedParts[0].reason, /opening:niche:bridge/);
  assert.ok(
    target.lockedShell.some((c) =>
      c.reasons.includes('locked-construction-or-component'),
    ),
  );
  assert.ok(
    target.lockedShell.some(
      (c) =>
        c.key === '10,6,20' &&
        c.reasons.includes('preserved-source-or-mounting-cell'),
    ),
  );
  assert.ok(
    target.lockedShell.some((c) => c.reasons.includes('declared-opening')),
  );
});

void test('same-size source substitution is rejected; snapshots and original state remain unchanged', () => {
  const mesh = box(),
    ids = frontIds(mesh, 20),
    ledger = captureRaw(mesh, ids);
  const before = structuredClone({ mesh, ledger });
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: ledger,
    regionId: 'test',
  });
  assert.deepEqual({ mesh, ledger }, before);
  target.source.positions.fill(8);
  target.voxelSource.positions.fill(9);
  assert.deepEqual({ mesh, ledger }, before);
  const wrong = { ...mesh, positions: mesh.positions.slice() };
  wrong.positions[0] += 0.1;
  assert.throws(
    () =>
      proposeRegionalTarget({
        sourceMesh: wrong,
        ownership: ledger,
        regionId: 'test',
      }),
    /captured face stream/,
  );
  assert.throws(
    () =>
      proposeRegionalTarget({
        sourceMesh: mesh,
        ownership: ledger,
        regionId: 'missing',
      }),
    /Unknown/,
  );
});

void test('regional samples retain detached original RGB/pixel/face identity without certifying material or alignment', () => {
  const data = new Uint8Array(20 * 20 * 4).fill(255);
  for (let y = 2; y < 18; y++)
    for (let x = 2; x < 18; x++)
      data.set([40 + x, 60 + y, 80, 255], (y * 20 + x) * 4);
  const mesh = colorFromReference(
    box(),
    { width: 20, height: 20, data },
    { yaw: 0, pitch: 0, perspective: 0 },
  );
  const ids = frontIds(mesh, 20),
    ledger = captureRaw(mesh, ids),
    graph = mesh.sourceObservations!;
  const target = proposeRegionalTarget({
    sourceMesh: mesh,
    ownership: ledger,
    regionId: 'test',
  });
  assert.ok(target.observations!.gridSamples.some((s) => s.observed));
  const sample = target.observations!.gridSamples.find((s) => s.observed)!;
  assert.deepEqual(
    sample.rawRGB,
    Array.from(
      graph.projection.rawRGB.slice(sample.index * 3, sample.index * 3 + 3),
    ),
  );
  assert.deepEqual(
    sample.pixel,
    Array.from(
      graph.projection.sourcePixelXY.slice(
        sample.index * 2,
        sample.index * 2 + 2,
      ),
    ),
  );
  assert.equal(sample.faceId, graph.projection.pixelFaces[sample.index]);
  assert.equal(target.observations!.internalCorrespondenceVerified, false);
  assert.equal(target.permissions.materialIdentityVerified, false);
  sample.rawRGB.fill(0);
  assert.notDeepEqual(
    sample.rawRGB,
    Array.from(
      graph.projection.rawRGB.slice(sample.index * 3, sample.index * 3 + 3),
    ),
  );
});
