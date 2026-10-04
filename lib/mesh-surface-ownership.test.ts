import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { buildMeshVolume, type BuildMeshVolumeOptions } from './mesh-design.ts';
import type { TriangleMesh } from './mesh-types.ts';
import {
  classifySurfaceOwnership,
  MESH_SURFACE_OWNERSHIP_LIMITS,
  prepareMeshSurfaceOwnership,
  type MeshSurfaceOwnership,
} from './mesh-surface-ownership.ts';
import { designMeshSurfaces } from './surface-design.ts';
import { triangleCellArea } from './voxel-materials.ts';

function box(
  width = 20,
  height = 4,
  depth = 20,
  min = [0, 0, 0],
): TriangleMesh {
  const geometry = new BoxGeometry(width, height, depth).toNonIndexed();
  geometry.translate(
    min[0] + width / 2,
    min[1] + height / 2,
    min[2] + depth / 2,
  );
  const mesh = {
    name: 'ownership box',
    positions: Float32Array.from(geometry.attributes.position.array),
    colors: new Uint8Array(geometry.attributes.position.count),
  };
  for (let i = 0; i < mesh.colors.length; i += 3)
    mesh.colors.set([215, 186, 140], i);
  geometry.dispose();
  return mesh;
}

function gridTriangle(ownership: MeshSurfaceOwnership, faceId: number) {
  const { min, scale, plateHeight } = ownership.normalization;
  return [0, 1, 2].map(
    (vertex) =>
      [0, 1, 2].map(
        (axis) =>
          ((ownership.mesh.positions[faceId * 9 + vertex * 3 + axis] -
            min[axis]) *
            scale) /
          (axis === 1 ? plateHeight : 1),
      ) as [number, number, number],
  );
}

void test('two regional face groups sharing a cell keep every exact contributor and both are locked', () => {
  const volume = buildMeshVolume(box(), 20, {
    surfaceOwnership: {
      regions: [
        { regionId: 'front-a', sourceFaceIds: [8] },
        { regionId: 'front-b', sourceFaceIds: [9] },
        { regionId: 'whole-front', sourceFaceIds: [8, 9] },
      ],
    },
  });
  const ownership = volume.surfaceOwnership!;
  const mixed = [...ownership.cells].find(
    ([, cell]) =>
      cell.contributors.length === 2 &&
      cell.contributors.some((entry) => entry.sourceFaceId === 8) &&
      cell.contributors.some((entry) => entry.sourceFaceId === 9) &&
      !cell.selectedShellOnlyFaceIds.length,
  );
  assert.ok(
    mixed,
    'the two front triangles have positive area in the same grid cell',
  );
  const [key, cell] = mixed;
  const coordinates = key
    .split(',')
    .map(
      (value, axis) => Number(value) - ownership.normalization.gridOffset[axis],
    ) as [number, number, number];
  for (const contributor of cell.contributors) {
    assert.ok(contributor.areaStudsSquared > 0);
    assert.equal(
      contributor.areaStudsSquared,
      triangleCellArea(
        gridTriangle(ownership, contributor.sourceFaceId),
        coordinates,
      ),
    );
  }
  assert.equal(classifySurfaceOwnership(ownership, key, 'front-a'), 'locked');
  assert.equal(classifySurfaceOwnership(ownership, key, 'front-b'), 'locked');
  assert.equal(
    classifySurfaceOwnership(ownership, key, 'whole-front'),
    'editable',
  );
  assert.equal(
    classifySurfaceOwnership(ownership, key, 'not-captured'),
    'unavailable',
  );
});

void test('a selected later face retains earlier unselected area owners without collecting the whole mesh', () => {
  const volume = buildMeshVolume(box(), 20, {
    surfaceOwnership: {
      regions: [{ regionId: 'later-front', sourceFaceIds: [9] }],
    },
  });
  const ownership = volume.surfaceOwnership!;
  const mixed = [...ownership.cells].find(
    ([, cell]) =>
      cell.contributors.some((entry) => entry.sourceFaceId === 8) &&
      cell.contributors.some((entry) => entry.sourceFaceId === 9),
  );
  assert.ok(mixed);
  assert.equal(
    classifySurfaceOwnership(ownership, mixed[0], 'later-front'),
    'locked',
  );
  assert.ok(
    ownership.cells.size < volume.cells.size / 4,
    'records are limited to the selected footprint',
  );
  assert.ok(
    [...ownership.cells.values()].every((cell) =>
      cell.selectedFaceIds.includes(9),
    ),
  );
  assert.ok(
    volume.cells.has('10,6,10'),
    'the control is an occupied interior voxel',
  );
  assert.equal(ownership.cells.has('10,6,10'), false);
  assert.equal(
    classifySurfaceOwnership(ownership, '10,6,10', 'later-front'),
    'unavailable',
  );
});

