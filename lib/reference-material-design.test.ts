import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type Raster, isOpaquePaletteColor } from './brick-engine.ts';
import { match } from './material-color-space.ts';
import { referenceMaterials } from './reference-materials.ts';
import { isReferenceFoliage, referenceMaterialDesign } from './reference-material-design.ts';

type RGB = [number, number, number];
function raster(width: number, height: number, pixel: (x: number, y: number) => RGB) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    data.set([...pixel(x, y), 255], (y * width + x) * 4);
  return { width, height, data } satisfies Raster;
}
const shade = (color: RGB, scale: number) => color.map((v) => Math.round(v * scale)) as RGB;
const fullMask = (image: Raster) => new Uint8Array(image.width * image.height).fill(1);

void test('abrupt shaded warm SAME-material becomes one stable choice, not dark pixel labels', () => {
  const color: RGB = [215, 186, 140];
  const image = raster(96, 24, (x) => shade(color, [1, 0.5, 0.18, 0.8][Math.floor(x / 24)]));
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  assert.ok(raw.design.regions.length >= 4, 'hard shadow edges are separate raw regions');
  assert.ok(new Set(raw.palette).size > 1, 'the original pipeline has dark palette labels');
  const result = referenceMaterialDesign(image, mask, raw);
  assert.deepEqual([...new Set(result.palette)], [match(...color)]);
  assert.equal(result.design.materials.length, 1);
  assert.ok(result.design.changedPixels > 0);
  assert.ok(result.design.regionAssignments.some((r) => r.reason === 'compatible-shading'));
  assert.equal(result.design.intrinsicMaterialVerified, false);
  assert.equal(result.design.approximate, true);
  assert.equal(result.design.method, 'reference-material-first-design');
});

void test('shaded other colours unify independently; real red, blue and green are negative controls', () => {
  const colors: RGB[] = [[201, 26, 9], [0, 85, 191], [35, 120, 65]];
  const image = raster(216, 24, (x) =>
    shade(colors[Math.floor(x / 72)], [1, 0.55, 0.23][Math.floor(x % 72 / 24)]));
  const result = referenceMaterialDesign(image, fullMask(image));
  for (let i = 0; i < colors.length; i++) {
    const row = result.palette.slice(i * 72, (i + 1) * 72);
    assert.deepEqual([...new Set(row)], [match(...colors[i])]);
  }
  assert.equal(new Set(result.palette).size, 3, 'distinct coloured paint cannot be blanket-unified');
  assert.equal(result.design.materials.length, 3);
  assert.ok(!result.palette.includes(1), 'blue/red/green shadows do not become black parts');
});

void test('warm olive foliage survives next to a shaded warm structure', () => {
  const foliage: RGB = [119, 119, 78], wall: RGB = [215, 186, 140];
  const image = raster(120, 30, (x) =>
    shade(x < 60 ? wall : foliage, x % 60 < 30 ? 1 : 0.4));
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  const result = referenceMaterialDesign(image, mask, raw);
  assert.equal(result.palette[5], match(...wall));
  assert.equal(result.palette[35], result.palette[5]);
  assert.equal(result.palette[65], match(...foliage));
  assert.equal(result.palette[95], raw.palette[95], 'unresolved leaf shading is preserved, not newly sandy');
  assert.notEqual(result.palette[5], result.palette[65]);
  assert.ok(result.design.protectedFoliagePixels > 0);
});

