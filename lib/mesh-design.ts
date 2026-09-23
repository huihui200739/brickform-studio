import { componentTemplate } from './component-library.ts';
import { repeatedGroups } from './scene-elements.ts';
import {
  placementCandidates,
  mountingPoint,
  reportPlacement,
  type PlacementReport,
} from './placement-policy.ts';
import {
  AUTO_REPLACEMENT_THRESHOLD,
  automaticReplacementScore,
} from './semantic-refinement.ts';
import { COMPONENT_LABELS } from './semantic-components.ts';
import type { V3 } from './assembly-catalog.ts';
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
  type Raster,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import type { TriangleMesh } from './mesh-types.ts';
import { requiresFocalPreservation } from './focal-preservation.ts';
import { classifyStructure } from './structure-classifier.ts';
import { generateLatticeTowerScaffold } from './procedural-structures.ts';
import { aestheticScore } from './aesthetic-packing.ts';
import { optimizeAestheticPacking } from './aesthetic-packing.ts';
import { applyRepresentationTransaction } from './composition/transaction.ts';
import { enforceGroupConsistency } from './element-grouping.ts';
import { routeStructureRepresentation } from './representation/representation-router.ts';
import {
  createModelView,
  createReferenceView,
  makeRepresentationResult,
  validateElementVisibility,
  type ReferenceView,
} from './representation/visibility-validation.ts';
import type { ReferenceCamera } from './reference-colors.ts';
import type { SceneElementInstance } from './scene/scene-types.ts';

// Conversion is split in two stages: the triangle volume is cast once, and each
// component-placement attempt re-reads that volume. Autoplacement can therefore
// test many bottom positions without paying for the voxelisation again.
export type MeshVolume = {
  cells: Map<string, { color: number; support: boolean }>;
  triangles: number;
  w: number;
  h: number;
  d: number;
  dominant: number;
  openRows: number;
  intersected: number;
  protectedCells: Set<string>;
};
export type PreservedRegion = {
  kind: 'statue';
  bbox3d: { min: V3; max: V3 };
  priority: 'high';
  preserveSilhouette: boolean;
  preserveCavity: boolean;
  preserveDepthSeparation: boolean;
};

export function proceduralTowerCells(width: number, height: number, depth: number) {
  const cells = new Map<string, { color: number; support: boolean }>();
  // A complete third layer bonds the two base courses. The tower remains open
  // above this platform, while every perimeter base piece belongs to one graph.
  for (let x = 0; x < width; x++)
    for (let z = 0; z < depth; z++)
      cells.set(`${x},2,${z}`, { color: 7, support: false });
  for (let x = 0; x < width; x++)
    for (let z = 0; z < depth; z++)
      cells.set(`${x},3,${z}`, { color: 7, support: false });
  const put = (x: number, y: number, z: number) => {
    if (x < 1 || x >= width - 1 || z < 1 || z >= depth - 1 || y < 2 || y >= height - 1) return;
    cells.set(`${x},${y},${z}`, { color: 7, support: false });
  };
  const top = Math.max(5, height - 5);
  const stride = Math.max(4, Math.floor(height / 10));
  for (let y = 2; y < top; y++) {
    const t = (y - 2) / Math.max(1, top - 2);
    const xs = [
      Math.round(1 + (width - 3) * 0.18 * (1 - t) + (width / 2 - 1) * t),
      Math.round(1 + (width - 3) * 0.82 * (1 - t) + (width / 2 - 1) * t),
    ];
    const zs = [
      Math.round(1 + (depth - 3) * 0.18 * (1 - t) + (depth / 2 - 1) * t),
      Math.round(1 + (depth - 3) * 0.82 * (1 - t) + (depth / 2 - 1) * t),
    ];
    for (const x of xs) for (const z of zs) put(x, y, z);
    if ((y - 2) % stride === 0 || y === top - 1) {
      for (let x = xs[0]; x <= xs[1]; x++) {
        put(x, y, zs[0]);
        put(x, y, zs[1]);
      }
      for (let z = zs[0]; z <= zs[1]; z++) {
        put(xs[0], y, z);
        put(xs[1], y, z);
      }
    }
  }
  const platform = Math.max(3, Math.floor(height * 0.48));
  for (let x = 2; x < width - 2; x++) {
    put(x, platform, Math.max(1, Math.floor(depth * 0.2)));
    put(x, platform, Math.max(1, depth - 2 - Math.floor(depth * 0.2)));
  }
  for (let y = top; y < height - 1; y++) put(Math.floor(width / 2), y, Math.floor(depth / 2));
  return cells;
}

