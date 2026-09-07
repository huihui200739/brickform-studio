import {
  nearestColor,
  type Brick,
  type Model,
  type Raster,
  type Options,
} from './brick-engine.ts';
import {
  ASSEMBLY_PARTS,
  rotate,
  transform,
  multiply,
  worldPoint,
  type V3,
  type Pose,
} from './assembly-catalog.ts';

export type DuckParameters = {
  bodyLength: number;
  headWidth: number;
  bodyColor: number;
  beakColor: number;
};
export const DEFAULT_DUCK: DuckParameters = {
  bodyLength: 8,
  headWidth: 6,
  bodyColor: 3,
  beakColor: 6,
};

// This is a user-selected duck design grammar, not an object classifier.
// The reference determines palette and coarse proportions within that grammar.
export function referenceDuck(
  raster: Raster,
  options: Pick<Options, 'background' | 'threshold'>,
): DuckParameters {
  const { width: w, height: h, data } = raster;
  if (w < 1 || h < 1 || data.length !== w * h * 4)
    throw Error('图片像素数据不完整。');
  const corners = [0, w - 1, w * (h - 1), w * h - 1];
  const bg = [0, 1, 2].map((c) =>
    options.background === 'white'
      ? 255
      : corners.reduce((s, i) => s + data[i * 4 + c], 0) / 4,
  );
  const transparent = corners.some((i) => data[i * 4 + 3] < 100);
  const points: { x: number; y: number; color: number }[] = [];
  const accentCounts = Array(7).fill(0);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 100) continue;
      const difference = Math.hypot(
        ...[0, 1, 2].map((c) => data[i + c] - bg[c]),
      );
      if (
        options.background !== 'keep' &&
        !transparent &&
        difference <= options.threshold
      )
        continue;
      const color = nearestColor(data[i], data[i + 1], data[i + 2]);
      points.push({ x, y, color });
      // Exclude orange-looking shadows on a yellow body from beak estimation.
      if (
        data[i] > 100 &&
        data[i] > data[i + 1] * 1.8 &&
        data[i] > data[i + 2] * 1.8
      )
        accentCounts[color]++;
    }
  if (points.length < 4) throw Error('没有找到图片主体，请调整背景设置。');
  const count = Array(7).fill(0);
  points.forEach((p) => count[p.color]++);
  const bodyColor = count.indexOf(Math.max(...count));
  const accents = [2, 6].sort((a, b) => accentCounts[b] - accentCounts[a]);
  const beakColor =
    accents.find(
      (c) => c !== bodyColor && accentCounts[c] > points.length * 0.005,
    ) ?? (bodyColor === 6 ? 2 : 6);
  const xs = points.map((p) => p.x),
    ys = points.map((p) => p.y);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys),
    minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const mid = minY + (maxY - minY) * 0.48;
  const upper = points.filter((p) => p.y < mid && p.color === bodyColor);
  const span = upper.length
    ? Math.max(...upper.map((p) => p.x)) - Math.min(...upper.map((p) => p.x))
    : 0;
  return {
    bodyLength: (maxX - minX) / (maxY - minY || 1) > 1.35 ? 10 : 8,
    headWidth: span / (maxX - minX || 1) > 0.38 ? 6 : 4,
    bodyColor,
    beakColor,
  };
}

export function envelope(part: string, pose: Pose) {
  const p = ASSEMBLY_PARTS[part],
    points: V3[] = [];
  for (const x of [-p.w * 10, p.w * 10])
    for (const y of [p.bottom - p.h * 8, p.bottom])
      for (const z of [
        (p.centerZ || 0) - p.d * 10,
        (p.centerZ || 0) + p.d * 10,
      ])
        points.push(worldPoint(pose, [x, y, z]));
  const min = ([0, 1, 2] as const).map((i) =>
      Math.min(...points.map((p) => p[i])),
    ),
    max = ([0, 1, 2] as const).map((i) => Math.max(...points.map((p) => p[i])));
  return {
    x: min[0] / 20,
    y: -max[1] / 8,
    z: min[2] / 20,
    w: (max[0] - min[0]) / 20,
    h: (max[1] - min[1]) / 8,
    d: (max[2] - min[2]) / 20,
  };
}