void test('fragmented warm tiny and shadowed leaves preserve their raw palette instead of the wall fallback', () => {
  const leafColors: RGB[] = [[119, 119, 78], [65, 68, 35], [37, 44, 22], [131, 134, 106], [84, 91, 66]];
  const wall: RGB = [215, 186, 140];
  const image = raster(96, 48, (x, y) => {
    if (x === 0 && y === 0) return leafColors[0]; // Masked background is not protected.
    if (x % 8 === 4 && y % 8 === 4)
      return leafColors[(Math.floor(x / 8) + Math.floor(y / 8)) % leafColors.length];
    return shade(wall, x < 48 ? 1 : 0.45);
  });
  const mask = fullMask(image);
  mask.fill(0, 0, image.width * 2);
  const raw = referenceMaterials(image, mask, true);
  const rgbaBefore = image.data.slice(), maskBefore = mask.slice(), rawPaletteBefore = raw.palette.slice();
  const rawLabelsBefore = raw.labels.slice(), rawDesignBefore = JSON.stringify(raw.design);
  const result = referenceMaterialDesign(image, mask, raw);
  const leafPixels: number[] = [];
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || !isReferenceFoliage(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2])) continue;
    leafPixels.push(i);
    assert.equal(raw.design.regions[raw.labels[i]].pixels, 1, 'each leaf fragment lacks a region witness');
    assert.equal(result.palette[i], raw.palette[i], 'the exact pre-existing leaf palette is authoritative');
  }
  assert.equal(leafPixels.length, 72);
  assert.equal(result.design.protectedFoliagePixels, leafPixels.length);
  assert.ok(result.design.pixelOverrides.overriddenPixels > 0, 'fixture exercises actual sandy-default overrides');
  assert.equal(result.design.pixelOverrides.method, 'preserve-raw-reference-foliage-palette');
  assert.ok(result.design.regionAssignments.some((r) => r.hasPixelOverrides && r.color === match(...wall)),
    'metadata discloses the region default is not its guarded per-pixel palette');
  assert.ok(leafPixels.some((i) => raw.palette[i] !== result.fallbackColor));
  assert.equal(result.palette[20 * image.width + 50], match(...wall), 'non-leaf body shadow still normalizes');
  assert.equal(result.palette[0], raw.palette[0], 'masked background remains untouched');
  assert.deepEqual(image.data, rgbaBefore);
  assert.deepEqual(result.rawRGBA, rgbaBefore);
  assert.deepEqual(mask, maskBefore);
  assert.deepEqual(raw.palette, rawPaletteBefore);
  assert.deepEqual(raw.labels, rawLabelsBefore);
  assert.equal(JSON.stringify(raw.design), rawDesignBefore);
});

void test('foliage guard matches the existing channel/value thresholds exactly and excludes brown wood', () => {
  for (const c of [[150, 140, 128], [30, 30, 18], [210, 210, 198], [35, 120, 65]] as RGB[])
    assert.equal(isReferenceFoliage(...c), true);
  for (const c of [[151, 140, 128], [150, 140, 129], [29, 29, 17], [211, 211, 199], [53, 33, 0], [95, 49, 9], [0, 85, 191]] as RGB[])
    assert.equal(isReferenceFoliage(...c), false);
});

void test('weak foliage false-positive stone shadow still resolves to one supported warm material', () => {
  const stone: RGB = [228, 204, 165];
  const image = raster(96, 24, (x) => shade(stone, x < 48 ? 1 : 0.35));
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  assert.equal(isReferenceFoliage(80, 71, 58), true, 'the unchanged weak predicate reproduces the real false positive');
  assert.ok(new Set(raw.palette).size > 1);
  const result = referenceMaterialDesign(image, mask, raw);
  assert.deepEqual([...new Set(result.palette)], [match(...stone)]);
  assert.equal(result.design.protectedFoliagePixels, 0);
  assert.equal(result.design.foliageGuard.candidatePixels, 48 * 24);
  assert.equal(result.design.foliageGuard.anchoredBodyShadowPixels, 48 * 24);
  assert.equal(result.design.foliageGuard.rejectedWeakPixels, 48 * 24);
  assert.equal(result.protectedFoliageMask[60], 0);
});

