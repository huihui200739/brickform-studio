import {
  finishModel,
  PALETTE,
  validateModel,
  type Model,
  type Raster,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { referenceMask } from './reference-colors.ts';
import {
  referenceMaterials,
  type ReferenceMaterialDesign,
} from './reference-materials.ts';
import type { TriangleMesh } from './mesh-types.ts';

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
  flippedVertical?: boolean;
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
  flippedVertical: boolean;
};
export function outline(view: MultiView): Silhouette {
  const { width, height } = view.image;
  const raw = multiViewSilhouette(view.image);
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
    flippedVertical: !!view.flippedVertical,
  };
}
// RGB shading is appearance, not empty space. Use a bounded background flood
// for opaque views, then fill enclosed RGB highlights. Alpha-cut holes remain
// explicit geometry and are preserved. Never grow indefinitely via local colour
// differences: that walks from a white backdrop into a pale stair surface.
function multiViewSilhouette(image: Raster): Uint8Array {
  const { width: w, height: h, data } = image;
  if (!w || !h || data.length !== w * h * 4) throw Error('参考图数据无效。');
  let transparent = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] <= 100) transparent++;
  if (transparent >= w * h * 0.01) return referenceMask(image).mask;
  const corners = [0, w - 1, (h - 1) * w, w * h - 1].map((i) => [
    data[i * 4],
    data[i * 4 + 1],
    data[i * 4 + 2],
  ]);
  const mask = new Uint8Array(w * h).fill(1),
    seen = new Uint8Array(w * h);
  const queue: number[] = [];
  for (let x = 0; x < w; x++) queue.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) queue.push(y * w, y * w + w - 1);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (seen[i]) continue;
    seen[i] = 1;
    if (
      !corners.some(
        (c) =>
          c.reduce(
            (sum, value, axis) => sum + Math.abs(data[i * 4 + axis] - value),
            0,
          ) < 84,
      )
    )
      continue;
    mask[i] = 0;
    const x = i % w,
      y = Math.floor(i / w);
    if (x > 0) queue.push(i - 1);
    if (x + 1 < w) queue.push(i + 1);
    if (y > 0) queue.push(i - w);
    if (y + 1 < h) queue.push(i + w);
  }
  // Unreached interior pixels are solid even if their RGB matches the backdrop.
  if (!mask.some(Boolean))
    throw Error('参考图中没有清晰主体，请换一张背景干净的图片。');
  return mask;
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
export type MultiViewVolume = {
  materialDesign?: ReferenceMaterialDesign;
  width: number;
  height: number;
  depth: number;
  resolution: number;
  solid: Uint8Array;
  colours: Uint8Array;
  // Visible first-hit colours for +Z, +X and +Y; 255 means unobserved.
  faceColours?: Uint8Array;
  quality?: MultiViewQuality;
  dominant: number;
  views: ViewAxis[];
};
export type MultiViewQuality = {
  passed: boolean;
  projections: { axis: ViewAxis; retainedFraction: number }[];
  components: number;
  largestComponentFraction: number;
  reasons: string[];
};
export type MultiViewSettings = { softenShadows?: boolean };
export type MultiViewReconstruction = {
  volume: MultiViewVolume;
  mesh: TriangleMesh;
};
// Keep this occupied grid as the source of both the preview and brick packing.
// Re-voxelising a surface mesh would introduce a second, different volume.
export function buildMultiViewVolume(
  views: MultiView[],
  resolution = 36,
  settings: MultiViewSettings = {},
): MultiViewVolume {
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
  const materials = new Map(
    shaped.map((s) => [
      s.axis,
      referenceMaterials(s.image, s.mask, settings.softenShadows !== false),
    ]),
  );
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
      vv = s.flippedVertical ? 1 - v : v,
      x = s.left + Math.min(span.x - 1, Math.max(0, Math.floor(uu * span.x))),
      y = s.bottom - Math.min(span.y - 1, Math.max(0, Math.floor(vv * span.y)));
    return y * s.width + x;
  };
  const inside = (s: Silhouette, u: number, v: number) =>
    s.mask[column(s, u, v)] === 1;
  const sample = (s: Silhouette, u: number, v: number) => {
    const span = size(s),
      uu = s.mirrored ? 1 - u : u,
      vv = s.flippedVertical ? 1 - v : v,
      cx = s.left + Math.floor(uu * span.x),
      cy = s.bottom - Math.floor(vv * span.y),
      votes = new Uint32Array(PALETTE.length);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.min(s.width - 1, Math.max(0, cx + dx)),
          py = Math.min(s.height - 1, Math.max(0, cy + dy)),
          p = py * s.width + px;
        if (!s.core[p]) continue;
        votes[materials.get(s.axis)!.palette[p]]++;
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
                ? inside(s, 1 - uz, vy)
                : inside(s, ux, 1 - uz);
          if (!seen) {
            keep = false;
            break;
          }
        }
        if (keep) solid[at(x, y, z)] = 1;
      }
  // A reference can colour only the first surface on its viewing ray. Copying
  // it to every exposed/back-facing voxel prints stairs, flames and dark seams
  // repeatedly onto inner walls and rear faces.
  const colours = new Uint8Array(w * h * d).fill(255),
    faceColours = new Uint8Array(w * h * d * 3).fill(255),
    counts = new Float64Array(PALETTE.length);
  const frontHits = new Int32Array(w * h).fill(-1),
    sideHits = new Int32Array(d * h).fill(-1),
    topHits = new Int32Array(w * d).fill(-1);
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        if (!solid[at(x, y, z)]) continue;
        frontHits[y * w + x] = z;
        sideHits[y * d + z] = x;
        topHits[z * w + x] = y;
      }
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        const index = at(x, y, z);
        if (!solid[index]) continue;
        const ux = (x + 0.5) / w,
          uz = (z + 0.5) / d,
          vy = (y + 0.5) / h;
        const visible: [ViewAxis, number, number, number][] = [];
        if (frontHits[y * w + x] === z) visible.push(['front', ux, vy, 0]);
        if (sideHits[y * d + z] === x) visible.push(['side', 1 - uz, vy, 1]);
        if (topHits[z * w + x] === y) visible.push(['top', ux, 1 - uz, 2]);
        const votes = new Uint32Array(PALETTE.length);
        for (const [axis, u, v, face] of visible) {
          const s = byAxis.get(axis);
          if (!s) continue;
          const colour = sample(s, u, v);
          if (colour < 0) continue;
          faceColours[index * 3 + face] = colour;
          votes[colour]++;
          counts[colour] += axis === 'top' ? 1 : 0.4;
        }
        let best = -1;
        for (let i = 0; i < votes.length; i++)
          if (votes[i] > (best < 0 ? 0 : votes[best])) best = i;
        if (best >= 0) colours[index] = best;
      }
  const dominant = Math.max(
    0,
    counts.indexOf(Math.max(...Array.from(counts), 1)),
  );
  if (!solid.some(Boolean))
    throw Error('三个轮廓相交后没有体积，请检查主体分离和视图方向。');
  for (let i = 0; i < colours.length; i++)
    if (colours[i] === 255) colours[i] = dominant;
  const materialDesign: ReferenceMaterialDesign = {
    method: 'reference-gradient-regions',
    regions: [],
    normalizedPixels: 0,
    warnings: [],
  };
  for (const [axis, material] of materials) {
    const offset = materialDesign.regions.length;
    for (const r of material.design.regions)
      materialDesign.regions.push({
        ...r,
        id: r.id + offset,
        view: axis,
      });
    materialDesign.normalizedPixels += material.design.normalizedPixels;
    materialDesign.warnings.push(...material.design.warnings);
  }
  materialDesign.warnings = [...new Set(materialDesign.warnings)];
  return {
    materialDesign,
    width: w,
    height: h,
    depth: d,
    resolution,
    solid,
    colours,
    faceColours,
    dominant,
    views: shaped.map((s) => s.axis),
  };
}

