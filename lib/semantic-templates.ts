import { ASSEMBLY_PARTS, IDENTITY } from './assembly-catalog.ts';
import type { Brick } from './brick-engine.ts';
import type { SceneElementInstance } from './scene-elements.ts';

// Real ordinary parts in LDraw units. No scaled special meshes or placeholder BOMs.
function part(
  id: string,
  color: number,
  x: number,
  y: number,
  z: number,
): Brick {
  const p = ASSEMBLY_PARTS[id];
  return {
    id: 0,
    part: id,
    color,
    x: 0,
    y: 0,
    z: 0,
    w: 0,
    h: 0,
    d: 0,
    pose: { position: [x * 20, -y * 8, z * 20], matrix: IDENTITY },
    installation: `安装${p.name}，与下层凸点对齐。`,
  };
}
export function simplifiedTree(): Brick[] {
  return [
    part('3022', 7, 0, 1, 0),
    part('3005', 9, -0.5, 4, -0.5),
    part('3003', 5, 0, 7, 0),
    part('3022', 5, 0, 8, 0),
  ];
}
export function reliefStatue(instance?: SceneElementInstance): Brick[] {
  if (!instance?.imageMask || !instance.imageMaskSize)
    throw Error('浮雕模板缺少实例轮廓');
  const [mw, mh] = instance.imageMaskSize,
    mask = instance.imageMask;
  if (mask.length !== mw * mh || !mw || !mh) throw Error('实例轮廓尺寸无效');
  const w = Math.min(
    8,
    Math.max(2, Math.round(instance.scaleHint?.width || 4)),
  );
  const h = Math.min(
    48,
    Math.max(4, Math.round(instance.scaleHint?.height || 16)),
  );
  const bits = new Uint8Array(w * h);
  // Area occupancy resampling preserves thin silhouette features at small resolutions.
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0,
        total = 0;
      for (
        let py = Math.floor((y * mh) / h);
        py <
        Math.max(Math.floor((y * mh) / h) + 1, Math.ceil(((y + 1) * mh) / h));
        py++
      )
        for (
          let px = Math.floor((x * mw) / w);
          px <
          Math.max(Math.floor((x * mw) / w) + 1, Math.ceil(((x + 1) * mw) / w));
          px++
        ) {
          n += mask[Math.min(mh - 1, py) * mw + Math.min(mw - 1, px)] ? 1 : 0;
          total++;
        }
      bits[(h - 1 - y) * w + x] = n / total >= 0.25 ? 1 : 0;
    }
  // Trim empty bottom rows to the detected base. Never infer another location.
  let bottom = 0;
  while (bottom < h && !bits.slice(bottom * w, (bottom + 1) * w).some(Boolean))
    bottom++;
  if (bottom === h) throw Error('实例轮廓为空');
  const base = w <= 2 ? '3022' : w <= 4 ? '3020' : '3034';
  const bricks = [part(base, 7, 0, 1, 0)];
  let previous = new Uint8Array(w).fill(1);
  for (let y = bottom; y < h; y++) {
    const current = bits.slice(y * w, (y + 1) * w);
    for (let x = 0; x < w;) {
      if (!current[x]) {
        x++;
        continue;
      }
      let end = x;
      while (end < w && current[end]) end++;
      for (; x < end;) {
        const width = end - x >= 4 ? 4 : end - x >= 2 ? 2 : 1;
        if (!previous.slice(x, x + width).some(Boolean))
          throw Error('轮廓悬挑未通过逐层承托检查');
        // Align to integer studs on the centred 2/4/8-wide mounting plate.
        const left =
          -ASSEMBLY_PARTS[base].w / 2 +
          Math.floor((ASSEMBLY_PARTS[base].w - w) / 2);
        bricks.push(
          part(
            width === 4 ? '3710' : width === 2 ? '3023' : '3024',
            11,
            left + x + width / 2,
            y - bottom + 2,
            -0.5,
          ),
        );
        x += width;
      }
    }
    previous = current;
  }
  return bricks;
}
