import type { Brick, CavityLintelConstruction } from './brick-engine.ts';
import type { BBox3d } from './scene/scene-types.ts';

type Cell = { color: number; support: boolean };
export type CavityLintelOpening = Pick<
  CavityLintelConstruction,
  'openingId' | 'regionId'
>;

/** Install catalog plates over an image-supported opening. The two side
 * corbels bond to the jambs; the 2 x 8 plate bonds to both corbels. */
export function installCavityLintel(
  cells: Map<string, Cell>,
  source: Map<string, Cell>,
  box: BBox3d,
  axis: 0 | 2,
  color: number,
  blocked?: (x: number, y: number, z: number) => boolean,
  opening?: CavityLintelOpening,
): Brick[] {
  const cross = axis === 0 ? 2 : 0;
  const left = box.min[cross],
    right = box.max[cross],
    span = right - left;
  if (span < 6 || span > 16) return [];
  const fixed: Brick[] = [];
  const put = (
    part: string,
    start: number,
    run: number,
    y: number,
    length: number,
    role: CavityLintelConstruction['role'],
  ) => {
    const b: Brick = {
      id: 0,
      part,
      x: axis === 2 ? start : run,
      z: axis === 2 ? run : start,
      y,
      w: axis === 2 ? length : 2,
      d: axis === 2 ? 2 : length,
      h: 1,
      color,
      ...(opening
        ? {
            construction: {
              ...opening,
              origin: 'cavity-lintel' as const,
              role,
            },
          }
        : {}),
      installation:
        part === '3020' && y === box.max[1]
          ? '把薄板外侧的两列凸点扣在入口侧壁顶面，内侧两列伸向入口，作为上方跨梁的承托。左右托板装好后再安装跨梁。'
          : span > 10
            ? '按本步位置扣上薄板，接在下方托板或梁板的凸点上。先装两侧梁板，再装上层连接板；该多层跨梁的承载能力仍需实物复核。'
            : '将整块 2 × 8 薄板横跨入口，两端分别扣在左右托板上，向下按紧；保持雕像两侧和前方通道畅通。',
    };
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        cells.set(`${x},${y},${z}`, { color, support: false });
    fixed.push(b);
  };
  // A final two-stud plate may extend one stud beyond an odd cavity depth.
  // Leaving that last strip uncovered made its roof pieces unsupported.
  for (let run = box.min[axis]; run < box.max[axis]; run += 2) {
    let roof = false;
    for (let u = left; u < right && !roof; u++)
      for (let y = box.max[1]; y <= box.max[1] + 8 && !roof; y++)
        for (let r = run; r < run + 2; r++)
          if (source.has(axis === 2 ? `${u},${y},${r}` : `${r},${y},${u}`))
            roof = true;
    if (!roof) continue;
    const shelfY = box.max[1];
    // A roof sample does not authorize a new column in another object's
    // foreground clearance. Check both complete bearing paths before writing.
    let prohibited = false;
    for (const start of [left - 2, right])
      for (let u = start; u < start + 2; u++)
        for (let r = run; r < run + 2; r++)
          for (let y = shelfY - 1; y >= 2; y--) {
            const x = axis === 2 ? u : r,
              z = axis === 2 ? r : u;
            if (cells.has(`${x},${y},${z}`)) break;
            if (blocked?.(x, y, z)) prohibited = true;
          }
    if (prohibited) continue;
    // Replace the lower roof courses with the actual corbel/beam layout.
    // Leaving source voxels under the higher bridge created unsupported
    // one-stud fragments at exactly the cavity ceiling.
    const replacedCourses = span > 10 ? 2 : span > 6 ? 1 : 0;
    for (let u = left; u < right; u++)
      for (let r = run; r < run + 2; r++)
        for (let y = shelfY; y < shelfY + replacedCourses; y++)
          cells.delete(axis === 2 ? `${u},${y},${r}` : `${r},${y},${u}`);
    // Fill only the two jamb bearing areas. Never grow a support in the opening.
    for (const start of [left - 2, right])
      for (let u = start; u < start + 2; u++)
        for (let r = run; r < run + 2; r++)
          for (let y = shelfY - 1; y >= 2; y--) {
            const key = axis === 2 ? `${u},${y},${r}` : `${r},${y},${u}`;
            if (cells.has(key)) break;
            cells.set(key, { color, support: true });
          }
    if (span > 10) {
      // Span follows the observed opening. Grow the beam above it, never a
      // pillar inside it. Two cantilevers and an overlapping upper plate use
      // catalog dimensions; the structural checker verifies their contacts.
      put('3020', left - 2, run, shelfY, 4, 'corbel');
      put('3020', right - 2, run, shelfY, 4, 'corbel');
      put('3034', left - 2, run, shelfY + 1, 8, 'bridge');
      if (span >= 12) put('3034', right - 6, run, shelfY + 1, 8, 'bridge');
      else put('3020', right - 2, run, shelfY + 1, 4, 'bridge');
      put(
        '3034',
        Math.ceil((left + right - 8) / 2),
        run,
        shelfY + 2,
        8,
        'bond',
      );
    } else if (span > 6) {
      put('3020', left - 2, run, shelfY, 4, 'corbel');
      put('3020', right - 2, run, shelfY, 4, 'corbel');
      put(
        '3034',
        Math.floor((left + right - 8) / 2),
        run,
        shelfY + 1,
        8,
        'bridge',
      );
    } else put('3034', left - 1, run, shelfY, 8, 'bridge');
  }
  return fixed;
}
