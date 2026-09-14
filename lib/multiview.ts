import {
  finishModel,
  nearestColor,
  PALETTE,
  validateModel,
  type Model,
  type Raster,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { referenceMask } from './reference-colors.ts';

// Silhouette carving. Every voxel must fall inside the outline of every view it
// has, so the volume is the intersection of the outlines: no generative guess,
// no camera fitting, and a doorway that is open in any view is carved open.
export type ViewAxis = 'front' | 'side' | 'top';
export const VIEW_LABELS: Record<ViewAxis, string> = {
  front: '正视',
  side: '侧视',
  top: '俯视',
};
export type MultiView = {
  axis: ViewAxis;
  image: Raster;
  // Mirrored pictures (a left-side view, or a plan drawn the other way round)
  // are flipped horizontally before they are intersected.
  mirrored?: boolean;
};
type Silhouette = {
  axis: ViewAxis;
  image: Raster;
  mask: Uint8Array;
  // Pixels whose four neighbours are inside as well: colour sampling uses this
  // so an anti-aliased edge blended with the background never colours a brick.
  core: Uint8Array;
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  mirrored: boolean;
};
export function outline(view: MultiView): Silhouette {
  const { mask: raw } = referenceMask(view.image),
    { width, height } = view.image;
  // Keep the largest connected body only: a drop shadow, a watermark or a
  // screenshot's own toolbar must not become part of the object.
  const mask = largestBody(raw, width, height);
  let left = width,
    right = 0,
    top = height,
    bottom = 0;
  for (let i = 0; i < mask.length; i++)
    if (mask[i]) {
      const x = i % width,
        y = Math.floor(i / width);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  const core = new Uint8Array(mask.length);
  let coreCount = 0;
  const inside = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] === 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      // Two pixels in, because anti-aliasing blends roughly that far.
      let clear = true;
      for (let dy = -2; dy <= 2 && clear; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (!inside(x + dx, y + dy)) {
            clear = false;
            break;
          }
      if (clear) {
        core[y * width + x] = 1;
        coreCount++;
      }
    }
  return {
    axis: view.axis,
    image: view.image,
    mask,
    core: coreCount ? core : mask,
    width,
    height,
    left,
    right,
    top,
    bottom,
    mirrored: !!view.mirrored,
  };
}
function largestBody(raw: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(raw.length),
    keep = new Uint8Array(raw.length);
  let best: number[] = [];
  for (let start = 0; start < raw.length; start++) {
    if (!raw[start] || seen[start]) continue;
    seen[start] = 1;
    const queue = [start],
      body: number[] = [];
    while (queue.length) {
      const i = queue.pop()!;
      body.push(i);
      const x = i % width,
        y = Math.floor(i / width);
      for (const next of [
        x > 0 ? i - 1 : -1,
        x < width - 1 ? i + 1 : -1,
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ]) {
        if (next < 0 || seen[next] || !raw[next]) continue;
        seen[next] = 1;
        queue.push(next);
      }
    }
    if (body.length > best.length) best = body;
  }
  for (const i of best) keep[i] = 1;
  return keep;
}
const size = (s: Silhouette) => ({
  x: s.right - s.left + 1,
  y: s.bottom - s.top + 1,
});
export function carveMultiView(
  views: MultiView[],
  resolution = 36,
  name = '三视图积木',
): Model {
  if (![20, 28, 36, 48].includes(resolution))
    throw Error('三视图只支持 20 / 28 / 36 / 48 凸点尺寸。');
  const axes = new Set<ViewAxis>();
  for (const view of views) {
    if (axes.has(view.axis))
      throw Error(`${VIEW_LABELS[view.axis]}只能上传一张图片。`);
    axes.add(view.axis);
  }
  if (views.length < 2)
    throw Error(
      '请至少上传正视图和侧视图：一个方向的轮廓无法确定体积。俯视图可以进一步挖出平面空缺。',
    );
  const shaped = views.map((view) => outline(view)),
    byAxis = new Map(shaped.map((s) => [s.axis, s] as const));
  // One shared scale. Height is the unit; the front view gives width, the side
  // view depth, and the plan view reconciles the two.
  const front = byAxis.get('front'),
    side = byAxis.get('side'),
    top = byAxis.get('top');
  let width = front ? size(front).x / size(front).y : NaN,
    depth = side ? size(side).x / size(side).y : NaN;
  if (top) {
    const ratio = size(top).x / size(top).y;
    if (!Number.isFinite(width) && !Number.isFinite(depth)) {
      width = ratio;
      depth = 1;
    } else if (!Number.isFinite(width)) width = depth * ratio;
    else depth = width / ratio;
  }
  if (front && side && top) {
    const fromViews =
        size(front).x / size(front).y / (size(side).x / size(side).y),
      fromPlan = size(top).x / size(top).y,
      mismatch =
        Math.abs(fromViews - fromPlan) / Math.max(fromViews, fromPlan, 1e-6);
    if (mismatch > 0.15)
      throw Error(
        `三个视图的比例对不上：正视 / 侧视推出宽深比 ${fromViews.toFixed(2)}，俯视推出 ${fromPlan.toFixed(2)}（差 ${(mismatch * 100).toFixed(0)}%）。` +
          '请确认三张图是同一模型的正投影视图、每张都完整包含主体，不要把同一张图放到不同方向。',
      );
  }
  if (!Number.isFinite(width)) width = 1;
  if (!Number.isFinite(depth)) depth = 1;
  const scale = resolution / Math.max(width, 1, depth),
    // Bricks span two studs, so an odd footprint leaves a one stud strip that no
    // piece can bridge into the rest of the model: keep width and depth even.
    w = Math.max(2, 2 * Math.round((width * scale) / 2)),
    d = Math.max(2, 2 * Math.round((depth * scale) / 2)),
    h = Math.max(2, Math.round(scale * 2.5));
  const column = (s: Silhouette, u: number, v: number) => {
    const span = size(s),
      uu = s.mirrored ? 1 - u : u,
      x = s.left + Math.min(span.x - 1, Math.max(0, Math.floor(uu * span.x))),
      y = s.bottom - Math.min(span.y - 1, Math.max(0, Math.floor(v * span.y)));
    return y * s.width + x;
  };
  const inside = (s: Silhouette, u: number, v: number) =>
    s.mask[column(s, u, v)] === 1;
  const sample = (s: Silhouette, u: number, v: number) => {
    const span = size(s),
      uu = s.mirrored ? 1 - u : u,
      cx = s.left + Math.floor(uu * span.x),
      cy = s.bottom - Math.floor(v * span.y),
      votes = new Uint32Array(PALETTE.length);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(s.width - 1, Math.max(0, cx + dx)),
          py = Math.min(s.height - 1, Math.max(0, cy + dy)),
          p = py * s.width + px;
        if (!s.core[p]) continue;
        const i = p * 4;
        votes[
          nearestColor(s.image.data[i], s.image.data[i + 1], s.image.data[i + 2], true)
        ]++;
      }
    let best = -1;
    for (let i = 0; i < votes.length; i++)
      if (votes[i] > (best < 0 ? 0 : votes[best])) best = i;
    return best;
  };
  const solid = new Uint8Array(w * h * d),
    at = (x: number, y: number, z: number) => (y * d + z) * w + x;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++) {
        const ux = (x + 0.5) / w,
          uz = (z + 0.5) / d,
          vy = (y + 0.5) / h;
        let keep = true;
        for (const s of shaped) {
          const seen =
            s.axis === 'front'
              ? inside(s, ux, vy)
              : s.axis === 'side'
                ? inside(s, uz, vy)
                : inside(s, ux, uz);
          if (!seen) {
            keep = false;
            break;
          }
        }
        if (keep) solid[at(x, y, z)] = 1;
      }
  // Each exposed side takes its colour from the view that looks straight at it.
  // 255 marks a voxel whose surface was never sampled: those keep the dominant
  // material. Using index 0 as "unset" would paint the whole interior white.
  const colours = new Uint8Array(w * h * d).fill(255),
    counts = new Uint32Array(PALETTE.length);
  const exposed = (x: number, y: number, z: number) =>
    x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d
      ? 0
      : solid[at(x, y, z)];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++) {
        if (!solid[at(x, y, z)]) continue;
        const ux = (x + 0.5) / w,
          uz = (z + 0.5) / d,
          vy = (y + 0.5) / h,
          directions: [ViewAxis, number, number][] = [];
        if (!exposed(x, y, z + 1)) directions.push(['front', ux, vy]);
        if (!exposed(x, y, z - 1)) directions.push(['front', ux, vy]);
        if (!exposed(x + 1, y, z)) directions.push(['side', uz, vy]);
        if (!exposed(x - 1, y, z)) directions.push(['side', uz, vy]);
        if (!exposed(x, y + 1, z)) directions.push(['top', ux, uz]);
        if (!exposed(x, y - 1, z)) directions.push(['top', ux, uz]);
        const votes = new Uint32Array(PALETTE.length);
        for (const [axis, u, v] of directions)
          for (const s of shaped) {
            if (s.axis !== axis) continue;
            const colour = sample(s, u, v);
            if (colour >= 0) votes[colour]++;
          }
        let best = -1;
        for (let i = 0; i < votes.length; i++)
          if (votes[i] > (best < 0 ? 0 : votes[best])) best = i;
        if (best >= 0) {
          colours[at(x, y, z)] = best;
          counts[best]++;
        }
      }
  const dominant = Math.max(
    0,
    counts.indexOf(Math.max(...Array.from(counts), 1)),
  );
  const cells = new Map<string, { color: number; support: boolean }>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++) {
        const i = at(x, y, z);
        if (!solid[i]) continue;
        cells.set(`${x},${y + 2},${z}`, {
          color: colours[i] === 255 ? dominant : colours[i],
          support: false,
        });
      }
  // The carved volume covers its own whole footprint, so the model gets no
  // extra base plate ring: an overhanging ring would not be joined to anything.
  const raw = finishModel(
    cells,
    w,
    h + 2,
    d,
    'image',
    name,
    resolution,
    dominant,
  );
  if (!raw.bricks.length) throw Error('轮廓里没有可以转换的体积。');
  if (raw.bricks.length > 14000)
    throw Error('此尺寸超过 14000 块零件，请降低积木尺寸后再转换。');
  const model = groupImageAssembly(raw);
  model.viewsDesign = {
    method: 'silhouette-carving',
    views: shaped.map((s) => s.axis),
    resolution,
    cells: cells.size,
  };
  model.assembly!.reference = `按 ${shaped
    .map((s) => VIEW_LABELS[s.axis])
    .join(' / ')}轮廓做空间雕刻：体积完全由轮廓相交得到，不含生成式推测。被遮挡的凹面与任一视图都看不到的内部结构仍无法恢复；未做实物拼装验证。`;
  const check = validateModel(model);
  if (check.collisions || check.unsupported || check.invalidParts || !check.connected)
    throw Error(
      `轮廓雕刻的模型未通过连接检查（重叠 ${check.collisions} · 缺支撑 ${check.unsupported} · 非法零件 ${check.invalidParts} · 连通 ${check.connected ? '是' : '否'}），请换更干净、互相对齐的正交视图，或降低尺寸。`,
    );
  return model;
}