void test('a local positive leaf witness protects an ambiguous tiny leaf but does not leak into a coherent stone shadow', () => {
  const stone: RGB = [228, 204, 165], weak: RGB = [80, 71, 58];
  const image = raster(48, 24, (x, y) => {
    if (y === 12 && x === 23) return [119, 119, 78];
    if (y === 12 && (x === 22 || x === 8)) return weak;
    return shade(stone, x < 24 ? 1 : 0.35);
  });
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  const rgba = image.data.slice(), oldPalette = raw.palette.slice(), oldMask = mask.slice();
  const result = referenceMaterialDesign(image, mask, raw);
  const at = (x: number) => 12 * image.width + x;
  assert.equal(result.protectedFoliageMask[at(23)], 1, 'positive olive witness');
  assert.equal(result.protectedFoliageMask[at(22)], 1, 'nearby ambiguous leaf borrows only classification support');
  assert.equal(result.palette[at(22)], raw.palette[at(22)], 'old weak-leaf colour preserved, not guessed green');
  assert.equal(result.protectedFoliageMask[at(8)], 0, 'same RGB without positive local support is not licensed foliage');
  assert.equal(result.palette[at(8)], match(...stone));
  assert.equal(result.protectedFoliageMask[at(24)], 0, 'a supported body shadow stays coherent even next to a tree');
  assert.equal(result.palette[at(24)], match(...stone));
  assert.ok(result.design.foliageGuard.rejectedWeakPixels > 0);
  assert.deepEqual(image.data, rgba);
  assert.deepEqual(raw.palette, oldPalette);
  assert.deepEqual(mask, oldMask);
});

void test('different material boundaries and large real grey/black accents survive', () => {
  const paints: RGB[] = [[215, 186, 140], [53, 33, 0], [244, 244, 244], [150, 150, 150], [36, 36, 36]];
  const image = raster(150, 30, (x) => paints[Math.floor(x / 30)]);
  const result = referenceMaterialDesign(image, fullMask(image));
  for (let i = 0; i < paints.length; i++)
    assert.equal(result.palette[i * 30 + 5], match(...paints[i]));
  assert.equal(new Set(result.palette).size, 5);
  assert.equal(result.design.changedPixels, 0);
});

void test('explicit design-domain boundaries keep same-hue dark paint separate', () => {
  const image = raster(80, 24, (x) => shade([215, 186, 140], x < 40 ? 1 : 0.45));
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  assert.equal(raw.design.regions.length, 2);
  const ordinary = referenceMaterialDesign(image, mask, raw);
  assert.equal(ordinary.palette[5], ordinary.palette[45]);
  const separate = referenceMaterialDesign(image, mask, raw, { regionDomainIds: [11, 12] });
  assert.notEqual(separate.palette[5], separate.palette[45]);
  assert.equal(separate.design.materials.length, 2);
});

void test('an unspecified bright witness cannot bridge two declared different domains', () => {
  const image = raster(90, 24, (x) => shade([215, 186, 140], [1, 0.7, 0.4][Math.floor(x / 30)]));
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  const result = referenceMaterialDesign(image, mask, raw, { regionDomainIds: [-1, 11, 12] });
  const assignments = result.design.regionAssignments;
  assert.notEqual(assignments[1].materialId, assignments[2].materialId);
  for (const material of result.design.materials) {
    const known = material.regionIds.map((i) => [-1, 11, 12][i]).filter((i) => i >= 0);
    assert.ok(new Set(known).size <= 1);
  }
});

void test('low-confidence and unobserved regions cannot create random extra or black colours', () => {
  const image = raster(64, 24, (x) => x < 48 ? [215, 186, 140] : [12, 16, 23]);
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  const confidence = raw.design.regions.map((r) => r.id === raw.labels[60] ? 0.2 : 1);
  const result = referenceMaterialDesign(image, mask, raw, { regionConfidence: confidence });
  assert.deepEqual([...new Set(result.palette)], [match(215, 186, 140)]);
  assert.equal(result.design.materials.length, 1);
  assert.equal(result.colorForRegion(-1), result.fallbackColor);
  assert.equal(result.colorForRegion(999), result.fallbackColor);
  assert.equal(result.colorForRegion(0.5), result.fallbackColor);
  assert.equal(result.colorForRegion(NaN), result.fallbackColor);
  assert.equal(result.colorForRegion(raw.labels[60], 0.1), result.fallbackColor);
  assert.ok(result.design.regionAssignments.some((r) => r.reason === 'local-design-fallback'));
});

