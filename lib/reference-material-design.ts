import { PALETTE, isOpaquePaletteColor, type Raster } from './brick-engine.ts';
import { colors, lab, match, rgb } from './material-color-space.ts';
import { referenceMaterials } from './reference-materials.ts';

export type ReferenceMaterialFirstOptions = {
  /** One design-domain ID per reference region; -1 is unspecified. Different
   * nonnegative IDs forbid merging. A source material ID is a design constraint,
   * not proof of intrinsic identity, nor permission to erase differently hued paint. */
  regionDomainIds?: ArrayLike<number>;
  /** Optional observation confidence per region, in [0, 1]. At <= .45 a region
   * cannot create a new material: it uses an already chosen design fallback. */
  regionConfidence?: ArrayLike<number>;
  /** Optional opaque PALETTE index for unsupported/unobserved surfaces. Otherwise
   * the largest supported material supplies the default, not an unknown RGB. */
  fallbackColor?: number;
};

export type ReferenceMaterialFirstDesign = {
  method: 'reference-material-first-design';
  intrinsicMaterialVerified: false;
  approximate: true;
  fallbackColor: number;
  changedPixels: number;
  /** Only weak-predicate candidates supported by positive palette/channel,
   * local or region leaf evidence. Their original reference palette survives. */
  protectedFoliagePixels: number;
  foliageGuard: {
    method: 'positive-reference-leaf-witnesses';
    candidatePixels: number;
    positiveWitnessPixels: number;
    rejectedWeakPixels: number;
    anchoredBodyShadowPixels: number;
    nearbyWitnessRadiusPixels: 2;
    minimumRegionWitnessFraction: 0.2;
  };
  pixelOverrides: {
    method: 'preserve-raw-reference-foliage-palette';
    /** Count whose region/default design choice was overridden, not source edits. */
    overriddenPixels: number;
    regionIds: number[];
  };
  materials: {
    id: number;
    color: number;
    regionIds: number[];
    representativeRGB: [number, number, number];
    pixels: number;
    designDomainId: number;
  }[];
  regionAssignments: {
    regionId: number;
    materialId: number;
    color: number;
    /** A region choice is a default, not a uniform pixel claim when this is true. */
    hasPixelOverrides: boolean;
    reason: 'observed-witness' | 'compatible-shading' | 'local-design-fallback' |
      'default-design-fallback' | 'ambiguous-radiance-preserved';
  }[];
  parameters: {
    minimumWitnessPixels: number;
    minimumNeutralAccentPixels: number;
    maximumMaterialWitnesses: 64;
    chromaticityTolerance: 0.065;
    minimumConfidence: 0.45;
  };
  limitations: string[];
};

/** Exactly the existing reference-colors WEAK foliage candidate predicate.
 * Warm stone shadows can also match: it is not the final protection decision,
 * nor semantic or intrinsic recognition. */
export function isReferenceFoliage(r: number, g: number, b: number) {
  const value = Math.max(r, g, b);
  return r - g <= 10 && g - b >= 12 && value >= 30 && value <= 210;
}

type RawMaterials = ReturnType<typeof referenceMaterials>;
type RGB = [number, number, number];
type Appearance = {
  representative: RGB;
  ratio: RGB;
  saturation: number;
  hue: number;
  lightness: number;
  value: number;
  color: number;
};

function appearance(representative: RGB): Appearance {
  const max = Math.max(...representative), min = Math.min(...representative);
  const delta = max - min, sum = representative.reduce((a, b) => a + b, 0);
  const [r, g, b] = representative;
  const hue = delta < 1e-6 ? 0 :
    ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 :
      (r - g) / delta + 4) * 60 + 360) % 360;
  return {
    representative,
    ratio: representative.map((v) => sum > 1e-6 ? v / sum : 1 / 3) as RGB,
    saturation: max > 0 ? delta / max : 0,
    hue,
    lightness: lab(...representative)[0],
    value: max,
    color: match(...representative),
  };
}
const hueDistance = (a: number, b: number) =>
  Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const paletteAppearances = rgb.map((c) => appearance(c as RGB));
// Dynamic palette families, not object names or a universal sand/green index.
const leafPalette = paletteAppearances.map((a) =>
  a.saturation >= 0.15 && a.hue >= 55 && a.hue <= 165);

