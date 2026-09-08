import {
  nearestColor,
  type Raster,
  type Options,
  type Model,
  type Brick,
} from './brick-engine.ts';
import {
  ASSEMBLY_PARTS,
  curveFloorY,
  rotate,
  transform,
  worldPoint,
  multiply,
  type V3,
  type Pose,
} from './assembly-catalog.ts';
import { envelope } from './duck-designer.ts';

export type DuckFit = {
  body: { z: number; y: number; length: number; height: number };
  head: { z: number; y: number; diameter: number };
  beak: { z: number; y: number; length: number };
  eye: { z: number; y: number };
  bodyColor: number;
  beakColor: number;
  mirrored: boolean;
};
// Coordinates are fractions of the cropped reference's longest side.
// This fitter is deliberately restricted to single, side-view rubber ducks.
export const SAMPLE_FIT: DuckFit = {
  body: { z: 0.46667, y: 0.23314, length: 0.94286, height: 0.49524 },
  head: { z: 0.59524, y: 0.62857, diameter: 0.51429 },
  beak: { z: 0.88571, y: 0.57143, length: 0.21905 },
  eye: { z: 0.75756, y: 0.67681 },
  bodyColor: 3,
  beakColor: 2,
  mirrored: false,
};
export function fitDuckImage(
  raster: Raster,
  options: Pick<Options, 'background' | 'threshold'>,
): DuckFit {
  const { width: w, height: h, data } = raster;
  if (!w || !h || data.length !== w * h * 4)
    throw Error('图片像素数据不完整。');
  if (options.background === 'keep')
    throw Error('立体重建需要分离主体，请选择自动去除背景或白色背景。');
  const corners = [0, w - 1, (h - 1) * w, h * w - 1];
  const bg = [0, 1, 2].map((c) =>
    options.background === 'white'
      ? 255
      : corners.reduce((s, i) => s + data[i * 4 + c], 0) / 4,
  );
  const transparent = corners.every((i) => data[i * 4 + 3] < 100);
  const points: {
    x: number;
    y: number;
    color: number;
    r: number;
    g: number;
    b: number;
  }[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4,
        [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (
        a < 100 ||
        (!transparent &&
          Math.hypot(r - bg[0], g - bg[1], b - bg[2]) <= options.threshold)
      )
        continue;
      points.push({ x, y, color: nearestColor(r, g, b), r, g, b });
    }
  if (points.length < 50)
    throw Error('没有找到完整主体，请使用背景干净的小鸭侧面图。');
  const counts = Array(7).fill(0);
  points.forEach((p) => counts[p.color]++);
  const bodyColor = counts.indexOf(Math.max(...counts));
  // Keep yellow's shaded orange pixels with the body; do not turn shading into patches.
  const main = points.filter((p) =>
    bodyColor === 3
      ? p.r >= p.g * 0.9 && p.g >= p.r * 0.65 && p.b < Math.min(p.r, p.g) * 0.65
      : p.color === bodyColor,
  );
  const mouth = points.filter(
    (p) =>
      p.r > 100 && p.r > p.g * 1.8 && p.r > p.b * 1.8 && p.color !== bodyColor,
  );
  if (main.length < points.length * 0.5 || mouth.length < points.length * 0.006)
    throw Error(
      '这一轮仅支持有清晰红色或橙色鸭嘴的小鸭侧面图。尚不能自动理解其他物体。',
    );
  const bound = (p: typeof points) => ({
    l: Math.min(...p.map((v) => v.x)),
    r: Math.max(...p.map((v) => v.x)),
    t: Math.min(...p.map((v) => v.y)),
    b: Math.max(...p.map((v) => v.y)),
  });
  const bb = bound(main),
    mb = bound(mouth),
    height = bb.b - bb.t + 1;
  const upper = main.filter((p) => p.y < bb.t + height * 0.32),
    lower = main.filter((p) => p.y > bb.t + height * 0.44);
  const hb = bound(upper),
    lb = bound(lower);
  const mirrored = (mb.l + mb.r) / 2 < (hb.l + hb.r) / 2;
  const all = bound([...main, ...mouth]),
    scale = Math.max(all.r - all.l + 1, height);
  const Z = (x: number) => (mirrored ? all.r - x : x - all.l) / scale;
  const Y = (y: number) => (bb.b - y) / scale;
  const diameter = (hb.r - hb.l + 1) / scale;
  const dark = points.filter(
    (p) =>
      p.color === 1 && p.y < bb.t + height * 0.5 && p.x >= hb.l && p.x <= hb.r,
  );
  const eye = dark.length
    ? {
        z: Z(dark.reduce((s, p) => s + p.x, 0) / dark.length),
        y: Y(dark.reduce((s, p) => s + p.y, 0) / dark.length),
      }
    : {
        z: Z((hb.l + hb.r) / 2) + diameter * 0.27,
        y: Y(bb.t + (hb.r - hb.l) * 0.42),
      };
  if (
    diameter < 0.25 ||
    diameter > 0.7 ||
    height / scale < 0.65 ||
    height / scale > 1.3
  )
    throw Error(
      '未找到可靠的头身比例。请换成单只小鸭、完整侧面、干净背景的图片。',
    );
  return {
    body: {
      z: Z((lb.l + lb.r) / 2),
      y: ((bb.b - lb.t) / scale) * 0.48,
      length: (lb.r - lb.l + 1) / scale,
      height: (bb.b - lb.t + 1) / scale,
    },
    head: {
      z: Z((hb.l + hb.r) / 2),
      y: Y(bb.t + (hb.r - hb.l + 1) * 0.5),
      diameter,
    },
    beak: {
      z: Z((mb.l + mb.r) / 2),
      y: Y((mb.t + mb.b) / 2),
      length: (mb.r - mb.l + 1) / scale,
    },
    eye,
    bodyColor,
    beakColor:
      mouth.filter((p) => p.color === 2).length > mouth.length / 2 ? 2 : 6,
    mirrored,
  };
}

export function roundedDuck(
  fit: DuckFit = SAMPLE_FIT,
  size = 18,
  fullness = 1,
  fromImage = false,
): Model {
  const values = [
    size,
    fullness,
    ...Object.values(fit.body),
    ...Object.values(fit.head),
    ...Object.values(fit.beak),
    ...Object.values(fit.eye),
  ];
  if (
    !values.every(Number.isFinite) ||
    fit.head.diameter < 0.25 ||
    fit.head.diameter > 0.7 ||
    fit.body.length < 0.5 ||
    fit.body.length > 1.1 ||
    fit.body.height < 0.2 ||
    fit.body.height > 0.8 ||
    fit.head.y < fit.body.y ||
    ![fit.bodyColor, fit.beakColor].every(
      (c) => Number.isInteger(c) && c >= 0 && c < 7,
    )
  )
    throw Error('参考图比例不适用于当前的小鸭重建，请换一张完整侧面图。');
  size = Math.max(18, Math.min(22, Math.round(size)));
  fullness = Math.max(0.85, Math.min(1.15, fullness));
  const H = 2.5,
    cells = new Map<string, number>(),
    reserved = new Set<string>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const body = {
    z: fit.body.z * size,
    y: fit.body.y * size * H,
    rx: fit.body.length * size * 0.33 * fullness,
    rz: fit.body.length * size * 0.5,
    ry: fit.body.height * size * H * 0.56,
  };
  const head = {
    z: fit.head.z * size,
    y: fit.head.y * size * H,
    rx: fit.head.diameter * size * 0.48 * fullness,
    rz: fit.head.diameter * size * 0.5,
    ry: fit.head.diameter * size * H * 0.5,
  };
  const neck = {
    z: head.z - 0.35,
    y: (body.y + head.y) * 0.5,
    rx: head.rx * 0.68,
    rz: head.rz * 0.7,
    ry: (head.y - body.y) * 0.65,
  };
  const ellipsoid = (x: number, y: number, z: number, e: typeof body) =>
    (x / e.rx) ** 2 + ((y - e.y) / e.ry) ** 2 + ((z - e.z) / e.rz) ** 2 <= 1;
  const height = Math.ceil(head.y + head.ry),
    depth = Math.ceil(size * 1.12),
    width = Math.ceil(body.rx + 1);
  for (let y = 0; y < height; y++)
    for (let z = 0; z < depth; z++)
      for (let x = -width; x < width; x++) {
        if (
          [body, head, neck].some((e) =>
            ellipsoid(x + 0.5, y + 0.5, z + 0.5, e),
          )
        )
          cells.set(key(x, y, z), fit.bodyColor);
        // A rising, narrowing tail grows out of the rear body, with no support posts.
        const tailZ = body.z - body.rz;
        if (
          z + 0.5 >= tailZ - 0.4 &&
          z + 0.5 < tailZ + size * 0.18 &&
          Math.abs(x + 0.5) < size * 0.1 &&
          y >= body.y * 0.75 &&
          y < body.y + body.ry * 0.7 - (z - tailZ) * 1.5
        )
          cells.set(key(x, y, z), fit.bodyColor);
      }
  const beakY = Math.max(2, Math.round(fit.beak.y * size * H));
  const beakStart = Math.round(head.z + head.rz * 0.6),
    beakEnd = Math.max(
      beakStart + 3,
      Math.round((fit.beak.z + fit.beak.length * 0.55) * size),
    );
  const beakHalf = Math.max(2, Math.round(head.rx * 0.52));
  for (let y = beakY; y < beakY + 2; y++)
    for (let z = beakStart; z < beakEnd; z++)
      for (let x = -beakHalf; x < beakHalf; x++) {
        if (z === beakEnd - 1 && (x === -beakHalf || x === beakHalf - 1))
          continue;
        cells.set(key(x, y, z), fit.beakColor);
      }
  const planned: {
    part: string;
    x: number;
    y: number;
    z: number;
    q: number;
    color: number;
    section: string;
  }[] = [];
  // Embed the eye connectors in the actual fitted head, at an exposed side cell.
  const eyeY = Math.min(
    height - 6,
    Math.max(beakY + 2, Math.round(fit.eye.y * size * H) - 1),
  );
  const eyeZ = Math.round(Math.min(head.z + head.rz * 0.55, fit.eye.z * size));
  let eyeX = 0;
  for (let x = 0; x < width; x++)
    if ([0, 1, 2].every((dy) => cells.has(key(x, eyeY + dy, eyeZ)))) eyeX = x;
  for (const x of [-eyeX - 1, eyeX]) {
    for (let dy = 0; dy < 3; dy++) {
      cells.set(key(x, eyeY + dy, eyeZ), fit.bodyColor);
      reserved.add(key(x, eyeY + dy, eyeZ));
    }
    planned.push({
      part: '87087',
      x,
      y: eyeY,
      z: eyeZ,
      q: x < 0 ? 1 : 3,
      color: fit.bodyColor,
      section: 'head',
    });
    // Keep the eye face exposed even where the next layer swells outward.
    for (let dy = 0; dy < 3; dy++)
      for (let xx = eyeX + 1; xx < width; xx++)
        cells.delete(key(x < 0 ? -xx - 1 : xx, eyeY + dy, eyeZ));
  }
  const wingY = Math.max(2, Math.round(body.y) - 2),
    wingZ = Math.round(body.z) - 2;
  let wingX = Math.max(1, Math.floor(body.rx) - 1);
  while (
    wingX > 1 &&
    !Array.from({ length: 4 }, (_, dz) => dz).every((dz) =>
      [-3, -2, -1, 0, 1, 2].every((dy) =>
        cells.has(key(wingX, wingY + dy, wingZ + dz)),
      ),
    )
  )
    wingX--;
  for (const x of [-wingX - 1, wingX])
    for (let dz = 0; dz < 4; dz++) {
      for (let dy = 0; dy < 3; dy++) {
        cells.set(key(x, wingY + dy, wingZ + dz), fit.bodyColor);
        reserved.add(key(x, wingY + dy, wingZ + dz));
      }
      planned.push({
        part: '87087',
        x,
        y: wingY,
        z: wingZ + dz,
        q: x < 0 ? 1 : 3,
        color: fit.bodyColor,
        section: 'body',
      });
      for (let dy = 0; dy < 6; dy++)
        for (let xx = wingX + 1; xx < width; xx++)
          cells.delete(key(x < 0 ? -xx - 1 : xx, wingY + dy, wingZ + dz));
    }
  // Short internal carrier plates bridge from the core to every side connector.
  // These are local mounting rails, not columns down to the floor.
  for (const x of [-wingX - 1, wingX]) {
    const rx = x < 0 ? x : x - 1;
    for (let dx = 0; dx < 2; dx++)
      for (let dz = 0; dz < 4; dz++) {
        const k = key(rx + dx, wingY - 1, wingZ + dz);
        cells.set(k, fit.bodyColor);
        reserved.add(k);
      }
    planned.push({
      part: '3020',
      x: rx,
      y: wingY - 1,
      z: wingZ,
      q: 1,
      color: fit.bodyColor,
      section: 'body',
    });
  }
  for (const x of [-eyeX - 1, eyeX]) {
    const rx = x < 0 ? x : x - 1;
    for (let dx = 0; dx < 2; dx++) {
      const k = key(rx + dx, eyeY - 1, eyeZ);
      cells.set(k, fit.bodyColor);
      reserved.add(k);
    }
    planned.push({
      part: '3023',
      x: rx,
      y: eyeY - 1,
      z: eyeZ,
      q: 0,
      color: fit.bodyColor,
      section: 'head',
    });
  }
  // Mount broad curved panels vertically at the breast and forehead. These
  // replace stepped surface cells, using real side studs and internal carriers.
  const frontPanels: Brick[] = [];
  for (const region of [
    { section: 'body', y: Math.max(3, Math.round(body.y) - 2), center: body.z },
    {
      section: 'head',
      y: Math.min(beakY - 6, Math.round(neck.y) - 1),
      center: neck.z,
    },
    {
      section: 'head',
      y: Math.max(beakY + 3, Math.round(head.y) + 2),
      center: head.z,
    },
    { section: 'head', y: Math.round(head.y) - 3, center: head.z, back: true },
  ]) {
    const y = region.y,
      x0 = -2,
      span = 4,
      direction = region.back ? -1 : 1;
    let z = region.back ? 1 : depth - 2;
    const fits = (zz: number) =>
      Array.from({ length: span }, (_, dx) => x0 + dx).every(
        (x) =>
          Array.from({ length: 7 }, (_, dy) => y - 1 + dy).every(
            (yy) =>
              cells.get(key(x, yy, zz)) === fit.bodyColor &&
              !reserved.has(key(x, yy, zz)),
          ) &&
          cells.get(key(x, y - 1, zz - direction)) === fit.bodyColor &&
          !reserved.has(key(x, y - 1, zz - direction)),
      );
    while ((z - region.center) * direction > 0 && !fits(z)) z -= direction;
    if ((z - region.center) * direction <= 0) continue;
    // Clear the panel's protruding volume before packing any interior bricks.
    for (let x = x0; x < x0 + span; x++) {
      for (let yy = y; yy < y + 6; yy++)
        for (let zz = z + direction; zz >= 0 && zz < depth; zz += direction)
          cells.delete(key(x, yy, zz));
      for (let dy = 0; dy < 3; dy++) reserved.add(key(x, y + dy, z));
      planned.push({
        part: '87087',
        x,
        y,
        z,
        q: region.back ? 0 : 2,
        color: fit.bodyColor,
        section: region.section,
      });
      for (const zz of [z - direction, z]) reserved.add(key(x, y - 1, zz));
    }
    planned.push({
      part: '3020',
      x: x0,
      y: y - 1,
      z: region.back ? z : z - 1,
      q: 0,
      color: fit.bodyColor,
      section: region.section,
    });
    for (const x of [region.back ? -2 : 1]) {
      const hostPose: Pose = {
        matrix: rotate(region.back ? 0 : 2),
        position: [(x + 0.5) * 20, -(y + 3) * 8, (z + 0.5) * 20],
      };
      const matrix = multiply(hostPose.matrix, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
      const socket = transform(matrix, [-30, 0, -10]),
        face = worldPoint(hostPose, [0, 10, -10]);
      const pose: Pose = {
        matrix,
        position: face.map((v, i) => v - socket[i]) as V3,
      };
      frontPanels.push({
        id: 0,
        part: '88930',
        color: fit.bodyColor,
        pose,
        section: region.section,
        step: height + 2,
        ...envelope('88930', pose),
      });
    }
  }
  // Fit mirrored cheek panels behind the eyes, replacing tall block faces.
  const cheekY = Math.round(head.y) - 2,
    cheekZ = Math.round(head.z) - 3;
  let cheekX = width - 1;
  const cheekFits = (xx: number) =>
    [xx, -xx - 1].every((x) =>
      Array.from({ length: 4 }, (_, dz) => cheekZ + dz).every(
        (z) =>
          Array.from({ length: 7 }, (_, dy) => cheekY - 1 + dy).every(
            (y) =>
              cells.get(key(x, y, z)) === fit.bodyColor &&
              !reserved.has(key(x, y, z)),
          ) &&
          cells.get(key(x < 0 ? x + 1 : x - 1, cheekY - 1, z)) ===
            fit.bodyColor &&
          !reserved.has(key(x < 0 ? x + 1 : x - 1, cheekY - 1, z)),
      ),
    );
  while (cheekX > 1 && !cheekFits(cheekX)) cheekX--;
  if (cheekX > 2 && cheekFits(cheekX - 1)) cheekX--;
  if (cheekX > 1)
    for (const x of [-cheekX - 1, cheekX]) {
      const q = x < 0 ? 1 : 3,
        rx = x < 0 ? x : x - 1;
      for (let z = cheekZ; z < cheekZ + 4; z++) {
        for (let dy = 0; dy < 6; dy++)
          for (let xx = cheekX + 1; xx < width; xx++)
            cells.delete(key(x < 0 ? -xx - 1 : xx, cheekY + dy, z));
        for (let dy = 0; dy < 3; dy++) reserved.add(key(x, cheekY + dy, z));
        planned.push({
          part: '87087',
          x,
          y: cheekY,
          z,
          q,
          color: fit.bodyColor,
          section: 'head',
        });
        for (let dx = 0; dx < 2; dx++)
          reserved.add(key(rx + dx, cheekY - 1, z));
      }
      planned.push({
        part: '3020',
        x: rx,
        y: cheekY - 1,
        z: cheekZ,
        q: 1,
        color: fit.bodyColor,
        section: 'head',
      });
      // Bridge the shoulder above the inset cheek so the crown cannot become a
      // disconnected overhang when the reference has a wider upper head.
      const roofX = x < 0 ? x - 1 : x;
      for (let dx = 0; dx < 2; dx++)
        for (let dz = 0; dz < 4; dz++) {
          cells.set(key(roofX + dx, cheekY + 6, cheekZ + dz), fit.bodyColor);
          reserved.add(key(roofX + dx, cheekY + 6, cheekZ + dz));
        }
      planned.push({
        part: '3020',
        x: roofX,
        y: cheekY + 6,
        z: cheekZ,
        q: 1,
        color: fit.bodyColor,
        section: 'head',
      });
      const z = cheekZ + (x < 0 ? 3 : 0),
        hostPose: Pose = {
          matrix: rotate(q),
          position: [(x + 0.5) * 20, -(cheekY + 3) * 8, (z + 0.5) * 20],
        };
      const matrix = multiply(hostPose.matrix, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
      const socket = transform(matrix, [-30, 0, -10]),
        face = worldPoint(hostPose, [0, 10, -10]);
      const pose: Pose = {
        matrix,
        position: face.map((v, i) => v - socket[i]) as V3,
      };
      frontPanels.push({
        id: 0,
        part: '88930',
        color: fit.bodyColor,
        pose,
        section: 'head',
        step: height + 2,
        ...envelope('88930', pose),
      });
    }
  // Fit real curved slopes to top stair transitions, preserving their raised rear socket.
  const tops = new Map<string, number>();
  for (const k of cells.keys()) {
    const [x, y, z] = k.split(',').map(Number);
    tops.set(`${x},${z}`, Math.max(tops.get(`${x},${z}`) || 0, y + 1));
  }
  const curved = new Set<string>();
  const capSupportCells = new Set<string>();
  const cap = (
    x: number,
    z: number,
    q: number,
    narrow = false,
    commit = false,
  ) => {
    const cw = narrow && !(q % 2) ? 1 : 2;
    const cd = narrow && q % 2 ? 1 : 2;
    const coords = Array.from({ length: cw }, (_, dx) => dx).flatMap((dx) =>
      Array.from({ length: cd }, (_, dz) => ({ x: x + dx, z: z + dz })),
    );
    if (coords.some((c) => curved.has(`${c.x},${c.z}`))) return false;
    const ts = coords.map((c) => tops.get(`${c.x},${c.z}`) || 0),
      low = Math.min(...ts),
      high = Math.max(...ts);
    if (low < 3 || high - low < 1 || high - low > 6) return false;
    if (narrow && high - low > 3) return false;
    const part =
        high - low > 3
          ? narrow
            ? '3040b'
            : '3039'
          : narrow
            ? '11477'
            : '15068',
      ph = ASSEMBLY_PARTS[part].h,
      base = low - 1;
    // Side eyes protrude beyond the host cell; keep their full round-tile
    // envelope clear before fitting caps into otherwise empty exterior cells.
    if (
      base < eyeY + 4 &&
      base + ph > eyeY &&
      coords.some((c) => c.z === eyeZ && (c.x > eyeX || c.x < -eyeX - 1))
    )
      return false;
    if (
      frontPanels.some(
        (p) =>
          x < p.x + p.w &&
          x + cw > p.x &&
          z < p.z + p.d &&
          z + cd > p.z &&
          base < p.y + p.h &&
          base + ph > p.y,
      )
    )
      return false;
    const rear = coords.filter(
      (c) =>
        transform(rotate(-q), [
          c.x - x - (cw - 1) / 2,
          0,
          c.z - z - (cd - 1) / 2,
        ])[2] > 0,
    );
    if (rear.some((c) => (tops.get(`${c.x},${c.z}`) || 0) <= low)) return false;
    if (
      coords.some(
        (c) =>
          !cells.has(key(c.x, base - 1, c.z)) ||
          Array.from({ length: Math.max(high - base, ph) }, (_, dy) =>
            key(c.x, base + dy, c.z),
          ).some((k) => reserved.has(k) || capSupportCells.has(k)),
      )
    )
      return false;
    const color = cells.get(key(x, low - 1, z))!;
    if (
      coords.some(
        (c) =>
          cells.get(key(c.x, (tops.get(`${c.x},${c.z}`) || 0) - 1, c.z)) !==
          color,
      )
    )
      return false;
    if (!commit) return true;
    for (const c of coords) {
      curved.add(`${c.x},${c.z}`);
      for (let yy = base; yy < high; yy++) cells.delete(key(c.x, yy, c.z));
      for (let dy = 0; dy < ph; dy++) reserved.add(key(c.x, base + dy, c.z));
    }
    planned.push({
      part,
      x,
      y: base,
      z,
      q,
      color,
      section:
        color === fit.beakColor
          ? 'beak'
          : base > body.y + body.ry
            ? 'head'
            : 'body',
    });
    if (ASSEMBLY_PARTS[part].kind === 'curve')
      for (const c of rear) {
        cells.set(key(c.x, base, c.z), color);
        reserved.delete(key(c.x, base, c.z));
      }
    return true;
  };
  const largeCap = (
    part: string,
    x: number,
    z: number,
    q: number,
    commit = false,
  ) => {
    const p = ASSEMBLY_PARTS[part],
      w = q % 2 ? p.d : p.w,
      d = q % 2 ? p.w : p.d;
    const coords = Array.from({ length: w }, (_, dx) => dx).flatMap((dx) =>
      Array.from({ length: d }, (_, dz) => ({ x: x + dx, z: z + dz })),
    );
    if (coords.some((c) => curved.has(`${c.x},${c.z}`))) return false;
    const ts = coords.map((c) => tops.get(`${c.x},${c.z}`) || 0),
      low = Math.min(...ts),
      high = Math.max(...ts),
      base = low - 1;
    if (
      low < 4 ||
      high - low > 3 ||
      (p.curveProfile === 'double' && base < head.y + 2)
    )
      return false;
    if (
      frontPanels.some(
        (b) =>
          x < b.x + b.w &&
          x + w > b.x &&
          z < b.z + b.d &&
          z + d > b.z &&
          base < b.y + b.h &&
          base + p.h > b.y,
      )
    )
      return false;
    if (
      base < eyeY + 4 &&
      base + p.h > eyeY &&
      coords.some((c) => c.z === eyeZ && (c.x > eyeX || c.x < -eyeX - 1))
    )
      return false;
    const rows = coords.map((c) =>
      Math.round(
        (transform(rotate(-q), [
          (c.x - x - (w - 1) / 2) * 20,
          0,
          (c.z - z - (d - 1) / 2) * 20,
        ])[2] +
          p.d * 10 -
          10) /
          20,
      ),
    );
    const expected = p.curveProfile === 'double' ? [1, 2, 2, 1] : [1, 2, 3, 3];
    if (
      coords.some(
        (c, i) =>
          Math.abs(ts[i] - base - expected[rows[i]]) > 1 ||
          cells.get(key(c.x, base - 1, c.z)) !== fit.bodyColor ||
          Array.from({ length: Math.max(high - base, p.h) }, (_, dy) =>
            key(c.x, base + dy, c.z),
          ).some((k) => reserved.has(k)) ||
          cells.get(key(c.x, ts[i] - 1, c.z)) !== fit.bodyColor,
      )
    )
      return false;
    if (!commit) return true;
    coords.forEach((c, i) => {
      curved.add(`${c.x},${c.z}`);
      for (let yy = base; yy < high; yy++) cells.delete(key(c.x, yy, c.z));
      const shim =
        (p.bottom - curveFloorY(p, (rows[i] + 0.5 - p.d / 2) * 20)) / 8;
      for (let dy = 0; dy < p.h; dy++) {
        if (dy < shim) cells.set(key(c.x, base + dy, c.z), fit.bodyColor);
        else reserved.add(key(c.x, base + dy, c.z));
      }
    });
    planned.push({
      part,
      x,
      y: base,
      z,
      q,
      color: fit.bodyColor,
      section: base > body.y + body.ry ? 'head' : 'body',
    });
    return true;
  };
  // Prefer a continuous four-stud curve before filling residual two-stud steps.
  for (const part of ['93273', '93606'])
    for (let z = 0; z < depth; z++)
      for (let x = -width; x < 0; x++)
        for (const q of [0, 1, 2, 3]) {
          if (part === '93273' && (q !== 1 || x !== -2)) continue;
          const p = ASSEMBLY_PARTS[part],
            w = q % 2 ? p.d : p.w,
            mx = -x - w,
            mq = q === 1 ? 3 : q === 3 ? 1 : q;
          if (
            mx < x ||
            (mx !== x && mx < x + w) ||
            (mx === x && q % 2 && p.curveProfile !== 'double')
          )
            continue;
          if (
            largeCap(part, x, z, q) &&
            (mx === x || largeCap(part, mx, z, mq))
          ) {
            largeCap(part, x, z, q, true);
            if (mx !== x) largeCap(part, mx, z, mq, true);
            break;
          }
        }
  // Commit matching left/right caps together; traversal order cannot create an
  // asymmetric shell on a symmetric reconstruction.
  // Fill broad transitions first, then one-stud strips at cheeks, crown and tail.
  const fitSmallCaps = () => {
    for (const narrow of [false, true])
      for (let z = 0; z < depth; z++)
        for (let x = -width; x < 0; x++)
          for (const q of [0, 1, 2, 3]) {
            const cw = narrow && !(q % 2) ? 1 : 2;
            const mx = -x - cw,
              mq = q === 1 ? 3 : q === 3 ? 1 : q;
            if (mx === x && q % 2) continue;
            if (cap(x, z, q, narrow) && (mx === x || cap(mx, z, mq, narrow))) {
              cap(x, z, q, narrow, true);
              if (mx !== x) cap(mx, z, mq, narrow, true);
              break;
            }
          }
  };
  fitSmallCaps();
  // A shelf below a later cap may still carry its sockets. Keep these stud
  // cells intact rather than replacing them with another smooth, studless cap.
  for (const placement of planned) {
    const p = ASSEMBLY_PARTS[placement.part],
      w = placement.q % 2 ? p.d : p.w,
      d = placement.q % 2 ? p.w : p.d;
    for (let dx = 0; dx < w; dx++)
      for (let dz = 0; dz < d; dz++) {
        const localZ =
          transform(rotate(-placement.q), [
            (dx - (w - 1) / 2) * 20,
            0,
            (dz - (d - 1) / 2) * 20,
          ])[2] + (p.centerZ || 0);
        const shim = (p.bottom - curveFloorY(p, localZ)) / 8;
        capSupportCells.add(
          key(placement.x + dx, placement.y + shim - 1, placement.z + dz),
        );
      }
  }
  // The neck and shoulders also have exposed shelves below the head. A single
  // column maximum misses these surfaces entirely. Fit each open shelf locally,
  // while retaining the reserved volume of every previously placed cap.
  for (let surface = 4; surface < height - 3; surface++) {
    tops.clear();
    curved.clear();
    for (let z = 0; z < depth; z++)
      for (let x = -width; x < width; x++) {
        for (let top = surface; top <= surface + 2; top++) {
          if (
            cells.get(key(x, top - 1, z)) === fit.bodyColor &&
            [0, 1, 2].every((dy) => !cells.has(key(x, top + dy, z)))
          ) {
            tops.set(`${x},${z}`, top);
            break;
          }
        }
      }
    fitSmallCaps();
  }
  const bricks: Brick[] = [],
    occupied = new Set<string>(),
    studs = new Set<string>(),
    studOwners = new Map<string, number>();
  const put = (
    part: string,
    x: number,
    y: number,
    z: number,
    color: number,
    q = 0,
    section = 'body',
  ) => {
    const p = ASSEMBLY_PARTS[part],
      matrix = rotate(q),
      w = q % 2 ? p.d : p.w,
      d = q % 2 ? p.w : p.d;
    const center = transform(matrix, [0, p.bottom - p.h * 4, p.centerZ || 0]);
    const pose: Pose = {
      matrix,
      position: [
        (x + w / 2) * 20 - center[0],
        -(y + p.h / 2) * 8 - center[1],
        (z + d / 2) * 20 - center[2],
      ],
    };
    const b: Brick = {
      id: bricks.length + 1,
      part,
      color,
      pose,
      section,
      step: y + (p.curveProfile === 'long' ? 2 : 0),
      ...envelope(part, pose),
    };
    bricks.push(b);
    for (let dx = 0; dx < w; dx++)
      for (let dz = 0; dz < d; dz++) {
        const nativeZ = transform(rotate(-q), [
          (dx - (w - 1) / 2) * 20,
          0,
          (dz - (d - 1) / 2) * 20,
        ])[2];
        const floor =
          p.kind === 'curve' ? (p.bottom - curveFloorY(p, nativeZ)) / 8 : 0;
        for (let dy = floor; dy < p.h; dy++)
          occupied.add(key(x + dx, y + dy, z + dz));
        if (['brick', 'plate', 'side'].includes(p.kind)) {
          studs.add(key(x + dx, y + p.h, z + dz));
          studOwners.set(key(x + dx, y + p.h, z + dz), b.id);
        }
      }
    return b;
  };
  const ids = [
    '3001',
    '3003',
    '3010',
    '3004',
    '3005',
    '3020',
    '3022',
    '3710',
    '3023',
    '3024',
  ];
  let trimmed = 0;
  for (let y = 0; y < height; y++) {
    // Place from the connected interior outwards. Search both rotations and all
    // offsets, so a plate can bridge an overhang instead of adding an exterior column.
    const pending = new Set(
      [...cells.keys()].filter(
        (k) =>
          Number(k.split(',')[1]) === y && !occupied.has(k) && !reserved.has(k),
      ),
    );
    while (pending.size) {
      let best:
        | {
            part: string;
            x: number;
            z: number;
            color: number;
            q: number;
            score: number;
          }
        | undefined;
      for (const k of pending) {
        const [x, , z] = k.split(',').map(Number),
          color = cells.get(k)!;
        for (const part of ids)
          for (const q of ASSEMBLY_PARTS[part].w === ASSEMBLY_PARTS[part].d
            ? [0]
            : [y % 2, (y + 1) % 2]) {
            const p = ASSEMBLY_PARTS[part],
              w = q ? p.d : p.w,
              d = q ? p.w : p.d;
            if (y < 2 && p.h !== 1) continue;
            const owners = new Set<number>();
            let valid = true,
              supports = 0,
              bridged = 0;
            for (let dx = 0; dx < w && valid; dx++)
              for (let dz = 0; dz < d && valid; dz++) {
                if (y === 0 || studs.has(key(x + dx, y, z + dz))) {
                  supports++;
                  const owner = studOwners.get(key(x + dx, y, z + dz));
                  if (owner !== undefined) owners.add(owner);
                } else bridged++;
                for (let dy = 0; dy < p.h; dy++) {
                  const kk = key(x + dx, y + dy, z + dz);
                  if (
                    cells.get(kk) !== color ||
                    occupied.has(kk) ||
                    reserved.has(kk)
                  ) {
                    valid = false;
                    break;
                  }
                }
              }
            if (!valid || !supports) continue;
            // Finish exposed tops with small plate-sized tiles, but always
            // preserve a full bridging piece when an edge lacks direct support.
            if (bridged === 0) {
              let exposed = 0;
              for (let dx = 0; dx < w; dx++)
                for (let dz = 0; dz < d; dz++) {
                  const top = key(x + dx, y + p.h, z + dz);
                  if (!cells.has(top) && !reserved.has(top)) exposed++;
                }
              if (
                exposed &&
                (p.h > 1 ||
                  exposed !== w * d ||
                  !['3022', '3023', '3024'].includes(part))
              )
                continue;
            }
            // Prefer plates across expanding edges; use larger bricks in the core.
            const score =
              w * d * p.h +
              bridged * 5 +
              Math.max(0, owners.size - 1) * 4 +
              Math.min(supports, 2) * 0.1 +
              (q === y % 2 ? 0.05 : 0);
            if (!best || score > best.score)
              best = { part, x, z, color, q, score };
          }
      }
      if (!best) {
        trimmed += pending.size;
        for (const k of pending) cells.delete(k);
        break;
      }
      const b = put(
        best.part,
        best.x,
        y,
        best.z,
        best.color,
        best.q,
        best.color === fit.beakColor
          ? 'beak'
          : y > body.y + body.ry * 0.65
            ? 'head'
            : 'body',
      );
      for (let dx = 0; dx < b.w; dx++)
        for (let dz = 0; dz < b.d; dz++)
          pending.delete(key(best.x + dx, y, best.z + dz));
    }
    for (const p of planned.filter((p) => p.y === y))
      put(p.part, p.x, p.y, p.z, p.color, p.q, p.section);
  }
  const eyeHosts = bricks.filter(
    (b) =>
      b.part === '87087' &&
      b.section === 'head' &&
      Math.abs(b.y - eyeY) < 0.001 &&
      Math.abs(b.z - eyeZ) < 0.001 &&
      b.pose!.matrix[0] === 0,
  );
  for (const host of eyeHosts) {
    const matrix = multiply(host.pose!.matrix, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
    const pose = { matrix, position: worldPoint(host.pose!, [0, 10, -18]) };
    bricks.push({
      id: bricks.length + 1,
      part: '98138',
      color: 1,
      pose,
      section: 'eyes',
      step: height,
      ...envelope('98138', pose),
    });
  }
  for (const x of [-wingX - 1, wingX]) {
    const host = bricks.find(
      (b) =>
        b.part === '87087' &&
        b.section === 'body' &&
        b.x === x &&
        b.z === wingZ + (x < 0 ? 3 : 0),
    )!;
    const matrix = multiply(host.pose!.matrix, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
    const socket = transform(matrix, [-30, 0, -10]),
      face = worldPoint(host.pose!, [0, 10, -10]);
    const pose = {
      matrix,
      position: face.map((v, i) => v - socket[i]) as V3,
    };
    bricks.push({
      id: bricks.length + 1,
      part: '88930',
      color: fit.bodyColor,
      pose,
      section: 'wings',
      step: height + 1,
      ...envelope('88930', pose),
    });
  }
  for (const panel of frontPanels)
    bricks.push({ ...panel, id: bricks.length + 1 });
  // Finish the exposed upper bill with real tiles, not a row of visible studs.
  const topBill = bricks.filter(
    (b) =>
      b.color === fit.beakColor &&
      b.y === beakY + 1 &&
      ASSEMBLY_PARTS[b.part].kind === 'plate' &&
      Array.from({ length: b.w }, (_, dx) => dx).every((dx) =>
        Array.from({ length: b.d }, (_, dz) => dz).every(
          (dz) =>
            !cells.has(key(b.x + dx, b.y + 1, b.z + dz)) &&
            !reserved.has(key(b.x + dx, b.y + 1, b.z + dz)),
        ),
      ),
  );
  for (const b of topBill) {
    const i = bricks.indexOf(b);
    bricks.splice(i, 1);
    const split = (x: number, z: number, w: number, d: number) => {
      if (w >= 2 && d >= 2) {
        put('3068b', x, b.y, z, b.color, 0, 'beak');
        if (w > 2) split(x + 2, z, w - 2, 2);
        if (d > 2) split(x, z + 2, w, d - 2);
      } else if (w >= 2) {
        put('3069b', x, b.y, z, b.color, 0, 'beak');
        if (w > 2) split(x + 2, z, w - 2, d);
      } else if (d >= 2) {
        put('3069b', x, b.y, z, b.color, 1, 'beak');
        if (d > 2) split(x, z + 2, w, d - 2);
      } else put('3070b', x, b.y, z, b.color, 0, 'beak');
    };
    split(b.x, b.z, b.w, b.d);
  }
  // Finish isolated exposed terraces with same-footprint tiles. Never split a
  // bridging plate or remove studs used by a higher part / raised curve socket.
  const tileFor: Record<string, string> = {
    '3022': '3068b',
    '3023': '3069b',
    '3024': '3070b',
  };
  for (const b of bricks) {
    const tile = tileFor[b.part];
    if (!tile || b.section === 'beak') continue;
    const clear = Array.from({ length: b.w }, (_, dx) => dx).every((dx) =>
      Array.from({ length: b.d }, (_, dz) => dz).every(
        (dz) =>
          !cells.has(key(b.x + dx, b.y + 1, b.z + dz)) &&
          !reserved.has(key(b.x + dx, b.y + 1, b.z + dz)),
      ),
    );
    if (clear) b.part = tile;
  }
  bricks.sort((a, b) => a.step! - b.step! || a.id - b.id);
  bricks.forEach((b, i) => (b.id = i + 1));
  const minX = Math.min(...bricks.map((b) => b.x)),
    maxX = Math.max(...bricks.map((b) => b.x + b.w)),
    minZ = Math.min(...bricks.map((b) => b.z)),
    maxZ = Math.max(...bricks.map((b) => b.z + b.d));
  for (const b of bricks) {
    b.x -= minX;
    b.z -= minZ;
    b.pose!.position[0] -= (minX + maxX) * 10;
    b.pose!.position[2] -= (minZ + maxZ) * 10;
  }
  const layers = [...new Set(bricks.map((b) => b.step!))].sort((a, b) => a - b);
  const steps = layers.map((y, i) => ({
    name:
      y === height + 2
        ? '安装连续弧面外壳'
        : y === height + 1
          ? '安装两侧弧面翅膀'
          : y === height
            ? '安装两侧圆形眼睛'
            : `第 ${i + 1} 步 · ${y < 12 ? '腹部与尾部' : y < beakY ? '肩部与颈部' : y < beakY + 3 ? '头部与鸭嘴' : '圆润头顶'}`,
    description:
      y === height + 2
        ? '将弧面件背面的孔对准正面侧凸点，弧面朝外，向模型内侧按紧。'
        : y === height + 1
          ? '左右各安装一块宽弧面翅膀，对准四个侧凸点，高边朝上，弧面朝外。'
          : y === height
            ? '将黑色圆形光面板侧装到头部两侧凸点。'
            : '按图放置高亮零件；外缘薄板跨接下层凸点，弧面件高边朝内。',
    section:
      y === height + 1
        ? 'wings'
        : y === height
          ? 'eyes'
          : y > body.y + body.ry * 0.65
            ? 'head'
            : 'body',
  }));
  for (const b of bricks) b.step = layers.indexOf(b.step!);
  if (trimmed / (cells.size + trimmed) > 0.12)
    throw Error(
      '这张图的悬挑过大，无法在不增加外露支柱的前提下连接。请换一张侧面图或减小饱满度。',
    );
  return {
    name: fromImage ? '参考图 · 圆润小鸭' : '小黄鸭 · 体积重建',
    bricks,
    width: maxX - minX,
    depth: maxZ - minZ,
    height: Math.max(...bricks.map((b) => b.y + b.h)),
    levels: steps.map((_, i) => i),
    supportCount: 0,
    source: fromImage ? 'image' : 'sample',
    resolution: size,
    shape: 'sculpture',
    reconstruction: {
      method: 'duck-profile',
      size,
      fullness,
      trimmedFraction: trimmed / (cells.size + trimmed),
    },
    assembly: {
      sections: [
        { id: 'body', name: '身体与尾巴' },
        { id: 'head', name: '头部与颈部' },
        { id: 'beak', name: '鸭嘴' },
        { id: 'eyes', name: '眼睛' },
        { id: 'wings', name: '侧装翅膀' },
      ],
      steps,
      reference: fromImage
        ? '从小鸭侧面图测量头、身体、鸭嘴和眼睛位置，使用对称体积推测背面；非通用物体识别。'
        : '小鸭体积重建示例；按参考图比例拟合圆润的头部与身体。',
      parameters: {
        bodyLength: fit.body.length * size,
        headWidth: head.rx * 2,
        bodyColor: fit.bodyColor,
        beakColor: fit.beakColor,
      },
    },
  };
}
