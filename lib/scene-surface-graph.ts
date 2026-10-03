import type { Raster } from './brick-engine.ts';
import type {
  ReferenceCamera,
  referenceAlignment,
} from './reference-colors.ts';

type AlignmentEvidence = ReturnType<typeof referenceAlignment>['evidence'];

export const SOURCE_OBSERVATION_LIMITS = Object.freeze({
  maximumFaces: 250000,
  maximumRasterPixels: 320 * 320,
  maximumProjectionPixels: 192 * 192,
  maximumArrayBytes: 40 * 1024 * 1024,
});

export const SOURCE_EDGE_KIND = Object.freeze({
  boundary: 1,
  manifold: 2,
  nonManifold: 3,
});

/** Detached source snapshots, independent of palette/material hypotheses.
 * Typed arrays are immutable by ownership, not runtime write protection;
 * structured clone preserves their data but does not preserve Object.freeze.
 * No functions, per-face objects or projected-vertex cache cross the worker. */
export type SceneSurfaceGraph = {
  readonly version: 1;
  readonly method: 'source-reference-observations';
  readonly sourceCoordinates: 'input-mesh';
  readonly sourcePositions: Float32Array;
  readonly faceNormals: Float32Array;
  readonly faceAreas: Float64Array;
  readonly camera: Readonly<ReferenceCamera>;
  readonly alignment: AlignmentEvidence;
  readonly raster: {
    readonly width: number;
    readonly height: number;
    readonly rgba: Uint8Array;
    readonly foregroundMask: Uint8Array;
    /** Original gradient-region labels, not surface or palette IDs. */
    readonly rawRegionIds: Int32Array;
    /** Right=1, down=2, left=4, up=8. Includes foreground/silhouette edges.
     * Region boundaries are radiance evidence, not proven paint boundaries. */
    readonly regionBoundaryBits: Uint8Array;
  };
  readonly projection: {
    readonly size: number;
    readonly transform: {
      readonly sourcePixelRounding: 'Math.round';
      /** Preserve the existing projection formula; this is not a new fit. */
      readonly gridDenominator: number;
      readonly rasterSampleOffset: readonly [0.5, 0.5];
      readonly imageBounds: readonly [number, number, number, number];
      readonly viewBounds: readonly [number, number, number, number];
      readonly meshCenter: readonly [number, number, number];
      readonly extent: number;
      readonly depthTolerance: number;
    };
    /** Nearest source face at each grid pixel center, including pixels without
     * a foreground observation. -1 means no source triangle. */
    readonly pixelFaces: Int32Array;
    /** Grid-indexed observations. Unobserved XY/region IDs remain -1 and RGB
     * remains zero; observed is the authoritative validity flag. */
    readonly sourcePixelXY: Int32Array;
    readonly rawRGB: Uint8Array;
    readonly rawRegionIds: Int32Array;
    readonly observed: Uint8Array;
    /** Exact-query microtriangle samples are a separate stream, not pixels
     * in the visibility grid. Projected XY/depth use Float64 precision. */
    readonly centroids: {
      readonly faces: Int32Array;
      readonly projectedXY: Float64Array;
      readonly sourcePixelXY: Int32Array;
      readonly rawRGB: Uint8Array;
      readonly rawRegionIds: Int32Array;
      readonly frontFaces: Int32Array;
      /** Source depth then nearest-front depth for each sample. */
      readonly depths: Float64Array;
    };
  };
  readonly sharedEdges: {
    /** Three local edges per face: (0,1), (1,2), (2,0). -1 is degenerate. */
    readonly faceEdgeIds: Int32Array;
    /** CSR incidence preserves every exact shared edge, including all faces
     * at a non-manifold edge. No proximity welding or inferred adjacency. */
    readonly offsets: Uint32Array;
    readonly faces: Uint32Array;
    readonly localEdges: Uint8Array;
    readonly kinds: Uint8Array;
  };
  readonly arrayBytes: number;
};

export type SourceObservationInput = {
  positions: Float32Array;
  image: Raster;
  mask: Uint8Array;
  rawRegionIds: Int32Array;
  camera: ReferenceCamera;
  alignment: AlignmentEvidence;
  projectionSize: number;
  pixelFaces: Int32Array;
  imageBounds: [number, number, number, number];
  viewBounds: [number, number, number, number];
  meshCenter: [number, number, number];
  extent: number;
  depthTolerance: number;
};