void test('point-only and degenerate edge shell contacts are distinct locked records even beside positive outside area', () => {
  const mesh = box();
  const positions = [
    ...mesh.positions,
    0,
    4,
    0,
    10,
    4,
    0,
    0,
    4,
    10,
    4,
    4,
    4,
    6,
    4,
    4,
    8,
    4,
    4,
  ];
  mesh.positions = Float32Array.from(positions);
  mesh.colors = Uint8Array.from([...mesh.colors, 215, 186, 140, 215, 186, 140]);
  const ownership = buildMeshVolume(mesh, 20, {
    surfaceOwnership: {
      regions: [
        { regionId: 'point-contact', sourceFaceIds: [12] },
        { regionId: 'edge-contact', sourceFaceIds: [13] },
      ],
    },
  }).surfaceOwnership!;
  const point = ownership.cells.get('6,11,6')!;
  assert.ok(point.selectedShellOnlyFaceIds.includes(12));
  assert.equal(triangleCellArea(gridTriangle(ownership, 12), [5, 9, 5]), 0);
  assert.ok(
    point.contributors.every((contributor) => contributor.sourceFaceId !== 12),
  );
  assert.ok(
    point.contributors.length > 0,
    'other top faces contribute positive area',
  );
  assert.equal(
    classifySurfaceOwnership(ownership, '6,11,6', 'point-contact'),
    'locked',
  );
  const edge = [...ownership.cells].find(([, cell]) =>
    cell.selectedShellOnlyFaceIds.includes(13),
  );
  assert.ok(edge);
  assert.ok(
    edge[1].contributors.every(
      (contributor) => contributor.sourceFaceId !== 13,
    ),
  );
  assert.equal(
    classifySurfaceOwnership(ownership, edge[0], 'edge-contact'),
    'locked',
  );
});

void test('normalization retains original world minimum and physical Y scale in plate units', () => {
  const ownership = buildMeshVolume(box(8, 4, 8, [100, -7, 25]), 20, {
    surfaceOwnership: {
      regions: [{ regionId: 'vertical-front', sourceFaceIds: [8] }],
    },
  }).surfaceOwnership!;
  assert.deepEqual(ownership.normalization, {
    min: [100, -7, 25],
    scale: 2.5,
    gridOffset: [1, 2, 1],
    plateHeight: 0.4,
    gridSize: [20, 25, 20],
  });
  assert.equal(
    Math.max(
      ...[...ownership.cells.keys()].map((key) => Number(key.split(',')[1])),
    ),
    26,
  );
  const area = [...ownership.cells.values()]
    .flatMap((cell) => cell.contributors)
    .filter((contributor) => contributor.sourceFaceId === 8)
    .reduce((sum, contributor) => sum + contributor.areaStudsSquared, 0);
  assert.ok(
    Math.abs(area - 100) < 1e-10,
    '16 world area units become 100 stud area units, not plate area',
  );
});

