import type { TriangleMesh } from './mesh-types.ts';
import { triangleMaterialAreas } from './voxel-materials.ts';

type Point = [number, number, number];

export type MeshSurfaceOwnershipRegion = {
  regionId: string;
  sourceFaceIds: readonly number[];
};
export type MeshSurfaceOwnershipSelection = {
  regions: readonly MeshSurfaceOwnershipRegion[];
};
export type MeshSurfaceOwnershipNormalization = {
  /** Original input minimum and scale, before surface design moves vertices. */
  min: Point;
  scale: number;
  gridOffset: [1, 2, 1];
  plateHeight: 0.4;
  gridSize: Point;
};
export type MeshSurfaceOwnershipCell = {
  contributors: { sourceFaceId: number; areaStudsSquared: number }[];
  /** Selected faces with positive clipped area or a sampled shell contact. */
  selectedFaceIds: number[];
  /** Selected shell contacts without a positive-area callback for that face. */
  selectedShellOnlyFaceIds: number[];
};
/** A regional area ledger over the actual designed volume mesh. These detached
 * arrays describe geometry and color input to casting, not observed material,
 * true depth, semantic identity, or permission to change an occupied cell. */
export type MeshSurfaceOwnership = {
  version: 1;
  method: 'selected-source-face-area';
  /** Detached raw casting input for face identity binding, before design. */
  sourceMesh: TriangleMesh;
  mesh: TriangleMesh;
  normalization: MeshSurfaceOwnershipNormalization;
  regions: MeshSurfaceOwnershipRegion[];
  cells: Map<string, MeshSurfaceOwnershipCell>;
  contributorCount: number;
};

export const MESH_SURFACE_OWNERSHIP_LIMITS = Object.freeze({
  regions: 64,
  selectedFaces: 4096,
  footprintCells: 65536,
  contributors: 500000,
});

function snapshotMesh(mesh: TriangleMesh): TriangleMesh {
  return {
    name: mesh.name,
    positions: mesh.positions.slice(),
    colors: mesh.colors.slice(),
    ...(mesh.features ? { features: mesh.features.slice() } : {}),
  };
}

function validatedRegions(
  selection: MeshSurfaceOwnershipSelection,
  faceCount: number,
): MeshSurfaceOwnershipRegion[] {
  if (
    !selection ||
    typeof selection !== 'object' ||
    Object.keys(selection).some((key) => key !== 'regions') ||
    !Array.isArray(selection.regions) ||
    !selection.regions.length ||
    selection.regions.length > MESH_SURFACE_OWNERSHIP_LIMITS.regions
  )
    throw Error(
      'Surface ownership requires a bounded nonempty region selection.',
    );
  const regionIds = new Set<string>(),
    selectedFaces = new Set<number>();
  return selection.regions.map((region) => {
    if (
      !region ||
      typeof region !== 'object' ||
      Object.keys(region).some(
        (key) => !['regionId', 'sourceFaceIds'].includes(key),
      ) ||
      typeof region.regionId !== 'string' ||
      !region.regionId.trim() ||
      region.regionId !== region.regionId.trim() ||
      regionIds.has(region.regionId) ||
      !Array.isArray(region.sourceFaceIds) ||
      !region.sourceFaceIds.length
    )
      throw Error(
        'Surface ownership region IDs and source face selections are invalid.',
      );
    regionIds.add(region.regionId);
    const ids = new Set<number>();
    for (const id of region.sourceFaceIds) {
      if (!Number.isInteger(id) || id < 0 || id >= faceCount || ids.has(id))
        throw Error(
          'Surface ownership source face IDs must be unique valid triangle indices.',
        );
      ids.add(id);
      selectedFaces.add(id);
      if (selectedFaces.size > MESH_SURFACE_OWNERSHIP_LIMITS.selectedFaces)
        throw Error(
          'Surface ownership selection exceeds the regional face limit.',
        );
    }
    return { regionId: region.regionId, sourceFaceIds: [...ids] };
  });
}

/** Precompute only the selected exact-area and existing shell-sampling footprint.
 * All source faces are visited later by the unchanged area-voting callback. */