export function multiViewMesh(
  volume: MultiViewVolume,
  name = '三视图三维草稿',
): TriangleMesh {
  const { width: w, height: h, depth: d, solid, colours } = volume;
  const positions: number[] = [],
    colors: number[] = [];
  const at = (x: number, y: number, z: number) => (y * d + z) * w + x;
  const occupied = (x: number, y: number, z: number) =>
    x >= 0 && y >= 0 && z >= 0 && x < w && y < h && z < d && solid[at(x, y, z)];
  // Outward winding, front at +Z, physical plate height = 0.4 stud.
  const faces = [
    {
      normal: [1, 0, 0],
      corners: [
        [1, 0, 0],
        [1, 1, 0],
        [1, 1, 1],
        [1, 0, 1],
      ],
    },
    {
      normal: [-1, 0, 0],
      corners: [
        [0, 0, 1],
        [0, 1, 1],
        [0, 1, 0],
        [0, 0, 0],
      ],
    },
    {
      normal: [0, 1, 0],
      corners: [
        [0, 1, 1],
        [1, 1, 1],
        [1, 1, 0],
        [0, 1, 0],
      ],
    },
    {
      normal: [0, -1, 0],
      corners: [
        [0, 0, 0],
        [1, 0, 0],
        [1, 0, 1],
        [0, 0, 1],
      ],
    },
    {
      normal: [0, 0, 1],
      corners: [
        [0, 0, 1],
        [1, 0, 1],
        [1, 1, 1],
        [0, 1, 1],
      ],
    },
    {
      normal: [0, 0, -1],
      corners: [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
      ],
    },
  ];
  for (let y = 0; y < h; y++)
    for (let z = 0; z < d; z++)
      for (let x = 0; x < w; x++) {
        if (!occupied(x, y, z)) continue;

        for (const {
          normal: [nx, ny, nz],
          corners,
        } of faces) {
          if (occupied(x + nx, y + ny, z + nz)) continue;
          for (const index of [0, 1, 2, 0, 2, 3]) {
            const [cx, cy, cz] = corners[index];
            positions.push(x + cx, (y + cy) * 0.4, z + cz);
          }
          const face = nz > 0 ? 0 : nx > 0 ? 1 : ny > 0 ? 2 : -1;
          const observed =
            face < 0 ? 255 : volume.faceColours?.[at(x, y, z) * 3 + face];
          const colour = volume.faceColours
            ? observed === undefined || observed === 255
              ? volume.dominant
              : observed
            : colours[at(x, y, z)];
          const hex = PALETTE[colour].hex;
          const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
          colors.push(...rgb, ...rgb);
        }
      }
  return {
    name,
    materialDesign: volume.materialDesign,
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
  };
}

