/**
 * The scene layer is the contract between image analysis and model planning.
 * It deliberately contains no mesh mutation or brick placement operations.
 */
export type ElementCategory =
  | 'tree'
  | 'plant'
  | 'person'
  | 'statue'
  | 'brazier'
  | 'lamp'
  | 'fountain'
  | 'bench'
  | 'animal'
  | 'vehicle'
  | 'stairs'
  | 'column'
  | 'arch'
  | 'door'
  | 'window'
  | 'tower'
  | 'building'
  | 'decor'
  | 'unknown'
  // Kept for compatibility with older manually-created regions.
  | 'furniture';

export type ImageBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type BBox3d = {
  min: [number, number, number];
  max: [number, number, number];
};

export type ElementImportance = 'primary' | 'secondary' | 'background';
export type DetectionSource = 'vision' | 'color' | 'geometry' | 'heuristic';

/** One detected object in the reference image. One tree means one instance. */
export type SceneElementInstance = {
  id: string;
  category: ElementCategory;
  confidence: number;
  imageBox?: ImageBox;
  imageMask?: Uint8Array;
  imageMaskSize?: [number, number];
  anchorUV?: [number, number];
  worldAnchor?: [number, number, number];
  bbox3d?: BBox3d;
  scaleHint?: { width: number; height: number; depth: number };
  colorHints?: number[];
  groupId?: string;
  importance?: ElementImportance;
  importanceScore?: number;
  mustRepresent?: boolean;
  detectionSource?: DetectionSource;
  anchorKind?: 'ground' | 'wall' | 'surface' | 'free';
  anchorConfidence?: number;
  evidence?: string[];
  shapeEmbedding?: number[];

  // Planning outcome is written after routing/transaction, never by detection.
  chosenRepresentation?: RepresentationKind;
  chosenTemplateId?: string;
  outcome?: 'pending' | 'committed' | 'preserved';
  reason?: string;
  representationResult?: RepresentationResult;
};

export type SceneElementGroup = {
  id: string;
  category: ElementCategory;
  members: string[];
  layout: 'line' | 'ring' | 'symmetric' | 'cluster' | 'scattered';
  styleLock: boolean;
  preferredTemplates: string[];
};

export type RepresentationKind =
  | 'component'
  | 'semantic-template'
  | 'parametric-structure'
  | 'procedural-structure'
  | 'relief'
  | 'generic-geometry'
  // Compatibility name used by the pre-Phase-1 assembly API.
  | 'voxel';

/** The router's immutable decision; it does not edit a mesh. */
export type RepresentationPlan = {
  elementId: string;
  kind: RepresentationKind;
  templateId?: string;
  confidence: number;
  reason: string[];
};

/** Verified geometry produced by a plan, using IDs from the final model. */
export type RepresentationResult = {
  elementId: string;
  requestedKind: RepresentationKind;
  actualKind: RepresentationKind;
  committed: boolean;
  brickIds: number[];
  bbox3d?: BBox3d;
  brickCount: number;
  visibleFromReference: boolean;
  projectedCoverage?: number;
  occlusionRatio?: number;
  projectedBox?: ImageBox;
  fallbackLevel: number;
  failureReasons: string[];
};

export type SceneAnalysis = {
  elements: SceneElementInstance[];
  groups: SceneElementGroup[];
};
