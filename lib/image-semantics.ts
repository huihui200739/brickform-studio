import type { Raster } from './brick-engine.ts';
import type { ComponentKind } from './semantic-components.ts';
import { referenceMask } from './reference-colors.ts';

export type ImageSemanticDetection = {
  kind: ComponentKind;
  bbox: { x: number; y: number; width: number; height: number };
  mask?: Uint8Array;
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
