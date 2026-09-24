import type { V3 } from './assembly-catalog.ts';

/** How a semantic component is expected to be installed in the generated model. */
export type PlacementMode =
  | 'wall-mounted'
  | 'pedestal-mounted'
  | 'cavity-contained';

export type AnchorResult = {
  elementId: string;
  imageAnchor: { x: number; y: number };
  worldAnchor: { x: number; y: number; z: number };
  surface: {
    detected: boolean;
    normal: [number, number, number];
    supportBrickIds: number[];
  };
  depthConfidence: number;
  attached: boolean;
  failureReasons: string[];
  placementMode?: PlacementMode;
  /** Soft placement quality used to order candidates, never a semantic gate. */
  placementScore?: number;
  /** Normalized anchor consumed by the legacy component placement API. */
  normalizedAnchor?: V3;
  /** Candidate kind used by debug output and placement policy. */
  surfaceKind?: 'ground' | 'wall' | 'platform' | 'unknown';
};
