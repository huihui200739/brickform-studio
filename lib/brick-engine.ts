export const PALETTE = [
  { name: '白色', hex: '#F4F4F4', ldraw: 15, lego: 1 },
  { name: '黑色', hex: '#242424', ldraw: 0, lego: 26 },
  { name: '亮红色', hex: '#C91A09', ldraw: 4, lego: 21 },
  { name: '亮黄色', hex: '#F2CD37', ldraw: 14, lego: 24 },
  { name: '亮蓝色', hex: '#0055BF', ldraw: 1, lego: 23 },
  { name: '深绿色', hex: '#237841', ldraw: 2, lego: 28 },
];
export type Brick = {
  id: number;
  part: string;
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  color: number;
  support?: boolean;
};
export type Model = {
  name: string;
  bricks: Brick[];
  width: number;
  depth: number;
  height: number;
  supportCount: number;
  source: 'image' | 'sample';
  resolution: number;
};
export type Raster = { width: number; height: number; data: ArrayLike<number> };
export type Options = {
  resolution: number;
  depth: number;
  threshold: number;
  background: 'auto' | 'white' | 'keep';
};
export const PARTS: Record<string, string> = {
  '3005': '砖块 1 × 1',
  '3004': '砖块 1 × 2',
  '3010': '砖块 1 × 4',
};
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
export function nearestColor(r: number, g: number, b: number) {
  let best = 0,
    distance = Infinity;
  PALETTE.forEach((c, i) => {
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
  cells: Map<string, { color: number; support: boolean }>,
  width: number,
  height: number,
  depth: number,
  source: Model['source'],
  name: string,
  resolution: number,
): Model {
  const bricks: Brick[] = [];
  const used = new Set<string>();
  for (let y = 0; y < height; y++)
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++) {
        const start = cells.get(key(x, y, z));
        if (!start || used.has(key(x, y, z))) continue;
        const alongZ = y === 1 || (y > 1 && y % 2 === 1);
        let length = 1;
        for (const n of [4, 2, 1]) {
          // Offset seams on the first base layer so the crossed upper layer joins the whole base.
          if (y === 0 && z % 2 === 1 && x === 0 && n > 1) continue;
          let valid = true;
          for (let i = 0; i < n; i++) {
            const k = key(x + (alongZ ? 0 : i), y, z + (alongZ ? i : 0));
            const cell = cells.get(k);
            if (
              !cell ||
              cell.color !== start.color ||
              cell.support !== start.support ||
              used.has(k)
            ) {
              valid = false;
              break;
            }
          }
          if (valid) {
            length = n;
            break;
          }
        }
        for (let i = 0; i < length; i++)
          used.add(key(x + (alongZ ? 0 : i), y, z + (alongZ ? i : 0)));
        bricks.push({
          id: bricks.length + 1,
          part: length === 4 ? '3010' : length === 2 ? '3004' : '3005',
          x,
          y,
          z,
          w: alongZ ? 1 : length,
          d: alongZ ? length : 1,
          color: start.color,
          support: start.support,
        });
      }
  return {
    name,
    bricks,
    width,
    height,
    depth,
    source,
    resolution,
    supportCount: bricks.filter((b) => b.support).length,
  };
}
function makeSolid(
  subject: Map<string, { color: number; support: boolean }>,
  width: number,
  height: number,
  depth: number,
  source: Model['source'],
  name: string,
  resolution: number,
) {
  // Every occupied column rests on the base. Missing voxels underneath become explicit white supports.
  for (let x = 0; x < width; x++)
    for (let z = 0; z < depth; z++) {
      let top = 1;
      for (let y = 2; y < height; y++) if (subject.has(key(x, y, z))) top = y;
      for (let y = 2; y < top; y++)
        if (!subject.has(key(x, y, z)))
          subject.set(key(x, y, z), { color: 0, support: true });
      for (let y = 0; y < 2; y++)
        subject.set(key(x, y, z), { color: 0, support: false });
    }
  return pack(subject, width, height, depth, source, name, resolution);
}
export function sampleModel(resolution = 20, depth = 8): Model {
  const width = resolution + 2,
    height = Math.round(resolution * 0.8) + 3,
    cells = new Map<string, { color: number; support: boolean }>();
  for (let x = 1; x < width - 1; x++)
    for (let y = 2; y < height; y++)
      for (let z = 1; z < depth + 1; z++) {
        const u = (x - 1) / resolution,
          v = (y - 2) / (height - 3),
          q = (z - (depth + 1) / 2) / (depth / 2);
        const body = ((u - 0.43) / 0.41) ** 2 + ((v - 0.3) / 0.3) ** 2 + q * q;
        const head =
          ((u - 0.65) / 0.23) ** 2 + ((v - 0.72) / 0.27) ** 2 + (q / 0.77) ** 2;
        const beak =
          u > 0.79 && u < 0.99 && v > 0.61 && v < 0.73 && Math.abs(q) < 0.55;
        const tail = u < 0.19 && v > 0.33 && v < 0.56 && Math.abs(q) < 0.55;
        if (body < 1 || head < 1 || beak || tail) {
          let color = beak ? 2 : 3;
          if (u > 0.67 && u < 0.77 && v > 0.76 && v < 0.86 && Math.abs(q) > 0.3)
            color = 1;
          cells.set(key(x, y, z), { color, support: false });
        }
      }
  return makeSolid(
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
  const scale =
    options.resolution / Math.max(maxX - minX + 1, (maxY - minY + 1) * 0.8333);
  const w = Math.max(2, Math.round((maxX - minX + 1) * scale)),
    h = Math.max(2, Math.round((maxY - minY + 1) * scale * 0.8333));
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
  const cells = new Map<string, { color: number; support: boolean }>();
  pixels.forEach((p, k) => {
    const [x, py] = k.split(',').map(Number);
    const color = p.sum.indexOf(Math.max(...p.sum));
    for (let z = 1; z <= options.depth; z++)
      cells.set(key(x + 1, h - py + 1, z), { color, support: false });
  });
  return makeSolid(
    cells,
    w + 2,
    h + 2,
    options.depth + 2,
    'image',
    name,
    options.resolution,
  );
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
  const occupied = new Map<string, number>();
  let collisions = 0,
    unsupported = 0;
  for (const b of model.bricks)
    for (let dx = 0; dx < b.w; dx++)
      for (let dz = 0; dz < b.d; dz++) {
        const k = key(b.x + dx, b.y, b.z + dz);
        if (occupied.has(k)) collisions++;
        occupied.set(k, b.id);
      }
  const links = new Map<number, Set<number>>();
  model.bricks.forEach((b) => links.set(b.id, new Set()));
  for (const b of model.bricks) {
    let supported = b.y === 0;
    for (let dx = 0; dx < b.w; dx++)
      for (let dz = 0; dz < b.d; dz++) {
        const below = occupied.get(key(b.x + dx, b.y - 1, b.z + dz));
        if (below) {
          supported = true;
          links.get(b.id)!.add(below);
          links.get(below)!.add(b.id);
        }
      }
    if (!supported) unsupported++;
  }
  const seen = new Set<number>();
  const queue = model.bricks.length ? [model.bricks[0].id] : [];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...links.get(id)!);
  }
  return {
    collisions,
    unsupported,
    connected: seen.size === model.bricks.length,
    brickCount: model.bricks.length,
  };
}
export function toLDraw(model: Model) {
  const lines = [
    '0 Brickform model',
    '0 Name: brickform.ldr',
    '0 Author: Brickform',
    '0 Unverified physical prototype; dimensions in LDraw units',
  ];
  for (let y = 0; y < model.height; y++) {
    for (const b of model.bricks.filter((b) => b.y === y)) {
      const matrix = b.d > 1 ? '0 0 -1 0 1 0 1 0 0' : '1 0 0 0 1 0 0 0 1';
      lines.push(
        `1 ${PALETTE[b.color].ldraw} ${(b.x + b.w / 2 - model.width / 2) * 20} ${-(b.y + 1) * 24} ${(b.z + b.d / 2 - model.depth / 2) * 20} ${matrix} ${b.part}.dat`,
      );
    }
    lines.push('0 STEP');
  }
  return lines.join('\n');
}
