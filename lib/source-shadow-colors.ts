import type { TriangleMesh } from './mesh-types.ts';
import { NATIVE_APPEARANCE_SOURCE } from './source-material-provenance.ts';

/** A radiance relation, never a declaration of intrinsic material identity.
 * Both encoded-sRGB scaling (baked images) and linear-light scaling are tested.
 * Quantisation error is absolute at low exposure, not a Lab-chroma paint lock. */
export function sourceScalarRelation(source: readonly number[], anchor: readonly number[]) {
  const fit = (a: readonly number[], b: readonly number[], tolerance: number) => {
    const norm = b.reduce((s, v) => s + v * v, 0);
    if (norm < 1e-10) return undefined;
    const scale = a.reduce((s, v, i) => s + v * b[i], 0) / norm;
    const error = Math.max(...a.map((v, i) => Math.abs(v - scale * b[i])));
    return scale >= 0.06 && scale <= 1.06 && error <= tolerance ? { scale, error } : undefined;
  };
  if (Math.max(...source) < 8 || Math.max(...anchor) < 8) return undefined;
  const encoded = fit(source, anchor, Math.max(1.15, Math.max(...source) * 0.025));
  // Equal deep exposures can carry a source path to a genuinely bright anchor.
  // They cannot themselves license an exposure extrapolation below the signal
  // floor; the final face-to-bright-anchor relation is checked independently.
  if (Math.max(...anchor) < 24) return encoded && encoded.scale >= 0.94 ? { ...encoded, space: 'encoded-srgb' as const } : undefined;
  if (encoded) return { ...encoded, space: 'encoded-srgb' as const };
  const linear = (c: readonly number[]) => c.map(v => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const a = linear(source), b = linear(anchor);
  const physical = fit(a, b, Math.max(0.0006, Math.max(...a) * 0.025));
  return physical ? { ...physical, space: 'linear-light' as const } : undefined;
}

/** Neutral rays cannot distinguish grey paint from shade without other evidence. */
export const hasChromaticScalarSignal = (rgb: readonly number[]) =>
  Math.max(...rgb) - Math.min(...rgb) > Math.max(...rgb) * 0.07;

/** Imported appearance is not albedo. A texture/vertex-colour/default material,
 * missing material -1, transparency, or one all-white proxy material is not
 * positive authored-material identity. Distinct explicit slots can still be a
 * negative boundary elsewhere; this helper only returns a restricted clue. */
export function sourceFactorMaterialKey(mesh: TriangleMesh, face: number) {
  const native = mesh.nativeAppearance;
  if (!native || native.materialIds.length !== mesh.positions.length / 9 || native.originalRGB.length !== mesh.positions.length / 3) return -1;
  const id = native.materialIds[face], material = native.materials.find(m => m.id === id);
  if (id < 0 || !material || material.source !== 'explicit-gltf-material' || material.alphaMode !== 'OPAQUE' || native.faceSourceKinds[face] !== NATIVE_APPEARANCE_SOURCE.materialFactor) return -1;
  if (native.materials.length === 1 && material.baseColorFactor.slice(0, 3).every(v => v >= 0.94)) return -1;
  return id;
}