export function prepareMeshSurfaceOwnership(
  mesh: TriangleMesh,
  normalization: MeshSurfaceOwnershipNormalization,
  selection: MeshSurfaceOwnershipSelection,
  sourceMesh: TriangleMesh,
): MeshSurfaceOwnership {
  if (sourceMesh.positions.length !== mesh.positions.length)
    throw Error('Surface ownership requires preserved source face indices.');
  const regions = validatedRegions(selection, mesh.positions.length / 9);
  const {
    min,
    scale,
    plateHeight,
    gridSize: size,
    gridOffset: offset,
  } = normalization;
  const ownership: MeshSurfaceOwnership = {
    version: 1,
    method: 'selected-source-face-area',
    sourceMesh: snapshotMesh(sourceMesh),
    mesh: snapshotMesh(mesh),
    normalization: {
      ...normalization,
      min: [...min],
      gridSize: [...size],
      gridOffset: [...offset],
    },
    regions,
    cells: new Map(),
    contributorCount: 0,
  };
  const cellKey = (x: number, y: number, z: number) =>
    `${x + offset[0]},${y + offset[1]},${z + offset[2]}`;
  const getCell = (key: string) => {
    let cell = ownership.cells.get(key);
    if (!cell) {
      if (ownership.cells.size >= MESH_SURFACE_OWNERSHIP_LIMITS.footprintCells)
        throw Error(
          'Surface ownership footprint exceeds the regional cell limit.',
        );
      cell = {
        contributors: [],
        selectedFaceIds: [],
        selectedShellOnlyFaceIds: [],
      };
      ownership.cells.set(key, cell);
    }
    return cell;
  };
  const faceIds = new Set(
    regions.flatMap((region) => [...region.sourceFaceIds]),
  );
  let areaTests = 0,
    shellSamples = 0;
  for (const faceId of faceIds) {
    const v = [0, 1, 2].map(
      (j) =>
        [0, 1, 2].map(
          (a) =>
            ((mesh.positions[faceId * 9 + j * 3 + a] - min[a]) * scale) /
            (a === 1 ? plateHeight : 1),
        ) as Point,
    );
    const positive = new Set<string>();
    areaTests += triangleMaterialAreas(v, size, (x, y, z) => {
      const key = cellKey(x, y, z);
      positive.add(key);
      getCell(key).selectedFaceIds.push(faceId);
    });
    if (areaTests > 8000000)
      throw Error(
        'Surface ownership selection exceeds the area traversal limit.',
      );
    const edge = Math.max(
      ...[
        [0, 1],
        [0, 2],
        [1, 2],
      ].map(([a, b]) => Math.hypot(...v[a].map((x, i) => x - v[b][i]))),
    );
    const steps = Math.max(1, Math.ceil(edge * 1.5));
    shellSamples += ((steps + 1) * (steps + 2)) / 2;
    if (shellSamples > 8000000)
      throw Error(
        'Surface ownership selection exceeds the shell sampling limit.',
      );
    const shell = new Set<string>();
    for (let a = 0; a <= steps; a++)
      for (let b = 0; b <= steps - a; b++) {
        const c = v[0].map(
          (x, i) =>
            (x * a) / steps +
            (v[1][i] * b) / steps +
            v[2][i] * (1 - (a + b) / steps),
        );
        shell.add(
          cellKey(
            ...(c.map((value, axis) =>
              Math.min(size[axis] - 1, Math.max(0, Math.floor(value))),
            ) as Point),
          ),
        );
      }
    for (const key of shell) {
      if (positive.has(key)) continue;
      const cell = getCell(key);
      cell.selectedFaceIds.push(faceId);
      cell.selectedShellOnlyFaceIds.push(faceId);
    }
  }
  return ownership;
}

/** Called by the existing exact-area vote for every face, storing only sparse
 * selected-footprint keys. Outside faces must remain visible as mixed owners. */
export function recordSurfaceOwnershipContribution(
  ownership: MeshSurfaceOwnership,
  cellKey: string,
  sourceFaceId: number,
  areaStudsSquared: number,
) {
  const cell = ownership.cells.get(cellKey);
  if (!cell) return;
  if (ownership.contributorCount >= MESH_SURFACE_OWNERSHIP_LIMITS.contributors)
    throw Error(
      'Surface ownership contributors exceed the regional ledger limit.',
    );
  cell.contributors.push({ sourceFaceId, areaStudsSquared });
  ownership.contributorCount++;
}

/** "editable" means sole selected-face area ownership only. Structural,
 * material, observation, target depth and edit permission checks are separate.
 * Missing records, including source-less interior voxels, remain unavailable. */
export function classifySurfaceOwnership(
  ownership: MeshSurfaceOwnership,
  cellKey: string,
  regionId: string,
): 'editable' | 'locked' | 'unavailable' {
  const region = ownership.regions.find(
    (region) => region.regionId === regionId,
  );
  const cell = ownership.cells.get(cellKey);
  if (!region || !cell) return 'unavailable';
  const owns = (id: number) => region.sourceFaceIds.includes(id);
  if (!cell.selectedFaceIds.some(owns)) return 'unavailable';
  if (cell.selectedShellOnlyFaceIds.some(owns)) return 'locked';
  if (!cell.contributors.some(({ sourceFaceId }) => owns(sourceFaceId)))
    return 'unavailable';
  return cell.contributors.every(({ sourceFaceId }) => owns(sourceFaceId))
    ? 'editable'
    : 'locked';
}
