import type { PlacementReport } from './placement-policy.ts';
import { ASSEMBLY_PARTS, type Pose } from './assembly-catalog.ts';
import { validateAssembly } from './assembly-validation.ts';
export const PALETTE = [
  { name: '白色', hex: '#F4F4F4', ldraw: 15, lego: 1 },
  { name: '黑色', hex: '#242424', ldraw: 0, lego: 26 },
  { name: '亮红色', hex: '#C91A09', ldraw: 4, lego: 21 },
  { name: '亮黄色', hex: '#F2CD37', ldraw: 14, lego: 24 },
  { name: '亮蓝色', hex: '#0055BF', ldraw: 1, lego: 23 },
  { name: '深绿色', hex: '#237841', ldraw: 2, lego: 28 },
  { name: '亮橙色', hex: '#FE8A18', ldraw: 25, lego: 106 },
  { name: '沙色', hex: '#D7BA8C', ldraw: 19, lego: 5 },
  { name: '深沙色', hex: '#897D62', ldraw: 28, lego: 138 },
  { name: '红棕色', hex: '#5F3109', ldraw: 70, lego: 192 },
  { name: '深棕色', hex: '#352100', ldraw: 308, lego: 308 },
  { name: '浅灰色', hex: '#969696', ldraw: 71, lego: 194 },
  { name: '深灰色', hex: '#646464', ldraw: 72, lego: 199 },
  { name: '沙绿色', hex: '#708E7C', ldraw: 378, lego: 151 },
];
// Coordinates use studs in X/Z and plate units (3.2 mm) in Y.
export type Brick = {
  id: number;
  part: string;
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: number;
  support?: boolean;
  installation?: string;
  pose?: Pose;
  section?: string;
  step?: number;
};
export type Model = {
  componentPlacement?: PlacementReport[];
  name: string;
  bricks: Brick[];
  width: number;
  depth: number;
  height: number;
  levels: number[];
  supportCount: number;
  source: 'image' | 'sample';
  resolution: number;
  shape: 'sculpture' | 'relief';
  semanticDesign?: {
    components: { id: string; name: string; kind: string; parts: number }[];
    removedCells: number;
    reviewRequired: true;
    autoPlaced?: boolean;
    dropped?: string[];
  };
  meshDesign?: {
    method: 'mesh-volume';
    smoothTiles?: number;
    referenceColors?: boolean;
    triangles: number;
    resolution: number;
    openRowFraction: number;
  };
  blueprintDesign?: {
    method: 'face-reading';
    bricks: number;
    studs: number;
    depth: number;
    pitch: number;
  };
  viewsDesign?: {
    method: 'silhouette-carving';
    views: string[];
    resolution: number;
    cells: number;
  };
  imageDesign?: {
    shape: 'sculpture' | 'relief';
    background: Options['background'];
    note: string;
  };
  reconstruction?: {
    method: 'duck-profile';
    size: number;
    fullness: number;
    trimmedFraction: number;
  };
  assembly?: {
    sections: { id: string; name: string }[];
    steps: { name: string; description: string; section: string }[];
    reference: string;
    parameters: {
      bodyLength: number;
      headWidth: number;
      bodyColor: number;
      beakColor: number;
    };
  };
};
export type Raster = { width: number; height: number; data: ArrayLike<number> };
export type Options = {
  resolution: number;
  depth: number;
  threshold: number;
  background: 'auto' | 'white' | 'keep';
  shape?: 'sculpture' | 'relief';
};
export const CATALOG = [
  { id: '3001', name: '砖块 2 × 4', w: 4, d: 2, h: 3 },
  { id: '3003', name: '砖块 2 × 2', w: 2, d: 2, h: 3 },
  { id: '3010', name: '砖块 1 × 4', w: 4, d: 1, h: 3 },
  { id: '3004', name: '砖块 1 × 2', w: 2, d: 1, h: 3 },
  { id: '3005', name: '砖块 1 × 1', w: 1, d: 1, h: 3 },
  { id: '3020', name: '薄板 2 × 4', w: 4, d: 2, h: 1 },
  { id: '3022', name: '薄板 2 × 2', w: 2, d: 2, h: 1 },
  { id: '3710', name: '薄板 1 × 4', w: 4, d: 1, h: 1 },
  { id: '3023', name: '薄板 1 × 2', w: 2, d: 1, h: 1 },
  { id: '3024', name: '薄板 1 × 1', w: 1, d: 1, h: 1 },
];
export const PARTS: Record<string, string> = Object.fromEntries([
  ...CATALOG.map((p) => [p.id, p.name]),
  ...Object.entries(ASSEMBLY_PARTS).map(([id, p]) => [id, p.name]),
]);
type Cell = { color: number; support: boolean };
type Cells = Map<string, Cell>;
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
export function nearestColor(
  r: number,
  g: number,
  b: number,
  expanded = false,
) {
  let best = 0,
    distance = Infinity;
  PALETTE.forEach((c, i) => {
    if (!expanded && i >= 7) return;
    const hex = parseInt(c.hex.slice(1), 16);
    const delta =
      (r - (hex >> 16)) ** 2 +
      (g - ((hex >> 8) & 255)) ** 2 +
      (b - (hex & 255)) ** 2;
    if (delta < distance) {
      best = i;
      distance = delta;
    }
  });
  return best;
}
function pack(
  cells: Cells,
  width: number,
  height: number,
  depth: number,
  fixed: Brick[] = [],
): Brick[] {
  const bricks: Brick[] = fixed.map((b) => ({ ...b }));
  const used = new Set<string>();
  for (const b of fixed)
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        for (let y = b.y; y < b.y + b.h; y++) used.add(key(x, y, z));
  for (let y = 0; y < height; y++)
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++) {
        const start = cells.get(key(x, y, z));
        if (!start || used.has(key(x, y, z))) continue;
        const base = y < 2;
        const candidates = CATALOG.flatMap((p) => {
          if (base && (p.h !== 1 || (y === 0 && p.d !== 1))) return [];
          const rotations = p.w === p.d ? [false] : [Boolean(y % 2), !(y % 2)];
          return rotations
            .filter((rot) => y !== 0 || !rot)
            .map((rot) => ({ ...p, w: rot ? p.d : p.w, d: rot ? p.w : p.d }));
        });
        let chosen = candidates[candidates.length - 1];
        let bestScore = -Infinity;
        for (const p of candidates) {
          if (base && y === 0 && z % 2 === 1 && x === 0 && p.w > 1) continue;
          if (y === 1 && Math.floor(x / 2) % 2 === 1 && z === 0 && p.d > 2)
            continue;
          let valid = true;
          for (let dy = 0; dy < p.h && valid; dy++)
            for (let dz = 0; dz < p.d && valid; dz++)
              for (let dx = 0; dx < p.w; dx++) {
                const k = key(x + dx, y + dy, z + dz),
                  c = cells.get(k);
                if (
                  !c ||
                  c.color !== start.color ||
                  c.support !== start.support ||
                  used.has(k)
                ) {
                  valid = false;
                  break;
                }
              }
          if (valid) {
            if (base) {
              chosen = p;
              break;
            }
            let contact = 0;
            for (let dx = 0; dx < p.w; dx++)
              for (let dz = 0; dz < p.d; dz++)
                if (cells.has(key(x + dx, y - 1, z + dz))) contact++;
            const score =
              (contact > 0 ? 1000 : 0) + p.w * p.d * p.h + (p.h === 3 ? 2 : 0);
            if (score > bestScore) {
              chosen = p;
              bestScore = score;
            }
          }
        }
        for (let dy = 0; dy < chosen.h; dy++)
          for (let dz = 0; dz < chosen.d; dz++)
            for (let dx = 0; dx < chosen.w; dx++)
              used.add(key(x + dx, y + dy, z + dz));
        bricks.push({
          id: bricks.length + 1,
          part: chosen.id,
          x,
          y,
          z,
          w: chosen.w,
          d: chosen.d,
          h: chosen.h,
          color: start.color,
          support: start.support,
        });
      }
  return bricks;
}
export function finishModel(
  subject: Cells,
  width: number,
  height: number,
  depth: number,
  source: Model['source'],
  name: string,
  resolution: number,
  baseColor = 0,
  blocked?: (x: number, y: number, z: number) => boolean,
  fixed: Brick[] = [],
): Model {
  for (let x = 0; x < width; x++)
    for (let z = 0; z < depth; z++)
      for (let y = 0; y < 2; y++)
        subject.set(key(x, y, z), { color: baseColor, support: false });
  let bricks = pack(subject, width, height, depth, fixed);
  const counts = Array(PALETTE.length).fill(0);
  subject.forEach((c, k) => {
    if (Number(k.split(',')[1]) >= 2) counts[c.color]++;
  });
  const coreColor = counts.indexOf(Math.max(...counts));
  // Only add a column when a whole packed piece lacks a stud connection below.
  // Anchor towards the centre of the model and prefer the shortest visible gap.
  for (let pass = 0; pass < 8; pass++) {
    let added = false;
    for (const b of bricks) {
      if (!b.y) continue;
      let supported = false;
      for (let dx = 0; dx < b.w; dx++)
        for (let dz = 0; dz < b.d; dz++)
          if (subject.has(key(b.x + dx, b.y - 1, b.z + dz))) supported = true;
      if (supported) continue;
      let best = { x: b.x, z: b.z, bottom: 1, score: Infinity };
      for (let dx = 0; dx < b.w; dx++)
        for (let dz = 0; dz < b.d; dz++) {
          const x = b.x + dx,
            z = b.z + dz;
          let bottom = b.y - 1;
          while (bottom > 0 && !subject.has(key(x, bottom, z))) bottom--;
          let prohibited = false;
          for (let y = bottom + 1; y < b.y; y++)
            if (blocked?.(x, y, z)) {
              prohibited = true;
              break;
            }
          if (prohibited) continue;
          const score = b.y - bottom + Math.abs(z + 0.5 - depth / 2) * 2;
          if (score < best.score) best = { x, z, bottom, score };
        }
      if (!Number.isFinite(best.score)) continue;
      for (let y = best.bottom + 1; y < b.y; y++)
        subject.set(key(best.x, y, best.z), {
          color: coreColor,
          support: true,
        });
      added = true;
    }
    if (!added) break;
    bricks = pack(subject, width, height, depth, fixed);
  }
  bricks = bricks
    .sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x)
    .map((b, i) => ({ ...b, id: i + 1 }));
  return {
    name,
    bricks,
    width,
    height,
    depth,
    source,
    resolution,
    levels: [...new Set(bricks.map((b) => b.y))].sort((a, b) => a - b),
    supportCount: bricks.filter((b) => b.support).length,
    shape: 'sculpture',
  };
}
export function sampleModel(resolution = 28, depth = 12): Model {
  const width = resolution + 2,
    height = Math.round(resolution * 1.9) + 2,
    cells: Cells = new Map();
  for (let x = 1; x < width - 1; x++)
    for (let y = 2; y < height; y++)
      for (let z = 1; z <= depth; z++) {
        const u = (x - 0.5) / resolution,
          v = (y - 1.5) / (height - 2),
          q = (z + 0.5 - (depth + 2) / 2) / (depth / 2);
        const body =
          ((u - 0.43) / 0.42) ** 2 + ((v - 0.29) / 0.29) ** 2 + q * q;
        const head =
          ((u - 0.65) / 0.23) ** 2 + ((v - 0.73) / 0.27) ** 2 + (q / 0.8) ** 2;
        const beak =
          u > 0.8 && u < 0.99 && v > 0.6 && v < 0.72 && Math.abs(q) < 0.47;
        const tail = u < 0.2 && v > 0.3 && v < 0.52 && Math.abs(q) < 0.45;
        if (body < 1 || head < 1 || beak || tail) {
          let color = beak ? 2 : 3;
          if (
            u > 0.69 &&
            u < 0.77 &&
            v > 0.75 &&
            v < 0.84 &&
            Math.abs(q) > 0.38
          )
            color = 1;
          cells.set(key(x, y, z), { color, support: false });
        }
      }
  return finishModel(
    cells,
    width,
    height,
    depth + 2,
    'sample',
    '小黄鸭',
    resolution,
  );
}
export function imageToModel(
  raster: Raster,
  options: Options,
  name: string,
): Model {
  const { data, width: iw, height: ih } = raster;
  if (iw < 1 || ih < 1 || data.length !== iw * ih * 4)
    throw new Error('图片像素数据不完整，请换一张图片。');
  const corners = [0, iw - 1, (ih - 1) * iw, iw * ih - 1];
  const bg = [0, 1, 2].map((c) =>
    options.background === 'white'
      ? 255
      : corners.reduce((n, i) => n + data[i * 4 + c], 0) / 4,
  );
  // Flood only background pixels connected to the border. White details inside
  // a colored subject survive; transparent PNGs use their alpha channel.
  const alphaBackground =
    options.background === 'auto' &&
    corners.some((i) => data[i * 4 + 3] <= 100);
  const removed = new Uint8Array(iw * ih);
  const queue: number[] = [];
  const enqueue = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= iw || y >= ih) return;
    const p = y * iw + x,
      i = p * 4;
    if (removed[p]) return;
    const diff = Math.sqrt(
      [0, 1, 2].reduce((sum, c) => sum + (data[i + c] - bg[c]) ** 2, 0),
    );
    if (data[i + 3] <= 100 || (!alphaBackground && diff <= options.threshold)) {
      removed[p] = 1;
      queue.push(p);
    }
  };
  if (options.background !== 'keep') {
    for (let x = 0; x < iw; x++) {
      enqueue(x, 0);
      enqueue(x, ih - 1);
    }
    for (let y = 0; y < ih; y++) {
      enqueue(0, y);
      enqueue(iw - 1, y);
    }
    for (let n = 0; n < queue.length; n++) {
      const p = queue[n],
        x = p % iw,
        y = Math.floor(p / iw);
      enqueue(x - 1, y);
      enqueue(x + 1, y);
      enqueue(x, y - 1);
      enqueue(x, y + 1);
    }
  }
  const raw: { x: number; y: number; color: number }[] = [];
  const sourceColors = new Map<number, number>();
  for (let y = 0; y < ih; y++)
    for (let x = 0; x < iw; x++) {
      const p = y * iw + x,
        i = p * 4;
      if (data[i + 3] > 100 && !removed[p]) {
        const color = nearestColor(data[i], data[i + 1], data[i + 2]);
        raw.push({ x, y, color });
        sourceColors.set(p, color);
      }
    }
  if (!raw.length)
    throw new Error('没有找到主体。请降低背景去除强度，或选择「保留背景」。');
  let minX = iw,
    minY = ih,
    maxX = 0,
    maxY = 0;
  raw.forEach((p) => {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  });
  const scale = options.resolution / Math.max(maxX - minX + 1, maxY - minY + 1);
  const w = Math.max(2, Math.round((maxX - minX + 1) * scale)),
    h = Math.max(2, Math.round((maxY - minY + 1) * scale * 2.5));
  const pixels = new Map<string, { sum: number[]; n: number }>();
  // Sample each output cell, so upscaling a small source never creates gaps.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const x0 = minX + Math.floor((x * (maxX - minX + 1)) / w);
      const x1 = Math.min(
        maxX + 1,
        minX + Math.ceil(((x + 1) * (maxX - minX + 1)) / w),
      );
      const y0 = minY + Math.floor((y * (maxY - minY + 1)) / h);
      const y1 = Math.min(
        maxY + 1,
        minY + Math.ceil(((y + 1) * (maxY - minY + 1)) / h),
      );
      const value = { sum: Array(PALETTE.length).fill(0), n: 0 };
      for (let sy = y0; sy < y1; sy++)
        for (let sx = x0; sx < x1; sx++) {
          const color = sourceColors.get(sy * iw + sx);
          if (color !== undefined) {
            value.sum[color]++;
            value.n++;
          }
        }
      if (value.n > 0) pixels.set(`${x},${y}`, value);
    }
  const flat = new Map<string, number>();
  pixels.forEach((p, k) => flat.set(k, p.sum.indexOf(Math.max(...p.sum))));
  const edge: [number, number][] = [];
  flat.forEach((_, k) => {
    const [x, y] = k.split(',').map(Number);
    if (
      !flat.has(`${x - 1},${y}`) ||
      !flat.has(`${x + 1},${y}`) ||
      !flat.has(`${x},${y - 1}`) ||
      !flat.has(`${x},${y + 1}`)
    )
      edge.push([x, y]);
  });
  const distances = new Map<string, number>();
  let maxDistance = 0.5;
  flat.forEach((_, k) => {
    const [x, y] = k.split(',').map(Number);
    let d = Infinity;
    for (const [ex, ey] of edge)
      d = Math.min(d, Math.hypot(x - ex, (y - ey) * 0.4));
    d += 0.45;
    distances.set(k, d);
    maxDistance = Math.max(maxDistance, d);
  });
  const cells: Cells = new Map();
  flat.forEach((color, k) => {
    const [x, py] = k.split(',').map(Number);
    const normalized = Math.min(1, distances.get(k)! / maxDistance);
    const radius =
      options.shape === 'relief'
        ? options.depth / 2
        : Math.max(
            0.55,
            (options.depth / 2) *
              Math.sqrt(2 * normalized - normalized * normalized),
          );
    const z0 = Math.max(1, Math.ceil((options.depth + 2) / 2 - radius - 0.5));
    const z1 = Math.min(
      options.depth,
      Math.floor((options.depth + 2) / 2 + radius - 0.5),
    );
    // Small dark details remain on both surfaces rather than tunnelling through the core.
    let core = color;
    if (color === 1) {
      const nearby = Array(PALETTE.length).fill(0);
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const c = flat.get(`${x + dx},${py + dy}`);
          if (c !== undefined && c !== 1) nearby[c]++;
        }
      if (Math.max(...nearby) > 0) core = nearby.indexOf(Math.max(...nearby));
    }
    for (let z = z0; z <= z1; z++)
      cells.set(key(x + 1, h - py + 1, z), {
        color: z === z0 || z === z1 ? color : core,
        support: false,
      });
  });
  const model = finishModel(
    cells,
    w + 2,
    h + 2,
    options.depth + 2,
    'image',
    name,
    options.resolution,
  );
  model.shape = options.shape === 'relief' ? 'relief' : 'sculpture';
  return model;
}
export function inventory(bricks: Brick[]) {
  const items = new Map<
    string,
    { part: string; color: number; quantity: number }
  >();
  for (const b of bricks) {
    const k = `${b.part}-${b.color}`;
    const item = items.get(k) || { part: b.part, color: b.color, quantity: 0 };
    item.quantity++;
    items.set(k, item);
  }
  return [...items.values()].sort((a, b) => b.quantity - a.quantity);
}
export function validateModel(model: Model) {
  if (model.assembly) {
    const {
      badIds: _badIds,
      overlapIds: _overlapIds,
      ...validation
    } = validateAssembly(model);
    return validation;
  }
  const occupied = new Map<string, number>();
  let collisions = 0,
    unsupported = 0,
    invalidParts = 0;
  for (const b of model.bricks) {
    const p = CATALOG.find((p) => p.id === b.part);
    if (
      !p ||
      p.h !== b.h ||
      !((p.w === b.w && p.d === b.d) || (p.w === b.d && p.d === b.w))
    )
      invalidParts++;
    for (let dy = 0; dy < b.h; dy++)
      for (let dx = 0; dx < b.w; dx++)
        for (let dz = 0; dz < b.d; dz++) {
          const k = key(b.x + dx, b.y + dy, b.z + dz);
          if (occupied.has(k)) collisions++;
          occupied.set(k, b.id);
        }
  }
  const links = new Map<number, Set<number>>();
  model.bricks.forEach((b) => links.set(b.id, new Set()));
  for (const b of model.bricks) {
    let supported = b.y === 0;
    for (let dx = 0; dx < b.w; dx++)
      for (let dz = 0; dz < b.d; dz++) {
        const below = occupied.get(key(b.x + dx, b.y - 1, b.z + dz));
        if (below && below !== b.id) {
          supported = true;
          links.get(b.id)!.add(below);
          links.get(below)!.add(b.id);
        }
      }
    if (!supported) unsupported++;
  }
  const seen = new Set<number>(),
    queue = model.bricks.length ? [model.bricks[0].id] : [];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...links.get(id)!);
  }
  return {
    collisions,
    unsupported,
    invalidParts,
    connected: seen.size === model.bricks.length,
    brickCount: model.bricks.length,
  };
}
export function toLDraw(model: Model) {
  const lines = [
    '0 Brickform V3 model',
    '0 Name: brickform.ldr',
    '0 Author: Brickform',
    '0 Coordinates: studs in X/Z, plate units in Y. Physical stability unverified.',
  ];
  for (const y of model.levels) {
    if (model.assembly) lines.push(`0 // ${model.assembly.steps[y].name}`);
    for (const b of model.bricks.filter((b) =>
      model.assembly ? b.step === y : b.y === y,
    )) {
      if (b.pose) {
        lines.push(
          `1 ${PALETTE[b.color].ldraw} ${b.pose.position.join(' ')} ${b.pose.matrix.join(' ')} ${b.part}.dat`,
        );
        continue;
      }
      const p = CATALOG.find((p) => p.id === b.part)!;
      const rotated = p.w !== p.d && b.w !== p.w;
      const matrix = rotated ? '0 0 -1 0 1 0 1 0 0' : '1 0 0 0 1 0 0 0 1';
      lines.push(
        `1 ${PALETTE[b.color].ldraw} ${(b.x + b.w / 2 - model.width / 2) * 20} ${-(b.y + b.h) * 8} ${(b.z + b.d / 2 - model.depth / 2) * 20} ${matrix} ${b.part}.dat`,
      );
    }
    lines.push('0 STEP');
  }
  return lines.join('\n');
}
