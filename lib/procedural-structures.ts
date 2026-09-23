import type { Brick } from './brick-engine.ts';

type Occupied = (x: number, y: number, z: number) => boolean;

function canPlace(occupied: Occupied, x: number, y: number, z: number, w: number, h: number, d: number) {
  if (x < 0 || y < 0 || z < 0) return false;
  for (let yy = y; yy < y + h; yy++)
    for (let zz = z; zz < z + d; zz++)
      for (let xx = x; xx < x + w; xx++)
        if (!occupied(xx, yy, zz) || (y > 0 && !occupied(xx, y - 1, zz))) return false;
  return true;
}

function brick(part: string, x: number, y: number, z: number, w: number, h: number, d: number, color: number): Brick {
  return { id: 0, part, x, y, z, w, h, d, color, support: false, installation: '程序化塔身结构，与下层重复单元对齐。' };
}

/** Creates a deterministic open tower scaffold from the detected voxel envelope. */
export function generateLatticeTowerScaffold(
  width: number,
  height: number,
  depth: number,
  occupied: Occupied,
  color = 7,
): Brick[] {
  const out: Brick[] = [];
  const seen = new Set<string>();
  const add = (part: string, x: number, y: number, z: number, w: number, h: number, d: number) => {
    const id = `${x},${y},${z},${w},${h},${d}`;
    if (seen.has(id) || !canPlace(occupied, x, y, z, w, h, d)) return;
    seen.add(id); out.push(brick(part, x, y, z, w, h, d, color));
  };
  const left = Math.max(1, Math.floor(width * 0.18));
  const right = Math.max(left + 1, width - left - 1);
  const front = Math.max(1, Math.floor(depth * 0.18));
  const back = Math.max(front + 1, depth - front - 1);
  const top = Math.max(3, height - 3);
  const stride = Math.max(3, Math.floor(height / 8));
  // Four tapered legs. Their x/z positions move toward the centre with height.
  for (let y = 2; y < top; y += stride) {
    const t = (y - 2) / Math.max(1, top - 2);
    const xs = [Math.round(left * (1 - t) + width * 0.5 * t), Math.round(right * (1 - t) + width * 0.5 * t)];
    const zs = [Math.round(front * (1 - t) + depth * 0.5 * t), Math.round(back * (1 - t) + depth * 0.5 * t)];
    for (const x of xs) for (const z of zs) add('3005', x, y, z, 1, Math.min(3, top - y), 1);
    // Alternating horizontal braces retain the open lattice rhythm.
    if (y + 1 < top) {
      add('3710', xs[0], y + 1, zs[0], Math.max(1, xs[1] - xs[0] + 1), 1, 1);
      add('3710', xs[0], y + 1, zs[1], Math.max(1, xs[1] - xs[0] + 1), 1, 1);
    }
  }
  // A strong middle platform and a small spire make the silhouette legible.
  const platformY = Math.max(3, Math.floor(height * 0.48));
  for (let x = left; x < right; x += 4) add('3710', x, platformY, front, Math.min(4, right - x + 1), 1, 1);
  for (let y = top; y < height; y += 3) add('3005', Math.floor(width / 2), y, Math.floor(depth / 2), 1, Math.min(3, height - y), 1);
  return out;
}