function assembleProceduralStructure(
  mesh: TriangleMesh,
  resolution: number,
  structure: ReturnType<typeof classifyStructure>,
): Model {
  const volume = buildMeshVolume(mesh, resolution);
  const width = volume.w + 2;
  const height = volume.h + 2;
  const depth = volume.d + 2;
  const raw = finishModel(
    proceduralTowerCells(width, height, depth),
    width,
    height,
    depth,
    'image',
    mesh.name,
    resolution,
    volume.dominant,
  );
  // The generic base packer intentionally uses a one-stud perimeter row. Its
  // far edge has no cross-row plate and is therefore a disconnected cosmetic
  // strip on an otherwise open tower; omit that strip before validation.
  raw.bricks = raw.bricks
    .filter((brick) => brick.z + brick.d <= depth - 1)
    .map((brick, index) => ({ ...brick, id: index + 1 }));
  raw.supportCount = raw.bricks.filter((brick) => brick.support).length;
  raw.levels = [...new Set(raw.bricks.map((brick) => brick.y))].sort((a, b) => a - b);
  optimizeAestheticPacking(raw, 256);
  const model = groupImageAssembly(raw);
  model.structureCategory = structure.category;
  model.structureConfidence = structure.confidence;
  model.meshDesign = {
    method: 'mesh-volume',
    referenceColors: !!mesh.coloring,
    triangles: mesh.positions.length / 9,
    resolution,
    openRowFraction: volume.openRows / Math.max(1, volume.intersected),
  };
  const structurePlan = routeStructureRepresentation(structure.category, structure.confidence);
  model.representationPlans = [{
    elementId: 'primary-structure',
    kind: structurePlan.kind,
    confidence: structurePlan.confidence,
    reason: [...structure.evidence, ...structurePlan.reason, '结构路由使用开放式塔身、平台与尖塔模板'],
  }];
  model.assembly!.reference = `结构分类为 ${structure.category}，使用程序化开放塔身表达；保留四腿、平台、收腰和尖塔轮廓。`;
  model.aesthetic = aestheticScore(model);
  const check = validateModel(model);
  if (check.collisions || check.unsupported || check.invalidParts || !check.connected)
    throw Error(`程序化结构未通过连接检查，请降低尺寸后重试（碰撞 ${check.collisions}，缺支撑 ${check.unsupported}，断开 ${check.connected ? 0 : 1}）。`);
  return model;
}

export type VisibilityContext = {
  image?: Raster;
  camera?: ReferenceCamera;
};

function ensureSceneElement(region: ComponentRegion): ComponentRegion {
  if (region.sceneElement) return region;
  const category = region.kind;
  const sceneElement: SceneElementInstance = {
    id: region.id,
    category,
    confidence: region.confidence ?? 1,
    anchorUV: region.imageUV,
    worldAnchor: [...region.anchor],
    scaleHint: {
      width: region.width,
      depth: region.depth,
      height: region.height,
    },
    importance: category === 'statue' ? 'primary' : 'secondary',
    importanceScore: category === 'statue' ? 1 : 0.5,
    mustRepresent: category === 'statue',
    detectionSource: region.source === 'color' ? 'color' : 'heuristic',
    anchorKind: category === 'statue' ? 'surface' : 'ground',
    evidence: ['legacy region promoted to a scene instance'],
  };
  return { ...region, sceneElement };
}

function visibilityView(
  mesh: TriangleMesh,
  model: Model,
  resolution: number,
  context?: VisibilityContext,
): ReferenceView {
  if (context?.image) {
    try {
      return createReferenceView(mesh, context.image, resolution, context.camera);
    } catch {
      // A missing or invalid reference cannot make a valid component disappear.
    }
  }
  return createModelView(model, context?.camera);
}

function auditRepresentation(
  model: Model,
  region: ComponentRegion,
  view: ReferenceView,
  fallbackLevel: number,
) {
  const element = region.sceneElement!;
  const section = `component-${region.id}`;
  const requestedKind = region.representation || 'component';
  const actualKind = region.representation || 'component';
  const result = makeRepresentationResult(
    element,
    requestedKind,
    actualKind,
    model,
    section,
    fallbackLevel,
  );
  const checked = validateElementVisibility(element, result, view, model);
  checked.committed = checked.brickCount > 0 && checked.visibleFromReference;
  region.representationResult = checked;
  return checked;
}

