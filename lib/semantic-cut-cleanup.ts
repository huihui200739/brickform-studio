import type { Model } from './brick-engine.ts';
import type { BBox3d } from './scene/scene-types.ts';
import { connectors } from './assembly-validation.ts';

/** Remove unbuildable source remnants above a semantic cut, in assembly order.
 * This never removes catalog components or repairs unrelated parts of a model.
 * The caller must still validate the complete assembly after replacement.
 */
export function removeSemanticCutRemnants(model: Model, cuts: BBox3d[]) {
  if (!cuts.length) return 0;
  const key = (port: ReturnType<typeof connectors>['studs'][number]) =>
    (port.type || 'stud') + ':' + [...port.point, ...port.normal]
      .map(value => Math.round(value * 1000)).join(',');
  const ports = model.bricks.map(brick => ({ brick, ...connectors(brick) }));
  const byId = new Map(model.bricks.map(brick => [brick.id, brick]));
  const studs = new Map<string, number[]>();
  const links = new Map<number, Set<number>>();
  for (const { brick, studs: plugs } of ports) {
    links.set(brick.id, new Set());
    for (const plug of plugs) {
      const k = key(plug), ids = studs.get(k) || [];
      ids.push(brick.id);
      studs.set(k, ids);
    }
  }
  for (const { brick, sockets } of ports)
    for (const socket of sockets)
      for (const id of studs.get(key(socket)) || []) {
        links.get(brick.id)!.add(id);
        links.get(id)!.add(brick.id);
      }
  const supported = new Set<number>(), removed = new Set<number>();
  const ordered = [...model.bricks].sort((a, b) =>
    (a.step || 0) - (b.step || 0) || a.id - b.id,
  );
  for (const brick of ordered) {
    if (brick.y === 0 || [...links.get(brick.id)!].some(id => supported.has(id))) {
      supported.add(brick.id);
      continue;
    }
    if (brick.section !== 'subject' && brick.section !== 'supports') continue;
    // Grid packing can leave pieces one stud beyond the cut. Only follow
    // those local remnants upward; preserve the base and distant structure.
    if (cuts.some(cut =>
      brick.y >= cut.min[1] &&
      brick.x < cut.max[0] + 1 && brick.x + brick.w > cut.min[0] - 1 &&
      brick.z < cut.max[2] + 1 && brick.z + brick.d > cut.min[2] - 1,
    )) removed.add(brick.id);
  }
  // Removing a local bridge can orphan a branch that extends past the cut.
  // Follow connector links to the whole disconnected branch; a coordinate
  // test on each brick alone leaves its distant end floating.
  const grounded = new Set<number>();
  const queue = model.bricks.filter(b => b.y === 0).map(b => b.id);
  while (queue.length) {
    const id = queue.pop()!;
    if (removed.has(id) || grounded.has(id)) continue;
    grounded.add(id);
    queue.push(...links.get(id)!);
  }
  const visited = new Set<number>();
  for (const brick of model.bricks) {
    if (grounded.has(brick.id) || removed.has(brick.id) || visited.has(brick.id)) continue;
    const branch: number[] = [], pending = [brick.id];
    let touchesCut = false;
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id) || grounded.has(id) || removed.has(id)) continue;
      visited.add(id);
      branch.push(id);
      const member = byId.get(id)!;
      if (cuts.some(cut => member.y >= cut.min[1] &&
        member.x <= cut.max[0] + 1 && member.x + member.w >= cut.min[0] - 1 &&
        member.z <= cut.max[2] + 1 && member.z + member.d >= cut.min[2] - 1) ||
        [...links.get(id)!].some(next => removed.has(next))) touchesCut = true;
      pending.push(...links.get(id)!);
    }
    if (touchesCut && branch.every(id => {
      const b = byId.get(id)!;
      return b.section === 'subject' || b.section === 'supports';
    })) for (const id of branch) removed.add(id);
  }
  if (!removed.size) return 0;
  model.bricks = model.bricks.filter(brick => !removed.has(brick.id))
    .map((brick, index) => ({ ...brick, id: index + 1 }));
  model.supportCount = model.bricks.filter(brick => brick.support).length;
  if (model.assembly) {
    const activeSteps = new Set(model.bricks.map(brick => brick.step));
    const remap = new Map<number, number>();
    model.assembly.steps = model.assembly.steps.filter((_, old) => {
      if (!activeSteps.has(old)) return false;
      remap.set(old, remap.size);
      return true;
    });
    for (const brick of model.bricks) brick.step = remap.get(brick.step!);
    model.levels = model.assembly.steps.map((_, i) => i);
    model.assembly.reference += ` 语义组件替换清理了切口上方无安装连接的残片 ${removed.size} 块。`;
  }
  return removed.size;
}
