import type { Raster } from './brick-engine.ts';
import type { ComponentKind } from './semantic-components.ts';
import { referenceMask } from './reference-colors.ts';

export type ImageSemanticDetection = {
  kind: ComponentKind;
  bbox: { x: number; y: number; width: number; height: number };
  mask?: Uint8Array;
  maskSize?: [number, number];
  nicheBox?: { x: number; y: number; width: number; height: number };
  anchorUV: [number, number];
  confidence: number;
  evidence: string[];
  // Colour patches normally describe a canopy/flame, not an entire object.
  // A detector may only claim a base when it actually detects one.
  anchorConfidence: number;
};
export interface SemanticDetector {
  detect(image: Raster): Promise<ImageSemanticDetection[]>;
}

export class ColorSemanticDetector implements SemanticDetector {
  async detect(image: Raster): Promise<ImageSemanticDetection[]> {
    const { width: w, height: h, data } = image,
      foreground = referenceMask(image).mask;
    const labels = new Uint8Array(w * h),
      seen = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) {
      if (!foreground[i]) continue;
      const r = data[i * 4],
        g = data[i * 4 + 1],
        b = data[i * 4 + 2],
        max = Math.max(r, g, b),
        min = Math.min(r, g, b);
      if (r - g <= 10 && g - b >= 12 && max >= 30 && max <= 210) labels[i] = 1;
      else if (
        r >= 170 &&
        g >= 30 &&
        g <= r * 0.68 &&
        b <= 45 &&
        (max - min) / max >= 0.82
      )
        labels[i] = 2;
    }
    // Whole foreground islands can establish an actual bottom silhouette.
    // A colour patch connected to the building cannot make that claim.
    const islandIds = new Int32Array(w * h).fill(-1);
    const islands: {
      x0: number;
      x1: number;
      y0: number;
      y1: number;
      count: number;
    }[] = [];
    for (let start = 0; start < foreground.length; start++) {
      if (!foreground[start] || islandIds[start] >= 0) continue;
      const id = islands.length,
        queue = [start];
      islandIds[start] = id;
      let x0 = w,
        x1 = 0,
        y0 = h,
        y1 = 0;
      for (let at = 0; at < queue.length; at++) {
        const k = queue[at],
          x = k % w,
          y = Math.floor(k / w);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const xx = x + dx,
            yy = y + dy,
            j = yy * w + xx;
          if (
            xx >= 0 &&
            xx < w &&
            yy >= 0 &&
            yy < h &&
            foreground[j] &&
            islandIds[j] < 0
          ) {
            islandIds[j] = id;
            queue.push(j);
          }
        }
      }
      islands.push({ x0, x1, y0, y1, count: queue.length });
    }
    const detections: ImageSemanticDetection[] = [];
    for (let i = 0; i < labels.length; i++) {
      if (!labels[i] || seen[i]) continue;
      const queue = [i];
      seen[i] = 1;
      let x0 = w,
        x1 = 0,
        y0 = h,
        y1 = 0;
      for (let at = 0; at < queue.length; at++) {
        const k = queue[at],
          x = k % w,
          y = Math.floor(k / w);
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
          [2, 0],
          [-2, 0],
          [0, 2],
          [0, -2],
          [1, 1],
          [-1, -1],
          [1, -1],
          [-1, 1],
        ]) {
          const xx = x + dx,
            yy = y + dy,
            j = yy * w + xx;
          if (
            xx >= 0 &&
            xx < w &&
            yy >= 0 &&
            yy < h &&
            !seen[j] &&
            labels[j] === labels[i]
          ) {
            seen[j] = 1;
            queue.push(j);
          }
        }
      }
      if (
        queue.length < Math.max(8, w * h * 0.00008) ||
        queue.length > w * h * 0.15 ||
        x1 <= x0 ||
        y1 <= y0
      )
        continue;
      const density = queue.length / ((x1 - x0 + 1) * (y1 - y0 + 1));
      const island = islands[islandIds[i]];
      const wholeObject =
        island &&
        island.count < w * h * 0.12 &&
        island.count > queue.length * 1.15 &&
        island.count < queue.length * 4 &&
        island.y1 > y1 + 2 &&
        island.y1 < h - 1 &&
        island.x1 - island.x0 < (x1 - x0 + 1) * 1.5;
      if (wholeObject) {
        x0 = island.x0;
        x1 = island.x1;
        y0 = island.y0;
        y1 = island.y1;
      }
      detections.push({
        kind: labels[i] === 1 ? 'tree' : 'brazier',
        bbox: {
          x: x0 / (w - 1),
          y: y0 / (h - 1),
          width: (x1 - x0) / (w - 1),
          height: (y1 - y0) / (h - 1),
        },
        anchorUV: [(x0 + x1) / 2 / (w - 1), y1 / (h - 1)],
        confidence: Math.min(0.9, 0.65 + density * 0.25),
        anchorConfidence: wholeObject ? 0.9 : 0.8,
        evidence: [
          labels[i] === 1
            ? '原图二维绿色/橄榄绿连通区域'
            : '原图二维高饱和橙红色连通区域',
          wholeObject
            ? '独立完整前景轮廓包含下方底座'
            : '颜色区域底部不一定是物体底座；保守保留原几何',
        ],
      });
    }
    // Canopy holes and planter foliage may split a single colour region.
    // Merge only nearby ambiguous tree patches; this never upgrades confidence.
    for (let i = 0; i < detections.length; i++) {
      const a = detections[i];
      if (a.kind !== 'tree' || a.anchorConfidence >= 0.8) continue;
      for (let j = i + 1; j < detections.length; j++) {
        const b = detections[j];
        if (b.kind !== 'tree' || b.anchorConfidence >= 0.8) continue;
        const xgap =
          Math.max(a.bbox.x, b.bbox.x) -
          Math.min(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width);
        const ygap =
          Math.max(a.bbox.y, b.bbox.y) -
          Math.min(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height);
        if (xgap > 0.02 || ygap > 0.05) continue;
        const x = Math.min(a.bbox.x, b.bbox.x),
          y = Math.min(a.bbox.y, b.bbox.y);
        const right = Math.max(
            a.bbox.x + a.bbox.width,
            b.bbox.x + b.bbox.width,
          ),
          bottom = Math.max(a.bbox.y + a.bbox.height, b.bbox.y + b.bbox.height);
        a.bbox = { x, y, width: right - x, height: bottom - y };
        a.anchorUV = [(x + right) / 2, bottom];
        a.confidence = Math.min(a.confidence, b.confidence);
        detections.splice(j--, 1);
      }
    }
    const statue = detectEnclosedSubject(image);
    if (statue) detections.push(statue);
    return detections
      .sort(
        (a, b) =>
          b.confidence - a.confidence ||
          a.bbox.x - b.bbox.x ||
          a.bbox.y - b.bbox.y,
      )
      .slice(0, 64);
  }
}

