import type { Brick } from './brick-engine.ts';

export function explodedLayers(
  bricks: Brick[],
  first: number,
  count: number,
  gap: number,
) {
  const steps = [...new Set(bricks.map((b) => b.step ?? 0))].sort(
    (a, b) => a - b,
  );
  const selected = steps.slice(first, first + count);
  let cursor = 0;
  const offsets = new Map<number, number>();
  const layers = selected.map((step) => {
    const group = bricks.filter((b) => (b.step ?? 0) === step);
    const min = Math.min(...group.map((b) => b.y * 0.4));
    const max = Math.max(...group.map((b) => (b.y + b.h) * 0.4));
    const offset = cursor - min;
    offsets.set(step, offset);
    const center = cursor + (max - min) / 2;
    cursor += max - min + Math.max(0.2, gap);
    return { step, center, count: group.length };
  });
  return { offsets, layers };
}

export type PreviewMode = 'complete' | 'steps';
export function previewRange(
  mode: PreviewMode,
  total: number,
  layer: number,
  focusId?: number,
) {
  return mode === 'complete'
    ? { layer: total, focusId: undefined }
    : { layer, focusId };
}
export function visibleInPreview(
  b: Brick,
  range: { layer: number; focusId?: number; section: string },
) {
  return (
    (b.step ?? 0) < range.layer &&
    (range.focusId === undefined ||
      b.step !== range.layer - 1 ||
      b.id <= range.focusId) &&
    (range.section === 'all' || b.section === range.section)
  );
}

// Frame the actual visible mesh bounds, including side-mounted parts and studs.
export function previewFrame(
  min: readonly number[],
  max: readonly number[],
  aspect: number,
  verticalFov = 34,
) {
  const target = min.map((v, i) => (v + max[i]) / 2);
  const radius = Math.max(
    1.5,
    Math.hypot(...min.map((v, i) => max[i] - v)) / 2,
  );
  const vertical = (verticalFov * Math.PI) / 180;
  const fov = Math.min(
    vertical,
    2 * Math.atan(Math.tan(vertical / 2) * Math.max(0.01, aspect)),
  );
  return {
    target,
    distance: (radius / Math.sin(fov / 2)) * 1.06,
    minDistance: Math.max(1, radius * 0.8),
  };
}