function sourceTopology(p: Float32Array) {
  const count = p.length / 9;
  const faceNormals = new Float32Array(count * 3);
  const faceAreas = new Float64Array(count);
  const vertexIds = new Int32Array(p.length / 3);
  const vertices = new Map<string, number>();
  for (let i = 0; i < p.length; i += 3) {
    const key = `${p[i]},${p[i + 1]},${p[i + 2]}`;
    let id = vertices.get(key);
    if (id === undefined) {
      id = vertices.size;
      vertices.set(key, id);
    }
    vertexIds[i / 3] = id;
  }
  const faceEdgeIds = new Int32Array(count * 3).fill(-1);
  const edges = new Map<number, number>();
  const incidenceCounts: number[] = [];
  // At the face limit, vertex IDs are below 750,000: this integer key stays
  // exactly representable and avoids storing three coordinate strings per edge.
  const base = vertexIds.length;
  for (let t = 0; t < count; t++) {
    const i = t * 9;
    const ax = p[i + 3] - p[i],
      ay = p[i + 4] - p[i + 1],
      az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i],
      by = p[i + 7] - p[i + 1],
      bz = p[i + 8] - p[i + 2];
    const normal = [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
    const length = Math.hypot(...normal);
    faceAreas[t] = length / 2;
    if (length > 0)
      for (let k = 0; k < 3; k++) faceNormals[t * 3 + k] = normal[k] / length;
    for (let e = 0; e < 3; e++) {
      const a = vertexIds[t * 3 + e],
        b = vertexIds[t * 3 + ((e + 1) % 3)];
      if (a === b) continue;
      const key = Math.min(a, b) * base + Math.max(a, b);
      let id = edges.get(key);
      if (id === undefined) {
        id = edges.size;
        edges.set(key, id);
        incidenceCounts.push(0);
      }
      faceEdgeIds[t * 3 + e] = id;
      incidenceCounts[id]++;
    }
  }
  const offsets = new Uint32Array(edges.size + 1);
  const kinds = new Uint8Array(edges.size);
  for (let e = 0; e < edges.size; e++) {
    offsets[e + 1] = offsets[e] + incidenceCounts[e];
    kinds[e] =
      incidenceCounts[e] === 1
        ? SOURCE_EDGE_KIND.boundary
        : incidenceCounts[e] === 2
          ? SOURCE_EDGE_KIND.manifold
          : SOURCE_EDGE_KIND.nonManifold;
  }
  const faces = new Uint32Array(offsets[edges.size]);
  const localEdges = new Uint8Array(faces.length);
  const cursor = offsets.slice(0, -1);
  for (let at = 0; at < faceEdgeIds.length; at++) {
    const e = faceEdgeIds[at];
    if (e < 0) continue;
    const slot = cursor[e]++;
    faces[slot] = Math.floor(at / 3);
    localEdges[slot] = at % 3;
  }
  for (let e = 0; e < edges.size; e++)
    if (incidenceCounts[e] === 2 && faces[offsets[e]] === faces[offsets[e] + 1])
      kinds[e] = SOURCE_EDGE_KIND.nonManifold;
  return {
    faceNormals,
    faceAreas,
    sharedEdges: { faceEdgeIds, offsets, faces, localEdges, kinds },
  };
}

function freezeMetadata<T>(value: T): T {
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}

/** Returns no ledger beyond the existing production mesh/raster limits.
 * Recording limits must not reject an otherwise valid legacy color result. */
