import type { Raster } from '../../lib/brick-engine.ts';
import type { ContourSample } from './mesh-contours.ts';

const MAX_SIDE = 320,
  MAX_DISTANCE = 8,
  MIN_DIRECTION_DOT = Math.cos(Math.PI / 6);

export type ImageContourSummary = {
  inputSize: [number, number];
  analysisSize: [number, number];
  scale: [number, number];
  persistentEdgePixels: number;
  retainedChains: number;
  persistentComponents: number;
  rejectedShortChains: number;
  rejectedIncoherentChains: number;
  sampleCount: number;
  contrastSpan: number;
  minChainLength: number;
  semanticBoundaryTruth: false;
};
export type ContourMatch = {
  geometryIndex: number;
  imageIndex: number | null;
  geometryGroup: number;
  imageGroup: number | null;
  distance: number;
  directionDot: number;
  orientationPenalty: number;
  residual: number;
  matched: boolean;
  weight: number;
};
export type ContourGroupScore = {
  group: number;
  totalWeight: number;
  matchedWeight: number;
  coverage: number;
  residual: number;
  matchedImageGroups: number[];
  matchedImageComponents: number[];
};

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  values.sort((a, b) => a - b);
  return values[
    Math.min(values.length - 1, Math.floor((values.length - 1) * p))
  ];
}

function blur(input: Float64Array, w: number, h: number, sigma: number) {
  const radius = Math.ceil(sigma * 3),
    kernel: number[] = [];
  let total = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-i * i) / (2 * sigma * sigma));
    kernel.push(v);
    total += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= total;
  const temp = new Float64Array(input.length),
    output = new Float64Array(input.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++)
        value +=
          input[y * w + Math.max(0, Math.min(w - 1, x + k))] *
          kernel[k + radius];
      temp[y * w + x] = value;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let value = 0;
      for (let k = -radius; k <= radius; k++)
        value +=
          temp[Math.max(0, Math.min(h - 1, y + k)) * w + x] *
          kernel[k + radius];
      output[y * w + x] = value;
    }
  return output;
}

function sobel(input: Float64Array, w: number, h: number) {
  const gx = new Float64Array(input.length),
    gy = new Float64Array(input.length),
    magnitude = new Float64Array(input.length);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      gx[p] =
        (-input[p - w - 1] +
          input[p - w + 1] -
          2 * input[p - 1] +
          2 * input[p + 1] -
          input[p + w - 1] +
          input[p + w + 1]) /
        8;
      gy[p] =
        (-input[p - w - 1] -
          2 * input[p - w] -
          input[p - w + 1] +
          input[p + w - 1] +
          2 * input[p + w] +
          input[p + w + 1]) /
        8;
      magnitude[p] = Math.hypot(gx[p], gy[p]);
    }
  return { gx, gy, magnitude };
}

/** Two-scale grayscale line observations, not material/paint/semantic boundaries.
 * Without foregroundMask only the supplied alpha defines the object interior. */
