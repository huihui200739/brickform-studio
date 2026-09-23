// Per-triangle flags read from the reference picture *before* its colours are
// quantised to the brick palette. Foliage is the reason they exist: an olive
// canopy is warm and desaturated, the palette has no olive green, so leaves and
// the sand floor around them can land on the very same brick colour. The
// photograph still tells them apart, and that reading survives the palette.
export const MESH_FEATURE = { foliage: 1 } as const;
export type TriangleMesh = {
  positions: Float32Array;
  // One sRGB color per triangle, sampled from the original material/texture.
  colors: Uint8Array;
  name: string;
  // One flags byte per triangle; unobserved triangles carry no flags.
  features?: Uint8Array;
  coloring?: {
    method: 'reference-projection';
    yaw: number;
    pitch: number;
    perspective: number;
    observedFraction: number;
  };
  statueFallback?: {
    cells: Array<[number, number, number]>;
    width: number;
    height: number;
    depth: number;
  };
};
