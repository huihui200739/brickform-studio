import {
  ASSEMBLY_PARTS,
  IDENTITY,
  add,
  multiply,
  rotate,
  transform,
  worldPoint,
  type M3,
  type V3,
} from './assembly-catalog.ts';
import { SPECIAL_DATA } from './special-part-data.ts';
import { SPECIAL_PORTS } from './special-connectors.ts';
import type { Brick, Model } from './brick-engine.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
export type ComponentKind = 'tree' | 'brazier' | 'statue';
export type ComponentRegion = {
  id: string;
  kind: ComponentKind;
  placed?: boolean;
  // Bottom centre, in normalized original mesh coordinates. Bounds are stud/
  // plate units; changing overall resolution never scales a catalog part.
  anchor: V3;
  // Legacy candidate hints. Only those within the original placement limit
  // may be considered; remote fallback locations are rejected.
  fallbackAnchors?: V3[];
  // Initial intended position, retained through every automatic retry.
  referenceAnchor?: V3;
  positionLocked?: boolean;
  placementStatus?:
    | 'kept'
    | 'adjusted'
    | 'conflict'
    | 'unpositioned'
    | 'budget';
  width: number;
  depth: number;
  height: number;
  rotation: number;
};
export const COMPONENT_LABELS = {
  tree: '枝叶树',
  brazier: '火盆',
  statue: '持盾人物',
};
export const COMPONENT_SIZES = {
  tree: { width: 8, depth: 8, height: 16 },
  brazier: { width: 4, depth: 4, height: 18 },
  statue: { width: 6, depth: 5, height: 23 },
};
export function meshFrame(mesh: TriangleMesh, resolution: number) {
  const min: V3 = [Infinity, Infinity, Infinity],
    max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a], mesh.positions[i]);
    max[a] = Math.max(max[a], mesh.positions[i]);
  }
  const span = max.map((v, i) => v - min[i]) as V3;
  const scale = resolution / Math.max(...span);
  return {
    min,
    max,
    span,
    scale,
    grid: span.map((v, i) =>
      Math.ceil((v * scale) / (i === 1 ? 0.4 : 1)),
    ) as V3,
  };
}
export function regionPlacement(region: ComponentRegion, grid: V3) {
  const [w, h, d] = grid;
  const x = Math.max(2, Math.min(w, Math.round(region.anchor[0] * w) + 1));
  const z = Math.max(2, Math.min(d, Math.round(region.anchor[2] * d) + 1));
  const y = Math.max(2, Math.round(region.anchor[1] * h) + 2);
  return {
    x,
    y,
    z,
    min: [
      Math.floor(x - region.width / 2),
      y,
      Math.floor(z - region.depth / 2),
    ] as V3,
    max: [
      Math.ceil(x + region.width / 2),
      y + region.height,
      Math.ceil(z + region.depth / 2),
    ] as V3,
  };
}
export function insideRegion(
  point: V3,
  region: ReturnType<typeof regionPlacement>,
) {
  return point.every((v, i) => v >= region.min[i] && v < region.max[i]);
}
export function validateRegions(regions: ComponentRegion[], grid: V3) {
  if (regions.length > 12) throw Error('一次最多替换 12 个组件。');
  const ids = new Set<string>();
  for (const r of regions) {
    if (r.placed === false)
      throw Error('请先点击草稿，为每个新增组件定位底部。');
    if (
      !COMPONENT_LABELS[r.kind] ||
      ids.has(r.id) ||
      !r.id ||
      r.anchor.length !== 3 ||
      !r.anchor.every((v) => Number.isFinite(v) && v >= 0 && v <= 1) ||
      ![r.width, r.depth, r.height, r.rotation].every(Number.isFinite) ||
      r.width < 2 ||
      r.depth < 2 ||
      r.width > 24 ||
      r.depth > 24 ||
      r.height < 2 ||
      r.height > 60 ||
      !Number.isInteger(r.rotation) ||
      r.rotation < 0 ||
      r.rotation > 3
    )
      throw Error('组件范围无效，请重新定位。');
    ids.add(r.id);
  }
  const boxes = regions.map((r) => regionPlacement(r, grid));
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++)
      if (
        [0, 1, 2].every(
          (a) =>
            Math.min(boxes[i].max[a], boxes[j].max[a]) -
              Math.max(boxes[i].min[a], boxes[j].min[a]) >
            0,
        )
      )
        throw Error('两个替换区域重叠了，请缩小范围或移动组件。');
}
const rx = (degree: number): M3 => {
  const c = Math.cos((degree * Math.PI) / 180),
    s = Math.sin((degree * Math.PI) / 180);
  return [1, 0, 0, 0, c, -s, 0, s, c];
};
const rz = (degree: number): M3 => {
  const c = Math.cos((degree * Math.PI) / 180),
    s = Math.sin((degree * Math.PI) / 180);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};