export function designDuck(
  input: Partial<DuckParameters> = {},
  fromImage = false,
): Model {
  const cfg = { ...DEFAULT_DUCK, ...input };
  cfg.bodyLength = cfg.bodyLength >= 10 ? 10 : 8;
  cfg.headWidth = cfg.headWidth >= 6 ? 6 : 4;
  if (
    !Number.isInteger(cfg.bodyColor) ||
    cfg.bodyColor < 0 ||
    cfg.bodyColor > 6
  )
    cfg.bodyColor = 3;
  if (
    !Number.isInteger(cfg.beakColor) ||
    cfg.beakColor < 0 ||
    cfg.beakColor > 6
  )
    cfg.beakColor = 6;
  const bricks: Brick[] = [],
    steps: NonNullable<Model['assembly']>['steps'] = [];
  const sections = [
    { id: 'body', name: '身体' },
    { id: 'wings', name: '翅膀' },
    { id: 'tail', name: '尾巴' },
    { id: 'head', name: '头部' },
    { id: 'beak', name: '鸭嘴' },
    { id: 'eyes', name: '眼睛' },
  ];
  let step = -1,
    section = 'body';
  const next = (name: string, description: string, s = 'body') => {
    section = s;
    step++;
    steps.push({ name, description, section: s });
  };
  const put = (
    part: string,
    x: number,
    y: number,
    z: number,
    color = cfg.bodyColor,
    q = 0,
  ): Brick => {
    const p = ASSEMBLY_PARTS[part],
      matrix = rotate(q),
      w = q % 2 ? p.d : p.w,
      d = q % 2 ? p.w : p.d;
    const center = transform(matrix, [0, p.bottom - p.h * 4, p.centerZ || 0]);
    const position: V3 = [
      (x + w / 2) * 20 - center[0],
      -(y + p.h / 2) * 8 - center[1],
      (z + d / 2) * 20 - center[2],
    ];
    // The rear underside of a curved slope is one plate higher. Fill that
    // recess with a real plate, so both rows connect and no open gap shows.
    if (p.kind === 'curve') {
      const shimPart = p.w === 2 ? '3023' : '3024';
      const shimPose = {
        matrix,
        position: worldPoint({ matrix, position }, [0, -8, 10]),
      };
      bricks.push({
        id: bricks.length + 1,
        part: shimPart,
        color,
        pose: shimPose,
        section,
        step,
        ...envelope(shimPart, shimPose),
      });
    }
    const b: Brick = {
      id: bricks.length + 1,
      part,
      color,
      pose: { position, matrix },
      section,
      step,
      ...envelope(part, { position, matrix }),
    };
    bricks.push(b);
    return b;
  };
  // Tile rectangles with legal parts. Alternating direction ties lower seams.
  const fill = (
    x: number,
    z: number,
    w: number,
    d: number,
    y: number,
    h = 1,
    exclude: (x: number, z: number) => boolean = () => false,
  ) => {
    const occupied = new Set<string>();
    const ids =
      h === 3
        ? ['3001', '3003', '3010', '3004', '3005']
        : ['3020', '3022', '3710', '3023', '3024'];
    for (let zz = z; zz < z + d; zz++)
      for (let xx = x; xx < x + w; xx++) {
        if (occupied.has(`${xx},${zz}`) || exclude(xx, zz)) continue;
        candidate: for (const id of ids)
          for (const q of step % 2 ? [1, 0] : [0, 1]) {
            const p = ASSEMBLY_PARTS[id],
              ww = q ? p.d : p.w,
              dd = q ? p.w : p.d;
            if (xx + ww > x + w || zz + dd > z + d) continue;
            for (let dz = 0; dz < dd; dz++)
              for (let dx = 0; dx < ww; dx++)
                if (
                  occupied.has(`${xx + dx},${zz + dz}`) ||
                  exclude(xx + dx, zz + dz)
                )
                  continue candidate;
            put(id, xx, y, zz, cfg.bodyColor, q);
            for (let dz = 0; dz < dd; dz++)
              for (let dx = 0; dx < ww; dx++)
                occupied.add(`${xx + dx},${zz + dz}`);
            break candidate;
          }
      }
  };
  const rear = 4 - cfg.bodyLength;
  const corners = (x: number, z: number) =>
    (x === -4 || x === 3) && (z === rear || z === 3);
  next('腹部底板', '将第一层薄板平放，下一步交错连接。');
  fill(-4, rear, 8, cfg.bodyLength, 0, 1, corners);
  next('锁住底板', '薄板跨过下层接缝，将腹部连成整体。');
  fill(-4, rear, 8, cfg.bodyLength, 1, 1, corners);
  next('饱满的身体', '沿底板搭建主体，四角各收进一格。');
  fill(-4, rear, 8, cfg.bodyLength, 2, 3, corners);
  next('身体交错连接', '改变砖块方向，避免上下接缝一直贯通。');
  const wingHosts: Brick[] = [];
  for (const x of [-4, 3])
    for (const z of [-1, 0])
      wingHosts.push(put('87087', x, 5, z, cfg.bodyColor, x < 0 ? 1 : 3));
  fill(
    -4,
    rear,
    8,
    cfg.bodyLength,
    5,
    3,
    (x, z) => corners(x, z) || ((x === -4 || x === 3) && (z === -1 || z === 0)),
  );
  next('连接肩部', '盖上一层薄板，为翅膀、尾巴和脖子提供连接。');
  fill(-4, rear, 8, cfg.bodyLength, 8);
  next('肩部与脖子', '中间保留颈部支座，前后弧面低的一端朝外。');
  for (const y of [9, 10]) fill(-2, rear + 2, 4, cfg.bodyLength - 2, y);
  for (const x of [-4, 2]) put('15068', x, 9, 2, cfg.bodyColor, 2);
  for (const x of [-4, 2]) put('15068', x, 9, rear, cfg.bodyColor, 0);
  next(
    '两侧翅膀',
    '顶部弧面低边朝外；另外两块弧面件侧装在身体的侧凸点上，高边朝上。',
    'wings',
  );
  for (let z = rear + 2; z < 2; z += 2) {
    put('15068', -4, 9, z, cfg.bodyColor, 1);
    put('15068', 2, 9, z, cfg.bodyColor, 3);
  }
  for (const x of [-4, 3]) {
    const host = wingHosts.find((b) => b.x === x && b.z === (x < 0 ? 0 : -1))!;
    const matrix = multiply(host.pose!.matrix, [1, 0, 0, 0, 0, -1, 0, 1, 0]);
    const socket = transform(matrix, [-10, 0, -10]);
    const face = worldPoint(host.pose!, [0, 10, -10]);
    const pose = { matrix, position: face.map((v, i) => v - socket[i]) as V3 };
    bricks.push({
      id: bricks.length + 1,
      part: '15068',
      color: cfg.bodyColor,
      pose,
      section,
      step,
      ...envelope('15068', pose),
    });
  }
  next('翘起的尾巴', '斜坡高端朝后，两个凸点上安装光面板收口。', 'tail');
  for (const x of [-2, 0]) {
    put('3039', x, 9, rear, cfg.bodyColor, 2);
    put('3069b', x, 12, rear, cfg.bodyColor, 0);
  }
  const hw = cfg.headWidth,
    hx = -hw / 2,
    hz = 4 - hw;
  next('头部底板', '头部位于身体前方；底板覆盖颈部并向两侧伸出。', 'head');
  fill(hx, hz, hw, hw, 11);
  next('头部轮廓', '拼出头部下半部分，保留朝前的嘴部位置。', 'head');
  fill(hx, hz, hw, hw, 12, 3);
  next(
    '眼睛连接砖',
    '两块侧凸点砖朝向身体左右两侧。其余位置用薄板补平。',
    'head',
  );
  const hosts = [
    put('87087', hx, 15, 2, cfg.bodyColor, 1),
    put('87087', -hx - 1, 15, 2, cfg.bodyColor, 3),
  ];
  const eyes = (x: number, z: number) => (x === hx || x === -hx - 1) && z === 2;
  const slot = (x: number, z: number) => x >= -2 && x < 2 && z === 3;
  fill(hx, hz, hw, hw, 15, 1, (x, z) => eyes(x, z) || slot(x, z));
  next(
    '扁平的鸭嘴',
    '两块薄板后端扣住头部前排凸点；弧面低端朝前，嘴尖用光面板收边。',
    'beak',
  );
  for (const x of [-2, 0]) {
    put('3020', x, 15, 3, cfg.beakColor, 1);
    put('15068', x, 16, 4, cfg.beakColor, 2);
    put('3069b', x, 16, 6, cfg.beakColor);
  }
  next('锁住鸭嘴', '在鸭嘴后端上方补入两层薄板，夹住嘴部连接。', 'head');
  for (const y of [16, 17]) fill(hx, hz, hw, hw, y, 1, eyes);
  next(
    '圆形眼睛',
    '先将白色薄板按在左右侧凸点上，再扣上黑色圆形光面板。这一步是侧向安装。',
    'eyes',
  );
  for (const host of hosts) {
    const tilt = [1, 0, 0, 0, 0, -1, 0, 1, 0] as const;
    const matrix = multiply(host.pose!.matrix, [...tilt]);
    const whitePose = {
      matrix,
      position: worldPoint(host.pose!, [0, 10, -18]),
    };
    bricks.push({
      id: bricks.length + 1,
      part: '3024',
      color: 0,
      pose: whitePose,
      section,
      step,
      ...envelope('3024', whitePose),
    });
    const position = worldPoint(host.pose!, [0, 10, -26]);
    const pose = { position, matrix };
    bricks.push({
      id: bricks.length + 1,
      part: '98138',
      color: 1,
      pose,
      section,
      step,
      ...envelope('98138', pose),
    });
  }
  next('封住头顶', '薄板横跨头部，把两侧眼睛连接砖锁在内部。', 'head');
  fill(hx, hz, hw, hw, 18);
  next('圆润的头顶', '弧面件低边朝外，高边向内。中间用光面板收口。', 'head');
  for (let z = hz; z < 4; z += 2) {
    put('15068', hx, 19, z, cfg.bodyColor, 1);
    put('15068', -hx - 2, 19, z, cfg.bodyColor, 3);
  }
  if (hw === 6) {
    put('15068', -1, 19, hz, cfg.bodyColor, 0);
    put('15068', -1, 19, 2, cfg.bodyColor, 2);
    fill(-1, hz + 2, 2, 2, 19);
    put('3068b', -1, 20, hz + 2);
  }
  // Recenter exact LDraw positions, then derive one common positive diagram grid.
  const minX = Math.min(...bricks.map((b) => b.x)),
    maxX = Math.max(...bricks.map((b) => b.x + b.w));
  const minZ = Math.min(...bricks.map((b) => b.z)),
    maxZ = Math.max(...bricks.map((b) => b.z + b.d));
  for (const b of bricks) {
    b.x -= minX;
    b.z -= minZ;
    b.pose!.position[0] -= (minX + maxX) * 10;
    b.pose!.position[2] -= (minZ + maxZ) * 10;
  }
  return {
    name: fromImage ? '参考图 · 小鸭设计' : '小黄鸭 · 曲面版',
    bricks,
    width: maxX - minX,
    depth: maxZ - minZ,
    height: Math.max(...bricks.map((b) => b.y + b.h)),
    levels: steps.map((_, i) => i),
    supportCount: 0,
    source: fromImage ? 'image' : 'sample',
    resolution: 8,
    shape: 'sculpture',
    assembly: {
      sections,
      steps,
      parameters: cfg,
      reference: fromImage
        ? '按所选小鸭结构，用图片配色与粗略比例生成；非任意物体识别。'
        : '小鸭部件设计示例，可调整比例和配色。',
    },
  };
}
