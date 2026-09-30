import type { TriangleMesh } from './mesh-types.ts';
import type { Model } from './brick-engine.ts';
import { ASSEMBLY_PARTS, type V3 } from './assembly-catalog.ts';
import { meshFrame } from './semantic-components.ts';

type Cell = { color: number; support: boolean };
type Face = { points: V3[]; y: number; area: number };
export type PlatformDesign = {
  source: 'reconstructed-mesh';
  intent: 'level-display-surface';
  topY: number;
  columns: string[];
  evidence: {
    samples: number;
    areaStudsSquared: number;
    lowSurfaceConsensus: number;
    rmsePlates: number;
  };
  adjustedColumns: number;
  validation?: ReturnType<typeof auditPlatform>;
};

/** Authorize a floor from a broad, near-horizontal mesh patch. A low bounding
 * box or a flat-looking colour alone cannot turn an animal/hat into a floor.
 * Only observed columns close to this plane are included; raised structures,
 * missing columns and the unobserved space under them are not filled. */
export function fitPlatform(
  mesh: TriangleMesh,
  resolution: number,
  cells: Map<string, Cell>,
  width: number,
  height: number,
  depth: number,
): PlatformDesign | undefined {
  const frame = meshFrame(mesh, resolution),
    p = mesh.positions;
  const faces: Face[] = [];
  for (let i = 0; i < p.length; i += 9) {
    const ab = [0, 1, 2].map((a) => p[i + 3 + a] - p[i + a]);
    const ac = [0, 1, 2].map((a) => p[i + 6 + a] - p[i + a]);
    const normal = [
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ];
    const twiceArea = Math.hypot(...normal);
    if (!twiceArea || normal[1] / twiceArea < 0.96) continue;
    const points = [0, 1, 2].map(
      (v) =>
        [0, 1, 2].map(
          (a) =>
            ((p[i + v * 3 + a] - frame.min[a]) * frame.scale) /
              (a === 1 ? 0.4 : 1) +
            (a === 1 ? 2 : 1),
        ) as V3,
    );
    const y = points.reduce((sum, v) => sum + v[1], 0) / 3;
    if (y < 4 || y > height * 0.25 + 2) continue;
    faces.push({ points, y, area: (twiceArea * frame.scale ** 2) / 2 });
  }
  if (!faces.length) return undefined;
  const candidates = new Set(faces.map((f) => Math.round(f.y * 2) / 2));
  const totalArea = faces.reduce((sum, f) => sum + f.area, 0);
  let best: Face[] = [],
    bestArea = 0;
  for (const level of candidates) {
    const patch = faces.filter((f) => Math.abs(f.y - level) <= 0.6);
    const area = patch.reduce((sum, f) => sum + f.area, 0);
    if (area > bestArea) {
      best = patch;
      bestArea = area;
    }
  }
  if (
    bestArea < width * depth * 0.15 ||
    bestArea / totalArea < 0.55 ||
    best.length < 2
  )
    return undefined;
  const coordinate = best.reduce((sum, f) => sum + f.y * f.area, 0) / bestArea;
  const rmse = Math.sqrt(
    best.reduce((sum, f) => sum + (f.y - coordinate) ** 2 * f.area, 0) /
      bestArea,
  );
  if (rmse > 0.35) return undefined;
  // Mesh faces define the upper surface, while voxels are occupied intervals.
  const topY = Math.ceil(coordinate - 0.05) - 1;
  const tops = new Map<string, number>();
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number),
      column = `${x},${z}`;
    tops.set(column, Math.max(tops.get(column) ?? -1, y));
  }
  const inliers = new Set(best);
  const covered = new Set<string>(),
    raised = new Set<string>();
  for (const face of faces) {
    const { points: v } = face;
    const onPlane = inliers.has(face);
    if (!onPlane && face.y <= coordinate + 0.85) continue;
    // Require the whole face to lie near the fitted plane, not just its centre.
    if (onPlane && v.some((p) => Math.abs(p[1] - coordinate) > 0.85)) continue;
    const denom =
      (v[1][2] - v[2][2]) * (v[0][0] - v[2][0]) +
      (v[2][0] - v[1][0]) * (v[0][2] - v[2][2]);
    if (Math.abs(denom) < 1e-8) continue;
    for (
      let x = Math.max(1, Math.floor(Math.min(...v.map((p) => p[0]))));
      x <= Math.min(width, Math.ceil(Math.max(...v.map((p) => p[0]))));
      x++
    )
      for (
        let z = Math.max(1, Math.floor(Math.min(...v.map((p) => p[2]))));
        z <= Math.min(depth, Math.ceil(Math.max(...v.map((p) => p[2]))));
        z++
      ) {
        const a =
          ((v[1][2] - v[2][2]) * (x + 0.5 - v[2][0]) +
            (v[2][0] - v[1][0]) * (z + 0.5 - v[2][2])) /
          denom;
        const b =
          ((v[2][2] - v[0][2]) * (x + 0.5 - v[2][0]) +
            (v[0][0] - v[2][0]) * (z + 0.5 - v[2][2])) /
          denom;
        if (a < 0 || b < 0 || a + b > 1) continue;
        const column = `${x},${z}`,
          top = tops.get(column);
        if (!onPlane) {
          raised.add(column);
          continue;
        }
        if (top === undefined || Math.abs(top - topY) > 2) continue;
        // A hole down to the base is different from a shallow sampling dip.
        if (!cells.has(`${x},${topY - 3},${z}`)) continue;
        covered.add(column);
      }
  }
  for (const column of raised) covered.delete(column);
  if (covered.size < width * depth * 0.12) return undefined;
  return {
    source: 'reconstructed-mesh',
    intent: 'level-display-surface',
    topY,
    columns: [...covered],
    adjustedColumns: 0,
    evidence: {
      samples: best.length,
      areaStudsSquared: bestArea,
      lowSurfaceConsensus: bestArea / totalArea,
      rmsePlates: rmse,
    },
  };
}