/** Keep clearly chromatic reference paint chromatic even when the limited brick
 * palette's ordinary Lab match is grey. This is palette design, not recovery of
 * a measured reflectance. No translucent palette colour is inferred from radiance. */
function materialColor(a: Appearance) {
  if (a.saturation < 0.28 || paletteAppearances[a.color].saturation >= 0.2)
    return a.color;
  const p = lab(...a.representative);
  let selected = a.color, best = Infinity;
  for (let i = 0; i < PALETTE.length; i++) {
    const candidate = paletteAppearances[i];
    if (!isOpaquePaletteColor(i) || candidate.saturation < 0.22 ||
      hueDistance(a.hue, candidate.hue) > 50) continue;
    const distance = 0.5 * (p[0] - colors[i][0]) ** 2 +
      (p[1] - colors[i][1]) ** 2 + (p[2] - colors[i][2]) ** 2;
    if (distance < best) { best = distance; selected = i; }
  }
  return selected;
}

/** Optional material-first DESIGN stage for colorFromReference, before projection
 * and brick packing. Supply an 8-bit sRGB RGBA Raster, its actual foreground mask,
 * and the referenceMaterials result, not mesh RGB already shaded/quantized. The raw region
 * labels remain intact; output palette[i] normally shares a chosen region
 * material rather than a new colour per dark pixel. Foliage-classified pixels
 * instead preserve the existing raw reference palette, with explicit overrides.
 *
 * Bright, sufficiently supported region witnesses are fixed first. Compatible
 * channel ratios let abrupt warm/coloured shadows share their witness's palette
 * choice. Vivid different hues, explicit design-domain boundaries, and supported
 * neutral/black accents stay separate. Small/low-confidence dark regions only
 * borrow an existing local/domain/default choice; they cannot introduce black.
 *
 * Outputs are detached, including unchanged rawRGBA. design is new metadata,
 * meant to be attached as rawMaterials.design.materialFirst. colorForRegion(-1)
 * handles unobserved faces without interpreting missing observations as black.
 * This opt-in helper does not alter source-faithful mode or prove intrinsic albedo.
 * Work is O(pixels + regions log regions + regions * 64); at most 64
 * deterministic samples per region.
 */
