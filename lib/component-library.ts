import type { Brick } from './brick-engine.ts';
import { componentBricks } from './component-parts.ts';
import { simplifiedTree, reliefStatue, simplifiedStatue, simplifiedStandingStatue } from './semantic-templates.ts';
import type { SceneElementInstance, SceneCategory } from './scene-elements.ts';
export type {
  SceneCategory,
  SceneElement,
  SceneElementInstance,
} from './scene-elements.ts';
export type LegoComponentTemplate = {
  id: string;
  name: string;
  category: SceneCategory;
  tags: string[];
  bboxStuds: { width: number; depth: number; height: number };
  anchor: {
    kind: 'ground' | 'wall' | 'surface' | 'free';
    localPoint: [number, number, number];
  };
  colors: number[];
  representation: 'component' | 'template';
  build: (instance?: SceneElementInstance) => Brick[];
  requiresMask?: boolean;
  fallback?: 'relief' | 'voxel';
  geometryEmbedding?: number[];
};
export const COMPONENT_LIBRARY: LegoComponentTemplate[] = [
  {
    id: 'tree-basic',
    name: '枝叶树',
    category: 'tree',
    tags: ['foliage'],
    bboxStuds: { width: 8, depth: 8, height: 16 },
    anchor: { kind: 'ground', localPoint: [0, 0, 0] },
    colors: [5, 7, 9],
    representation: 'component',
    build: () => componentBricks('tree'),
    fallback: 'voxel',
  },
  {
    id: 'tree-small-round',
    name: '简化小树',
    category: 'tree',
    tags: ['small', 'round'],
    bboxStuds: { width: 2, depth: 2, height: 8 },
    anchor: { kind: 'ground', localPoint: [0, 0, 0] },
    colors: [5, 7, 9],
    representation: 'template',
    build: simplifiedTree,
    fallback: 'voxel',
  },
  {
    id: 'brazier-basic',
    name: '火盆',
    category: 'brazier',
    tags: ['flame'],
    bboxStuds: { width: 4, depth: 4, height: 18 },
    anchor: { kind: 'surface', localPoint: [0, 0, 0] },
    colors: [1, 7],
    representation: 'component',
    build: () => componentBricks('brazier'),
    fallback: 'voxel',
  },
  {
    id: 'statue-standing',
    name: '持盾人物',
    category: 'statue',
    tags: ['figure'],
    bboxStuds: { width: 6, depth: 5, height: 23 },
    anchor: { kind: 'ground', localPoint: [0, 0, 0] },
    colors: [11],
    representation: 'component',
    build: () => componentBricks('statue'),
    fallback: 'relief',
  },
  {
    id: 'statue-relief',
    name: '轮廓浮雕',
    category: 'statue',
    tags: ['relief'],
    bboxStuds: { width: 6, depth: 2, height: 24 },
    anchor: { kind: 'surface', localPoint: [0, 0, 0] },
    colors: [7, 11],
    representation: 'template',
    build: reliefStatue,
    requiresMask: true,
    fallback: 'relief',
  },
  {
    id: 'statue-simple-standing',
    name: '简化站立雕像',
    category: 'statue',
    tags: ['focal', 'standing', 'fallback'],
    bboxStuds: { width: 6, depth: 4, height: 14 },
    anchor: { kind: 'ground', localPoint: [0, 0, 0] },
    colors: [7, 11],
    representation: 'template',
    build: simplifiedStandingStatue,
    fallback: 'voxel',
  },
  {
    id: 'statue-simplified',
    name: '简化主视觉雕像',
    category: 'statue',
    tags: ['focal', 'blockout'],
    bboxStuds: { width: 4, depth: 2, height: 8 },
    anchor: { kind: 'surface', localPoint: [0, 0, 0] },
    colors: [7, 11],
    representation: 'template',
    build: simplifiedStatue,
    fallback: 'voxel',
  },
];
export function componentTemplate(id: string) {
  return COMPONENT_LIBRARY.find((t) => t.id === id);
}
export {
  retrieveComponent,
  retrieveComponentForInstance,
  fallbackRepresentation,
} from './component-retrieval.ts';
export type { ComponentMatch } from './component-retrieval.ts';