/** Snapshot edits never grow a plane through stairs or previously empty columns.
 * Retain source materials; an architectural plane does not prove its colour. */
export function applyPlatform(cells: Map<string, Cell>, plan: PlatformDesign) {
  let changed = 0;
  for (const column of plan.columns) {
    const [x, z] = column.split(',').map(Number);
    let top = plan.topY + 2;
    while (top >= plan.topY - 2 && !cells.has(`${x},${top},${z}`)) top--;
    if (top < plan.topY - 2) continue;
    const material = cells.get(`${x},${top},${z}`)!;
    if (top !== plan.topY) changed++;
    for (let y = top; y > plan.topY; y--) cells.delete(`${x},${y},${z}`);
    for (let y = top + 1; y <= plan.topY; y++)
      cells.set(`${x},${y},${z}`, { ...material });
    cells.set(`${x},${plan.topY},${z}`, { ...material });
  }
  return changed;
}

/** Audit final parts, including optimizer/support additions, against the plan.
 * Mounts and real structures installed over a floor are excluded explicitly. */
export function auditPlatform(
  model: Model,
  plan: PlatformDesign,
  excluded: Set<string>,
) {
  const targets = new Set(plan.columns.filter((c) => !excluded.has(c)));
  const top = new Map<string, { y: number; kind: string }>();
  for (const b of model.bricks) {
    if (b.section?.startsWith('component-')) continue;
    const kind = ASSEMBLY_PARTS[b.part]?.kind ?? 'unknown';
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++) {
        const column = `${x},${z}`;
        if (!targets.has(column)) continue;
        if ((top.get(column)?.y ?? -1) < b.y + b.h)
          top.set(column, { y: b.y + b.h, kind });
      }
  }
  let missing = 0,
    uneven = 0,
    exposedStuds = 0;
  for (const c of targets) {
    const result = top.get(c);
    if (!result) missing++;
    else {
      if (result.y !== plan.topY + 1) uneven++;
      if (result.kind !== 'tile') exposedStuds++;
    }
  }
  return {
    passed: missing + uneven + exposedStuds === 0,
    checkedColumns: targets.size,
    excludedColumns: excluded.size,
    missing,
    uneven,
    exposedStuds,
  };
}
