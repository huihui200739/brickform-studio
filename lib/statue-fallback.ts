import type { Raster } from './brick-engine.ts';

export type NicheSubjectRegion = {
  nicheBox: { min: [number, number, number]; max: [number, number, number] };
  subjectFrontMask: Uint8Array;
  subjectWidth: number;
  subjectHeight: number;
  subjectDepth: number;
  preserveRecess: true;
  preserveSubject: true;
};

/** Extracts a conservative central foreground silhouette; it never infers a minifigure. */
export function extractStatueMaskFromReference(image: Raster) {
  const { width: w, height: h, data } = image;
  const x0 = Math.floor(w * 0.34),
    x1 = Math.ceil(w * 0.66);
  const y0 = Math.floor(h * 0.18),
    y1 = Math.ceil(h * 0.58);
  const rw = Math.max(1, x1 - x0),
    rh = Math.max(1, y1 - y0);
  const mask = new Uint8Array(rw * rh);
  // Local dark/edge contrast against the niche, with a narrow central ROI.
  let sum = 0,
    count = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
      count++;
    }
  const mean = sum / Math.max(1, count);
  for (let y = 1; y < rh - 1; y++)
    for (let x = 1; x < rw - 1; x++) {
      const i = ((y + y0) * w + x + x0) * 4;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const left = (data[i - 4] + data[i - 3] + data[i - 2]) / 3;
      const right = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
      const edge = Math.abs(left - right);
      mask[y * rw + x] = lum < mean * 0.78 || edge > 28 ? 1 : 0;
    }
  // Remove isolated noise and retain the central connected mass.
  for (let y = 1; y < rh - 1; y++)
    for (let x = 1; x < rw - 1; x++) {
      const k = y * rw + x;
      let neighbours = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          neighbours += mask[(y + dy) * rw + x + dx];
      if (neighbours < 3) mask[k] = 0;
    }
  return {
    mask,
    width: rw,
    height: rh,
    origin: [x0 / w, y0 / h] as [number, number],
  };
}

export function buildReliefStatueFromMask(
  mask: Uint8Array,
  width: number,
  height: number,
  gridWidth: number,
  gridHeight: number,
  depth = 2,
) {
  const cells: Array<[number, number, number]> = [];
  const sx = gridWidth / width,
    sy = gridHeight / height;
  for (let gy = 0; gy < gridHeight; gy++)
    for (let gx = 0; gx < gridWidth; gx++) {
      const x = Math.min(width - 1, Math.floor(gx / sx));
      const y = Math.min(height - 1, Math.floor(gy / sy));
      if (!mask[y * width + x]) continue;
      for (let z = 0; z < depth; z++) cells.push([gx, gy, z]);
    }
  return { cells, width: gridWidth, height: gridHeight, depth };
}

export function injectStatueIntoNiche(
  image: Raster,
  gridWidth: number,
  gridHeight: number,
  gridDepth: number,
) {
  const extracted = extractStatueMaskFromReference(image);
  const relief = buildReliefStatueFromMask(
    extracted.mask,
    extracted.width,
    extracted.height,
    Math.max(4, Math.round(gridWidth * 0.16)),
    Math.max(5, Math.round(gridHeight * 0.24)),
    Math.min(2, Math.max(1, Math.round(gridDepth * 0.08))),
  );
  const xOffset = Math.floor((gridWidth - relief.width) / 2);
  const yOffset = Math.floor(gridHeight * 0.34);
  const zOffset = Math.max(1, Math.floor(gridDepth * 0.18));
  return {
    ...relief,
    cells: relief.cells.map(
      ([x, y, z]) =>
        [x + xOffset, y + yOffset, z + zOffset] as [number, number, number],
    ),
    origin: extracted.origin,
  };
}
