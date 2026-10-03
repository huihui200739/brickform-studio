export const LOCAL_MATERIAL_MODEL = {
  method: 'marigold-iid-lighting',
  repo: 'prs-eth/marigold-iid-lighting-v1-1',
  revision: '08c3930bb641abf786ba44ce92547507ebefbc16',
  license: 'OpenRAIL++',
} as const;

export type MaterialRaster = {
  width: number;
  height: number;
  data: ArrayLike<number>;
};
export type LocalMaterialCandidate = {
  raster: { width: number; height: number; data: number[] };
  provenance: {
    method: typeof LOCAL_MATERIAL_MODEL.method;
    modelRepo: typeof LOCAL_MATERIAL_MODEL.repo;
    modelRevision: typeof LOCAL_MATERIAL_MODEL.revision;
    modelLicense: typeof LOCAL_MATERIAL_MODEL.license;
    sourceSha256: string;
    engineFingerprint: string;
    runtimeDtype: 'float32';
    device: 'mps';
    steps: 4;
    processingResolution: 512;
    ensembleSize: 1;
    seed: 735;
    inferenceHypothesis: true;
    originalAlphaPreserved: true;
    elapsedSeconds: number;
    limits: string[];
    mapStats?: Record<string, unknown>;
  };
};
export type LocalMaterialAnalysisResponse = {
  candidate: LocalMaterialCandidate;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('材质数据无效。');
  return value as Record<string, unknown>;
}

/** Validate canonical pixels before starting the local model or allocating maps. */
export function decodeMaterialRaster(value: unknown) {
  const { width, height, data } = record(value);
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 320 ||
    height > 320 ||
    !Array.isArray(data) ||
    data.length !== width * height * 4
  )
    throw Error('参考图像素无效或超过 320 × 320。');
  // Array.every skips sparse holes; inspect each byte explicitly.
  for (let i = 0; i < data.length; i++)
    if (!Number.isInteger(data[i]) || data[i] < 0 || data[i] > 255)
      throw Error('参考图必须是完整的 RGBA 字节。');
  return { width, height, data: Uint8Array.from(data) };
}

/** Same little-endian size header as the local scene raster fingerprint. */
export function encodeMaterialRaster(raster: MaterialRaster) {
  const valid = decodeMaterialRaster({
    width: raster.width,
    height: raster.height,
    data: Array.from(raster.data),
  });
  const bytes = new Uint8Array(8 + valid.data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, valid.width, true);
  view.setUint32(4, valid.height, true);
  bytes.set(valid.data, 8);
  return bytes;
}

/** An estimate is aligned only if dimensions, original alpha and source match. */
export function decodeMaterialCandidate(
  value: unknown,
  source: MaterialRaster,
  expected?: { sourceSha256?: string; engineFingerprint?: string },
): LocalMaterialCandidate {
  const candidate = record(value),
    raster = decodeMaterialRaster(candidate.raster),
    provenance = record(candidate.provenance);
  if (
    raster.width !== source.width ||
    raster.height !== source.height ||
    source.data.length !== raster.data.length
  )
    throw Error('材质候选没有与原图对齐。');
  for (let i = 3; i < raster.data.length; i += 4)
    if (raster.data[i] !== source.data[i])
      throw Error('材质候选改变了原图透明度。');
  const isHash = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (
    provenance.method !== LOCAL_MATERIAL_MODEL.method ||
    provenance.modelRepo !== LOCAL_MATERIAL_MODEL.repo ||
    provenance.modelRevision !== LOCAL_MATERIAL_MODEL.revision ||
    provenance.modelLicense !== LOCAL_MATERIAL_MODEL.license ||
    !isHash(provenance.sourceSha256) ||
    !isHash(provenance.engineFingerprint) ||
    (expected?.sourceSha256 !== undefined &&
      provenance.sourceSha256 !== expected.sourceSha256) ||
    (expected?.engineFingerprint !== undefined &&
      provenance.engineFingerprint !== expected.engineFingerprint) ||
    provenance.runtimeDtype !== 'float32' ||
    provenance.device !== 'mps' ||
    provenance.steps !== 4 ||
    provenance.processingResolution !== 512 ||
    provenance.ensembleSize !== 1 ||
    provenance.seed !== 735 ||
    provenance.inferenceHypothesis !== true ||
    provenance.originalAlphaPreserved !== true ||
    typeof provenance.elapsedSeconds !== 'number' ||
    !Number.isFinite(provenance.elapsedSeconds) ||
    provenance.elapsedSeconds < 0 ||
    !Array.isArray(provenance.limits) ||
    !provenance.limits.length ||
    !provenance.limits.every((v) => typeof v === 'string')
  )
    throw Error('材质候选的来源或推理参数无效。');
  return {
    raster: {
      width: raster.width,
      height: raster.height,
      data: Array.from(raster.data),
    },
    provenance: {
      method: LOCAL_MATERIAL_MODEL.method,
      modelRepo: LOCAL_MATERIAL_MODEL.repo,
      modelRevision: LOCAL_MATERIAL_MODEL.revision,
      modelLicense: LOCAL_MATERIAL_MODEL.license,
      sourceSha256: provenance.sourceSha256,
      engineFingerprint: provenance.engineFingerprint,
      runtimeDtype: 'float32',
      device: 'mps',
      steps: 4,
      processingResolution: 512,
      ensembleSize: 1,
      seed: 735,
      inferenceHypothesis: true,
      originalAlphaPreserved: true,
      elapsedSeconds: provenance.elapsedSeconds,
      limits: provenance.limits.slice(),
      ...(provenance.mapStats && typeof provenance.mapStats === 'object'
        ? { mapStats: provenance.mapStats as Record<string, unknown> }
        : {}),
    },
  };
}
