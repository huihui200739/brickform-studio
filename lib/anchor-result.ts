import type { V3 } from './assembly-catalog.ts';

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
  /** Normalized anchor consumed by the legacy component placement API. */
  normalizedAnchor?: V3;
  /** Candidate kind used by debug output and placement policy. */
  surfaceKind?: 'ground' | 'wall' | 'platform' | 'unknown';
};
