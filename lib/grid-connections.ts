import type { Brick } from './brick-engine.ts';
import { ASSEMBLY_PARTS } from './assembly-catalog.ts';

/** Exact stud/socket graph for upright rectangular grid bricks, plates and slopes.
 * Used before poses exist. Curves, side mounts and special joints are handled
 * by the full catalog connector validator after composition. */
export function gridConnections(bricks: Brick[]) {
  const links = new Map(bricks.map((b) => [b.id, new Set<number>()]));
  const tops = new Map<string, number[]>();
  const regular = (b: Brick) => {
    const p = ASSEMBLY_PARTS[b.part];
    return (
      !!p &&
      (b.rotation === undefined ||
        (Number.isInteger(b.rotation) &&
          b.rotation >= 0 &&
          b.rotation <= 3 &&
          (b.rotation % 2
            ? p.d === b.w && p.w === b.d
            : p.w === b.w && p.d === b.d))) &&
      ['brick', 'plate', 'tile', 'slope'].includes(p.kind) &&
      p.h === b.h &&
      ((p.w === b.w && p.d === b.d) || (p.w === b.d && p.d === b.w))
    );
  };
  for (const b of bricks) {
    if (!regular(b) || ASSEMBLY_PARTS[b.part].kind === 'tile') continue;
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++) {
        if (ASSEMBLY_PARTS[b.part].kind === 'slope') {
          const q = b.rotation ?? (ASSEMBLY_PARTS[b.part].w === b.w ? 0 : 1);
          if (
            ![z === b.z + b.d - 1, x === b.x + b.w - 1, z === b.z, x === b.x][q]
          )
            continue;
        }
        const key = `${x},${b.y + b.h},${z}`;
        tops.set(key, [...(tops.get(key) || []), b.id]);
      }
  }
  for (const b of bricks) {
    if (!regular(b)) continue;
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        for (const id of tops.get(`${x},${b.y},${z}`) || []) {
          if (id === b.id) continue;
          links.get(b.id)!.add(id);
          links.get(id)!.add(b.id);
        }
  }
  return links;
}

export function groundedIds(bricks: Brick[], links = gridConnections(bricks)) {
  const seen = new Set<number>(),
    queue = bricks.filter((b) => b.y === 0).map((b) => b.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(links.get(id) || []));
  }
  return seen;
}
