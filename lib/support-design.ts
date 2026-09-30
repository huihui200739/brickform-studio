import type { Brick } from './brick-engine.ts';
import { gridConnections, groundedIds } from './grid-connections.ts';
import { ASSEMBLY_PARTS } from './assembly-catalog.ts';

type Cells = Map<string, { color: number; support: boolean }>;

/** Connect disconnected catalog groups instead of placing a column below every
 * overhanging piece. An upper stud connection is part of the same rigid graph.
 * These are connectivity repairs, not a proof of tensile strength or stability. */
export function connectUnsupportedGroups(
  cells: Cells,
  bricks: Brick[],
  depth: number,
  color: number,
  blocked?: (x: number, y: number, z: number) => boolean,
) {
  const links = gridConnections(bricks),
    grounded = groundedIds(bricks, links);
  const owner = new Map<string, number>();
  for (const b of bricks)
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        for (let y = b.y; y < b.y + b.h; y++) owner.set(`${x},${y},${z}`, b.id);
  const byId = new Map(bricks.map((b) => [b.id, b])),
    seen = new Set(grounded);
  let groups = 0,
    columns = 0,
    addedCells = 0;
  for (const seed of bricks) {
    if (seen.has(seed.id)) continue;
    groups++;
    const component = new Set<number>(),
      queue = [seed.id];
    while (queue.length) {
      const id = queue.pop()!;
      if (component.has(id)) continue;
      component.add(id);
      seen.add(id);
      queue.push(...links.get(id)!);
    }
    let best:
      | { x: number; z: number; bottom: number; top: number; score: number }
      | undefined;
    for (const id of component) {
      const b = byId.get(id)!;
      for (let x = b.x; x < b.x + b.w; x++)
        for (let z = b.z; z < b.z + b.d; z++) {
          let bottom = b.y - 1;
          while (bottom >= 0 && !cells.has(`${x},${bottom},${z}`)) bottom--;
          const other = owner.get(`${x},${bottom},${z}`);
          if (
            bottom < 0 ||
            other === undefined ||
            component.has(other) ||
            bottom === b.y - 1
          )
            continue;
          const supportingPart = ASSEMBLY_PARTS[byId.get(other)!.part];
          if (
            !supportingPart ||
            !['brick', 'plate'].includes(supportingPart.kind)
          )
            continue;
          let forbidden = false;
          for (let y = bottom + 1; y < b.y; y++)
            if (blocked?.(x, y, z)) {
              forbidden = true;
              break;
            }
          if (forbidden) continue;
          const length = b.y - bottom - 1;
          // Prefer a short connection to any existing group; do not fill a
          // long visible void merely because its base is already grounded.
          const score =
            length ** 2 +
            Math.abs(z + 0.5 - depth / 2) * 0.2 +
            (grounded.has(other) ? 0 : 0.1);
          if (!best || score < best.score)
            best = { x, z, bottom, top: b.y, score };
        }
    }
    if (!best) continue;
    columns++;
    for (let y = best.bottom + 1; y < best.top; y++) {
      const key = `${best.x},${y},${best.z}`;
      if (!cells.has(key)) {
        cells.set(key, { color, support: true });
        addedCells++;
      }
    }
  }
  return { groups, columns, addedCells };
}
