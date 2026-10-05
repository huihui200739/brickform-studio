import type { Brick } from './brick-engine.ts';
import { gridConnections } from './grid-connections.ts';

export type AssemblyMove = {
  direction: 'down' | 'up';
  parentIds: number[];
  clearancePlates: number;
};

/** Peel removable parts from the complete model, then reverse the sequence.
 * Every retained prefix stays connected to its floor and every move has a
 * one-plate final approach. Hand access, full paths and joint forces remain
 * unverified; this is a bounded grid-part planner, not a stability certificate. */
export function planGridAssembly(bricks: Brick[]) {
  const links = gridConnections(bricks),
    byId = new Map(bricks.map((b) => [b.id, b]));
  const remaining = new Set(byId.keys());
  const removed: Array<{ brick: Brick; move: AssemblyMove }> = [];
  const bodies = new Map<string, number>();
  for (const b of bricks)
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        for (let y = b.y; y < b.y + b.h; y++)
          bodies.set(`${x},${y},${z}`, b.id);
  const blockers = new Map<number, { down: Set<number>; up: Set<number> }>();
  for (const b of bricks) {
    const down = new Set<number>(),
      up = new Set<number>();
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++) {
        const above = bodies.get(`${x},${b.y + b.h},${z}`);
        const below = bodies.get(`${x},${b.y - 1},${z}`);
        if (above !== undefined) down.add(above);
        if (below !== undefined) up.add(below);
      }
    blockers.set(b.id, { down, up });
  }
  const root = Number.MIN_SAFE_INTEGER;
  const bases = bricks.filter((b) => b.y === 0).map((b) => b.id);
  const criticalParts = () => {
    const discovery = new Map<number, number>(),
      low = new Map<number, number>();
    const critical = new Set<number>();
    let clock = 0;
    const frame = (id: number, parent: number | undefined) => {
      discovery.set(id, ++clock);
      low.set(id, clock);
      const neighbors =
        id === root
          ? bases
          : [...links.get(id)!, ...(byId.get(id)!.y === 0 ? [root] : [])];
      return { id, parent, neighbors, next: 0, children: 0 };
    };
    // Large high-detail models can have thousands of consecutive graph
    // vertices. Use explicit DFS frames so browser/worker call-stack limits
    // cannot prevent conversion. Neighbor order and articulation rules remain
    // identical to the recursive traversal.
    const stack = [frame(root, undefined)];
    while (stack.length) {
      const current = stack[stack.length - 1];
      const { id, parent, neighbors } = current;
      if (current.next < neighbors.length) {
        const other = neighbors[current.next++];
        if (other !== root && !remaining.has(other)) continue;
        if (!discovery.has(other)) {
          current.children++;
          stack.push(frame(other, id));
        } else if (other !== parent)
          low.set(id, Math.min(low.get(id)!, discovery.get(other)!));
        continue;
      }
      stack.pop();
      if (parent === undefined) {
        if (current.children > 1) critical.add(id);
      } else {
        low.set(parent, Math.min(low.get(parent)!, low.get(id)!));
        if (
          stack[stack.length - 1].parent !== undefined &&
          low.get(id)! >= discovery.get(parent)!
        )
          critical.add(parent);
      }
    }
    return { critical, reachable: discovery };
  };
  // Highest-first removal favors familiar bottom-up building after reversal.
  const preference = [...bricks].sort((a, b) => b.y - a.y || b.id - a.id);
  while (remaining.size) {
    const { critical, reachable } = criticalParts();
    let chosen: { brick: Brick; move: AssemblyMove } | undefined;
    for (const b of preference) {
      if (!remaining.has(b.id) || critical.has(b.id) || !reachable.has(b.id))
        continue;
      const neighbors = [...links.get(b.id)!].filter((id) => remaining.has(id));
      const below = neighbors.filter(
        (id) => byId.get(id)!.y + byId.get(id)!.h === b.y,
      );
      const above = neighbors.filter((id) => byId.get(id)!.y === b.y + b.h);
      const clear = (direction: 'down' | 'up') =>
        ![...blockers.get(b.id)![direction]].some((id) => remaining.has(id));
      let move: AssemblyMove;
      if ((b.y === 0 || below.length) && clear('down'))
        move = {
          direction: 'down',
          parentIds: below,
          clearancePlates: b.y === 0 ? 0 : 1,
        };
      else if (above.length && b.y > 0 && clear('up'))
        move = { direction: 'up', parentIds: above, clearancePlates: 1 };
      else continue;
      chosen = { brick: b, move };
      break;
    }
    if (!chosen) break;
    remaining.delete(chosen.brick.id);
    removed.push(chosen);
  }
  return { ordered: removed.reverse(), unresolved: [...remaining] };
}
