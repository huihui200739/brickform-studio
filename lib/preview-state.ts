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
  direction?: readonly number[],
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
  let distance = (radius / Math.sin(fov / 2)) * 1.06;
  if (direction) {
    const length = Math.hypot(...direction),
      n = direction.map((v) => v / length);
    const rLength = Math.hypot(n[0], n[2]);
    const right =
      rLength > 0.0001 ? [n[2] / rLength, 0, -n[0] / rLength] : [1, 0, 0];
    const up = [
      n[1] * right[2] - n[2] * right[1],
      n[2] * right[0] - n[0] * right[2],
      n[0] * right[1] - n[1] * right[0],
    ];
    const tanV = Math.tan(vertical / 2),
      tanH = tanV * Math.max(0.01, aspect);
    let fit = 0;
    for (const x of [min[0], max[0]])
      for (const y of [min[1], max[1]])
        for (const z of [min[2], max[2]]) {
          const v = [x - target[0], y - target[1], z - target[2]];
          const dot = (axis: number[]) =>
            v.reduce((sum, value, i) => sum + value * axis[i], 0);
          fit = Math.max(
            fit,
            dot(n) + Math.abs(dot(right)) / tanH,
            dot(n) + Math.abs(dot(up)) / tanV,
          );
        }
    distance = Math.max(radius * 1.1, fit * 1.08);
  }
  return {
    target,
    distance,
    minDistance: Math.max(1, radius * 0.8),
  };
}