export function componentBricks(kind: ComponentKind): Brick[] {
  const bricks: Brick[] = [];
  function put(
    part: string,
    color: number,
    position: V3,
    matrix: M3,
    installation: string,
  ) {
    const b: Brick = {
      id: bricks.length + 1,
      part,
      color,
      pose: { position, matrix },
      x: 0,
      y: 0,
      z: 0,
      w: 0,
      h: 0,
      d: 0,
      installation,
    };
    bricks.push(b);
    return b;
  }
  function attach(
    parent: Brick,
    parentPort: number,
    part: string,
    childPort: number,
    color: number,
    matrix: M3,
    text: string,
  ) {
    const at = worldPoint(
      parent.pose!,
      SPECIAL_PORTS[parent.part][parentPort].point,
    );
    return put(
      part,
      color,
      at.map(
        (v, i) =>
          v - transform(matrix, SPECIAL_PORTS[part][childPort].point)[i],
      ) as V3,
      matrix,
      text,
    );
  }
  // Standard 2 x 2 mounting plate is counted and installed first.
  put(
    '3022',
    7,
    [0, -8, 0],
    IDENTITY,
    '把这块 2 × 2 薄板安装在标记的四个凸点上，作为组件底座。',
  );
  if (kind === 'tree') {
    const jumper = put(
      '87580',
      7,
      [0, -16, 0],
      IDENTITY,
      '把中心单凸点薄板扣在底板上，树干将安装在正中央。',
    );
    let trunk = attach(
      jumper,
      4,
      '3062b',
      0,
      9,
      IDENTITY,
      '将圆砖接在正中央的凸点上，作为树干。',
    );
    for (let i = 0; i < 2; i++)
      trunk = attach(
        trunk,
        1,
        '3062b',
        0,
        9,
        IDENTITY,
        '把下一节圆砖接在树干顶端，保持垂直。',
      );
    let leaf = attach(
      trunk,
      1,
      '2423',
      0,
      5,
      rotate(0),
      '将枝叶片根部的圆孔扣在树干顶部，枝叶朝后伸出。',
    );
    for (let i = 1; i < 4; i++)
      leaf = attach(
        leaf,
        1,
        '2423',
        0,
        5,
        rotate(i),
        `在上一片枝叶根部继续叠一片，转向${['', '左', '前', '右'][i]}，形成展开的树冠。`,
      );
  } else if (kind === 'brazier') {
    const jumper = put(
      '87580',
      1,
      [0, -16, 0],
      IDENTITY,
      '把中心单凸点薄板装在底板上，让火盆位于正中央。',
    );
    const dish = attach(
      jumper,
      4,
      '4740',
      0,
      1,
      IDENTITY,
      '将黑色碟形件中心的底孔扣在中央凸点上。',
    );
    const holder = attach(
      dish,
      1,
      '85861',
      0,
      1,
      IDENTITY,
      '把空心凸点圆板接到碟形件中央，为火焰预留插孔。',
    );
    attach(
      holder,
      2,
      '6126b',
      0,
      6,
      rx(90),
      '握住火焰底部，将短插杆插入中央圆孔。火尖向上；不要按压细长火尖。',
    );
  } else {
    const right = put(
      '3816c',
      11,
      [0, -36, -8.75],
      IDENTITY,
      '人物面向前方。将右脚底部的孔对准底板左后凸点；腿部通常随髋部成套购买，不建议拆卸已装好的关节。',
    );
    const hips = attach(
      right,
      1,
      '3815b',
      0,
      11,
      IDENTITY,
      '将髋部与右腿关节对齐；若使用已组装腿部，可连同下一块一起完成。',
    );
    attach(
      hips,
      1,
      '3817c',
      1,
      11,
      IDENTITY,
      '安装另一条腿，两只脚平齐，分别接到底板的两个凸点上。',
    );
    const torso = attach(
      hips,
      2,
      '973',
      0,
      11,
      IDENTITY,
      '将躯干底部套在髋部上，肩部在上方，人物面向前方。',
    );
    const armR = attach(
      torso,
      2,
      '3818',
      0,
      11,
      rz(9.792),
      '对齐人物右肩安装右臂。已带手臂的躯干可保持原装。',
    );
    const armL = attach(
      torso,
      3,
      '3819',
      0,
      11,
      rz(-9.792),
      '对齐人物左肩安装左臂，两臂自然垂下。',
    );
    const handR = attach(
      armR,
      1,
      '3820',
      0,
      11,
      multiply(rz(9.792), rx(45)),
      '将右手的短轴对准右臂末端孔，握口朝向前方。',
    );
    const handL = attach(
      armL,
      1,
      '3820',
      0,
      11,
      multiply(rz(-9.792), rx(45)),
      '将左手的短轴装入左臂，握口朝向前方。',
    );
    const head = attach(
      torso,
      1,
      '3626c',
      0,
      11,
      IDENTITY,
      '把无印刷灰色头部套在颈部圆柱上，作为石雕头部。',
    );
    attach(
      head,
      1,
      '3844',
      0,
      11,
      IDENTITY,
      '把头盔套在头部上，面部开口朝前。',
    );
    attach(
      handR,
      1,
      '4497',
      0,
      11,
      IDENTITY,
      '将长矛杆扣入右手握口，尖端朝上。可轻转手臂调整方向。',
    );
    attach(
      handL,
      1,
      '3846',
      0,
      11,
      IDENTITY,
      '将盾牌背面的握柄扣入左手，盾面朝前。检查配件与建筑之间留有间隙。',
    );
  }
  return bricks;
}
export function positionedComponent(
  kind: ComponentKind,
  origin: V3,
  rotation: number,
  model: Pick<Model, 'width' | 'depth'>,
): Brick[] {
  const m = rotate(rotation);
  return componentBricks(kind).map((b) => {
    const pose = {
      matrix: multiply(m, b.pose!.matrix),
      position: add(origin, transform(m, b.pose!.position)),
    };
    const p = ASSEMBLY_PARTS[b.part],
      raw = SPECIAL_DATA[b.part];
    const min = raw?.min || [-p.w * 10, 0, -p.d * 10],
      max = raw?.max || [p.w * 10, p.bottom, p.d * 10];
    const pts = [min[0], max[0]].flatMap((x) =>
      [min[1], max[1]].flatMap((y) =>
        [min[2], max[2]].map((z) => worldPoint(pose, [x, y, z])),
      ),
    );
    const lo = [0, 1, 2].map((a) => Math.min(...pts.map((v) => v[a]))),
      hi = [0, 1, 2].map((a) => Math.max(...pts.map((v) => v[a])));
    return {
      ...b,
      pose,
      x: lo[0] / 20 + model.width / 2,
      z: lo[2] / 20 + model.depth / 2,
      y: -hi[1] / 8,
      w: (hi[0] - lo[0]) / 20,
      d: (hi[2] - lo[2]) / 20,
      h: (hi[1] - lo[1]) / 8,
    };
  });
}
export function addComponents(
  model: Model,
  regions: ComponentRegion[],
  grid: V3,
  removedCells: number,
) {
  if (!regions.length) return model;
  model.semanticDesign = { components: [], removedCells, reviewRequired: true };
  for (const r of regions) {
    const { x, y, z } = regionPlacement(r, grid),
      section = `component-${r.id}`,
      label = COMPONENT_LABELS[r.kind];
    const parts = positionedComponent(
      r.kind,
      [(x - model.width / 2) * 20, -y * 8, (z - model.depth / 2) * 20],
      r.rotation,
      model,
    );
    model.assembly!.sections.push({ id: section, name: label });
    model.semanticDesign.components.push({
      id: section,
      name: label,
      kind: r.kind,
      parts: parts.length,
    });
    for (const b of parts) {
      const step = model.assembly!.steps.length;
      model.assembly!.steps.push({
        name: `${label} · ${ASSEMBLY_PARTS[b.part].name}`,
        description: b.installation!,
        section,
      });
      model.bricks.push({ ...b, id: model.bricks.length + 1, step, section });
    }
  }
  model.levels = model.assembly!.steps.map((_, i) => i);
  model.height = Math.max(model.height, ...model.bricks.map((b) => b.y + b.h));
  model.assembly!.reference +=
    ' 已按用户指定区域替换为目录零件组件；颜色与在售组合需核对，人物关节和配件插接需实物复核。';
  return model;
}
// Color clusters are suggestions, never semantic claims. No temple-specific
// coordinates, file names, or automatic application of uncertain detections.
export type ComponentHint = ComponentRegion & { source: 'color' | 'guess' };
// HSV keeps foliage and flames apart from the sand, grey and white bricks that
// dominate most reconstructions. Saturation, not just green dominance, is what
// separates a green canopy from a beige wall.
function hueSaturation(r: number, g: number, b: number) {
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    chroma = max - min,
    sat = max ? chroma / max : 0;
  if (!chroma) return { hue: -1, sat, value: max };
  const h =
    max === r
      ? ((g - b) / chroma + 6) % 6
      : max === g
        ? (b - r) / chroma + 2
        : (r - g) / chroma + 4;
  return { hue: h * 60, sat, value: max };
}
export function suggestComponents(
  mesh: TriangleMesh,
  resolution: number,
  options: { statue?: boolean } = {},
): ComponentHint[] {
  const { min, span, grid } = meshFrame(mesh, resolution);
  const buckets = new Map<string, Map<string, V3[]>>();
  const dark = new Map<string, V3[]>();
  const add = (map: Map<string, V3[]>, key: string, p: V3) => {
    const cell = map.get(key) || [];
    cell.push(p);
    map.set(key, cell);
  };
  for (let t = 0; t < mesh.colors.length / 3; t++) {
    const [r, g, b] = Array.from(mesh.colors.slice(t * 3, t * 3 + 3));
    const { hue, sat, value } = hueSaturation(r, g, b);
    // The picture, not the brick colour, is what settles whether a face is
    // canopy: an olive leaf can be quantised to the sand around it, and this
    // flag was read before that happened.
    const kind: ComponentKind | undefined =
      (mesh.features?.[t] || 0) & MESH_FEATURE.foliage ||
      (sat >= 0.15 && value >= 35 && hue >= 65 && hue <= 175)
        ? 'tree'
        : sat >= 0.45 && value >= 90 && (hue < 45 || hue > 350)
          ? 'brazier'
          : undefined;
    const p = [0, 1, 2].map(
      (a) =>
        ([0, 1, 2].reduce((s, j) => s + mesh.positions[t * 9 + j * 3 + a], 0) /
          3 -
          min[a]) /
        span[a],
    ) as V3;
    // Dark neutral faces include the flat base plate and the rim around it,
    // which would otherwise join every object into one cluster; only faces
    // standing above that plane can describe a tree or an opening. They are
    // bucketed on a finer grid because a rim is a thin sliver that must not
    // swallow a nearby compact object.
    const isDark = sat <= 0.3 && value <= 125 && p[1] >= 0.06;
    if (!kind && !isDark) continue;
    const key = kind
      ? `${Math.floor(p[0] * 8)}:${Math.floor(p[2] * 8)}`
      : `${Math.floor(p[0] * 16)}:${Math.floor(p[2] * 16)}`;
    if (kind) {
      const map = buckets.get(kind) || new Map<string, V3[]>();
      buckets.set(kind, map);
      add(map, key, p);
    } else add(dark, key, p);
  }
  const candidates: ComponentHint[] = [];
  const accepted: ReturnType<typeof regionPlacement>[] = [];
  const place = (
    kind: ComponentKind,
    anchor: V3,
    source: 'color' | 'guess',
    fallbackAnchors?: V3[],
  ): ComponentHint | undefined => {
    const region: ComponentHint = {
      id: `${source === 'guess' ? 'guess' : 'hint'}-${candidates.length + 1}`,
      kind,
      anchor,
      referenceAnchor: [...anchor],
      ...(fallbackAnchors?.length ? { fallbackAnchors } : {}),
      ...COMPONENT_SIZES[kind],
      rotation: kind === 'statue' ? 2 : 0,
      source,
    };
    const box = regionPlacement(region, grid);
    if (
      kind !== 'statue' &&
      accepted.some((other) =>
        [0, 1, 2].every(
          (a) =>
            Math.min(other.max[a], box.max[a]) -
              Math.max(other.min[a], box.min[a]) >
            0,
        ),
      )
    )
      return undefined;
    accepted.push(box);
    candidates.push(region);
    return region;
  };
  const push = (
    kind: ComponentKind,
    points: V3[],
    source: 'color' | 'guess',
  ) => {
    const anchor = centerOf(points);
    anchor[1] = Math.max(
      0,
      Math.min(...points.map((p) => p[1])) -
        (kind === 'tree' ? 10 : kind === 'brazier' ? 8 : 4) / grid[1],
    );
    return place(kind, anchor, source);
  };
  // A canopy or a flame spread over several ground cells; merging neighbouring
  // cells before thresholding is what keeps a real tree from being dropped.
  const coloured = (['tree', 'brazier'] as ComponentKind[]).flatMap((kind) =>
    mergeCells(buckets.get(kind) || new Map())
      .filter((points) => points.length >= 12)
      .map((points) => ({ kind, points })),
  );
  for (const cluster of coloured.sort(
    (a, b) => b.points.length - a.points.length,
  )) {
    push(cluster.kind, cluster.points, 'color');
    if (candidates.length === 6) break;
  }
  // Dark faces above the flat base plate and its rim. A low, compact, upright
  // mass standing on the ground reads as a tree or bush; a facade recess is
  // just as tall but sits high on the wall, so height and footprint separate
  // the two. Both are guesses, never colour detections.
  const darkClusters = mergeCells(dark)
    .filter((points) => points.length >= 20)
    .map((points) => ({
      points,
      x: extent(points, 0),
      y: extent(points, 1),
      z: extent(points, 2),
    }));
  const trees = darkClusters
    .filter(
      (c) =>
        (c.y[0] + c.y[1]) / 2 < 0.45 &&
        c.y[1] - c.y[0] >= 0.08 &&
        c.x[1] - c.x[0] <= 0.3 &&
        c.z[1] - c.z[0] <= 0.3,
    )
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, 2);
  for (const tree of trees) {
    if (candidates.length >= 6) break;
    push('tree', tree.points, 'guess');
  }
  // A person is not a colour either. Two flames flank an entrance, and the
  // figure in such a reference usually stands between them on the recess
  // floor; otherwise the tallest dark recess is the best available guess.
  if (options.statue !== false && candidates.length < 6) {
    const flames = candidates.filter((c) => c.kind === 'brazier');
    const pair = nearestPair(flames);
    if (pair) {
      const mx = (pair[0].anchor[0] + pair[1].anchor[0]) / 2,
        mz = (pair[0].anchor[2] + pair[1].anchor[2]) / 2,
        // The figure stands inside the opening between the flames, not on the
        // steps in front of it: take the depth and floor from the dark faces
        // in that column of the facade.
        column = darkClusters
          .flatMap((c) => c.points)
          .filter((q) => Math.abs(q[0] - mx) < 0.12),
        floor = column.length
          ? Math.min(...column.map((q) => q[1]))
          : Math.max(pair[0].anchor[1], pair[1].anchor[1]),
        depth = column.length
          ? column.map((q) => q[2]).sort((a, b) => a - b)[
              Math.floor(column.length / 2)
            ]
          : mz;
      // Keep the inferred entrance position even if it overlaps a neighbour.
      // The assembler reports the conflict; detection must not relocate a
      // statue sideways just to make its bounding box fit.
      place('statue', [mx, floor, depth], 'guess');
    } else {
      const tallest = [...darkClusters].sort(
        (a, b) => b.y[1] - b.y[0] - (a.y[1] - a.y[0]),
      )[0];
      if (tallest) push('statue', tallest.points, 'guess');
    }
  }
  return candidates;
}
function extent(points: V3[], axis: number): [number, number] {
  const values = points.map((p) => p[axis]);
  return [Math.min(...values), Math.max(...values)];
}
// The two flames closest to each other on the ground are the likeliest pair
// framing a single entrance.
function nearestPair<T extends { anchor: V3 }>(items: T[]): [T, T] | undefined {
  let best: [T, T] | undefined,
    distance = Infinity;
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const d = Math.hypot(
        items[i].anchor[0] - items[j].anchor[0],
        items[i].anchor[2] - items[j].anchor[2],
      );
      if (d < distance) {
        distance = d;
        best = [items[i], items[j]];
      }
    }
  return best;
}
// Flood fill over the 8 x 8 ground grid, joining cells that touch, including
// diagonally, so one object is never split into sub-threshold fragments.
function mergeCells(cells: Map<string, V3[]>): V3[][] {
  const seen = new Set<string>(),
    clusters: V3[][] = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const queue = [start],
      points: V3[] = [];
    while (queue.length) {
      const key = queue.pop()!;
      points.push(...cells.get(key)!);
      const [cx, cz] = key.split(':').map(Number);
      for (let dx = -1; dx <= 1; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          const next = `${cx + dx}:${cz + dz}`;
          if (cells.has(next) && !seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
    }
    clusters.push(points);
  }
  return clusters;
}
function centerOf(points: V3[]): V3 {
  return points
    .reduce((sum, p) => sum.map((v, a) => v + p[a]) as V3, [0, 0, 0])
    .map((v) => v / points.length) as V3;
}