// Reproject the resulting volume into each input view. A fragmented object
// may have valid triangles but cannot account for the foreground it came from.
export function multiViewQuality(
  volume: MultiViewVolume,
  views: MultiView[],
): MultiViewQuality {
  const { width: w, height: h, depth: d, solid } = volume;
  const at = (x: number, y: number, z: number) => (y * d + z) * w + x;
  const projections = views.map((view) => {
    const s = outline(view),
      a = view.axis === 'side' ? d : w,
      b = view.axis === 'top' ? d : h;
    let expected = 0,
      retained = 0;
    for (let row = 0; row < b; row++)
      for (let col = 0; col < a; col++) {
        const u = (col + 0.5) / a,
          v = (row + 0.5) / b;
        const imageU = s.mirrored ? 1 - u : u,
          imageV = s.flippedVertical ? 1 - v : v;
        const px =
          s.left + Math.min(size(s).x - 1, Math.floor(imageU * size(s).x));
        const py =
          s.bottom - Math.min(size(s).y - 1, Math.floor(imageV * size(s).y));
        if (!s.mask[py * s.width + px]) continue;
        expected++;
        let found = false;
        const length = view.axis === 'front' ? d : view.axis === 'side' ? w : h;
        for (let ray = 0; ray < length; ray++) {
          const x = view.axis === 'side' ? ray : col;
          const y = view.axis === 'top' ? ray : row;
          const z =
            view.axis === 'front'
              ? ray
              : view.axis === 'side'
                ? d - col - 1
                : d - row - 1;
          if (solid[at(x, y, z)]) {
            found = true;
            break;
          }
        }
        if (found) retained++;
      }
    return {
      axis: view.axis,
      retainedFraction: retained / Math.max(1, expected),
    };
  });
  const seen = new Uint8Array(solid.length);
  let components = 0,
    largest = 0,
    total = 0;
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || seen[start]) continue;
    components++;
    let count = 0;
    const queue = [start];
    seen[start] = 1;
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head],
        x = i % w,
        z = Math.floor(i / w) % d,
        y = Math.floor(i / (w * d));
      count++;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x + 1 < w ? i + 1 : -1,
        z > 0 ? i - w : -1,
        z + 1 < d ? i + w : -1,
        y > 0 ? i - w * d : -1,
        y + 1 < h ? i + w * d : -1,
      ]) {
        if (j < 0 || !solid[j] || seen[j]) continue;
        seen[j] = 1;
        queue.push(j);
      }
    }
    largest = Math.max(largest, count);
    total += count;
  }
  const reasons = projections
    .filter((p) => p.retainedFraction < 0.98)
    .map(
      (p) =>
        `${VIEW_LABELS[p.axis]}只有 ${(p.retainedFraction * 100).toFixed(0)}% 的主体能被草稿解释，请检查方向、主体遮罩和透视`,
    );
  const largestComponentFraction = largest / Math.max(1, total);
  if (components > 1)
    reasons.push(
      `体积分裂为 ${components} 块，最大主体仅占 ${(largestComponentFraction * 100).toFixed(0)}%`,
    );
  return {
    passed: reasons.length === 0,
    projections,
    components,
    largestComponentFraction,
    reasons,
  };
}