void test('a tiny unsupported dark pixel borrows its established local material', () => {
  const image = raster(64, 24, (x, y) => x === 32 && y === 12 ? [0, 0, 0] : [215, 186, 140]);
  const result = referenceMaterialDesign(image, fullMask(image));
  assert.equal(result.palette[12 * 64 + 32], result.palette[0]);
  assert.equal(new Set(result.palette).size, 1);
});

void test('continuous neutral SAME-material shading keeps a single observed grey design colour', () => {
  const image = raster(160, 24, (x) => shade([150, 150, 150], 0.4 + 0.6 * x / 159));
  const result = referenceMaterialDesign(image, fullMask(image));
  assert.equal(new Set(result.palette).size, 1);
  assert.equal(result.design.materials.length, 1);
  assert.ok(result.design.changedPixels > 0);
});

void test('a high-residual multicolour region is not painted over with one dominant material', () => {
  const image = raster(200, 20, (x) => [Math.round(230 - 200 * x / 199), 45, Math.round(30 + 200 * x / 199)]);
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  assert.ok(raw.design.regions.some((r) => r.chromaticityResidual > 0.14));
  const result = referenceMaterialDesign(image, mask, raw);
  assert.deepEqual(result.palette, raw.palette);
  assert.ok(new Set(result.palette).size >= 2);
  assert.ok(result.design.regionAssignments.some((r) => r.reason === 'ambiguous-radiance-preserved'));
});

void test('raw RGBA, mask, palette, labels and region metadata are immutable; output is deterministic and detached', () => {
  const image = raster(64, 24, (x) => shade([35, 120, 65], x < 32 ? 1 : 0.3));
  const mask = fullMask(image), raw = referenceMaterials(image, mask, true);
  const rgba = image.data.slice(), maskBefore = mask.slice(), paletteBefore = raw.palette.slice();
  const labelsBefore = raw.labels.slice(), designBefore = JSON.stringify(raw.design);
  const first = referenceMaterialDesign(image, mask, raw), second = referenceMaterialDesign(image, mask, raw);
  assert.deepEqual(first.palette, second.palette);
  assert.deepEqual(first.design, second.design);
  assert.deepEqual(first.rawRGBA, rgba);
  assert.deepEqual(image.data, rgba);
  assert.deepEqual(mask, maskBefore);
  assert.deepEqual(raw.palette, paletteBefore);
  assert.deepEqual(raw.labels, labelsBefore);
  assert.equal(JSON.stringify(raw.design), designBefore);
  assert.notEqual(first.palette, raw.palette);
  assert.notEqual(first.labels, raw.labels);
  first.rawRGBA[0] = 255;
  first.labels[0] = 99;
  first.palette[0] = 0;
  assert.deepEqual(image.data, rgba);
  assert.deepEqual(raw.palette, paletteBefore);
  assert.deepEqual(raw.labels, labelsBefore);
});

void test('with no supported observation, one documented opaque default is used, not unknown black', () => {
  const image = raster(3, 2, () => [0, 0, 0]), mask = fullMask(image);
  const raw = referenceMaterials(image, mask, true);
  const result = referenceMaterialDesign(image, mask, raw, { regionConfidence: [0] });
  assert.equal(result.design.materials.length, 0);
  assert.equal(new Set(result.palette).size, 1);
  assert.equal(result.fallbackColor, match(150, 150, 150));
  assert.equal(result.colorForRegion(-1), result.fallbackColor);
  assert.ok(isOpaquePaletteColor(result.fallbackColor));
});

void test('invalid domain/confidence/fallback metadata is rejected, never silently interpreted as paint', () => {
  const image = raster(16, 16, () => [215, 186, 140]), mask = fullMask(image);
  const raw = referenceMaterials(image, mask, true);
  assert.throws(() => referenceMaterialDesign(image, mask, raw, { regionDomainIds: [] }));
  assert.throws(() => referenceMaterialDesign(image, mask, raw, { regionConfidence: [NaN] }));
  assert.throws(() => referenceMaterialDesign(image, mask, raw, { regionDomainIds: [-2] }));
  assert.throws(() => referenceMaterialDesign(image, mask, raw, { fallbackColor: 14 }));
  assert.throws(() => referenceMaterialDesign(image, new Uint8Array(1), raw));
});
