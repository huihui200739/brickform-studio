import {
  addComponents,
  insideRegion,
  regionPlacement,
  validateRegions,
  type ComponentRegion,
} from './semantic-components.ts';
import {
  finishModel,
  PALETTE,
  nearestColor,
  validateModel,
  type Model,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import type { TriangleMesh } from './mesh-types.ts';

// Cast through a genuine triangle volume, retaining separate depth intervals
// and openings. Image brightness is never used to invent depth.
export function meshToDesign(
  mesh: TriangleMesh,
  resolution = 28,
  regions: ComponentRegion[] = [],
): Model {
  const p = mesh.positions,
    n = p.length / 9;
  if (
    !Number.isInteger(n) ||
    n < 1 ||
    n > 250000 ||
    mesh.colors.length !== n * 3 ||
    ![20, 28, 36, 48].includes(resolution)
  )
    throw Error('三维网格或尺寸不受支持。');
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) throw Error('三维网格包含无效坐标。');
    const a = i % 3;
    min[a] = Math.min(min[a], p[i]);
    max[a] = Math.max(max[a], p[i]);
  }
  const span = max.map((v, i) => v - min[i]),
    scale = resolution / Math.max(...span);
  if (!Number.isFinite(scale) || span.some((v) => v <= 0))
    throw Error('这个文件没有可转换的三维体积。');
  const w = Math.max(1, Math.ceil(span[0] * scale)),
    h = Math.max(1, Math.ceil((span[1] * scale) / 0.4)),
    d = Math.max(1, Math.ceil(span[2] * scale));
  validateRegions(regions, [w, h, d]);
  const placements = regions.map((r) => regionPlacement(r, [w, h, d]));
  const hits: { x: number; color: number }[][] = Array.from(
    { length: h * d },
    () => [],
  );
  const cells = new Map<string, { color: number; support: boolean }>();
  const surface = new Map<string, { color: number; support: boolean }>();
  const votes = new Map<string, Uint32Array>();
  let samples = 0;
  for (let t = 0; t < n; t++) {
    const v = [0, 1, 2].map((j) =>
      [0, 1, 2].map(
        (a) => ((p[t * 9 + j * 3 + a] - min[a]) * scale) / (a === 1 ? 0.4 : 1),
      ),
    );
    const color = nearestColor(
      mesh.colors[t * 3],
      mesh.colors[t * 3 + 1],
      mesh.colors[t * 3 + 2],
      true,
    );
    const denom =
      (v[1][2] - v[2][2]) * (v[0][1] - v[2][1]) +
      (v[2][1] - v[1][1]) * (v[0][2] - v[2][2]);
    if (Math.abs(denom) > 1e-10) {
      for (
        let y = Math.max(0, Math.floor(Math.min(...v.map((a) => a[1]))));
        y < Math.min(h, Math.ceil(Math.max(...v.map((a) => a[1]))));
        y++
      )
        for (
          let z = Math.max(0, Math.floor(Math.min(...v.map((a) => a[2]))));
          z < Math.min(d, Math.ceil(Math.max(...v.map((a) => a[2]))));
          z++
        ) {
          const yy = y + 0.500013,
            zz = z + 0.500027;
          const a =
            ((v[1][2] - v[2][2]) * (yy - v[2][1]) +
              (v[2][1] - v[1][1]) * (zz - v[2][2])) /
            denom;
          const b =
            ((v[2][2] - v[0][2]) * (yy - v[2][1]) +
              (v[0][1] - v[2][1]) * (zz - v[2][2])) /
            denom;
          if (a >= 0 && b >= 0 && a + b <= 1)
            hits[y * d + z].push({
              x: a * v[0][0] + b * v[1][0] + (1 - a - b) * v[2][0],
              color,
            });
        }
    }
    // Paint exposed faces with their own texture colors, including the front,
    // back and upward surfaces, not only the entry/exit faces of the X rays.
    const edge = Math.max(
      ...[
        [0, 1],
        [0, 2],
        [1, 2],
      ].map(([a, b]) => Math.hypot(...v[a].map((x, i) => x - v[b][i]))),
    );
    const steps = Math.max(1, Math.ceil(edge * 1.5));
    samples += ((steps + 1) * (steps + 2)) / 2;
    if (samples > 8000000)
      throw Error('网格跨度过大，请先简化网格或降低尺寸。');
    for (let a = 0; a <= steps; a++)
      for (let b = 0; b <= steps - a; b++) {
        const c = v[0].map(
          (x, i) =>
            (x * a) / steps +
            (v[1][i] * b) / steps +
            v[2][i] * (1 - (a + b) / steps),
        );
        const x = Math.min(w - 1, Math.max(0, Math.floor(c[0]))),
          y = Math.min(h - 1, Math.max(0, Math.floor(c[1]))),
          z = Math.min(d - 1, Math.max(0, Math.floor(c[2])));
        const key = `${x + 1},${y + 2},${z + 1}`;
        let vote = votes.get(key);
        if (!vote) {
          vote = new Uint32Array(PALETTE.length);
          votes.set(key, vote);
        }
        vote[color]++;
      }
  }
  const colorCounts = new Uint32Array(PALETTE.length);
  votes.forEach((vote, key) => {
    let color = 0;
    for (let i = 1; i < vote.length; i++) if (vote[i] > vote[color]) color = i;
    surface.set(key, { color, support: false });
    colorCounts[color]++;
  });
  const dominant = colorCounts.indexOf(Math.max(...colorCounts));
  let openRows = 0,
    intersected = 0;
  hits.forEach((row, i) => {
    if (!row.length) return;
    intersected++;
    row.sort((a, b) => a.x - b.x);
    const unique = row.filter((hit, j) => !j || hit.x - row[j - 1].x > 1e-4);
    if (unique.length % 2) openRows++;
    for (let j = 0; j + 1 < unique.length; j += 2) {
      const left = unique[j],
        right = unique[j + 1],
        y = Math.floor(i / d),
        z = i % d;
      for (
        let x = Math.max(0, Math.ceil(left.x - 0.5));
        x < Math.min(w, Math.ceil(right.x - 0.5));
        x++
      )
        cells.set(`${x + 1},${y + 2},${z + 1}`, {
          color: dominant,
          support: false,
        });
    }
  });
  if (!intersected || openRows / intersected > 0.15)
    throw Error(
      '三维草稿有较多开放边界，无法可靠填充体积。请换一个闭合 GLB 模型或重新生成草稿。',
    );
  surface.forEach((v, k) => cells.set(k, v));
  let removedCells = 0;
  for (const key of cells.keys()) {
    const p = key.split(',').map(Number) as [number, number, number];
    if (placements.some((r) => insideRegion(p, r))) {
      cells.delete(key);
      removedCells++;
    }
  }
  // The cut can detach a canopy or a flame tip outside the box. Remove only
  // detached islands touching this cut; unrelated islands retain normal support.
  if (placements.length) {
    const seen = new Set<string>();
    for (const start of cells.keys()) {
      if (seen.has(start)) continue;
      const queue = [start],
        island: string[] = [];
      let touchesGround = false,
        touchesCut = false;
      while (queue.length) {
        const key = queue.pop()!;
        if (seen.has(key)) continue;
        seen.add(key);
        island.push(key);
        const [x, y, z] = key.split(',').map(Number);
        if (y === 2) touchesGround = true;
        for (const [dx, dy, dz] of [
          [1, 0, 0],
          [-1, 0, 0],
          [0, 1, 0],
          [0, -1, 0],
          [0, 0, 1],
          [0, 0, -1],
        ]) {
          const next = `${x + dx},${y + dy},${z + dz}`;
          if (cells.has(next) && !seen.has(next)) queue.push(next);
          if (placements.some((r) => insideRegion([x + dx, y + dy, z + dz], r)))
            touchesCut = true;
        }
      }
      if (!touchesGround && touchesCut)
        for (const key of island) {
          cells.delete(key);
          removedCells++;
        }
    }
  }
  // Seat each component on a connected four-stud mounting surface. Fill only
  // below the selected base, never refill the removed object above that base.
  for (const r of placements)
    for (let x = r.x - 1; x < r.x + 1; x++)
      for (let z = r.z - 1; z < r.z + 1; z++) {
        for (let y = r.y - 1; y >= 2; y--) {
          const key = `${x},${y},${z}`;
          if (cells.has(key)) break;
          cells.set(key, { color: dominant, support: true });
        }
      }
  // A removed statue must not be replaced by a column through the doorway.
  // If both jambs are present, bridge the opening with full 2 x 8 plates at
  // its upper boundary. Plates retain their catalog dimensions and are counted.
  const bridges: Model['bricks'] = [];
  for (const r of placements) {
    const x = r.min[0] - 1,
      y = r.max[1];
    if (r.max[0] - r.min[0] !== 6 || x < 0 || x + 8 > w + 2 || y >= h + 2)
      continue;
    for (let z = r.min[2]; z + 2 <= r.max[2]; z += 2) {
      const left = [z, z + 1].some((zz) => cells.has(`${x},${y - 1},${zz}`));
      const right = [z, z + 1].some((zz) =>
        cells.has(`${x + 7},${y - 1},${zz}`),
      );
      const roof = [z, z + 1].some((zz) => cells.has(`${x + 3},${y},${zz}`));
      if (!left || !right || !roof) continue;
      for (let xx = x; xx < x + 8; xx++)
        for (let zz = z; zz < z + 2; zz++)
          cells.set(`${xx},${y},${zz}`, { color: dominant, support: false });
      bridges.push({
        id: 0,
        part: '3034',
        x,
        y,
        z,
        w: 8,
        d: 2,
        h: 1,
        color: dominant,
        installation:
          '将整块 2 × 8 薄板横跨开口，两端分别扣在左右承托凸点上，保持下方通道畅通。',
      });
    }
  }
  const raw = finishModel(
    cells,
    w + 2,
    h + 2,
    d + 2,
    'image',
    mesh.name,
    resolution,
    dominant,
    placements.length
      ? (x, y, z) => placements.some((r) => insideRegion([x, y, z], r))
      : undefined,
    bridges,
  );
  // Preserve the occupied volume and full-width bridging plates. An exposed
  // brick becomes two full plates with a tiled top at the original height.
  // Only unused studs are removed; attachment surfaces stay intact.
  let smoothTiles = 0;
  const tiles: Record<string, string> = {
    '3022': '3068b',
    '3023': '3069b',
    '3024': '3070b',
  };
  const plates: Record<string, string> = {
    '3001': '3020',
    '3003': '3022',
    '3010': '3710',
    '3004': '3023',
    '3005': '3024',
  };
  const finished: typeof raw.bricks = [];
  for (const b of raw.bricks) {
    let covered =
      !!b.support ||
      b.y < 2 ||
      placements.some(
        (r) =>
          b.y + b.h === r.y &&
          b.x < r.x + 1 &&
          b.x + b.w > r.x - 1 &&
          b.z < r.z + 1 &&
          b.z + b.d > r.z - 1,
      );
    for (let x = b.x; x < b.x + b.w; x++)
      for (let z = b.z; z < b.z + b.d; z++)
        if (cells.has(`${x},${b.y + b.h},${z}`)) covered = true;
    if (covered) {
      finished.push(b);
      continue;
    }
    if (tiles[b.part]) {
      finished.push({ ...b, part: tiles[b.part] });
      smoothTiles++;
    } else if (b.part === '3020' || b.part === '3710') {
      const w = Math.min(2, b.w),
        d = Math.min(2, b.d);
      const candidates: typeof raw.bricks = [];
      let supported = true;
      for (let x = b.x; x < b.x + b.w; x += w)
        for (let z = b.z; z < b.z + b.d; z += d) {
          let contact = false;
          for (let xx = x; xx < x + w; xx++)
            for (let zz = z; zz < z + d; zz++)
              if (cells.has(`${xx},${b.y - 1},${zz}`)) contact = true;
          if (!contact) supported = false;
          candidates.push({
            ...b,
            x,
            z,
            w,
            d,
            part: w * d === 4 ? '3068b' : '3069b',
          });
        }
      if (supported) {
        finished.push(...candidates);
        smoothTiles += candidates.length;
      } else finished.push(b);
    } else if (plates[b.part]) {
      finished.push(
        { ...b, part: plates[b.part], h: 1 },
        { ...b, part: plates[b.part], y: b.y + 1, h: 1 },
      );
      const w = Math.min(2, b.w),
        d = Math.min(2, b.d);
      const part = w * d === 4 ? '3068b' : w * d === 2 ? '3069b' : '3070b';
      for (let x = b.x; x < b.x + b.w; x += w)
        for (let z = b.z; z < b.z + b.d; z += d) {
          finished.push({ ...b, part, x, z, y: b.y + 2, w, d, h: 1 });
          smoothTiles++;
        }
    } else finished.push(b);
  }
  raw.bricks = finished.map((b, i) => ({ ...b, id: i + 1 }));
  raw.levels = [...new Set(raw.bricks.map((b) => b.y))].sort((a, b) => a - b);
  if (raw.bricks.length > 14000)
    throw Error('此尺寸超过 14000 块零件，请降低积木尺寸后再转换。');
  const model = groupImageAssembly(raw);
  model.meshDesign = {
    method: 'mesh-volume',
    smoothTiles,
    referenceColors: !!mesh.coloring,
    triangles: n,
    resolution,
    openRowFraction: openRows / Math.max(1, intersected),
  };
  model.assembly!.reference = `按三维网格体积生成；保留网格中的前后布局和孔洞。新增辅助支撑 ${model.supportCount} 块，已计入清单。网格可能含 AI 推测，连接检查不代表外观还原或实物稳定性已验证。`;
  // Support added by the generic packer must not reoccupy a replacement zone.
  if (
    model.bricks.some((b) =>
      placements.some(
        (r) =>
          b.x < r.max[0] &&
          b.x + b.w > r.min[0] &&
          b.y < r.max[1] &&
          b.y + b.h > r.min[1] &&
          b.z < r.max[2] &&
          b.z + b.d > r.min[2],
      ),
    )
  )
    throw Error(
      '所选区域上方仍有结构需要支撑，请缩小清除范围，避开墙体或屋顶。',
    );
  addComponents(model, regions, [w, h, d], removedCells);
  const check = validateModel(model);
  if (
    check.collisions ||
    check.unsupported ||
    check.invalidParts ||
    !check.connected
  )
    throw Error(
      regions.length
        ? '组件与周围建筑发生干涉或缺少连接，请调整底部位置与清除范围后重试。'
        : '积木结构未通过连接检查，请降低尺寸后重试。',
    );
  return model;
}