export function reconstructMultiView(
  views: MultiView[],
  resolution = 36,
  name = '三视图三维草稿',
  settings: MultiViewSettings = {},
): MultiViewReconstruction {
  const volume = buildMultiViewVolume(views, resolution, settings);
  volume.quality = multiViewQuality(volume, views);
  return { volume, mesh: multiViewMesh(volume, name) };
}

export function carveMultiView(
  views: MultiView[],
  resolution = 36,
  name = '三视图积木',
): Model {
  return multiViewToModel(buildMultiViewVolume(views, resolution), name);
}

export function multiViewToModel(
  volume: MultiViewVolume,
  name = '三视图积木',
): Model {
  if (volume.quality && !volume.quality.passed)
    throw Error(
      `三维草稿未通过一致性检查：${volume.quality.reasons.join('；')}`,
    );
  const {
    width: w,
    height: h,
    depth: d,
    solid,
    colours,
    dominant,
    resolution,
    views,
  } = volume;
  const at = (x: number, y: number, z: number) => (y * d + z) * w + x;
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
  const sourceCellCount = cells.size;
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
  model.materialDesign = volume.materialDesign;
  model.viewsDesign = {
    method: 'silhouette-carving',
    views,
    resolution,
    cells: sourceCellCount,
  };
  model.assembly!.reference = `按 ${views
    .map((axis) => VIEW_LABELS[axis])
    .join(
      ' / ',
    )}轮廓做空间雕刻：体积完全由轮廓相交得到，不含生成式推测。被遮挡的凹面与任一视图都看不到的内部结构仍无法恢复；未做实物拼装验证。`;
  const check = validateModel(model);
  if (
    check.collisions ||
    check.unsupported ||
    check.invalidParts ||
    !check.connected
  )
    throw Error(
      `轮廓雕刻的模型未通过连接检查（重叠 ${check.collisions} · 缺支撑 ${check.unsupported} · 非法零件 ${check.invalidParts} · 连通 ${check.connected ? '是' : '否'}），请换更干净、互相对齐的正交视图，或降低尺寸。`,
    );
  return model;
}
