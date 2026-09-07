export type V3 = [number, number, number];
export type M3 = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];
export type CatalogPart = {
  name: string;
  w: number;
  d: number;
  h: number;
  kind: 'brick' | 'plate' | 'tile' | 'curve' | 'slope' | 'side' | 'round';
  // LDraw origin relative to the centre of the nominal envelope, in LDU.
  bottom: number;
  centerZ?: number;
};
export const ASSEMBLY_PARTS: Record<string, CatalogPart> = {
  '3001': { name: '砖块 2 × 4', w: 4, d: 2, h: 3, kind: 'brick', bottom: 24 },
  '3003': { name: '砖块 2 × 2', w: 2, d: 2, h: 3, kind: 'brick', bottom: 24 },
  '3010': { name: '砖块 1 × 4', w: 4, d: 1, h: 3, kind: 'brick', bottom: 24 },
  '3004': { name: '砖块 1 × 2', w: 2, d: 1, h: 3, kind: 'brick', bottom: 24 },
  '3005': { name: '砖块 1 × 1', w: 1, d: 1, h: 3, kind: 'brick', bottom: 24 },
  '3020': { name: '薄板 2 × 4', w: 4, d: 2, h: 1, kind: 'plate', bottom: 8 },
  '3022': { name: '薄板 2 × 2', w: 2, d: 2, h: 1, kind: 'plate', bottom: 8 },
  '3710': { name: '薄板 1 × 4', w: 4, d: 1, h: 1, kind: 'plate', bottom: 8 },
  '3023': { name: '薄板 1 × 2', w: 2, d: 1, h: 1, kind: 'plate', bottom: 8 },
  '3024': { name: '薄板 1 × 1', w: 1, d: 1, h: 1, kind: 'plate', bottom: 8 },
  '3034': { name: '薄板 2 × 8', w: 8, d: 2, h: 1, kind: 'plate', bottom: 8 },
  '3036': { name: '薄板 6 × 8', w: 8, d: 6, h: 1, kind: 'plate', bottom: 8 },
  '3068b': { name: '光面板 2 × 2', w: 2, d: 2, h: 1, kind: 'tile', bottom: 8 },
  '3069b': { name: '光面板 1 × 2', w: 2, d: 1, h: 1, kind: 'tile', bottom: 8 },
  '3070b': { name: '光面板 1 × 1', w: 1, d: 1, h: 1, kind: 'tile', bottom: 8 },
  '15068': {
    name: '弧面斜坡 2 × 2',
    w: 2,
    d: 2,
    h: 2,
    kind: 'curve',
    bottom: 0,
  },
  '11477': {
    name: '弧面斜坡 1 × 2',
    w: 1,
    d: 2,
    h: 2,
    kind: 'curve',
    bottom: 0,
  },
  '3039': {
    name: '45° 斜坡 2 × 2',
    w: 2,
    d: 2,
    h: 3,
    kind: 'slope',
    bottom: 24,
    centerZ: -10,
  },
  '3040b': {
    name: '45° 斜坡 1 × 2',
    w: 1,
    d: 2,
    h: 3,
    kind: 'slope',
    bottom: 24,
    centerZ: -10,
  },
  '87087': {
    name: '侧面单凸点砖 1 × 1',
    w: 1,
    d: 1,
    h: 3,
    kind: 'side',
    bottom: 24,
  },
  '98138': {
    name: '圆形光面板 1 × 1',
    w: 1,
    d: 1,
    h: 1,
    kind: 'round',
    bottom: 8,
  },
};
export const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export function rotate(q: number): M3 {
  return [
    IDENTITY,
    [0, 0, 1, 0, 1, 0, -1, 0, 0],
    [-1, 0, 0, 0, 1, 0, 0, 0, -1],
    [0, 0, -1, 0, 1, 0, 1, 0, 0],
  ][((q % 4) + 4) % 4] as M3;
}
export const multiply = (a: M3, b: M3): M3 =>
  Array.from({ length: 9 }, (_, i) =>
    [0, 1, 2].reduce(
      (v, k) => v + a[Math.floor(i / 3) * 3 + k] * b[k * 3 + (i % 3)],
      0,
    ),
  ) as M3;
export const transform = (m: M3, p: V3): V3 =>
  [0, 1, 2].map(
    (i) => m[i * 3] * p[0] + m[i * 3 + 1] * p[1] + m[i * 3 + 2] * p[2],
  ) as V3;
export const add = (a: V3, b: V3): V3 => a.map((v, i) => v + b[i]) as V3;
export type Pose = { position: V3; matrix: M3 };
export const worldPoint = (pose: Pose, p: V3) =>
  add(pose.position, transform(pose.matrix, p));