void test('capture snapshots the designed mesh with unchanged whole-volume output and detached inputs', () => {
  const geometry = new BoxGeometry(20, 12, 4, 10, 6, 2)
    .toNonIndexed()
    .translate(10, 6, 2);
  const mesh: TriangleMesh = {
    name: 'noisy wall ownership',
    positions: Float32Array.from(geometry.attributes.position.array),
    colors: new Uint8Array(geometry.attributes.position.count),
    features: new Uint8Array(geometry.attributes.position.count / 3),
  };
  geometry.dispose();
  for (let i = 0; i < mesh.positions.length; i += 3)
    if (mesh.positions[i + 2] === 4)
      mesh.positions[i + 2] +=
        0.08 *
        Math.sin((mesh.positions[i] / 20) * Math.PI * 2) *
        Math.sin((mesh.positions[i + 1] / 12) * Math.PI * 2);
  const designed = designMeshSurfaces(mesh, 20);
  assert.ok(
    designed.design.adjustedVertices > 0,
    'the capture uses a mesh whose surface design actually moved vertices',
  );
  const faceId = Array.from(
    { length: mesh.positions.length / 9 },
    (_, id) => id,
  ).find((id) =>
    [2, 5, 8].every((axis) => mesh.positions[id * 9 + axis] > 3.9),
  )!;
  const sourceFaceIds = [faceId];
  const defaultVolume = buildMeshVolume(mesh, 20);
  const traced = buildMeshVolume(mesh, 20, {
    surfaceOwnership: { regions: [{ regionId: 'wall', sourceFaceIds }] },
  });
  const { surfaceOwnership: ownership, ...unchanged } = traced;
  assert.ok(ownership);
  assert.deepEqual(
    unchanged,
    defaultVolume,
    'strip only the additive ledger to recover the exact default volume',
  );
  assert.equal(Object.hasOwn(defaultVolume, 'surfaceOwnership'), false);
  assert.deepEqual(buildMeshVolume(mesh, 20, {}), defaultVolume);
  assert.deepEqual(ownership.mesh.positions, designed.mesh.positions);
  assert.notDeepEqual(ownership.mesh.positions, mesh.positions);
  assert.notEqual(ownership.mesh.positions, designed.mesh.positions);
  assert.notEqual(ownership.mesh.colors, mesh.colors);
  assert.notEqual(ownership.mesh.features, mesh.features);
  assert.equal(ownership.mesh.sourceObservations, undefined);
  assert.deepEqual(ownership.sourceMesh.positions, mesh.positions);
  assert.deepEqual(ownership.sourceMesh.colors, mesh.colors);
  assert.deepEqual(ownership.sourceMesh.features, mesh.features);
  assert.notEqual(ownership.sourceMesh.positions, mesh.positions);
  assert.notEqual(ownership.sourceMesh.colors, mesh.colors);
  assert.notEqual(ownership.sourceMesh.features, mesh.features);
  assert.equal(ownership.sourceMesh.sourceObservations, undefined);
  const positions = ownership.mesh.positions.slice(),
    colors = ownership.mesh.colors.slice(),
    sourcePositions = ownership.sourceMesh.positions.slice(),
    sourceColors = ownership.sourceMesh.colors.slice(),
    sourceFeatures = ownership.sourceMesh.features!.slice();
  mesh.positions.fill(999);
  mesh.colors.fill(42);
  mesh.features!.fill(7);
  sourceFaceIds[0] = 0;
  assert.deepEqual(ownership.mesh.positions, positions);
  assert.deepEqual(ownership.mesh.colors, colors);
  assert.deepEqual(ownership.sourceMesh.positions, sourcePositions);
  assert.deepEqual(ownership.sourceMesh.colors, sourceColors);
  assert.deepEqual(ownership.sourceMesh.features, sourceFeatures);
  assert.deepEqual(ownership.regions[0].sourceFaceIds, [faceId]);
});

void test('malformed options, region selections and source face IDs fail explicitly', () => {
  const mesh = box();
  const invalid: unknown[] = [
    null,
    false,
    [],
    { regions: [] },
    { surfaceOwnership: null },
    { surfaceOwnership: {} },
    { surfaceOwnership: { regions: [] } },
    { surfaceOwnership: { regions: [{ regionId: '', sourceFaceIds: [0] }] } },
    { surfaceOwnership: { regions: [{ regionId: 'a', sourceFaceIds: [] }] } },
    ...[-1, 12, 0.5, NaN].map((id) => ({
      surfaceOwnership: { regions: [{ regionId: 'a', sourceFaceIds: [id] }] },
    })),
    {
      surfaceOwnership: { regions: [{ regionId: 'a', sourceFaceIds: [0, 0] }] },
    },
    {
      surfaceOwnership: {
        regions: [
          { regionId: 'a', sourceFaceIds: [0] },
          { regionId: 'a', sourceFaceIds: [1] },
        ],
      },
    },
    {
      surfaceOwnership: {
        regions: [{ regionId: 'a', sourceFaceIds: [0], confidence: 1 }],
      },
    },
  ];
  for (const options of invalid)
    assert.throws(
      () => buildMeshVolume(mesh, 20, options as BuildMeshVolumeOptions),
      /ownership|options/i,
    );
  const faces = MESH_SURFACE_OWNERSHIP_LIMITS.selectedFaces + 1;
  const limitMesh = {
    name: 'limit control',
    positions: new Float32Array(faces * 9),
    colors: new Uint8Array(faces * 3),
  };
  assert.throws(
    () =>
      prepareMeshSurfaceOwnership(
        limitMesh,
        {
          min: [0, 0, 0],
          scale: 1,
          gridOffset: [1, 2, 1],
          plateHeight: 0.4,
          gridSize: [20, 50, 20],
        },
        {
          regions: [
            {
              regionId: 'too-wide',
              sourceFaceIds: Array.from({ length: faces }, (_, id) => id),
            },
          ],
        },
        limitMesh,
      ),
    /regional face limit/,
  );
});
