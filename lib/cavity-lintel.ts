import type { Brick } from './brick-engine.ts';
import type { BBox3d } from './scene/scene-types.ts';

type Cell = { color: number; support: boolean };

/** Install catalog plates over an image-supported opening. The two side
 * corbels bond to the jambs; the 2 x 8 plate bonds to both corbels. */
export function installCavityLintel(
  cells: Map<string, Cell>,
  source: Map<string, Cell>,
  box: BBox3d,
  axis: 0 | 2,
  color: number,
): Brick[] {
  const cross = axis === 0 ? 2 : 0;
  const left = box.min[cross], right = box.max[cross], span = right - left;
  if (span < 6 || span > 10) return [];
  const fixed: Brick[] = [];
  const put = (part: string, start: number, run: number, y: number, length: number) => {
    const b: Brick = {
      id: 0, part, x: axis === 2 ? start : run, z: axis === 2 ? run : start,
      y, w: axis === 2 ? length : 2, d: axis === 2 ? 2 : length, h: 1, color,
      installation: part === '3020'
        ? '把薄板外侧的两列凸点扣在入口侧壁顶面，内侧两列伸向入口，作为上方跨梁的承托。左右托板装好后再安装跨梁。'
        : '将整块 2 × 8 薄板横跨入口，两端分别扣在左右托板上，向下按紧；保持雕像两侧和前方通道畅通。',
    };
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++) cells.set(`${x},${y},${z}`, { color, support: false });
    fixed.push(b);
  };
  for (let run = box.min[axis]; run + 2 <= box.max[axis]; run += 2) {
    let roof = false;
    for (let u = left; u < right && !roof; u++)
      for (let y = box.max[1]; y <= box.max[1] + 8 && !roof; y++)
        for (let r = run; r < run + 2; r++)
          if (source.has(axis === 2 ? `${u},${y},${r}` : `${r},${y},${u}`)) roof = true;
    if (!roof) continue;
    const shelfY = box.max[1];
    // Fill only the two jamb bearing areas. Never grow a support in the opening.
    for (const start of [left - 2, right])
      for (let u = start; u < start + 2; u++)
        for (let r = run; r < run + 2; r++)
          for (let y = shelfY - 1; y >= 2; y--) {
            const key = axis === 2 ? `${u},${y},${r}` : `${r},${y},${u}`;
            if (cells.has(key)) break;
            cells.set(key, { color, support: true });
          }
    if (span > 6) {
      put('3020', left - 2, run, shelfY, 4);
      put('3020', right - 2, run, shelfY, 4);
      put('3034', Math.floor((left + right - 8) / 2), run, shelfY + 1, 8);
    } else put('3034', left - 1, run, shelfY, 8);
  }
  return fixed;
}
