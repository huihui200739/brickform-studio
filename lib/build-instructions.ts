import { PALETTE, PARTS, type Model, type Brick } from './brick-engine.ts';
import {
  ASSEMBLY_PARTS,
  IDENTITY,
  rotate,
  transform,
  type Pose,
  type V3,
} from './assembly-catalog.ts';
import { brickFaces, orientationLabel } from './assembly-diagram.ts';
import { connectors } from './assembly-validation.ts';

export const escapeText = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
export function instructionModel(model: Model): Model {
  if (model.assembly) return model;
  return {
    ...model,
    bricks: model.bricks.map((b) => {
      const p = ASSEMBLY_PARTS[b.part],
        q = p.w === b.w ? 0 : 1,
        matrix = rotate(q);
      const center = transform(matrix, [0, p.bottom - p.h * 4, p.centerZ || 0]);
      const pose: Pose = {
        matrix,
        position: [
          (b.x + b.w / 2 - model.width / 2) * 20 - center[0],
          -(b.y + b.h / 2) * 8 - center[1],
          (b.z + b.d / 2 - model.depth / 2) * 20 - center[2],
        ],
      };
      return { ...b, pose, step: model.levels.indexOf(b.y) };
    }),
    assembly: {
      sections: [],
      steps: model.levels.map((y, i) => ({
        name: `第 ${i + 1} 层`,
        description:
          y === 0
            ? '先在平面上摆好第一层。'
            : '沿用同一个方向，连接到下层凸点。',
        section: 'body',
      })),
      reference: '图片轮廓浮雕；按图示坐标与顺序搭建。',
      parameters: { bodyLength: 0, headWidth: 0, bodyColor: 3, beakColor: 2 },
    },
  };
}
export function stageBricks(model: Model, stage: number) {
  return model.bricks
    .filter((b) => b.step === stage)
    .sort((a, b) => a.id - b.id);
}
export function cleanStageName(name: string) {
  return name.replace(/^第\s*\d+\s*[步层]\s*[·：:]?\s*/, '') || '继续搭建';
}
export function isSideMounted(b: Brick) {
  return (
    !!b.pose && Math.abs(transform(b.pose.matrix, [0, -1, 0])[1] + 1) > 0.001
  );
}
function gridOrigin(model: Model) {
  const regular = model.bricks.filter((b) => !isSideMounted(b));
  return {
    x: Math.min(...regular.map((b) => b.x)),
    z: Math.min(...regular.map((b) => b.z)),
  };
}
function column(n: number): string {
  return n < 26
    ? String.fromCharCode(65 + n)
    : column(Math.floor(n / 26) - 1) + column(n % 26);
}
export function gridAddress(model: Model, b: Brick) {
  if (isSideMounted(b)) return '侧面连接点';
  const origin = gridOrigin(model);
  return `${column(Math.max(0, Math.round(b.x - origin.x)))}${Math.round(b.z - origin.z) + 1}`;
}
export function installationText(model: Model, b: Brick) {
  const kind = ASSEMBLY_PARTS[b.part].kind;
  if (isSideMounted(b))
    return `${orientationLabel(b)}。找到侧面朝外的小圆凸点，把零件背面的孔对准凸点，向身体方向按紧；不用向下压。`;
  const location = `把左后角对准俯视定位图的 ${gridAddress(model, b)} 格`;
  const shape =
    kind === 'curve' || kind === 'slope'
      ? `${orientationLabel(b)}。`
      : kind === 'side'
        ? `${orientationLabel(b)}，顶部凸点向上。`
        : kind === 'tile' || kind === 'round'
          ? '光滑的一面朝上。'
          : `凸点朝上，${b.w > b.d ? '长边横放（左右方向）' : b.d > b.w ? '长边竖放（前后方向）' : '四边对齐网格'}。`;
  return `${location}。${shape}${b.y === 0 ? '先平放，下一组会把底部连起来。' : '对准下方凸点后，垂直按紧。'}`;
}
export function placementContext(
  model: Model,
  stage: number,
  index: number,
  overview = false,
) {
  const batch = stageBricks(model, stage),
    active = batch[Math.max(0, Math.min(batch.length - 1, index))];
  const visible = model.bricks.filter(
    (b) =>
      b.step! < stage || (b.step === stage && (overview || b.id <= active?.id)),
  );
  return { batch, active, visible };
}
export function connectedBelow(model: Model, b: Brick) {
  const sockets = connectors(b).sockets;
  return model.bricks.filter(
    (p) =>
      p.id < b.id &&
      connectors(p).studs.some((c) =>
        sockets.some(
          (s) =>
            s.point.every((v, i) => Math.abs(v - c.point[i]) < 0.001) &&
            s.normal.every((v, i) => Math.abs(v - c.normal[i]) < 0.001),
        ),
      ),
  );
}
const num = (v: number) => v.toFixed(1);
function sceneSVG(
  bricks: Brick[],
  activeId: number | undefined,
  opts: { thumbnail?: boolean; side?: number } = {},
) {
  if (!bricks.length) return '';
  const side = opts.side || 1;
  const project = ([x, y, z]: V3) => [
    (side * x - z) * 0.707,
    (side * x + z) * 0.32 + y * 0.85,
  ];
  const polys = bricks.flatMap((b) =>
    brickFaces(b)
      .filter(
        (f) =>
          b.id === activeId ||
          opts.thumbnail ||
          (f.shade !== 0.96 && f.shade !== 0.95),
      )
      .map((f) => {
        const active = b.id === activeId || !!opts.thumbnail,
          rgb = active ? PALETTE[b.color].hex : '#dbe2e8';
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
          points: f.points.map(project),
          depth:
            f.points.reduce((s, p) => s + side * p[0] - p[1] + p[2], 0) /
            f.points.length,
          color,
          active,
        };
      }),
  );
  const pts = polys.flatMap((p) => p.points),
    xs = pts.map((p) => p[0]),
    ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs),
    minY = Math.min(...ys),
    maxX = Math.max(...xs),
    maxY = Math.max(...ys);
  const pad = Math.max(12, (maxX - minX) * 0.08),
    width = maxX - minX + pad * 2,
    height = maxY - minY + pad * 2;
  const active = bricks.find((b) => b.id === activeId);
  let marker = '';
  if (active && !opts.thumbnail) {
    const fs = brickFaces(active);
    const face =
      fs.find((f) => f.shade === 1) || fs[Math.min(3, fs.length - 1)];
    const faces = face.points.map(project);
    const ax = faces.reduce((s, p) => s + p[0], 0) / faces.length,
      ay = faces.reduce((s, p) => s + p[1], 0) / faces.length;
    const r = width * 0.021,
      sy = minY - pad * 0.5,
      sx = Math.min(maxX, Math.max(minX, ax + width * 0.16));
    marker = `<path d="M ${num(sx)} ${num(sy + r)} L ${num(ax)} ${num(ay)}" stroke="#dc6025" stroke-width="${num(width * 0.005)}" fill="none"/><circle cx="${num(ax)}" cy="${num(ay)}" r="${num(r * 0.45)}" fill="#dc6025"/><circle cx="${num(sx)}" cy="${num(sy)}" r="${num(r)}" fill="#dc6025"/><text x="${num(sx)}" y="${num(sy + r * 0.36)}" text-anchor="middle" fill="white" font-family="Arial" font-size="${num(r * 1.25)}">1</text>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(minX - pad)} ${num(minY - pad)} ${num(width)} ${num(height)}" role="img" aria-label="${opts.thumbnail ? '待取零件外形' : '安装位置局部放大图，箭头指向本次安装的零件'}"><rect x="${num(minX - pad)}" y="${num(minY - pad)}" width="${num(width)}" height="${num(height)}" rx="5" fill="#f7f9fb"/>${polys
    .sort((a, b) => Number(a.active) - Number(b.active) || a.depth - b.depth)
    .map(
      (f) =>
        `<polygon points="${f.points.map((p) => p.map(num).join(',')).join(' ')}" fill="${f.color}" stroke="${f.active ? '#51462b' : '#b3bec8'}" stroke-width="${opts.thumbnail ? 0.3 : 0.45}" stroke-linejoin="round"/>`,
    )
    .join('')}${marker}</svg>`;
}
export function partThumbnail(b: Brick) {
  // Show the part in its normal upright orientation so its shape is easy to find.
  const p = ASSEMBLY_PARTS[b.part];
  const matrix = p.kind === 'side' ? rotate(2) : IDENTITY;
  return sceneSVG([{ ...b, pose: { position: [0, 0, 0], matrix } }], b.id, {
    thumbnail: true,
  });
}
export function detailDiagram(model: Model, stage: number, index: number) {
  const { active, visible } = placementContext(model, stage, index);
  if (!active) return '';
  const distance = (b: Brick) =>
    Math.hypot(
      b.x + b.w / 2 - (active.x + active.w / 2),
      b.z + b.d / 2 - (active.z + active.d / 2),
      (b.y - active.y) * 0.4,
    );
  const near = visible
    .filter((b) => b.id === active.id || distance(b) < 6)
    .sort((a, b) => distance(a) - distance(b))
    .slice(0, 18);
  const normal = transform(active.pose!.matrix, [0, -1, 0]);
  return sceneSVG(near, active.id, { side: normal[0] < 0 ? -1 : 1 });
}
export function topDiagram(
  model: Model,
  stage: number,
  index: number,
  overview = false,
) {
  const { batch, active, visible } = placementContext(
    model,
    stage,
    index,
    overview,
  );
  if (!active) return '';
  const origin = gridOrigin(model),
    unit = 22,
    pad = 37;
  const cols = Math.ceil(model.width),
    rows = Math.ceil(model.depth),
    width = cols * unit + pad * 2,
    height = rows * unit + pad * 2;
  const px = (x: number) => pad + (x - origin.x) * unit,
    py = (z: number) => pad + (rows - (z - origin.z)) * unit;
  const rect = (b: Brick, active = false) =>
    `<rect x="${num(px(b.x))}" y="${num(py(b.z + b.d))}" width="${num(b.w * unit)}" height="${num(b.d * unit)}" rx="1.5" fill="${active ? PALETTE[b.color].hex : '#dce3e9'}" stroke="${active ? '#bd4b12' : '#aebbc6'}" stroke-width="${active ? 2.2 : 0.7}"/>`;
  let grid = '';
  for (let x = 0; x <= cols; x++)
    grid += `<path d="M ${pad + x * unit} ${pad} v ${rows * unit}" stroke="#a5b4c3" stroke-width=".45" stroke-dasharray="2 3"/>`;
  for (let z = 0; z <= rows; z++)
    grid += `<path d="M ${pad} ${pad + z * unit} h ${cols * unit}" stroke="#a5b4c3" stroke-width=".45" stroke-dasharray="2 3"/>`;
  for (let x = 0; x < cols; x++)
    grid += `<text x="${pad + (x + 0.5) * unit}" y="${height - 12}" text-anchor="middle" font-size="14" fill="#4b6374">${column(x)}</text>`;
  for (let z = 0; z < rows; z++)
    grid += `<text x="20" y="${py(origin.z + z + 0.5) + 4}" text-anchor="middle" font-size="14" fill="#4b6374">${z + 1}</text>`;
  const current = overview ? batch : [active];
  const badges = overview
    ? current
        .map(
          (b, i) =>
            `<text x="${num(px(b.x + b.w / 2))}" y="${num(py(b.z + b.d / 2) + 4)}" font-size="11" text-anchor="middle" fill="${[1, 2, 4, 5].includes(b.color) ? 'white' : '#352d17'}">${i + 1}</text>`,
        )
        .join('')
    : '';
  const target =
    !overview && !isSideMounted(active)
      ? `<circle cx="${num(px(active.x) + 4)}" cy="${num(py(active.z) - 4)}" r="3" fill="#bd4b12"/>`
      : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${overview ? '整组零件编号总览' : '俯视定位图，橙色外框为安装位置'}" font-family="Arial,sans-serif"><rect width="${width}" height="${height}" rx="8" fill="#f7f9fb"/><text x="${width / 2}" y="17" text-anchor="middle" font-size="14" fill="#345769">↑ 前方（鸭嘴）</text>${visible
    .slice()
    .sort((a, b) => a.y - b.y || a.id - b.id)
    .map((b) =>
      rect(
        b,
        current.some((c) => c.id === b.id),
      ),
    )
    .join(
      '',
    )}${grid}${current.map((b) => `<rect x="${num(px(b.x))}" y="${num(py(b.z + b.d))}" width="${num(b.w * unit)}" height="${num(b.d * unit)}" fill="none" stroke="#bd4b12" stroke-width="2"/>`).join('')}${badges}${target}</svg>`;
}
export function partDescription(b: Brick) {
  return `${PALETTE[b.color].name} · ${PARTS[b.part]}`;
}