/** Finds a foreground silhouette only when it is enclosed by a darker recess.
 * This deliberately uses image evidence and a relative search, so it does not
 * assume a temple coordinate or create a subject in open tower/sky scenes. */
function detectEnclosedSubject(image: Raster): ImageSemanticDetection | undefined {
  const { width: w, height: h, data } = image;
  const lum = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    return (data[i] * 3 + data[i + 1] * 4 + data[i + 2]) / 8;
  };
  let global = 0, samples = 0;
  for (let y = 0; y < h; y += 4)
    for (let x = 0; x < w; x += 4) {
      if (data[(y * w + x) * 4 + 3] <= 100) continue;
      global += lum(x, y);
      samples++;
    }
  global /= Math.max(1, samples);
  const dark = new Uint8Array(w * h);
  for (let i = 0; i < dark.length; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    // Alpha-zero RGB and saturated foliage cannot provide cavity evidence.
    if (data[i * 4 + 3] > 100 && lum(i % w, Math.floor(i / w)) < global * 0.55 &&
      Math.max(r, g, b) - Math.min(r, g, b) < 55) dark[i] = 1;
  }
  function components(mask: Uint8Array) {
    const visited = new Uint8Array(mask.length);
    const result: number[][] = [];
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || visited[start]) continue;
      const queue = [start];
      visited[start] = 1;
      for (let at = 0; at < queue.length; at++) {
        const i = queue[at], x = i % w, y = Math.floor(i / w);
        for (const [xx, yy] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
          const next = yy * w + xx;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !mask[next] || visited[next]) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }
      result.push(queue);
    }
    return result;
  }
  let best: ImageSemanticDetection | undefined;
  let bestArea = 0;
  for (const cavity of components(dark)) {
    if (cavity.length < w * h * 0.002) continue;
    const rows = new Map<number, [number, number]>();
    for (const i of cavity) {
      const x = i % w, y = Math.floor(i / w), row = rows.get(y) || [w, -1];
      rows.set(y, [Math.min(row[0], x), Math.max(row[1], x)]);
    }
    const foreground = new Uint8Array(w * h);
    // Keep only bright pixels enclosed by the SAME dark region on both sides.
    // This excludes the wall frame that a sliding contrast window captured.
    for (const [y, [left, right]] of rows)
      for (let x = left + 2; x < right - 1; x++)
        if (data[(y * w + x) * 4 + 3] > 100 && lum(x, y) > global * 0.68)
          foreground[y * w + x] = 1;
    for (const subject of components(foreground)) {
      if (subject.length < w * h * 0.001 || subject.length <= bestArea) continue;
      let minX = w, maxX = 0, minY = h, maxY = 0;
      for (const i of subject) {
        minX = Math.min(minX, i % w); maxX = Math.max(maxX, i % w);
        minY = Math.min(minY, Math.floor(i / w)); maxY = Math.max(maxY, Math.floor(i / w));
      }
      const width = maxX - minX + 1, height = maxY - minY + 1;
      if (height < h * 0.08 || height < width * 1.2 || width < w * 0.025 || subject.length < width * height * 0.2) continue;
      const mask = new Uint8Array(width * height);
      for (const i of subject) mask[(Math.floor(i / w) - minY) * width + i % w - minX] = 1;
      bestArea = subject.length;
      best = {
        kind: 'statue',
        bbox: { x: minX / (w - 1), y: minY / (h - 1), width: (maxX - minX) / (w - 1), height: (maxY - minY) / (h - 1) },
        mask,
        maskSize: [width, height],
        nicheBox: {
          x: Math.min(...[...rows.values()].map(row => row[0])) / (w - 1),
          y: Math.min(...rows.keys()) / (h - 1),
          width: (Math.max(...[...rows.values()].map(row => row[1])) -
            Math.min(...[...rows.values()].map(row => row[0]))) / (w - 1),
          height: (Math.max(...rows.keys()) - Math.min(...rows.keys())) / (h - 1),
        },
        anchorUV: [(minX + maxX) / 2 / (w - 1), maxY / (h - 1)],
        confidence: 0.86,
        anchorConfidence: 0.82,
        evidence: ['暗色凹陷包围的独立直立轮廓', '轮廓两侧均有壁龛背景，已排除窗口边框'],
      };
    }
  }
  return best;
}
