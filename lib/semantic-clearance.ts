import type { V3 } from './assembly-catalog.ts';
import type { BBox3d } from './scene/scene-types.ts';
import { regionPlacement, type ComponentRegion } from './semantic-components.ts';

/** A flame on a platform beside a detected recess needs open space above its
 * seat. Retain the rear facade and the entire foundation; only the foreground
 * source envelope belongs to the replaced object. No recess means no cut. */
export function brazierClearances(regions: ComponentRegion[], grid: V3): BBox3d[] {
  const niches = regions.filter(r => r.kind === 'statue' && r.anchorResult?.clearanceVolume);
  return regions.flatMap(r => {
    if (r.kind !== 'brazier' || !r.autoRefinement || !r.sourceAnchor ||
        !r.sceneElement?.imageBox || (r.anchorResult?.depthConfidence ?? 0) < 0.6) return [];
    const placed = regionPlacement(r, grid);
    const source = regionPlacement({ ...r, anchor: r.sourceAnchor }, grid);
    for (const niche of niches) {
      const opening = niche.anchorResult!.clearanceVolume!;
      const axis = niche.anchorResult!.clearanceAxis ?? 2, cross = axis === 2 ? 0 : 2;
      const normal = r.anchorResult!.surface.normal[axis];
      if (Math.abs(normal) < 0.7) continue;
      const nearEdge = Math.min(Math.abs(source.min[cross] - opening.max[cross]),
        Math.abs(source.max[cross] - opening.min[cross]));
      if (nearEdge > 2 || placed.y >= opening.max[1]) continue;
      const min: V3 = source.min.map((v, i) => Math.min(v, placed.min[i])) as V3;
      const max: V3 = source.max.map((v, i) => Math.max(v, placed.max[i])) as V3;
      // The source hit can sit one voxel behind the quantized replacement.
      // The rear architectural wall is outside this bounded source envelope.
      if (normal > 0) min[axis] = source.min[axis] - 1;
      else max[axis] = source.max[axis] + 1;
      min[1] = placed.y;
      max[1] = opening.max[1];
      // A fitted cavity ends at the façade. The flame envelope is normally
      // in front of that façade; only crossing the rear wall is prohibited.
      if ((normal > 0 ? min[axis] < opening.min[axis] : max[axis] > opening.max[axis]) ||
          min.some(v => v < 1) || max.some((v, i) => v > grid[i] + (i === 1 ? 2 : 1))) continue;
      return [{ min, max }];
    }
    return [];
  });
}
