import type { Raster } from './brick-engine.ts';
import type { ComponentKind } from './semantic-components.ts';
import { referenceMask } from './reference-colors.ts';

export type ImageSemanticDetection = {
  kind: ComponentKind;
  bbox: { x: number; y: number; width: number; height: number };
  mask?: Uint8Array;
  maskSize?: [number, number];
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
  let global = 0;
  for (let y = 0; y < h; y += 4) for (let x = 0; x < w; x += 4) global += lum(x, y);
  global /= Math.max(1, Math.ceil(w / 4) * Math.ceil(h / 4));
  let best: ImageSemanticDetection | undefined;
  for (let gy = 0.12; gy <= 0.48; gy += 0.04)
    for (let gx = 0.22; gx <= 0.62; gx += 0.04) {
      const x0 = Math.floor(gx * w), y0 = Math.floor(gy * h);
      const rw = Math.max(8, Math.floor(w * 0.16)), rh = Math.max(12, Math.floor(h * 0.25));
      const x1 = Math.min(w - 2, x0 + rw), y1 = Math.min(h - 2, y0 + rh);
      let inside = 0, border = 0, nInside = 0, nBorder = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const v = lum(x, y);
        if (x - x0 < 2 || y - y0 < 2 || x1 - x < 3 || y1 - y < 3) { border += v; nBorder++; }
        else { inside += v; nInside++; }
      }
      const dark = inside / Math.max(1, nInside), rim = border / Math.max(1, nBorder);
      if (dark > global * 0.82 || rim < dark * 1.12) continue;
      const mask = new Uint8Array((x1 - x0) * (y1 - y0));
      let count = 0, minX = x1, minY = y1, maxX = x0, maxY = y0;
      for (let y = y0 + 2; y < y1 - 2; y++) for (let x = x0 + 2; x < x1 - 2; x++) {
        if (lum(x, y) < dark + Math.max(12, (rim - dark) * 0.28)) continue;
        const k = (y - y0) * (x1 - x0) + (x - x0); mask[k] = 1; count++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      const area = (maxX - minX + 1) * (maxY - minY + 1);
      if (count < w * h * 0.0008 || area < w * h * 0.003 || maxY - minY < h * 0.05) continue;
      const confidence = Math.min(0.86, 0.52 + (rim - dark) / 180 + Math.min(0.2, count / Math.max(1, area) * 0.2));
      const candidate: ImageSemanticDetection = {
        kind: 'statue',
        bbox: { x: minX / (w - 1), y: minY / (h - 1), width: (maxX - minX) / (w - 1), height: (maxY - minY) / (h - 1) },
        mask,
        maskSize: [x1 - x0, y1 - y0],
        anchorUV: [(minX + maxX) / 2 / (w - 1), maxY / (h - 1)],
        confidence,
        anchorConfidence: Math.min(0.82, confidence),
        evidence: ['暗色凹陷包围的前景轮廓', '轮廓与壁龛背景存在明暗分离'],
      };
      if (!best || candidate.confidence > best.confidence) best = candidate;
    }
  return best;
}