export function referenceMaterialDesign(
  image: Raster,
  mask: Uint8Array,
  rawMaterials?: RawMaterials,
  options: ReferenceMaterialFirstOptions = {},
) {
  const n = image.width * image.height;
  if (!Number.isSafeInteger(n) || image.width <= 0 || image.height <= 0 ||
    !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
    image.data.length !== n * 4 || mask.length !== n)
    throw Error('Material design requires a valid raster and equally sized foreground mask.');
  const raw = rawMaterials ?? referenceMaterials(image, mask, true);
  const regions = raw.design.regions, count = regions.length;
  if (raw.palette.length !== n || raw.labels.length !== n ||
    regions.some((r, i) => r.id !== i))
    throw Error('Material design requires the original indexed reference regions.');
  if (options.regionDomainIds && options.regionDomainIds.length !== count ||
    options.regionConfidence && options.regionConfidence.length !== count)
    throw Error('Material design metadata must have one entry per reference region.');
  if (options.fallbackColor !== undefined && !isOpaquePaletteColor(options.fallbackColor))
    throw Error('Material design fallback must be an opaque palette index.');
  const domain = Array.from({ length: count }, (_, i) => options.regionDomainIds?.[i] ?? -1);
  const confidence = Array.from({ length: count }, (_, i) => options.regionConfidence?.[i] ?? 1);
  if (domain.some((v) => !Number.isInteger(v) || v < -1) ||
    confidence.some((v) => !Number.isFinite(v) || v < 0 || v > 1))
    throw Error('Material design domain IDs or confidence values are invalid.');

  const rawRGBA = Uint8Array.from(image.data), palette = raw.palette.slice(), labels = raw.labels.slice();
  const sizes = new Uint32Array(count);
  let foreground = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    foreground++;
    const id = labels[i];
    if (id < -1 || id >= count) throw Error('Reference region label is out of range.');
    if (id >= 0) sizes[id]++;
  }
  if (!foreground) throw Error('Material design requires observed foreground pixels.');
  const minimumWitnessPixels = Math.max(9, Math.ceil(foreground * 0.005));
  const minimumNeutralAccentPixels = Math.max(12, Math.ceil(foreground * 0.0125));
  const samples: RGB[][] = Array.from({ length: count }, () => []);
  const seen = new Uint32Array(count);
  const adjacency: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i] < 0) continue;
    const id = labels[i], budget = Math.min(64, sizes[id]);
    if (seen[id] === Math.floor(samples[id].length * sizes[id] / budget))
      samples[id].push([rawRGBA[i * 4], rawRGBA[i * 4 + 1], rawRGBA[i * 4 + 2]]);
    seen[id]++;
    for (const j of [i % image.width + 1 < image.width ? i + 1 : -1, i + image.width]) {
      if (j < 0 || j >= n || !mask[j] || labels[j] < 0 || labels[j] === id) continue;
      const other = labels[j];
      adjacency[id].set(other, (adjacency[id].get(other) ?? 0) + 1);
      adjacency[other].set(id, (adjacency[other].get(id) ?? 0) + 1);
    }
  }
  const appearances = samples.map((sample) => {
    if (!sample.length) return appearance([0, 0, 0]);
    sample.sort((a, b) => a.reduce((s, v) => s + v, 0) - b.reduce((s, v) => s + v, 0));
    // Upper-middle OBSERVED radiance; neither white balance nor an albedo estimate.
    const upper = sample.slice(Math.floor(sample.length * 0.6),
      Math.max(Math.floor(sample.length * 0.85), Math.floor(sample.length * 0.6) + 1));
    return appearance([0, 1, 2].map((a) =>
      upper.reduce((sum, c) => sum + c[a], 0) / upper.length) as RGB);
  });
  const ambiguous = regions.map((r) => r.chromaticityResidual > 0.14);
  const neutralAccent = appearances.map((a, i) =>
    a.saturation <= 0.12 && sizes[i] >= minimumNeutralAccentPixels);
  const compatibleDomain = (a: number, b: number) =>
    domain[a] < 0 || domain[b] < 0 || domain[a] === domain[b];
  const chromaticDistance = (a: number, b: number) =>
    Math.hypot(...appearances[a].ratio.map((v, k) => v - appearances[b].ratio[k]));
  const compatible = (a: number, b: number) => {
    if (!compatibleDomain(a, b)) return false;
    const p = appearances[a], q = appearances[b];
    // A sizeable black/grey paint patch is positive evidence, not an unknown shadow.
    if (neutralAccent[a] || neutralAccent[b])
      return p.saturation <= 0.12 && q.saturation <= 0.12 &&
        p.color === q.color && Math.abs(p.lightness - q.lightness) <= 15;
    if ((p.saturation <= 0.12) !== (q.saturation <= 0.12)) return false;
    return chromaticDistance(a, b) <= 0.065 &&
      (Math.min(p.saturation, q.saturation) < 0.2 || hueDistance(p.hue, q.hue) <= 22);
  };

  const materials: ReferenceMaterialFirstDesign['materials'] = [];
  const rootRegions: number[] = [];
  const assignments = new Int32Array(count).fill(-1);
  const reasons: ReferenceMaterialFirstDesign['regionAssignments'][number]['reason'][] =
    new Array(count).fill('default-design-fallback');
  const trusted = Array.from({ length: count }, (_, i) => i).filter((i) =>
    confidence[i] > 0.45 && !ambiguous[i] && sizes[i] > 0 &&
    (neutralAccent[i] || appearances[i].value >= 35) &&
    (sizes[i] >= minimumWitnessPixels ||
      appearances[i].saturation >= 0.28 && appearances[i].value >= 45 && sizes[i] >= 3));
  // Fixed roots, sorted by observed radiance, never corrected-region donors.
  trusted.sort((a, b) => appearances[b].lightness - appearances[a].lightness ||
    sizes[b] - sizes[a] || a - b);
  for (const i of trusted) {
    let selected = -1, distance = Infinity;
    for (let m = 0; m < materials.length; m++) {
      const root = rootRegions[m];
      const d = chromaticDistance(i, root);
      const materialDomain = materials[m].designDomainId;
      if ((domain[i] < 0 || materialDomain < 0 || domain[i] === materialDomain) &&
        compatible(i, root) && d < distance) { selected = m; distance = d; }
    }
    if (selected < 0 && materials.length < 64) {
      selected = materials.length;
      rootRegions.push(i);
      materials.push({ id: selected, color: materialColor(appearances[i]), regionIds: [],
        representativeRGB: [...appearances[i].representative], pixels: 0,
        designDomainId: domain[i] });
      reasons[i] = 'observed-witness';
    } else if (selected >= 0) reasons[i] = 'compatible-shading';
    if (selected >= 0) {
      assignments[i] = selected;
      materials[selected].regionIds.push(i);
      materials[selected].pixels += sizes[i];
      if (materials[selected].designDomainId < 0 && domain[i] >= 0)
        materials[selected].designDomainId = domain[i];
    }
  }
  const dominantMaterial = materials.reduce((best, m) =>
    best < 0 || m.pixels > materials[best].pixels ? m.id : best, -1);
  // With no supported witness, use one documented neutral design default rather
  // than turning isolated/unknown dark readings into a new material palette.
  const fallbackColor = options.fallbackColor ??
    (dominantMaterial >= 0 ? materials[dominantMaterial].color : match(150, 150, 150));
  const regionColors = new Uint8Array(count).fill(fallbackColor);
  for (let i = 0; i < count; i++) {
    if (assignments[i] >= 0) { regionColors[i] = materials[assignments[i]].color; continue; }
    if (ambiguous[i] && confidence[i] > 0.45 && sizes[i] >= minimumWitnessPixels) {
      reasons[i] = 'ambiguous-radiance-preserved';
      continue;
    }
    // Only established witnesses can donate. A corrected tiny patch never
    // propagates a guessed colour through a chain of unsupported regions.
    let selected = -1, strongest = 0;
    for (const [other, boundary] of adjacency[i]) {
      const m = assignments[other];
      if (m >= 0 && (domain[i] < 0 || materials[m].designDomainId < 0 ||
        domain[i] === materials[m].designDomainId) && boundary > strongest) {
        selected = m; strongest = boundary;
      }
    }
    if (selected < 0 && domain[i] >= 0) {
      for (const m of materials) {
        if (m.designDomainId === domain[i] &&
          (selected < 0 || m.pixels > materials[selected].pixels)) selected = m.id;
      }
    }
    if (selected >= 0) {
      regionColors[i] = materials[selected].color;
      reasons[i] = 'local-design-fallback';
      // No assignment is written here: fallbacks are not new positive evidence.
    }
  }
  // Freeze positive RAW leaf witnesses before any design correction. The old
  // weak predicate also matches [80,71,58] stone shading, so it cannot alone
  // license protection. Green/olive palette evidence or g>=r supports a leaf.
  const candidates = new Uint8Array(n), leafWitnesses = new Uint8Array(n);
  const regionLeafWitnesses = new Uint32Array(count);
  let candidatePixels = 0, positiveWitnessPixels = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i] || labels[i] < 0 ||
      !isReferenceFoliage(rawRGBA[i * 4], rawRGBA[i * 4 + 1], rawRGBA[i * 4 + 2])) continue;
    candidates[i] = 1;
    candidatePixels++;
    if (leafPalette[raw.palette[i]] || rawRGBA[i * 4 + 1] >= rawRGBA[i * 4]) {
      leafWitnesses[i] = 1;
      positiveWitnessPixels++;
      regionLeafWitnesses[labels[i]]++;
    }
  }
  const protectedFoliageMask = new Uint8Array(n);
  let anchoredBodyShadowPixels = 0;
  for (let i = 0; i < n; i++) {
    if (!candidates[i]) continue;
    const id = labels[i], m = assignments[id];
    if (leafWitnesses[i]) { protectedFoliageMask[i] = 1; continue; }
    // A coherent warm shadow with a brighter same-material witness stays
    // material-first, even beside a tree. RGB proximity is not leaf evidence.
    const root = m >= 0 ? appearances[rootRegions[m]].representative : undefined;
    if (reasons[id] === 'compatible-shading' && root &&
      !leafPalette[materials[m].color] && root[0] - root[1] >= 12 && root[1] - root[2] >= 12) {
      anchoredBodyShadowPixels++;
      continue;
    }
    if (regionLeafWitnesses[id] >= Math.max(1, Math.ceil(sizes[id] * 0.2))) {
      protectedFoliageMask[i] = 1;
      continue;
    }
    const x = i % image.width, y = Math.floor(i / image.width);
    for (let dy = -2; dy <= 2 && !protectedFoliageMask[i]; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const px = x + dx, py = y + dy;
        if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
        const j = py * image.width + px;
        if (leafWitnesses[j] && compatibleDomain(id, labels[j])) {
          protectedFoliageMask[i] = 1;
          break;
        }
      }
    }
  }
  let changedPixels = 0, protectedFoliagePixels = 0, overriddenFoliagePixels = 0;
  const overriddenRegions = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const id = labels[i];
    let color = id >= 0 && reasons[id] === 'ambiguous-radiance-preserved'
      ? raw.palette[i] : id >= 0 ? regionColors[id] : fallbackColor;
    // Fragmented warm/desaturated leaves often lack a large region witness.
    // Missing support must never turn them into the wall's fallback material.
    // Preserve the PRE-existing reference palette, including any unresolved
    // leaf shading; do not claim this guard recovers a uniform green albedo.
    if (protectedFoliageMask[i]) {
      protectedFoliagePixels++;
      if (color !== raw.palette[i]) {
        overriddenFoliagePixels++;
        overriddenRegions.add(id);
      }
      color = raw.palette[i];
    }
    if (palette[i] !== color) changedPixels++;
    palette[i] = color;
  }
  const design: ReferenceMaterialFirstDesign = {
    method: 'reference-material-first-design', intrinsicMaterialVerified: false,
    approximate: true, fallbackColor, changedPixels, protectedFoliagePixels,
    foliageGuard: { method: 'positive-reference-leaf-witnesses', candidatePixels,
      positiveWitnessPixels, rejectedWeakPixels: candidatePixels - protectedFoliagePixels,
      anchoredBodyShadowPixels, nearbyWitnessRadiusPixels: 2, minimumRegionWitnessFraction: 0.2 },
    pixelOverrides: { method: 'preserve-raw-reference-foliage-palette',
      overriddenPixels: overriddenFoliagePixels, regionIds: [...overriddenRegions] },
    materials,
    regionAssignments: regions.map((r) => ({ regionId: r.id, materialId: assignments[r.id],
      color: regionColors[r.id], hasPixelOverrides: overriddenRegions.has(r.id), reason: reasons[r.id] })),
    parameters: { minimumWitnessPixels, minimumNeutralAccentPixels,
      maximumMaterialWitnesses: 64, chromaticityTolerance: 0.065, minimumConfidence: 0.45 },
    limitations: [
      'Opt-in approximate palette DESIGN, not intrinsic-albedo recognition. Compatible channel ratios may also describe differently painted materials; supply design-domain boundaries when known.',
      'Upper-middle reference radiance is an observed colour witness, not illumination calibration. Coloured lighting, specular reflections and a wholly shadowed material can remain ambiguous.',
      'Large supported neutral/black accents and distinct hues are retained. Unreliable or unobserved regions use an existing local/domain/default choice, not invented black or random colours.',
      'High-residual multicolour regions retain their source radiance palette. Witnesses are capped at 64 and sampling is deterministic; tiny unsupported non-foliage marks can be omitted.',
      'Only evidence-supported foliage candidates preserve their raw reference palette: green/olive palette or green>=red witnesses, a 20% region witness fraction, or a frozen witness within two pixels. Coherent nonleaf warm-shadow anchors reject weak-only matches. These approximate guards may miss isolated ambiguous leaves or retain unresolved leaf shadows; region choices are defaults with disclosed pixel overrides, not uniform albedo claims.',
    ],
  };
  return {
    palette, labels, design, fallbackColor, rawRGBA,
    /** Optional material-first feature mask; the original weak predicate remains
     * available separately for unchanged source-faithful feature classification. */
    protectedFoliageMask,
    /** Unknown IDs and low-confidence observations use a stable DESIGN choice. */
    colorForRegion(regionId: number, observationConfidence = 1): number {
      if (!Number.isInteger(regionId) || regionId < 0 || regionId >= count ||
        !Number.isFinite(observationConfidence) || observationConfidence <= 0.45)
        return fallbackColor;
      return regionColors[regionId];
    },
  };
}