export function createSceneSurfaceGraph(input: SourceObservationInput) {
  const { positions, image, projectionSize } = input;
  const faceCount = positions.length / 9;
  const rasterPixels = image.width * image.height;
  const gridPixels = projectionSize * projectionSize;
  if (
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width < 1 ||
    image.height < 1 ||
    !Number.isInteger(faceCount) ||
    faceCount < 1 ||
    faceCount > SOURCE_OBSERVATION_LIMITS.maximumFaces ||
    !Number.isInteger(rasterPixels) ||
    rasterPixels < 1 ||
    rasterPixels > SOURCE_OBSERVATION_LIMITS.maximumRasterPixels ||
    !Number.isInteger(projectionSize) ||
    projectionSize < 2 ||
    gridPixels > SOURCE_OBSERVATION_LIMITS.maximumProjectionPixels ||
    image.data.length !== rasterPixels * 4 ||
    input.mask.length !== rasterPixels ||
    input.rawRegionIds.length !== rasterPixels ||
    input.pixelFaces.length !== gridPixels
  )
    return undefined;
  const sourcePositions = positions.slice();
  const camera = { ...input.camera },
    alignment = structuredClone(input.alignment);
  const raster = {
    width: image.width,
    height: image.height,
    rgba: Uint8Array.from(image.data),
    foregroundMask: input.mask.slice(),
    rawRegionIds: input.rawRegionIds.slice(),
    regionBoundaryBits: new Uint8Array(rasterPixels),
  };
  for (let k = 0; k < rasterPixels; k++) {
    const id = raster.rawRegionIds[k];
    if (id < 0) continue;
    const x = k % image.width,
      y = Math.floor(k / image.width);
    for (const [other, bit] of [
      [x + 1 < image.width ? k + 1 : -1, 1],
      [y + 1 < image.height ? k + image.width : -1, 2],
      [x > 0 ? k - 1 : -1, 4],
      [y > 0 ? k - image.width : -1, 8],
    ])
      if (other < 0 || raster.rawRegionIds[other] !== id)
        raster.regionBoundaryBits[k] |= bit;
  }
  const projection = {
    size: projectionSize,
    transform: {
      sourcePixelRounding: 'Math.round' as const,
      gridDenominator: projectionSize - 1,
      rasterSampleOffset: [0.5, 0.5] as const,
      imageBounds: [...input.imageBounds] as [number, number, number, number],
      viewBounds: [...input.viewBounds] as [number, number, number, number],
      meshCenter: [...input.meshCenter] as [number, number, number],
      extent: input.extent,
      depthTolerance: input.depthTolerance,
    },
    pixelFaces: input.pixelFaces.slice(),
    sourcePixelXY: new Int32Array(gridPixels * 2).fill(-1),
    rawRGB: new Uint8Array(gridPixels * 3),
    rawRegionIds: new Int32Array(gridPixels).fill(-1),
    observed: new Uint8Array(gridPixels),
  };
  const centroidFaces: number[] = [],
    centroidXY: number[] = [],
    centroidPixels: number[] = [];
  const centroidRGB: number[] = [],
    centroidRegions: number[] = [],
    centroidFrontFaces: number[] = [],
    centroidDepths: number[] = [];
  let result: SceneSurfaceGraph | undefined;
  const checkOpen = () => {
    if (result) throw Error('Source observations are already finalized.');
  };
  const checkSourcePixel = (k: number) => {
    if (
      !Number.isInteger(k) ||
      k < 0 ||
      k >= rasterPixels ||
      !raster.foregroundMask[k]
    )
      throw Error('Invalid foreground source observation.');
  };
  const copySample = (k: number, xy: number[], rgb: number[]) => {
    xy.push(k % raster.width, Math.floor(k / raster.width));
    rgb.push(
      raster.rgba[k * 4],
      raster.rgba[k * 4 + 1],
      raster.rgba[k * 4 + 2],
    );
  };
  return {
    recordPixel(gridPixel: number, sourcePixel: number) {
      checkOpen();
      checkSourcePixel(sourcePixel);
      if (
        !Number.isInteger(gridPixel) ||
        gridPixel < 0 ||
        gridPixel >= gridPixels ||
        projection.pixelFaces[gridPixel] < 0 ||
        projection.observed[gridPixel]
      )
        throw Error('Invalid or repeated source grid observation.');
      projection.sourcePixelXY[gridPixel * 2] = sourcePixel % raster.width;
      projection.sourcePixelXY[gridPixel * 2 + 1] = Math.floor(
        sourcePixel / raster.width,
      );
      projection.rawRGB.set(
        raster.rgba.subarray(sourcePixel * 4, sourcePixel * 4 + 3),
        gridPixel * 3,
      );
      projection.rawRegionIds[gridPixel] = raster.rawRegionIds[sourcePixel];
      projection.observed[gridPixel] = 1;
    },
    recordCentroid(
      face: number,
      x: number,
      y: number,
      sourcePixel: number,
      depth: number,
      front: { face: number; depth: number },
    ) {
      checkOpen();
      checkSourcePixel(sourcePixel);
      if (
        !Number.isInteger(face) ||
        face < 0 ||
        face >= faceCount ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      )
        throw Error('Invalid source centroid observation.');
      if (centroidFaces.length >= faceCount)
        throw Error('Too many source centroid observations.');
      centroidFaces.push(face);
      centroidXY.push(x, y);
      copySample(sourcePixel, centroidPixels, centroidRGB);
      centroidRegions.push(raster.rawRegionIds[sourcePixel]);
      centroidFrontFaces.push(front.face);
      centroidDepths.push(depth, front.depth);
    },
    finish(): SceneSurfaceGraph {
      if (result) return result;
      const topology = sourceTopology(sourcePositions);
      const centroids = {
        faces: Int32Array.from(centroidFaces),
        projectedXY: Float64Array.from(centroidXY),
        sourcePixelXY: Int32Array.from(centroidPixels),
        rawRGB: Uint8Array.from(centroidRGB),
        rawRegionIds: Int32Array.from(centroidRegions),
        frontFaces: Int32Array.from(centroidFrontFaces),
        depths: Float64Array.from(centroidDepths),
      };
      const arrays = [
        sourcePositions,
        topology.faceNormals,
        topology.faceAreas,
        ...Object.values(raster),
        ...Object.values(projection),
        ...Object.values(centroids),
        ...Object.values(topology.sharedEdges),
      ].filter((a) => ArrayBuffer.isView(a)) as ArrayBufferView[];
      const arrayBytes = arrays.reduce((sum, a) => sum + a.byteLength, 0);
      result = freezeMetadata({
        version: 1,
        method: 'source-reference-observations',
        sourceCoordinates: 'input-mesh',
        sourcePositions,
        ...topology,
        camera,
        alignment,
        raster,
        projection: { ...projection, centroids },
        arrayBytes,
      } as SceneSurfaceGraph);
      return result;
    },
  };
}
