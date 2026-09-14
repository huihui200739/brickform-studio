import {
  regionPlacement,
  type ComponentRegion,
} from './semantic-components.ts';
import type { V3 } from './assembly-catalog.ts';

export type PlacementReport = {
  id: string;
  name: string;
  status: 'kept' | 'adjusted' | 'conflict' | 'unpositioned' | 'budget';
  target: V3;
  actual?: V3;
  delta?: V3;
  message: string;
};
// Limits are measured at actual snapped mounting points, never relative to a
// previous retry. The immutable reference survives preview -> conversion.
export const PLACEMENT_LIMITS = { groundStuds: 1, heightPlates: 1 };
export function mountingPoint(r: ComponentRegion, grid: V3): V3 {
  const p = regionPlacement(r, grid);
  return [p.x, p.y, p.z];
}
export function placementDelta(r: ComponentRegion, grid: V3): V3 {
  const original = mountingPoint(
    { ...r, anchor: r.referenceAnchor || r.anchor },
    grid,
  );
  return mountingPoint(r, grid).map((v, a) => v - original[a]) as V3;
}
export function withinPlacementLimit(r: ComponentRegion, grid: V3) {
  const [x, y, z] = placementDelta(r, grid);
  return r.positionLocked
    ? x === 0 && y === 0 && z === 0
    : Math.hypot(x, z) <= PLACEMENT_LIMITS.groundStuds &&
        Math.abs(y) <= PLACEMENT_LIMITS.heightPlates;
}
export function placementCandidates(
  region: ComponentRegion,
  grid: V3,
): ComponentRegion[] {
  if (region.placed === false) return [];
  const referenceAnchor = region.referenceAnchor || region.anchor;
  const shifts: V3[] = [];
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const z of [-1, 0, 1])
        if (Math.hypot(x, z) <= 1) shifts.push([x, y, z]);
  shifts.sort(
    (a, b) =>
      a[0] ** 2 +
      a[2] ** 2 +
      (a[1] * 0.4) ** 2 -
      b[0] ** 2 -
      b[2] ** 2 -
      (b[1] * 0.4) ** 2,
  );
  const starts = [referenceAnchor, ...(region.fallbackAnchors || [])];
  const seen = new Set<string>();
  const candidates: ComponentRegion[] = [];
  for (const start of starts)
    for (const shift of shifts) {
      const anchor = start.map((v, a) => v + shift[a] / grid[a]) as V3;
      if (anchor.some((v) => !Number.isFinite(v) || v < 0 || v > 1)) continue;
      const candidate = { ...region, anchor, referenceAnchor, placed: true };
      if (!withinPlacementLimit(candidate, grid)) continue;
      const key = mountingPoint(candidate, grid).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(candidate);
    }
  return candidates.sort((a, b) => {
    const d = (r: ComponentRegion) => {
      const [x, y, z] = placementDelta(r, grid);
      return x * x + z * z + (y * 0.4) ** 2;
    };
    return d(a) - d(b);
  });
}
export function reportPlacement(
  requested: ComponentRegion,
  actual: ComponentRegion | undefined,
  grid: V3,
  name: string,
  exhausted = false,
): PlacementReport {
  const target = mountingPoint(
    { ...requested, anchor: requested.referenceAnchor || requested.anchor },
    grid,
  );
  if (!actual)
    return {
      id: requested.id,
      name,
      target,
      status:
        requested.placed === false
          ? 'unpositioned'
          : exhausted
            ? 'budget'
            : 'conflict',
      message:
        requested.placed === false
          ? '尚未定位：请点击草稿中的物件底部。'
          : exhausted
            ? '本轮未找到可用位置，保留原网格。可手动定位后重试。'
            : '原位置附近无法连接或存在干涉，保留原网格；未挪到其他区域。',
    };
  const delta = placementDelta(actual, grid),
    adjusted = delta.some((v) => v !== 0);
  return {
    id: requested.id,
    name,
    target,
    actual: mountingPoint(actual, grid),
    delta,
    status: adjusted ? 'adjusted' : 'kept',
    message: adjusted
      ? `微调：左右 ${delta[0]} 凸点，上下 ${delta[1]} 薄板层，前后 ${delta[2]} 凸点。`
      : '保持原落点，仅按积木网格对齐。',
  };
}
