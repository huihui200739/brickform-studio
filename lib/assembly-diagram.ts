import { SPECIAL_DATA } from './special-part-data.ts';
import {
  ASSEMBLY_PARTS,
  curveFloorY,
  curveTopY,
  worldPoint,
  transform,
  type V3,
} from './assembly-catalog.ts';
import { PALETTE, type Model, type Brick } from './brick-engine.ts';
type Face = {
  points: V3[];
  shade: number;
  detail?: 'stud-top' | 'stud-side';
  smooth?: boolean;
};
// Lightweight solid diagrams for offline instructions. The interactive viewer
// uses the original LDraw mesh; these diagrams omit underside cavities.
export function brickFaces(b: Brick): Face[] {
  const mesh = SPECIAL_DATA[b.part];
  if (mesh)
    return mesh.triangles.map((t) => {
      const points = [0, 3, 6].map((i) =>
        worldPoint(b.pose!, t.slice(i, i + 3) as V3),
      );
      const a = points[1].map((v, i) => v - points[0][i]),
        c = points[2].map((v, i) => v - points[0][i]);
      const n = [
        a[1] * c[2] - a[2] * c[1],
        a[2] * c[0] - a[0] * c[2],
        a[0] * c[1] - a[1] * c[0],
      ];
      const len = Math.hypot(...n) || 1;
      return {
        points,
        shade:
          0.78 +
          Math.max(0, (-n[1] * 0.8 + n[0] * 0.2 + n[2] * 0.3) / len) * 0.2,
        smooth: true,
      };
    });
  const p = ASSEMBLY_PARTS[b.part],
    x = p.w * 10,
    z = p.d * 10,
    cz = p.centerZ || 0,
    top = p.bottom - p.h * 8,
    bottom = p.bottom;
  const result: Face[] = [];
  const face = (
    points: V3[],
    shade: number,
    detail?: Face['detail'],
    smooth = false,
  ) =>
    result.push({
      points: points.map((pt) => worldPoint(b.pose!, pt)),
      shade,
      detail,
      smooth,
    });
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
    const zs = Array.from({ length: 17 }, (_, i) => -z + (i * z) / 8);
    const y = (zz: number) => curveTopY(p, zz);
    for (let i = 0; i < 16; i++)
      face(
        [
          [-x, y(zs[i]), zs[i]],
          [x, y(zs[i]), zs[i]],
          [x, y(zs[i + 1]), zs[i + 1]],
          [-x, y(zs[i + 1]), zs[i + 1]],
        ],
        0.94 + i * 0.003,
        undefined,
        true,
      );
    const underside: [number, number][] = [];
    for (let row = 0; row < p.d; row++) {
      const z0 = -z + row * 20,
        z1 = z0 + 20,
        floor = curveFloorY(p, (z0 + z1) / 2);
      underside.push([floor, z0], [floor, z1]);
    }
    for (const xx of [-x, x])
      face(
        [
          ...underside.map(([yy, zz]) => [xx, yy, zz] as V3),
          ...zs.toReversed().map((zz) => [xx, y(zz), zz] as V3),
        ],
        xx > 0 ? 0.78 : 0.88,
      );
    for (const zz of [-z, z])
      face(
        [
          [-x, curveFloorY(p, zz), zz],
          [x, curveFloorY(p, zz), zz],
          [x, y(zz), zz],
          [-x, y(zz), zz],
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
  }
  const stud = (center: V3, normal: V3, u: V3, v: V3) => {
    const ring = Array.from(
      { length: 32 },
      (_, i) =>
        center.map(
          (c, k) =>
            c +
            normal[k] * 4 +
            6 *
              (u[k] * Math.cos((i * Math.PI) / 16) +
                v[k] * Math.sin((i * Math.PI) / 16)),
        ) as V3,
    );
    // The diagram renderer takes the projected convex hull of these two rings.
    face(
      [...ring, ...ring.map((a) => a.map((n, k) => n - normal[k] * 4) as V3)],
      0.86,
      'stud-side',
    );
    face(ring, 0.98, 'stud-top');
  };
  if (['brick', 'plate', 'side'].includes(p.kind) || p.kind === 'slope')
    for (let i = 0; i < p.w; i++)
      for (let j = 0; j < p.d; j++) {
        if (p.kind === 'slope' && j !== p.d - 1) continue;
        stud(
          [(i + 0.5 - p.w / 2) * 20, 0, (j + 0.5 - p.d / 2) * 20 + cz],
          [0, -1, 0],
          [1, 0, 0],
          [0, 0, 1],
        );
      }
  if (p.kind === 'side') stud([0, 10, -10], [0, 0, -1], [1, 0, 0], [0, 1, 0]);
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
    brickFaces(b)
      .filter(
        (f) => f.detail !== 'stud-side' && (list.length <= 1200 || !f.detail),
      )
      .map((f) => {
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
  // Large reconstructed buildings have more vertices than a JS call's argument limit.
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const face of projected)
    for (const [x, y] of face.points) {
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  const minX = left - 16,
    minY = top - 16,
    w = right - minX + 16,
    h = bottom - minY + 16;
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
        : normal[2] > 0
          ? '侧装 · 朝前'
          : '侧装 · 朝后';
  if (p.curveProfile === 'arch') {
    const direction = transform(b.pose.matrix, [0, 0, 1]);
    return `圆弧顶朝上，弧线沿${direction[0] ? '左右' : '前后'}方向`;
  }
  if (p.curveProfile === 'double')
    return `中央弧顶朝上，长边${b.w > b.d ? '横放' : '竖放'}`;
  if (p.kind === 'curve' || p.kind === 'slope') {
    const high = transform(b.pose.matrix, [0, 0, 1]);
    return `高边朝${high[0] > 0 ? '右' : high[0] < 0 ? '左' : high[2] > 0 ? '前' : '后'}`;
  }
  if (p.kind === 'side') {
    const side = transform(b.pose.matrix, [0, 0, -1]);
    return `侧凸点朝${side[0] < 0 ? '左' : side[0] > 0 ? '右' : side[2] > 0 ? '前' : '后'}`;
  }
  return `${b.w} × ${b.d} 凸点`;
}
