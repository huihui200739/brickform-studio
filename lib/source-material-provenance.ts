/** Native GLB appearance is an imported sample, NOT verified intrinsic albedo.
 * Arrays are detached and immutable by ownership, like the raw observation
 * ledger; metadata is frozen. Typed arrays cannot be runtime-frozen safely. */
export const NATIVE_APPEARANCE_SOURCE = Object.freeze({
  materialFactor: 1,
  vertexColor: 2,
  textureSample: 4,
  defaultMaterial: 8,
});
export type NativeMaterialAppearance = {
  readonly id: number;
  readonly source: 'explicit-gltf-material' | 'gltf-default-material';
  readonly name: string;
  readonly baseColorFactor: readonly [number, number, number, number];
  readonly alphaMode: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff: number;
  readonly doubleSided: boolean;
};
export type NativeAppearanceProvenance = {
  readonly version: 1;
  readonly method: 'glb-native-appearance';
  readonly intrinsicMaterialVerified: false;
  /** One original sampled sRGB triplet per source face, before reference paint. */
  readonly originalRGB: Uint8Array;
  /** glTF material index; -1 specifically means the loader's missing-material default. */
  readonly materialIds: Int32Array;
  /** NATIVE_APPEARANCE_SOURCE bits; absence is not a measured white material. */
  readonly faceSourceKinds: Uint8Array;
  /** Factor * mean vertex alpha * centroid texture alpha. AlphaMode is separate:
   * OPAQUE ignores this value; it does not establish optical transmittance. */
  readonly alpha: Float32Array;
  readonly materials: readonly NativeMaterialAppearance[];
};
export type UnobservedMaterialPolicy = 'legacy' | 'source-topology-only';
export const SOURCE_COLOR_KIND = Object.freeze({
  nativeAppearance: 1,
  referenceObserved: 2,
  sourceTopologyInferred: 3,
  legacyLocalInferred: 4,
  legacyCompatibleInferred: 5,
  legacyInclinationInferred: 6,
  referenceDefault: 7,
});
export type ColourPipelineAudit = {
  readonly version: 1;
  readonly method: 'colour-source-audit';
  readonly intrinsicMaterialVerified: false;
  readonly unobservedPolicy?: UnobservedMaterialPolicy;
  readonly nativeRGB?: Uint8Array;
  /** Source selection / coverage at reference projection, not verified paint or
   * proof that a later material hypothesis still has the original photo RGB. */
  readonly perFaceSourceKind: Uint8Array;
  /** An inferred donor outside this face's exact-edge source component. */
  readonly disconnectedInference: Uint8Array;
  /** -1 has no licensed path. Roots point to themselves and have observed pixels;
   * other entries point to an exact manifold neighbour nearer that root. */
  readonly topologyParentFaces?: Int32Array;
  readonly sourceDomainIds?: Int32Array;
  readonly counts: Readonly<{
    nativeAppearanceFaces: number;
    referenceObservedFaces: number;
    inferredFaces: number;
    unknownFaces: number;
    disconnectedInferenceFaces: number;
  }>;
};

export function snapshotNativeAppearance(value: NativeAppearanceProvenance) {
  const faces = value.originalRGB.length / 3;
  if (
    !Number.isInteger(faces) ||
    value.materialIds.length !== faces ||
    value.faceSourceKinds.length !== faces ||
    value.alpha.length !== faces
  )
    throw Error('Native appearance source face counts are inconsistent.');
  const materials = value.materials.map((material) =>
    Object.freeze({
      ...material,
      baseColorFactor: Object.freeze([
        ...material.baseColorFactor,
      ]) as readonly [number, number, number, number],
    }),
  );
  return Object.freeze({
    ...value,
    originalRGB: value.originalRGB.slice(),
    materialIds: value.materialIds.slice(),
    faceSourceKinds: value.faceSourceKinds.slice(),
    alpha: value.alpha.slice(),
    materials: Object.freeze(materials),
  });
}

export function colourPipelineAudit(input: {
  nativeAppearance?: NativeAppearanceProvenance;
  unobservedPolicy?: UnobservedMaterialPolicy;
  perFaceSourceKind: Uint8Array;
  disconnectedInference?: Uint8Array;
  topologyParentFaces?: Int32Array;
  sourceDomainIds?: Int32Array;
}): ColourPipelineAudit {
  const counts = {
    nativeAppearanceFaces: input.nativeAppearance?.materialIds.length ?? 0,
    referenceObservedFaces: 0,
    inferredFaces: 0,
    unknownFaces: 0,
    disconnectedInferenceFaces: 0,
  };
  const disconnected =
    input.disconnectedInference ??
    new Uint8Array(input.perFaceSourceKind.length);
  for (let f = 0; f < input.perFaceSourceKind.length; f++) {
    const kind = input.perFaceSourceKind[f];
    if (kind === SOURCE_COLOR_KIND.referenceObserved)
      counts.referenceObservedFaces++;
    else if (kind === SOURCE_COLOR_KIND.referenceDefault) counts.unknownFaces++;
    else if (kind !== SOURCE_COLOR_KIND.nativeAppearance)
      counts.inferredFaces++;
    if (disconnected[f]) counts.disconnectedInferenceFaces++;
  }
  return Object.freeze({
    version: 1,
    method: 'colour-source-audit',
    intrinsicMaterialVerified: false,
    ...(input.unobservedPolicy
      ? { unobservedPolicy: input.unobservedPolicy }
      : {}),
    ...(input.nativeAppearance
      ? { nativeRGB: input.nativeAppearance.originalRGB.slice() }
      : {}),
    perFaceSourceKind: input.perFaceSourceKind.slice(),
    disconnectedInference: disconnected.slice(),
    ...(input.topologyParentFaces
      ? { topologyParentFaces: input.topologyParentFaces.slice() }
      : {}),
    ...(input.sourceDomainIds
      ? { sourceDomainIds: input.sourceDomainIds.slice() }
      : {}),
    counts: Object.freeze(counts),
  });
}

export function unobservedMaterialPolicy(
  value?: UnobservedMaterialPolicy,
): UnobservedMaterialPolicy {
  if (
    value !== undefined &&
    value !== 'legacy' &&
    value !== 'source-topology-only'
  )
    throw Error('Unobserved material policy is invalid.');
  return value ?? 'legacy';
}
