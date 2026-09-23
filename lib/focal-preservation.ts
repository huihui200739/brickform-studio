import type { ComponentRegion } from './semantic-components.ts';
import type { SceneElementInstance } from './scene-elements.ts';

export type FocalFallback =
  | 'component'
  | 'semantic-template'
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
      'semantic-template',
      'relief',
      'simplified-standing-statue',
      'forced-voxel-silhouette',
    ];
  return ['component', 'simplified', 'voxel'];
}

/** Public audit label sequence used by debug reports and regression tests. */
export function focalFallbackLabels(region: ComponentRegion): FocalFallback[] {
  return focalFallbacks(region);
}
