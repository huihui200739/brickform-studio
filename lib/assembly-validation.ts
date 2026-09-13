import { SPECIAL_PORTS } from './special-connectors.ts';
import type { Model, Brick } from './brick-engine.ts';
import {
  ASSEMBLY_PARTS,
  curveFloorY,
  worldPoint,
  transform,
  type V3,
} from './assembly-catalog.ts';
export function connectors(b: Brick) {
  const p = ASSEMBLY_PARTS[b.part];
  const studs: { point: V3; normal: V3; type?: string }[] = [],
    sockets: { point: V3; normal: V3; type?: string }[] = [];
  if (!p || !b.pose) return { studs, sockets };
  if (SPECIAL_PORTS[b.part]) {
    for (const port of SPECIAL_PORTS[b.part]) {
      const list = port.role === 'plug' ? studs : sockets;
      list.push({
        point: worldPoint(b.pose, port.point),
        normal:
          port.type === 'stud'
            ? transform(b.pose.matrix, [0, -1, 0])
            : [0, 0, 0],
        type: port.type,
      });
    }
    return { studs, sockets };
  }
  for (let x = 0; x < p.w; x++)
    for (let z = 0; z < p.d; z++) {
      const xx = (x + 0.5 - p.w / 2) * 20,
        zz = (z + 0.5 - p.d / 2) * 20 + (p.centerZ || 0);
      // Curved slopes have two mounting rows separated by one plate height.
      sockets.push({
        point: worldPoint(b.pose, [xx, curveFloorY(p, zz), zz]),
        normal: transform(b.pose.matrix, [0, -1, 0]),
      });
      if (
        ['brick', 'plate', 'side'].includes(p.kind) ||
        (p.kind === 'slope' && z === p.d - 1)
      )
        studs.push({
          point: worldPoint(b.pose, [xx, 0, zz]),
          normal: transform(b.pose.matrix, [0, -1, 0]),
        });
    }
  if (p.kind === 'side')
    studs.push({
      point: worldPoint(b.pose, [0, 10, -10]),
      normal: transform(b.pose.matrix, [0, 0, -1]),
    });
  return { studs, sockets };
}
const key = (p: V3, n: V3, type = 'stud') =>
  type + ':' + [...p, ...n].map((v) => Math.round(v * 1000)).join(',');
export function validateAssembly(model: Model) {
  let invalidParts = 0,
    collisions = 0,
    unsupported = 0;
  const byId = new Map(model.bricks.map((b) => [b.id, b]));
  const studs = new Map<string, number[]>(),
    links = new Map<number, Set<number>>();
  for (const b of model.bricks) {
    links.set(b.id, new Set());
    if (!ASSEMBLY_PARTS[b.part] || !b.pose) invalidParts++;
    for (const c of connectors(b).studs) {
      const k = key(c.point, c.normal, c.type);
      studs.set(k, [...(studs.get(k) || []), b.id]);
    }
  }
  const badIds: number[] = [];
  for (const b of model.bricks)
    for (const c of connectors(b).sockets)
      for (const id of studs.get(key(c.point, c.normal, c.type)) || []) {
        if (id === b.id) continue;
        links.get(b.id)!.add(id);
        links.get(id)!.add(b.id);
      }
  for (const b of model.bricks) {
    const support =
      b.y === 0 ||
      [...links.get(b.id)!].some((id) => {
        const other = byId.get(id)!;
        return (
          (other.step || 0) < (b.step || 0) ||
          ((other.step || 0) === (b.step || 0) && id < b.id)
        );
      });
    if (!support) {
      unsupported++;
      badIds.push(b.id);
    }
  }
  // Conservative body envelopes exclude studs and their mating cavities.
  // This catches overlapping placements but is not a physical force solver.
  const overlapIds: number[][] = [];
  for (let i = 0; i < model.bricks.length; i++)
    for (let j = i + 1; j < model.bricks.length; j++) {
      const a = model.bricks[i],
        b = model.bricks[j];
      // Interlocking accessory/figure envelopes overlap by design. Their joint
      // graph is checked above; exact surface collision is explicitly unverified.
      if (
        model.semanticDesign &&
        a.section?.startsWith('component-') &&
        a.section === b.section
      )
        continue;
      if (
        model.semanticDesign &&
        links.get(a.id)?.has(b.id) &&
        (SPECIAL_PORTS[a.part] || SPECIAL_PORTS[b.part])
      )
        continue;
      if (
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-5 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-5 &&
        Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z) > 1e-5
      ) {
        // A plate may legally occupy the open rear recess of a curved slope.
        const inRecess = (curve: Brick) => {
          if (ASSEMBLY_PARTS[curve.part]?.kind !== 'curve' || !curve.pose)
            return false;
          const r = curve.pose.matrix,
            transpose = [
              r[0],
              r[3],
              r[6],
              r[1],
              r[4],
              r[7],
              r[2],
              r[5],
              r[8],
            ] as typeof r;
          for (const x of [Math.max(a.x, b.x), Math.min(a.x + a.w, b.x + b.w)])
            for (const y of [
              Math.max(a.y, b.y),
              Math.min(a.y + a.h, b.y + b.h),
            ])
              for (const z of [
                Math.max(a.z, b.z),
                Math.min(a.z + a.d, b.z + b.d),
              ]) {
                const world: V3 = [
                  (x - model.width / 2) * 20,
                  -y * 8,
                  (z - model.depth / 2) * 20,
                ];
                const local = transform(
                  transpose,
                  world.map((v, i) => v - curve.pose!.position[i]) as V3,
                );
                if (
                  local[1] <
                  Math.min(
                    curveFloorY(ASSEMBLY_PARTS[curve.part], local[2] - 1e-5),
                    curveFloorY(ASSEMBLY_PARTS[curve.part], local[2] + 1e-5),
                  ) -
                    1e-5
                )
                  return false;
              }
          return true;
        };
        if (inRecess(a) || inRecess(b)) continue;
        collisions++;
        overlapIds.push([a.id, b.id]);
      }
    }
  const seen = new Set<number>(),
    queue = model.bricks.length ? [model.bricks[0].id] : [];
  while (queue.length) {
    const id = queue.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...links.get(id)!);
  }
  return {
    collisions,
    unsupported,
    invalidParts,
    connected: seen.size === model.bricks.length,
    brickCount: model.bricks.length,
    badIds,
    overlapIds,
  };
}