export function extractImageContours(
  image: Raster,
  foregroundMask?: Uint8Array,
): { samples: ContourSample[]; summary: ImageContourSummary } {
  const { width, height } = image;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width * height > 16_777_216 ||
    image.data.length !== width * height * 4
  )
    throw Error('Invalid contour raster dimensions.');
  if (
    foregroundMask !== undefined &&
    (!(foregroundMask instanceof Uint8Array) ||
      foregroundMask.length !== width * height)
  )
    throw Error(
      'Foreground mask must contain one byte per original image pixel.',
    );
  const factor = Math.min(1, MAX_SIDE / Math.max(width, height)),
    w = Math.max(2, Math.round(width * factor)),
    h = Math.max(2, Math.round(height * factor)),
    sx = width / w,
    sy = height / h,
    gray = new Float64Array(w * h),
    opaque = new Uint8Array(w * h);
  // Sample without modifying or replacing the original RGBA evidence.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const ox = Math.max(0, Math.min(width - 1, (x + 0.5) * sx - 0.5)),
        oy = Math.max(0, Math.min(height - 1, (y + 0.5) * sy - 0.5)),
        x0 = Math.floor(ox),
        y0 = Math.floor(oy),
        x1 = Math.min(width - 1, x0 + 1),
        y1 = Math.min(height - 1, y0 + 1),
        fx = ox - x0,
        fy = oy - y0;
      let luminance = 0,
        alpha = 0,
        foreground = true;
      for (const [xx, yy, weight] of [
        [x0, y0, (1 - fx) * (1 - fy)],
        [x1, y0, fx * (1 - fy)],
        [x0, y1, (1 - fx) * fy],
        [x1, y1, fx * fy],
      ]) {
        const i = (yy * width + xx) * 4;
        for (let channel = 0; channel < 4; channel++)
          if (
            !Number.isFinite(image.data[i + channel]) ||
            image.data[i + channel] < 0 ||
            image.data[i + channel] > 255
          )
            throw Error('Invalid contour raster pixels.');
        luminance +=
          (weight *
            (0.2126 * image.data[i] +
              0.7152 * image.data[i + 1] +
              0.0722 * image.data[i + 2])) /
          255;
        alpha += weight * image.data[i + 3];
        if (weight > 0 && foregroundMask && !foregroundMask[yy * width + xx])
          foreground = false;
      }
      gray[y * w + x] = luminance;
      opaque[y * w + x] = Number(alpha >= 100 && foreground);
    }
  const interior = new Uint8Array(w * h),
    values: number[] = [];
  // A contour must be at least three analysis pixels inside the supplied alpha mask.
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++) {
      let valid = true;
      for (let yy = y - 3; yy <= y + 3 && valid; yy++)
        for (let xx = x - 3; xx <= x + 3; xx++)
          if (!opaque[yy * w + xx]) {
            valid = false;
            break;
          }
      if (valid) {
        interior[y * w + x] = 1;
        values.push(gray[y * w + x]);
      }
    }
  let low = percentile(values.slice(), 0.02),
    high = percentile(values.slice(), 0.98);
  // Sparse long lines can occupy less than 2%; use extrema only in that case.
  if (high - low < 0.025 && values.length) {
    low = values.reduce((a, b) => Math.min(a, b), Infinity);
    high = values.reduce((a, b) => Math.max(a, b), -Infinity);
  }
  const contrastSpan = high - low,
    minChainLength = Math.max(12, 0.05 * Math.max(w, h));
  const summary: ImageContourSummary = {
    inputSize: [width, height],
    analysisSize: [w, h],
    scale: [sx, sy],
    persistentEdgePixels: 0,
    retainedChains: 0,
    persistentComponents: 0,
    rejectedShortChains: 0,
    rejectedIncoherentChains: 0,
    sampleCount: 0,
    contrastSpan,
    minChainLength,
    semanticBoundaryTruth: false,
  };
  if (contrastSpan < 0.045) return { samples: [], summary };
  for (let i = 0; i < gray.length; i++)
    gray[i] = (gray[i] - low) / contrastSpan;
  const fine = sobel(blur(gray, w, h, 0.75), w, h),
    coarse = sobel(blur(gray, w, h, 1.6), w, h),
    active: number[] = [];
  for (let p = 0; p < gray.length; p++)
    if (interior[p] && fine.magnitude[p] > 0.01) active.push(fine.magnitude[p]);
  const strong = Math.max(0.025, percentile(active, 0.85) * 0.35),
    weak = strong * 0.55,
    candidates = new Uint8Array(w * h),
    bins = new Uint8Array(w * h);
  for (let y = 3; y < h - 3; y++)
    for (let x = 3; x < w - 3; x++) {
      const p = y * w + x,
        m = fine.magnitude[p],
        cm = coarse.magnitude[p];
      if (!interior[p] || m < weak || cm < Math.max(0.008, strong * 0.2))
        continue;
      const dot = Math.abs(
        (fine.gx[p] * coarse.gx[p] + fine.gy[p] * coarse.gy[p]) / (m * cm),
      );
      if (dot < 0.8) continue;
      const angle = (Math.atan2(fine.gy[p], fine.gx[p]) + Math.PI) % Math.PI,
        bin = Math.round(angle / (Math.PI / 4)) % 4,
        offset = [1, w + 1, w, w - 1][bin];
      // Break ties consistently so plateaus do not form two-pixel-wide branches.
      if (
        !(
          m > fine.magnitude[p - offset] + 1e-12 &&
          m >= fine.magnitude[p + offset] - 1e-12
        )
      )
        continue;
      candidates[p] = 1;
      bins[p] = bin;
      summary.persistentEdgePixels++;
    }
  // Preserve complete connected evidence before splitting directions at corners.
  // Several directional sides of the same frame are one source component.
  const components = new Int32Array(w * h).fill(-1);
  for (let start = 0; start < candidates.length; start++) {
    if (!candidates[start] || components[start] >= 0) continue;
    const component = summary.persistentComponents++,
      queue = [start];
    components[start] = component;
    for (let head = 0; head < queue.length; head++) {
      const p = queue[head],
        x = p % w,
        y = Math.floor(p / w);
      for (let yy = y - 1; yy <= y + 1; yy++)
        for (let xx = x - 1; xx <= x + 1; xx++) {
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const next = yy * w + xx;
          if (candidates[next] && components[next] < 0) {
            components[next] = component;
            queue.push(next);
          }
        }
    }
  }
  const visited = new Uint8Array(w * h),
    samples: ContourSample[] = [];
  for (let start = 0; start < candidates.length; start++) {
    if (!candidates[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let head = 0,
      minX = w,
      maxX = 0,
      minY = h,
      maxY = 0,
      hasStrong = false,
      tx = 0,
      ty = 0;
    while (head < queue.length) {
      const p = queue[head++],
        x = p % w,
        y = Math.floor(p / w),
        m = fine.magnitude[p];
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      hasStrong ||= m >= strong;
      // Double-angle coherence is invariant to tangent sign, including near vertical lines.
      const dx = -fine.gy[p] / m,
        dy = fine.gx[p] / m;
      tx += dx * dx - dy * dy;
      ty += 2 * dx * dy;
      for (let yy = y - 1; yy <= y + 1; yy++)
        for (let xx = x - 1; xx <= x + 1; xx++) {
          if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
          const next = yy * w + xx;
          // Split corners into edge chains instead of treating a full object/loop as one line.
          if (
            !visited[next] &&
            candidates[next] &&
            bins[next] === bins[start]
          ) {
            visited[next] = 1;
            queue.push(next);
          }
        }
    }
    const extent = Math.hypot(maxX - minX, maxY - minY);
    if (
      !hasStrong ||
      queue.length < minChainLength ||
      extent < minChainLength
    ) {
      summary.rejectedShortChains++;
      continue;
    }
    const coherence = Math.hypot(tx, ty) / queue.length;
    if (coherence < 0.8) {
      summary.rejectedIncoherentChains++;
      continue;
    }
    const group = summary.retainedChains++;
    // Deterministic 2-pixel thinning within a connected directional chain.
    queue.sort((a, b) => a - b);
    const occupied = new Set<string>();
    for (const p of queue) {
      const x = p % w,
        y = Math.floor(p / w),
        cell = Math.floor(x / 2) + ',' + Math.floor(y / 2);
      if (occupied.has(cell)) continue;
      occupied.add(cell);
      const dx = -fine.gy[p] * sx,
        dy = fine.gx[p] * sy,
        length = Math.hypot(dx, dy);
      samples.push({
        x: (x + 0.5) * sx - 0.5,
        y: (y + 0.5) * sy - 0.5,
        tx: dx / length,
        ty: dy / length,
        weight: Math.min(1, fine.magnitude[p] / strong) * coherence,
        group,
        component: components[p],
      });
    }
  }
  summary.sampleCount = samples.length;
  return { samples, summary };
}

function validSample(sample: ContourSample) {
  return (
    [
      sample.x,
      sample.y,
      sample.tx,
      sample.ty,
      sample.weight,
      sample.group,
    ].every(Number.isFinite) &&
    sample.weight > 0 &&
    Math.hypot(sample.tx, sample.ty) > 1e-12
  );
}

/**
 * Directed geometry-to-image residual. Unmatched samples retain the full penalty.
 * Inspect independent geometric AND image chains; even several shadow/paint/mortar
 * chains do not certify a camera without held-out geometric evidence.
 */
export function scoreContourCorrespondence(
  geometry: ContourSample[],
  image: ContourSample[],
  omittedGroup?: number,
): {
  residual: number;
  coverage: number;
  matchedWeight: number;
  groups: ContourGroupScore[];
  matches: ContourMatch[];
} {
  const grid = new Map<string, number[]>();
  for (let i = 0; i < image.length; i++)
    if (validSample(image[i])) {
      const key =
          Math.floor(image[i].x / MAX_DISTANCE) +
          ',' +
          Math.floor(image[i].y / MAX_DISTANCE),
        bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
  const accumulated = new Map<
      number,
      {
        weight: number;
        matched: number;
        cost: number;
        imageGroups: Set<number>;
        imageComponents: Set<number>;
      }
    >(),
    matches: ContourMatch[] = [];
  let totalWeight = 0,
    matchedWeight = 0,
    residualWeight = 0;
  for (let i = 0; i < geometry.length; i++) {
    const g = geometry[i];
    if (!validSample(g) || g.group === omittedGroup) continue;
    const gx = Math.floor(g.x / MAX_DISTANCE),
      gy = Math.floor(g.y / MAX_DISTANCE),
      gl = Math.hypot(g.tx, g.ty);
    let best = -1,
      distance = MAX_DISTANCE,
      directionDot = 0,
      cost = 1;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        for (const index of grid.get(gx + dx + ',' + (gy + dy)) ?? []) {
          const source = image[index],
            d = Math.hypot(g.x - source.x, g.y - source.y);
          if (d > MAX_DISTANCE) continue;
          const dot = Math.min(
              1,
              Math.abs(
                (g.tx * source.tx + g.ty * source.ty) /
                  (gl * Math.hypot(source.tx, source.ty)),
              ),
            ),
            candidateCost = Math.min(1, d / MAX_DISTANCE + 0.5 * (1 - dot));
          if (candidateCost < cost || (best < 0 && candidateCost === cost)) {
            best = index;
            distance = d;
            directionDot = dot;
            cost = candidateCost;
          }
        }
      }
    const matched = best >= 0 && directionDot >= MIN_DIRECTION_DOT,
      group = accumulated.get(g.group) ?? {
        weight: 0,
        matched: 0,
        cost: 0,
        imageGroups: new Set<number>(),
        imageComponents: new Set<number>(),
      };
    totalWeight += g.weight;
    residualWeight += g.weight * cost;
    group.weight += g.weight;
    group.cost += g.weight * cost;
    if (matched) {
      matchedWeight += g.weight;
      group.matched += g.weight;
      group.imageGroups.add(image[best].group);
      group.imageComponents.add(image[best].component ?? image[best].group);
    }
    accumulated.set(g.group, group);
    matches.push({
      geometryIndex: i,
      imageIndex: best < 0 ? null : best,
      geometryGroup: g.group,
      imageGroup: best < 0 ? null : image[best].group,
      distance,
      directionDot,
      orientationPenalty: 0.5 * (1 - directionDot),
      residual: cost,
      matched,
      weight: g.weight,
    });
  }
  return {
    residual: totalWeight ? residualWeight / totalWeight : 1,
    coverage: totalWeight ? matchedWeight / totalWeight : 0,
    matchedWeight,
    groups: Array.from(accumulated, ([group, value]) => ({
      group,
      totalWeight: value.weight,
      matchedWeight: value.matched,
      coverage: value.matched / value.weight,
      residual: value.cost / value.weight,
      matchedImageGroups: Array.from(value.imageGroups).sort((a, b) => a - b),
      matchedImageComponents: Array.from(value.imageComponents).sort(
        (a, b) => a - b,
      ),
    })).sort((a, b) => a.group - b.group),
    matches,
  };
}
