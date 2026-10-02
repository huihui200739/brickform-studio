import type { Raster } from './brick-engine.ts';
import { colors, lab, match } from './material-color-space.ts';

export type ReferenceMaterialRegion = {
  id: number;
  pixels: number;
  color: number;
  lightnessRange: [number, number];
  chromaticityResidual: number;
  inferredIllumination: boolean;
  quantization?: {
    method: 'chromatic-near-tie-with-region-witness';
    originalColor: number;
    representative: [number, number, number];
    originalDistance: number;
    selectedDistance: number;
    hueDifference: number;
    witnessRegionIds: number[];
    maximumWitnessDeltaE: 4;
    minimumWitnessPixels: number;
    inference: true;
  };
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
    visibilityMethod?: 'perspective-depth-tested-surfaces';
    pixelObservedFaces?: number;
    centroidObservedFaces?: number;
    occludedCentroids?: number;
    depthTolerance?: number;
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
  const representatives: [number, number, number][] = [];
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
    representatives.push(representative);
    regions.push({
      id,
      pixels: queue.length,
      color,
      lightnessRange: range,
      chromaticityResidual: residual,
      inferredIllumination: inferred,
    });
  }
  if (normalize) {
    const prototypes = representatives.map((value, id) => ({
      id,
      representative: value,
      lab: lab(...value),
      color: regions[id].color,
    }));
    const chroma = (p: number[]) => Math.hypot(p[1], p[2]);
    const hueDifference = (p: number[], c: number[]) =>
      (Math.acos(
        Math.max(
          -1,
          Math.min(
            1,
            Math.cos(Math.atan2(p[2], p[1]) - Math.atan2(c[2], c[1])),
          ),
        ),
      ) *
        180) /
      Math.PI;
    const minimumWitnessPixels = Math.max(
      64,
      mask.reduce((n, v) => n + Number(!!v), 0) * 0.01,
    );
    // Freeze witnesses before resolving near ties. Corrections never become
    // donors, and similar RGB alone cannot establish an intrinsic material.
    const witnesses = prototypes.filter(
      (p) =>
        regions[p.id].inferredIllumination &&
        regions[p.id].pixels >= minimumWitnessPixels &&
        chroma(p.lab) >= 25 &&
        chroma(colors[p.color]) >= 20 &&
        hueDifference(p.lab, colors[p.color]) <= 30,
    );
    for (const p of prototypes) {
      if (
        !regions[p.id].inferredIllumination ||
        chroma(p.lab) < 25 ||
        chroma(colors[p.color]) >= 5
      )
        continue;
      const distance = (c: number[]) =>
        Math.hypot(
          Math.sqrt(0.5) * (p.lab[0] - c[0]),
          p.lab[1] - c[1],
          p.lab[2] - c[2],
        );
      const originalDistance = distance(colors[p.color]);
      const candidates = colors
        .map((c, color) => ({
          color,
          distance: distance(c),
          hueDifference: hueDifference(p.lab, c),
          witnesses: witnesses.filter(
            (w) =>
              w.color === color &&
              Math.hypot(...p.lab.map((v, a) => v - w.lab[a])) <= 4,
          ),
        }))
        .filter(
          (c) =>
            chroma(colors[c.color]) >= 20 &&
            c.hueDifference <= 30 &&
            c.distance <= originalDistance + 3 &&
            c.witnesses.length > 0,
        )
        .sort((a, b) => a.distance - b.distance || a.color - b.color);
      const selected = candidates[0];
      if (!selected) continue;
      regions[p.id].color = selected.color;
      regions[p.id].quantization = {
        method: 'chromatic-near-tie-with-region-witness',
        originalColor: p.color,
        representative: p.representative,
        originalDistance,
        selectedDistance: selected.distance,
        hueDifference: selected.hueDifference,
        witnessRegionIds: selected.witnesses.map((w) => w.id),
        maximumWitnessDeltaE: 4,
        minimumWitnessPixels,
        inference: true,
      };
    }
    for (let i = 0; i < n; i++) {
      if (!mask[i]) continue;
      const region = regions[labels[i]];
      if (!region.inferredIllumination) continue;
      if (palette[i] !== region.color) normalizedPixels++;
      palette[i] = region.color;
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
