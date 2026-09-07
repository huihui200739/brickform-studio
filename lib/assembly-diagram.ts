import {
  ASSEMBLY_PARTS,
  worldPoint,
  transform,
  type V3,
} from './assembly-catalog.ts';
import { PALETTE, type Model, type Brick } from './brick-engine.ts';
type Face = { points: V3[]; shade: number };
// Lightweight solid diagrams for offline instructions. The interactive viewer
// uses the original LDraw mesh; these diagrams omit underside cavities.
export function brickFaces(b: Brick): Face[] {
  const p = ASSEMBLY_PARTS[b.part],
    x = p.w * 10,
    z = p.d * 10,
    cz = p.centerZ || 0,
    top = p.bottom - p.h * 8,
    bottom = p.bottom;
  const result: Face[] = [];
  const face = (points: V3[], shade: number) =>
    result.push({ points: points.map((pt) => worldPoint(b.pose!, pt)), shade });
  if (p.kind === 'round') {
    const ring = Array.from(
      { length: 20 },
      (_, i) =>
        [
          Math.cos((i * Math.PI) / 10) * 10,
          top,
          Math.sin((i * Math.PI) / 10) * 10,
        ] as V3,
    );
    face(ring, 1);
    ring.forEach((a, i) => {
      const c = ring[(i + 1) % ring.length];
      face([a, c, [c[0], bottom, c[2]], [a[0], bottom, a[2]]], 0.83);
    });
  } else if (p.kind === 'curve') {
    const zs = Array.from({ length: 9 }, (_, i) => -20 + i * 5);
    const y = (zz: number) =>
      24.972 - 40.972 * Math.sqrt(1 - ((zz - 20) / 56.56854) ** 2);
    for (let i = 0; i < 8; i++)
      face(
        [
          [-x, y(zs[i]), zs[i]],
          [x, y(zs[i]), zs[i]],
          [x, y(zs[i + 1]), zs[i + 1]],
          [-x, y(zs[i + 1]), zs[i + 1]],
        ],
        0.94 + i * 0.007,
      );
    for (const xx of [-x, x])
      face(
        [
          [xx, 0, -20],
          [xx, -8, 0],
          [xx, -8, 20],
          ...zs.toReversed().map((zz) => [xx, y(zz), zz] as V3),
        ],
        xx > 0 ? 0.78 : 0.88,
      );
    face(
      [
        [-x, 0, -20],
        [x, 0, -20],
        [x, -4, -20],
        [-x, -4, -20],
      ],
      0.8,
    );
    face(
      [
        [-x, -8, 20],
        [x, -8, 20],
        [x, -16, 20],
        [-x, -16, 20],
      ],
      0.8,
    );
  } else {
    const z0 = cz - z,
      z1 = cz + z;
    const y0 = p.kind === 'slope' ? 20 : top;
    face(
      [
        [-x, y0, z0],
        [x, y0, z0],
        [x, top, z1],
        [-x, top, z1],
      ],
      1,
    );
    face(
      [
        [-x, bottom, z0],
        [x, bottom, z0],
        [x, y0, z0],
        [-x, y0, z0],
      ],
      0.85,
    );
    face(
      [
        [x, bottom, z1],
        [-x, bottom, z1],
        [-x, top, z1],
        [x, top, z1],
      ],
      0.85,
    );
    face(
      [
        [x, bottom, z0],
        [x, bottom, z1],
        [x, top, z1],
        [x, y0, z0],
      ],
      0.76,
    );
    face(
      [
        [-x, bottom, z1],
        [-x, bottom, z0],
        [-x, y0, z0],
        [-x, top, z1],
      ],
      0.9,
    );
    if (['brick', 'plate', 'side'].includes(p.kind))
      for (let i = 0; i < p.w; i++)
        for (let j = 0; j < p.d; j++) {
          const cx = (i + 0.5 - p.w / 2) * 20,
            zz = (j + 0.5 - p.d / 2) * 20 + cz;
          face(
            Array.from(
              { length: 12 },
              (_, k) =>
                [
                  cx + 6 * Math.cos((k * Math.PI) / 6),
                  -4,
                  zz + 6 * Math.sin((k * Math.PI) / 6),
                ] as V3,
            ),
            0.96,
          );
        }
  }
  if (p.kind === 'side')
    face(
      Array.from(
        { length: 16 },
        (_, i) =>
          [
            6 * Math.cos((i * Math.PI) / 8),
            10 + 6 * Math.sin((i * Math.PI) / 8),
            -14,
          ] as V3,
      ),
      0.95,
    );
  return result;
}
export function assemblyDiagram(
  model: Model,
  step: number,
  highlight?: number[],
) {
  const list = model.bricks.filter((b) => (b.step || 0) <= step);
  if (!list.length) return '';
  const projected = list.flatMap((b) =>
    brickFaces(b).map((f) => {
      const active = highlight ? highlight.includes(b.id) : b.step === step;
      const rgb = active ? PALETTE[b.color].hex : '#cbd3dc';
      const color =
        '#' +
        [1, 3, 5]
          .map((i) =>
            Math.round(parseInt(rgb.slice(i, i + 2), 16) * f.shade)
              .toString(16)
              .padStart(2, '0'),
          )
          .join('');
      return {
        points: f.points.map(([x, y, z]) => [
          (x - z) * 0.707,
          (x + z) * 0.32 + y * 0.85,
        ]),
        depth:
          f.points.reduce((s, p) => s + p[0] - p[1] + p[2], 0) /
          f.points.length,
        color,
        active,
      };
    }),
  );
  const pts = projected.flatMap((p) => p.points),
    xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs) - 16,
    minY = Math.min(...ys) - 16,
    w = Math.max(...xs) - minX + 16,
    h = Math.max(...ys) - minY + 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" role="img" aria-label="搭建步骤 ${step + 1} 等轴测示意图"><rect x="${minX}" y="${minY}" width="${w}" height="${h}" rx="8" fill="#f4f6f8"/>${projected
    .sort((a, b) => a.depth - b.depth)
    .map(
      (f) =>
        `<polygon points="${f.points.map((p) => p.map((v) => v.toFixed(2)).join(',')).join(' ')}" fill="${f.color}" stroke="${f.active ? '#695d3790' : '#a3afbb'}" stroke-width=".35" stroke-linejoin="round"/>`,
    )
    .join('')}</svg>`;
}
export function orientationLabel(b: Brick) {
  if (!b.pose) return `${b.w} × ${b.d}`;
  const p = ASSEMBLY_PARTS[b.part],
    normal = transform(b.pose.matrix, [0, -1, 0]);
  if (normal[1] !== -1)
    return normal[0] < 0
      ? '侧装 · 向左'
      : normal[0] > 0
        ? '侧装 · 向右'
        : '侧向安装';
  if (p.kind === 'curve' || p.kind === 'slope') {
    const high = transform(b.pose.matrix, [0, 0, 1]);
    return `高边朝${high[0] > 0 ? '右' : high[0] < 0 ? '左' : high[2] > 0 ? '前' : '后'}`;
  }
  if (p.kind === 'side') {
    const side = transform(b.pose.matrix, [0, 0, -1]);
    return `侧凸点朝${side[0] < 0 ? '左' : '右'}`;
  }
  return `${b.w} × ${b.d} 凸点`;
}
