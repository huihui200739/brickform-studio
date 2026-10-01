import type { Raster } from './brick-engine.ts';
import { lab, match } from './material-color-space.ts';

export type ReferenceMaterialRegion = {
  id: number;
  pixels: number;
  color: number;
  lightnessRange: [number, number];
  chromaticityResidual: number;
  inferredIllumination: boolean;
  view?: 'front' | 'side' | 'top';
};
export type ReferenceMaterialDesign = {
  method: 'reference-gradient-regions';
  regions: ReferenceMaterialRegion[];
  normalizedPixels: number;
  warnings: string[];
  alignment?: ReturnType<
    typeof import('./reference-colors.ts').referenceAlignment
  >['evidence'];
  surfaces?: import('./surface-materials.ts').SurfaceMaterialDesign;
  projection?: {
    voteUnit: 'visible-reference-pixel';
    projectedPixels: number;
    observedFaces: number;
    inferredFaces: number;
    materialPixels: number[];
  };
};

/** Region-level design inference, not intrinsic-material recognition. Only
 * spatially continuous radiance with coherent chromaticity is normalized.
 * Abrupt boundaries stay separate; ambiguous gradients keep their raw colors.
 * Paint gradients, reflections and soft boundaries remain intrinsically
 * ambiguous in one photograph and are explicitly reported as such. */
export function referenceMaterials(
  image: Raster,
  mask: Uint8Array,
  normalize: boolean,
) {
  const n = image.width * image.height;
  const labels = new Int32Array(n).fill(-1),
    palette = new Uint8Array(n);
  const lightness = new Float32Array(n),
    chroma = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const c = [image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]];
    palette[i] = match(...(c as [number, number, number]));
    lightness[i] = lab(...(c as [number, number, number]))[0];
    const linear = c.map((v) =>
      v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4,
    );
    const sum = linear.reduce((a, b) => a + b, 0);
    for (let a = 0; a < 3; a++)
      chroma[i * 3 + a] = sum > 1e-5 ? linear[a] / sum : 1 / 3;
  }
  const regions: ReferenceMaterialRegion[] = [];
  let normalizedPixels = 0;
  for (let seed = 0; seed < n; seed++) {
    if (!mask[seed] || labels[seed] >= 0) continue;
    const id = regions.length,
      queue = [seed];
    labels[seed] = id;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head],
        x = i % image.width;
      for (const other of [
        x > 0 ? i - 1 : -1,
        x + 1 < image.width ? i + 1 : -1,
        i - image.width,
        i + image.width,
      ]) {
        if (other < 0 || other >= n || !mask[other] || labels[other] >= 0)
          continue;
        const distance = Math.hypot(
          ...[0, 1, 2].map((a) => chroma[i * 3 + a] - chroma[other * 3 + a]),
        );
        if (Math.abs(lightness[i] - lightness[other]) > 6 || distance > 0.045)
          continue;
        labels[other] = id;
        queue.push(other);
      }
    }
    const ordered = [...queue].sort((a, b) => lightness[a] - lightness[b]);
    const at = (q: number) =>
      ordered[Math.min(ordered.length - 1, Math.floor(q * ordered.length))];
    const range: [number, number] = [lightness[at(0.1)], lightness[at(0.9)]];
    // Discard the brightest specular tail; use a locally observed upper-middle
    // radiance rather than replacing a region with the global dominant hue.
    const sample = ordered.slice(
      Math.floor(ordered.length * 0.6),
      Math.max(
        Math.floor(ordered.length * 0.9),
        Math.floor(ordered.length * 0.6) + 1,
      ),
    );
    const representative = [0, 1, 2].map(
      (a) =>
        sample.reduce((sum, i) => sum + image.data[i * 4 + a], 0) /
        sample.length,
    ) as [number, number, number];
    const center = [0, 1, 2].map(
      (a) =>
        [...queue].map((i) => chroma[i * 3 + a]).sort((a, b) => a - b)[
          Math.floor(queue.length / 2)
        ],
    );
    const residuals = queue
      .map((i) => Math.hypot(...center.map((v, a) => v - chroma[i * 3 + a])))
      .sort((a, b) => a - b);
    const residual = residuals[Math.floor(residuals.length * 0.85)];
    const inferred =
      normalize &&
      queue.length >= 9 &&
      range[1] - range[0] >= 8 &&
      residual <= 0.1;
    const color = match(...representative);
    regions.push({
      id,
      pixels: queue.length,
      color,
      lightnessRange: range,
      chromaticityResidual: residual,
      inferredIllumination: inferred,
    });
    if (inferred)
      for (const i of queue) {
        if (palette[i] !== color) normalizedPixels++;
        palette[i] = color;
      }
  }
  return {
    palette,
    labels,
    design: {
      method: 'reference-gradient-regions' as const,
      regions,
      normalizedPixels,
      warnings: normalize
        ? [
            'Continuous shading is a design inference: soft paint gradients, reflections and ambiguous boundaries cannot be proved to be one material from a single image. Unseen surfaces are separately inferred.',
          ]
        : [],
    },
  };
}
