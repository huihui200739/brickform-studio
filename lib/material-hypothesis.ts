import { PALETTE, type Raster } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';
import { rgb } from './material-color-space.ts';
import { referenceMaterials } from './reference-materials.ts';
import { surfaceMaterials } from './surface-materials.ts';

export type MaterialHypothesisCandidate = {
  raster: Raster;
  provenance: {
    method: 'marigold-iid-lighting';
    modelRevision: string;
    sourceSha256: string;
    engineFingerprint: string;
    runtimeDtype: 'float32';
    steps: 4;
    processingResolution: 512;
    seed: 735;
  };
};
export type MaterialHypothesisEvidence = {
  method: 'learned-albedo-candidate';
  provenance: MaterialHypothesisCandidate['provenance'];
  changedFaces: number;
  totalFaces: number;
  sourceObservationsPreserved: true;
  materialIdentityVerified: false;
  warnings: string[];
};

export async function rasterSha256(image: Raster) {
  const bytes = new Uint8Array(8 + image.width * image.height * 4);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, image.width, true);
  header.setUint32(4, image.height, true);
  bytes.set(Uint8Array.from(image.data), 8);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('');
}

/** Change only the material hypothesis. Camera, geometry, visibility samples,
 * original RGB, region boundaries and semantic feature flags remain the source
 * evidence. Albedo is a learned estimate and can also alter genuine paint. */
export async function applyMaterialHypothesis(
  mesh: TriangleMesh,
  candidate: MaterialHypothesisCandidate,
): Promise<TriangleMesh> {
  const graph = mesh.sourceObservations;
  if (!graph || !mesh.coloring)
    throw Error('请先按参考图恢复配色，再生成配色候选。');
  const image = candidate.raster,
    raw = graph.raster,
    provenance = candidate.provenance;
  if (
    image.width !== raw.width ||
    image.height !== raw.height ||
    image.data.length !== raw.rgba.length ||
    provenance.method !== 'marigold-iid-lighting' ||
    provenance.modelRevision !== '08c3930bb641abf786ba44ce92547507ebefbc16' ||
    provenance.runtimeDtype !== 'float32' ||
    provenance.steps !== 4 ||
    provenance.processingResolution !== 512 ||
    provenance.seed !== 735 ||
    !/^[a-f0-9]{64}$/.test(provenance.engineFingerprint)
  )
    throw Error('配色候选的尺寸或推理来源不匹配，已保留原配色。');
  for (let i = 0; i < image.data.length; i++)
    if (
      !Number.isInteger(image.data[i]) ||
      image.data[i] < 0 ||
      image.data[i] > 255 ||
      (i % 4 === 3 && image.data[i] !== raw.rgba[i])
    )
      throw Error('配色候选像素无效或改变了原图透明轮廓。');
  if (
    mesh.positions.length !== graph.sourcePositions.length ||
    mesh.positions.some((v, i) => v !== graph.sourcePositions[i])
  )
    throw Error('模型形状已改变，原图对应不再有效，请重新配色。');
  if (
    (await rasterSha256({
      width: raw.width,
      height: raw.height,
      data: raw.rgba,
    })) !== provenance.sourceSha256
  )
    throw Error('配色候选来自另一张图片，已保留原配色。');
  const materials = referenceMaterials(image, raw.foregroundMask, false);
  const faces = mesh.positions.length / 9;
  const votes = new Uint32Array(faces * PALETTE.length),
    samples = new Uint32Array(faces),
    counts = new Uint32Array(PALETTE.length);
  const visiblePixels: { face: number; color: number }[] = [];
  const sample = (face: number, xy: Int32Array, at: number) => {
    const pixel = xy[at + 1] * raw.width + xy[at],
      color = materials.palette[pixel];
    votes[face * PALETTE.length + color]++;
    samples[face]++;
    return color;
  };
  const { projection } = graph;
  for (let i = 0; i < projection.pixelFaces.length; i++)
    if (projection.observed[i]) {
      const face = projection.pixelFaces[i],
        color = sample(face, projection.sourcePixelXY, i * 2);
      counts[color]++;
      visiblePixels.push({ face, color });
    }
  for (let i = 0; i < projection.centroids.faces.length; i++)
    sample(
      projection.centroids.faces[i],
      projection.centroids.sourcePixelXY,
      i * 2,
    );
  const faceColors = new Int16Array(faces).fill(-1);
  for (let f = 0; f < faces; f++)
    if (samples[f]) {
      let color = 0;
      for (let c = 1; c < PALETTE.length; c++)
        if (votes[f * PALETTE.length + c] > votes[f * PALETTE.length + color])
          color = c;
      faceColors[f] = color;
    }
  const dominant = counts.indexOf(Math.max(...counts));
  const surfaces = surfaceMaterials(
    mesh.positions,
    faceColors,
    visiblePixels,
    dominant,
  );
  const colors = new Uint8Array(mesh.colors.length);
  let changedFaces = 0;
  for (let f = 0; f < faces; f++) {
    colors.set(rgb[Math.max(0, surfaces.colors[f])], f * 3);
    if ([0, 1, 2].some((c) => colors[f * 3 + c] !== mesh.colors[f * 3 + c]))
      changedFaces++;
  }
  const observed = Uint8Array.from(faceColors, (color) => (color >= 0 ? 1 : 0));
  if (
    mesh.materialEvidence &&
    observed.some((v, i) => v !== mesh.materialEvidence!.observed[i])
  )
    throw Error('配色候选改变了原图观测覆盖，已保留原配色。');
  const warnings = [
    'Learned albedo is a material hypothesis, not verified paint. Identical radiance can represent different materials and illumination. Genuine dark paint and fine texture may change; compare with source colors before converting.',
  ];
  return {
    ...mesh,
    colors,
    materialEvidence: { regionIds: surfaces.regionIds, observed },
    materialDesign: {
      ...materials.design,
      alignment: graph.alignment,
      surfaces: surfaces.design,
      projection: mesh.materialDesign?.projection
        ? {
            ...mesh.materialDesign.projection,
            materialPixels: Array.from(counts),
          }
        : undefined,
      warnings: [...materials.design.warnings, ...warnings],
    },
    materialHypothesis: {
      method: 'learned-albedo-candidate',
      provenance: { ...provenance },
      changedFaces,
      totalFaces: faces,
      sourceObservationsPreserved: true,
      materialIdentityVerified: false,
      warnings,
    },
  };
}
