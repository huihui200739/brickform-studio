export type TriangleMesh = {
  positions: Float32Array;
  // One sRGB color per triangle, sampled from the original material/texture.
  colors: Uint8Array;
  name: string;
  coloring?: {
    method: 'reference-projection';
    yaw: number;
    pitch: number;
    perspective: number;
    observedFraction: number;
  };
};