function reserveCommittedGeometry(model: Model) {
  model.reservedVolumes = (model.representationResults || [])
    .filter((result) => result.committed && result.bbox3d)
    .map((result) => result.bbox3d!);
  model.semanticReservedCells = (model.representationResults || [])
    .filter((result) => result.committed)
    .flatMap((result) => {
      const ids = new Set(result.brickIds);
      return model.bricks
        .filter((brick) => ids.has(brick.id))
        .flatMap((brick) => {
          const cells: string[] = [];
          for (let x = Math.floor(brick.x); x < Math.ceil(brick.x + brick.w); x++)
            for (let y = Math.floor(brick.y); y < Math.ceil(brick.y + brick.h); y++)
              for (let z = Math.floor(brick.z); z < Math.ceil(brick.z + brick.d); z++)
                cells.push(`${x},${y},${z}`);
          return cells;
        });
    });
}

function focalFallbackCandidates(region: ComponentRegion): ComponentRegion[] {
  if (region.kind !== 'statue') return [];
  const ids = [
    'statue-simplified',
    'statue-relief',
    'statue-simple-standing',
    'statue-forced-voxel-silhouette',
  ];
  const candidates: ComponentRegion[] = ids.flatMap((id) => {
    const template = componentTemplate(id);
    if (!template) return [];
    return [{
      ...region,
      templateId: id,
      representation:
        id === 'statue-relief'
          ? 'relief' as const
          : id === 'statue-forced-voxel-silhouette'
            ? 'voxel' as const
            : 'semantic-template' as const,
      width: template.bboxStuds.width,
      depth: template.bboxStuds.depth,
      height: template.bboxStuds.height,
    }];
  });
  return candidates;
}

