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
import {
  componentTemplate,
  fallbackRepresentation,
  retrieveComponent,
  type SceneElement,
} from './component-library.ts';
export { componentBricks } from './component-parts.ts';
import { componentBricks } from './component-parts.ts';
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
    | 'budget'
    | 'auto-applied'
    | 'preserved'
    | 'candidate'
    | 'confirmed'
    | 'rejected';
  /** Detection provenance. Automatic detections remain candidates until confirmed. */
  source?: 'color' | 'guess' | 'manual';
  confidence?: number;
  imageUV?: [number, number];
  replacementConfidence?: number;
  autoRefinement?: boolean;
  autoConfirmed?: boolean;
  autoScoreWithInstallation?: number;
  evidence?: string[];
  confirmed?: boolean;
  sceneElement?: SceneElement;
  templateId?: string;
  representation?: 'component' | 'template' | 'relief' | 'voxel';
  templateCandidates?: string[];
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
  if (regions.length > 64) throw Error('一次最多替换 64 个组件。');
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
export function positionedComponent(
  kind: ComponentKind,
  origin: V3,
  rotation: number,
  model: Pick<Model, 'width' | 'depth'>,
  templateId?: string,
  instance?: SceneElement,
): Brick[] {
  const m = rotate(rotation);
  const template = templateId ? componentTemplate(templateId) : undefined;
  if (templateId && (!template || template.category !== kind)) throw Error('实例模板不可用');
  const parts = template ? template.build(instance) : componentBricks(kind);
  return parts.map((b) => {
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
      label = (r.templateId && componentTemplate(r.templateId)?.name) || COMPONENT_LABELS[r.kind];
    const parts = positionedComponent(
      r.kind,
      [(x - model.width / 2) * 20, -y * 8, (z - model.depth / 2) * 20],
      r.rotation,
      model,
      r.templateId,
      r.sceneElement,
    );
    model.assembly!.sections.push({ id: section, name: label });
    model.semanticDesign.components.push({
      id: section,
      name: label,
      kind: r.kind,
      parts: parts.length,
      templateId: r.templateId,
      instanceId: r.sceneElement?.id || r.id,
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
      sceneElement: {
        id: `${source}-${candidates.length + 1}`,
        category: kind,
        confidence: source === 'guess' ? 0.35 : 0.6,
        worldAnchor: anchor,
        scaleHint: COMPONENT_SIZES[kind],
      },
      confirmed: false,
      confidence: source === 'guess' ? 0.35 : 0.6,
      evidence:
        source === 'guess'
          ? ['来自颜色/形状启发式推测，尚未得到用户确认']
          : ['来自参考图颜色或网格特征候选，尚未得到用户确认'],
    };
    const element = region.sceneElement!;
    const match = retrieveComponent(element);
    region.templateId = match?.template.id;
    region.representation = fallbackRepresentation(element, match);
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
  // No statue detector exists here. Dark recesses and paired flames cannot
  // determine a statue's location, even when a legacy caller requests one.
  return candidates;
}
function extent(points: V3[], axis: number): [number, number] {
  const values = points.map((p) => p[axis]);
  return [Math.min(...values), Math.max(...values)];
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
