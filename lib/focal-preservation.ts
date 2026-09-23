import type { ComponentRegion } from './semantic-components.ts';
import type { SceneElementInstance } from './scene-elements.ts';

export type FocalFallback =
  | 'component'
  | 'relief'
  | 'simplified-standing-statue'
  | 'simplified'
  | 'forced-voxel-silhouette'
  | 'voxel';

export function requiresFocalPreservation(
  instance?: Pick<SceneElementInstance, 'mustRepresent' | 'category'>,
) {
  return Boolean(instance?.mustRepresent || instance?.category === 'statue');
}

/** Ordered fallbacks used by the transactional assembler. */
export function focalFallbacks(region: ComponentRegion): FocalFallback[] {
  if (!requiresFocalPreservation(region.sceneElement)) return ['voxel'];
  if (region.kind === 'statue')
    return [
      'component',
      'relief',
      'simplified-standing-statue',
      'simplified',
      'forced-voxel-silhouette',
    ];
  return ['component', 'simplified', 'voxel'];
}