// Cast through a genuine triangle volume, retaining separate depth intervals
// and openings. Image brightness is never used to invent depth.
export function buildMeshVolume(
  mesh: TriangleMesh,
  resolution = 28,
): MeshVolume {
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
  const protectedCells = new Set<string>();
  surface.forEach((cell, key) => {
    const [x, y] = key.split(',').map(Number);
    if (x > w * 0.3 && x < w * 0.7 && y > 2 && y < h * 0.78)
      protectedCells.add(key);
  });
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
  if (mesh.statueFallback) {
    const f = mesh.statueFallback;
    for (const [x, y, z] of f.cells) {
      if (x < 0 || y < 0 || z < 0 || x >= w || y >= h || z >= d) continue;
      // Fallback cells are in front of the niche. They are ordinary subject
      // voxels, but are protected from generic support insertion below.
      const key = `${x + 1},${y + 2},${z + 1}`;
      cells.set(key, { color: dominant, support: false });
      protectedCells.add(key);
    }
  }
  return {
    cells,
    triangles: n,
    w,
    h,
    d,
    dominant,
    openRows,
    intersected,
    protectedCells,
  };
}
// Assemble the brick model from a cast volume and the requested component
// replacements. Strict on purpose: any component that cannot be seated throws.
function assembleVolume(
  mesh: TriangleMesh,
  volume: MeshVolume,
  resolution: number,
  regions: ComponentRegion[],
): Model {
  const {
      w,
      h,
      d,
      dominant,
      openRows,
      intersected,
      triangles,
      protectedCells,
    } = volume,
    cells = new Map(volume.cells);
  validateRegions(regions, [w, h, d]);
  const placements = regions.map((r) => regionPlacement(r, [w, h, d]));
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
    protectedCells.size || placements.length
      ? (x, y, z) =>
          protectedCells.has(`${x},${y},${z}`) ||
          placements.some((r) => insideRegion([x, y, z], r))
      : undefined,
    [...bridges, ...(() => {
      const structure = classifyStructure(mesh);
      if ((structure.category !== 'lattice-tower' && structure.category !== 'tower') || structure.confidence < 0.7)
        return [];
      return generateLatticeTowerScaffold(
        w + 2,
        h + 2,
        d + 2,
        (x, y, z) => y < 2 || cells.has(`${x},${y},${z}`),
        dominant,
      );
    })()],
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
  const packing = optimizeAestheticPacking(raw, 192);
  const model = groupImageAssembly(raw);
  model.meshDesign = {
    method: 'mesh-volume',
    smoothTiles,
    referenceColors: !!mesh.coloring,
    triangles,
    resolution,
    openRowFraction: openRows / Math.max(1, intersected),
  };
  model.assembly!.reference = `按三维网格体积生成；保留网格中的前后布局和孔洞。新增辅助支撑 ${model.supportCount} 块，已计入清单。网格可能含 AI 推测，连接检查不代表外观还原或实物稳定性已验证。`;
  if (packing.removed)
    model.assembly!.reference += ` 美学后处理移除冗余隐藏支撑 ${packing.removed} 块，保留连接与连通性。`;
  if (mesh.statueFallback?.cells.length)
    model.assembly!.reference +=
      ' 已根据参考图提取的轮廓注入普通积木浮雕，未使用人物特殊零件；轮廓与位置仍需外观核对。';
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
export function meshToDesign(
  mesh: TriangleMesh,
  resolution = 28,
  regions: ComponentRegion[] = [],
  visibility?: VisibilityContext,
): Model {
  regions = regions.map(ensureSceneElement);
  enforceGroupConsistency(regions);
  if (regions.some((r) => r.autoRefinement))
    return meshToDesignAuto(mesh, resolution, regions, 48, visibility).model;
  const eligible = regions.filter(
    (r) =>
      r.placementStatus !== 'rejected' &&
      (r.source === 'manual' || r.confirmed === true || !r.source),
  );
  const structure = classifyStructure(mesh);
  if (!eligible.length && (structure.category === 'lattice-tower' || structure.category === 'tower') && structure.confidence >= 0.62)
    return assembleProceduralStructure(mesh, resolution, structure);
  const model = assembleVolume(
    mesh,
    buildMeshVolume(mesh, resolution),
    resolution,
    eligible,
  );
  model.structureCategory = structure.category;
  model.structureConfidence = structure.confidence;
  const view = visibilityView(mesh, model, resolution, visibility);
  const applied = eligible.filter((r) => r.sceneElement);
  model.representationResults = applied.map((r) => auditRepresentation(model, r, view, 0));
  reserveCommittedGeometry(model);
  model.sceneElements = applied.map((r) => ({
    ...r.sceneElement!,
    chosenRepresentation: r.representation || 'component',
    chosenTemplateId: r.templateId,
    outcome: 'committed',
    representationResult: r.representationResult,
  }));
  model.representationPlans = model.sceneElements.map((element) => ({
    elementId: element.id,
    kind: element.chosenRepresentation || 'generic-geometry',
    templateId: element.chosenTemplateId,
    confidence: element.confidence,
    reason: ['legacy composition audited after commit'],
  }));
  return model;
}
export type AutoComponentResult = {
  model: Model;
  applied: ComponentRegion[];
  dropped: ComponentRegion[];
  reports: PlacementReport[];
  attempts: number;
};
export function meshToDesignAuto(
  mesh: TriangleMesh,
  resolution = 28,
  regions: ComponentRegion[] = [],
  budget = 48,
  visibility?: VisibilityContext,
): AutoComponentResult {
  if (regions.length > 64) throw Error('一次最多替换 64 个组件。');
  regions = regions.map(ensureSceneElement);
  enforceGroupConsistency(regions);
  // Manual overrides and sufficiently confident automatic proposals can enter
  // a trial. Automatic confirmation happens only after the trial commits.
  const eligible = regions.filter(
    (r) =>
      r.placementStatus !== 'rejected' &&
      (r.source === 'manual' ||
        (!r.autoRefinement && (r.confirmed === true || !r.source)) ||
        (r.autoRefinement === true &&
          r.source === 'color' &&
          (r.kind !== 'statue' || r.templateId === 'statue-relief' || r.templateId === 'statue-simplified') &&
          automaticReplacementScore(r) >= AUTO_REPLACEMENT_THRESHOLD)),
  );
  const unconfirmed = regions.filter((r) => !eligible.includes(r));
  const classified = classifyStructure(mesh);
  if (!regions.length && (classified.category === 'lattice-tower' || classified.category === 'tower') && classified.confidence >= 0.62)
    return { model: assembleProceduralStructure(mesh, resolution, classified), applied: [], dropped: [], reports: [], attempts: 0 };
  const volume = buildMeshVolume(mesh, resolution),
    grid: V3 = [volume.w, volume.h, volume.d];
  const limit = Math.max(
    0,
    Math.min(96, Number.isFinite(budget) ? Math.floor(budget) : 48),
  );
  let attempts = 0;
  const attempt = (list: ComponentRegion[]) => {
    if (attempts >= limit) return null;
    attempts++;
    // Every replacement is composed in a trial state. The volume passed to
    // assembleVolume remains the source state; a failed trial returns it
    // untouched and therefore cannot erase the detected object.
    let trialModel: Model | null = null;
    const transaction = applyRepresentationTransaction({
      currentState: { regions: [] as ComponentRegion[] },
      plan: list,
      cloneCurrentState: (state) => ({ regions: [...state.regions] }),
      removeOriginalRegion: (trial) => {
        trial.regions.length = 0;
      },
      addRepresentation: (trial, plan) => {
        trial.regions.push(...plan);
        trialModel = assembleVolume(mesh, volume, resolution, trial.regions);
      },
      validate: () => ({ acceptable: trialModel !== null }),
    });
    return transaction.committed ? trialModel : null;
  };
  const applied: ComponentRegion[] = [],
    dropped: ComponentRegion[] = [...unconfirmed],
    reports: PlacementReport[] = [];
  let model: Model | null = null;
  const origin = (r: ComponentRegion) =>
    mountingPoint({ ...r, anchor: r.referenceAnchor || r.anchor }, grid);
  const candidates = eligible.map((r) => placementCandidates(r, grid));
  // The first candidates always keep the original snapped mounting points.
  if (eligible.length && candidates.every((c) => c.length)) {
    const initial = candidates.map((c) => c[0]);
    model = attempt(initial);
    if (model) applied.push(...initial);
  }
  if (!model) {
    // Every accepted addition is validated WITH the existing assembly. This
    // avoids accepting independently valid components then silently deleting
    // earlier components when the combined model fails.
    const visited = new Set<number>();
    for (let i = 0; i < eligible.length; i++) {
      if (visited.has(i)) continue;
      visited.add(i);
      const original = origin(eligible[i]);
      // Preserve a genuinely level pair's relative spacing. Do not invent a
      // model-wide symmetry axis or force different pedestals to one height.
      const partner = eligible.findIndex(
        (r, j) =>
          j > i &&
          !r.autoRefinement && !eligible[i].autoRefinement &&
          !visited.has(j) &&
          r.placed !== false &&
          eligible[i].placed !== false &&
          r.kind === eligible[i].kind &&
          origin(r)[1] === original[1] &&
          origin(r)[2] === original[2] &&
          (r.anchor[0] - 0.5) * (eligible[i].anchor[0] - 0.5) < 0,
      );
      const share = Math.max(
        1,
        Math.floor(
          (limit - attempts) / Math.max(1, regions.length - visited.size + 1),
        ),
      );
      const stop = Math.min(limit, attempts + share * (partner >= 0 ? 2 : 1));
      let accepted: ComponentRegion[] | undefined;
      const variants = [eligible[i]];
      for (const id of eligible[i].templateCandidates || []) {
        if (id === eligible[i].templateId) continue;
        const template = componentTemplate(id);
        if (!template || template.category !== eligible[i].kind) continue;
        variants.push({...eligible[i], templateId:id, representation:template.representation === 'component' ? 'component' : 'semantic-template',
          width:template.bboxStuds.width,depth:template.bboxStuds.depth,height:template.bboxStuds.height});
      }
      // Try each expression at the original anchor before spending budget on
      // movement. A failing large tree cannot starve its small-tree fallback.
      const options = variants.flatMap(r => placementCandidates(r,grid).slice(0,1));
      options.push(...candidates[i].slice(1));
      for (const first of options) {
        if (attempts >= stop) break;
        const list = [first];
        if (partner >= 0) {
          const p = mountingPoint(first, grid),
            d = p.map((v, a) => v - original[a]);
          const otherOrigin = origin(eligible[partner]);
          const second = candidates[partner].find((c) =>
            mountingPoint(c, grid).every((v, a) => v - otherOrigin[a] === d[a]),
          );
          if (!second) continue;
          list.push(second);
        }
        const result = attempt([...applied, ...list]);
        if (result) {
          model = result;
          accepted = list;
          break;
        }
      }
      if (partner >= 0) visited.add(partner);
      if (accepted) applied.push(...accepted);
      else {
        dropped.push(eligible[i]);
        if (partner >= 0) dropped.push(eligible[partner]);
      }
    }
  }
  if (!model) model = assembleVolume(mesh, volume, resolution, []);
  const structure = classifyStructure(mesh);
  model.structureCategory = structure.category;
  model.structureConfidence = structure.confidence;
  // Presence in metadata is insufficient for a focal element. Audit the
  // committed bricks from the reference view, then transactionally try the
  // ordered fallback chain until a visible representation is committed.
  const view = visibilityView(mesh, model, resolution, visibility);
  const focalRegions = [...applied, ...dropped].filter((r) =>
    requiresFocalPreservation(r.sceneElement),
  );
  for (const focal of focalRegions) {
    const current = applied.find((r) => r.id === focal.id);
    if (current && auditRepresentation(model, current, view, 0).committed)
      continue;
    let committed = false;
    const fallbacks = focalFallbackCandidates(focal);
    for (let level = 1; level <= fallbacks.length && !committed; level++) {
      const fallback = fallbacks[level - 1];
      const candidatesForFallback = placementCandidates(fallback, grid).slice(0, 9);
      for (const candidate of candidatesForFallback) {
        if (attempts >= limit) break;
        const trialApplied = applied.filter((r) => r.id !== focal.id);
        const trial = attempt([...trialApplied, candidate]);
        if (!trial) continue;
        const checked = auditRepresentation(trial, candidate, visibilityView(mesh, trial, resolution, visibility), level);
        if (!checked.committed) continue;
        model = trial;
        const index = applied.findIndex((r) => r.id === focal.id);
        if (index >= 0) applied.splice(index, 1, candidate);
        else applied.push(candidate);
        const droppedIndex = dropped.findIndex((r) => r.id === focal.id);
        if (droppedIndex >= 0) dropped.splice(droppedIndex, 1);
        committed = true;
        break;
      }
    }
    if (!committed && current) {
      const failed = current.representationResult;
      if (failed) failed.failureReasons.push('all focal fallbacks failed visibility validation');
    }
  }
  for (const r of regions)
    reports.push(
      reportPlacement(
        r,
        applied.find((a) => a.id === r.id),
        grid,
        COMPONENT_LABELS[r.kind],
        attempts >= limit,
      ),
    );
  for (const r of applied) {
    r.placementStatus = reports.find((v) => v.id === r.id)!.status;
    if (r.autoRefinement) {
      r.confirmed = true;
      r.autoConfirmed = true;
      r.replacementConfidence = automaticReplacementScore(r);
    }
  }
  if (model.semanticDesign) {
    model.semanticDesign.autoPlaced = true;
    model.semanticDesign.dropped = dropped.map((r) => r.id);
  }
  const finalView = visibilityView(mesh, model, resolution, visibility);
  for (const appliedRegion of applied)
    if (!appliedRegion.representationResult || !appliedRegion.representationResult.committed)
      auditRepresentation(model, appliedRegion, finalView, appliedRegion.representationResult?.fallbackLevel || 0);
  model.sceneElements = regions.filter(r=>r.sceneElement).map(r=>{
    const committed=applied.find(a=>a.id===r.id);
    return {...r.sceneElement!,chosenRepresentation:committed?.representation ?? r.representation ?? 'voxel',
      chosenTemplateId:committed?.templateId,outcome:committed?'committed':'preserved',
      representationResult:committed?.representationResult,
      reason:reports.find(p=>p.id===r.id)?.message};
  });
  model.repeatedGroups=repeatedGroups(model.sceneElements);
  model.sceneGroups = model.repeatedGroups;
  model.representationPlans = model.sceneElements.map((element) => ({
    elementId: element.id,
    kind: element.chosenRepresentation || 'generic-geometry',
    templateId: element.chosenTemplateId,
    confidence: element.confidence,
    reason: element.reason ? [element.reason] : ['preserved source geometry'],
  }));
  model.representationResults = [...applied, ...regions]
    .filter((r, index, all) =>
      r.representationResult && all.findIndex((candidate) => candidate.id === r.id) === index,
    )
    .map((r) => r.representationResult!);
  reserveCommittedGeometry(model);
  if (model.assembly && model.representationResults.length)
    model.assembly.reference +=
      ' 表达验证：' +
      model.representationResults
        .map((result) =>
          `${result.elementId} brickCount=${result.brickCount} ` +
          `bbox=${result.bbox3d ? 'valid' : 'invalid'} ` +
          `visibleFromReference=${result.visibleFromReference} ` +
          `fallbackLevel=${result.fallbackLevel}`,
        )
        .join('；');
  model.aesthetic = aestheticScore(model);
  model.componentPlacement = reports;
  if (reports.length && model.assembly)
    model.assembly.reference +=
      ' 组件位置检查：' +
      reports.map((r) => r.name + '：' + r.message).join('；');
  return { model, applied, dropped, reports, attempts };
}
