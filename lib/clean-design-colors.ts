import { ASSEMBLY_PARTS } from './assembly-catalog.ts';
import { PALETTE, nearestColor, type Model } from './brick-engine.ts';
import { lab, colors as paletteLab } from './material-color-space.ts';
import { choosePartColor } from './part-color-policy.ts';
import { SOURCE_EDGE_KIND } from './scene-surface-graph.ts';
import { referenceMaterials } from './reference-materials.ts';
import { designMeshSurfaces } from './surface-design.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import { triangleMaterialAreas } from './voxel-materials.ts';
import { coherentMaterialDesign, COHERENT_LIMITATIONS } from './coherent-design-colors.ts';

type Point = [number, number, number];
export type MeshColorOptions = { colorMode?: 'clean' | 'coherent' | 'faithful' };
export type ColorDesign = {
  method: 'source-aware-planar-colour-cleanup';
  mode: 'clean' | 'coherent';
  approximation: true;
  changedBricks: number;
  eligibleBricks: number;
  planarPatches: number;
  protectedBricks: number;
  catalogBlocked: number;
  /** Coherent v2 reports design evidence, not verified intrinsic albedo. */
  policyVersion?: 'provenance-material-v2';
  uncertainBricks?: number;
  protectionReasons?: Record<string, number>;
  uncertainReasons?: Record<string, number>;
  materialMetrics?: {
    domainInconsistentAreaBefore: number; domainInconsistentAreaAfter: number;
    scalarShadowMismatchAreaBefore: number; scalarShadowMismatchAreaAfter: number;
    protectedObservedMaterialChangedArea: number;
    scalarDesignBricks: number; localApproximationBricks: number;
  };
  beforeColorCounts: number[];
  afterColorCounts: number[];
  changes: {
    brickId: number;
    from: number;
    to: number;
    reason: 'small-weak-colour-island' | 'continuous-radiance-design' | 'shaded-region-design' | 'unobserved-surface-design' | 'orientation-tone-design' | 'coherent-material-design' | 'source-scalar-shadow-design' | 'source-local-material-design';
    areaSupport: number;
  }[];
  limitations: string[];
};
const LIMITATIONS = [
  'Design colour approximation, not intrinsic-material recovery: a single photograph cannot prove shade versus dark paint. Stable sharp paint and chromatically distinct/neutral accents are protected; internally shaded dark paint remains ambiguous and can be mistaken for illumination.',
  'Only broad connected source-backed planar surfaces are eligible. Parts, poses, support, components, source observations and identity evidence are unchanged; unknown catalog colours still require procurement review.',
];
const key = (p: Point) => p.join(',');
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
const dot = (a: number[], b: number[]) => a.reduce((n, v, i) => n + v * b[i], 0);
const chromaticity = (c: number[]) => {
  const linear = c.map((v) => v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  const sum = linear.reduce((n, v) => n + v, 0);
  return linear.map((v) => sum > 1e-5 ? v / sum : 1 / 3);
};
function compatibleShadedRadiance(sourceLab: number[], sourceChroma: number[], donorRGB: number[], donorLab: number[]) {
  const a = Math.hypot(sourceLab[1], sourceLab[2]), b = Math.hypot(donorLab[1], donorLab[2]);
  const angle = Math.abs(Math.atan2(Math.sin(Math.atan2(sourceLab[2], sourceLab[1]) - Math.atan2(donorLab[2], donorLab[1])), Math.cos(Math.atan2(sourceLab[2], sourceLab[1]) - Math.atan2(donorLab[2], donorLab[1])))) * 180 / Math.PI;
  // Lab chroma contracts in a deep shadow. A fixed C>=18 gate would mistake
  // warm low-L stone shade for neutral paint. Keep that lower floor only below
  // L=45, with hue and raw linear chromaticity agreement plus a relative chroma
  // floor. Warm reflected light can shift hue in that deep range; truly neutral
  // grey/black and brighter low-chroma inlays never receive this exception.
  const deepShade = sourceLab[0] < 45;
  const minimumChroma = deepShade ? 8 : 18;
  const relativeChroma = b * 0.8 * Math.max(0.35, Math.min(1, sourceLab[0] / Math.max(1, donorLab[0])));
  return sourceLab[0] + 6 < donorLab[0] && b >= 18 && a >= Math.max(minimumChroma, relativeChroma) && angle <= (deepShade ? 30 : 18) && distance(sourceLab.slice(1), donorLab.slice(1)) <= (deepShade ? 28 : 14) && distance(sourceChroma, chromaticity(donorRGB)) <= (deepShade ? 0.3 : 0.22);
}
type Observation = { weight: number; rgb: number[]; regions: Map<number, number> };
type Node = {
  point: Point;
  axis: number;
  sign: number;
  brick: number;
  area: number;
  neighbours: number[];
  sourceArea: number;
  observedArea: number;
  protectedArea: number;
  rgb: number[];
  regions: Map<number, number>;
  families: Map<number, number>;
  sourceFaces: Map<number, number>;
};
function add(map: Map<number, number>, id: number, weight: number) {
  map.set(id, (map.get(id) ?? 0) + weight);
}
function majority(map: Map<number, number>) {
  let id = -1, best = 0;
  for (const [candidate, n] of map) if (n > best) { id = candidate; best = n; }
  return { id, fraction: best / Math.max(1e-12, [...map.values()].reduce((n, v) => n + v, 0)) };
}
function prototype(nodes: Node[], ids: number[]) {
  const rgb = [0, 0, 0], regions = new Map<number, number>();
  let observedArea = 0, protectedArea = 0, sourceArea = 0, area = 0;
  for (const id of ids) {
    const n = nodes[id];
    area += n.area; sourceArea += n.sourceArea; observedArea += n.observedArea; protectedArea += n.protectedArea;
    for (let a = 0; a < 3; a++) rgb[a] += n.rgb[a];
    for (const [r, w] of n.regions) add(regions, r, w);
  }
  const observedRGB = rgb.map((v) => v / Math.max(1e-12, observedArea));
  return { area, sourceArea, observedArea, protectedArea, regions, rgb: observedRGB, lab: lab(...observedRGB as Point), chroma: chromaticity(observedRGB) };
}

/** Explicit opt-in post-packing design. A fresh Model changes only colour and
 * its design metadata. No colour-dependent semantic/packing trial is rerun. */
function modelColors(model: Model, mesh: TriangleMesh, resolution: number, mode: 'clean' | 'coherent'): Model {
  // Completed designs are stable outputs, never new radiance observations.
  // Switching modes must use the unchanged source Model, not the previous design.
  if (model.colorDesign?.method === 'source-aware-planar-colour-cleanup') return model;
  const count = (bricks: Model['bricks']) => {
    const result = Array<number>(PALETTE.length).fill(0);
    for (const b of bricks) if (result[b.color] !== undefined) result[b.color]++;
    return result;
  };
  const design: ColorDesign = {
    method: 'source-aware-planar-colour-cleanup', mode, approximation: true,
    changedBricks: 0, eligibleBricks: 0, planarPatches: 0, protectedBricks: 0, catalogBlocked: 0,
    beforeColorCounts: count(model.bricks), afterColorCounts: count(model.bricks), changes: [], limitations: [...(mode === 'coherent' ? COHERENT_LIMITATIONS : LIMITATIONS)],
  };
  const unchanged = (warning?: string): Model => ({ ...model, colorDesign: { ...design, limitations: warning ? [...design.limitations, warning] : design.limitations } });
  const immutableBricks = new Map<number, string[]>();
  const reservedCells = new Set(model.semanticReservedCells ?? []);
  if (mode === 'coherent') {
    design.policyVersion = 'provenance-material-v2'; design.protectionReasons = {}; design.uncertainReasons = {};
    model.bricks.forEach((b, i) => {
      const reasons: string[] = [];
      if (!['brick', 'plate', 'tile'].includes(ASSEMBLY_PARTS[b.part]?.kind)) reasons.push('special-part');
      if (b.support) reasons.push('support');
      if (b.section === 'base') reasons.push('base');
      if (b.section?.startsWith('component-')) reasons.push('component');
      if (b.colorChoice) reasons.push('reviewed-catalog-substitution');
      if (![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isInteger)) reasons.push('non-grid-pose');
      if ([...reservedCells].some(cell => { const [x, y, z] = cell.split(',').map(Number); return x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h && z >= b.z && z < b.z + b.d; })) reasons.push('reserved-cell');
      if (reasons.length) { immutableBricks.set(i, reasons); for (const reason of reasons) design.protectionReasons![reason] = (design.protectionReasons![reason] ?? 0) + 1; }
    });
    design.protectedBricks = immutableBricks.size;
    design.uncertainBricks = model.bricks.length - immutableBricks.size;
  }
  const graph = mesh.sourceObservations;
  const faces = mesh.positions.length / 9;
  if (!graph || graph.sourcePositions.length !== mesh.positions.length || graph.faceNormals.length !== faces * 3 || graph.faceAreas.length !== faces || ![20, 28, 36, 48].includes(resolution))
    return unchanged('No compatible bounded source observation ledger: colours were retained.');
  const lo: Point = [Infinity, Infinity, Infinity], hi: Point = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], mesh.positions[i]); hi[i % 3] = Math.max(hi[i % 3], mesh.positions[i]);
  }
  const scale = resolution / Math.max(...hi.map((v, a) => v - lo[a]));
  if (!Number.isFinite(scale) || scale <= 0) return unchanged('Invalid source frame: colours were retained.');
  const occupied = new Map<string, number>(), editable = new Set<number>();
  const reserved = new Set(model.semanticReservedCells ?? []);
  for (let i = 0; i < model.bricks.length; i++) {
    const b = model.bricks[i];
    // Components and special/curved parts are accents, not plane votes. Their
    // envelopes still block adjacency so a plane cannot grow through them.
    const regular = ['brick', 'plate', 'tile'].includes(ASSEMBLY_PARTS[b.part]?.kind);
    if (regular && (mode === 'coherent' ? !immutableBricks.has(i) : ![0, 1, 2, 3, 4, 5, 6, 13, 14, 15, 16].includes(b.color)) && !b.support && b.section !== 'base' && !b.section?.startsWith('component-') && !b.colorChoice && [b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isInteger)) editable.add(i);
    if (![b.x, b.y, b.z, b.w, b.h, b.d].every(Number.isInteger)) continue;
    for (let x = b.x; x < b.x + b.w; x++) for (let y = b.y; y < b.y + b.h; y++) for (let z = b.z; z < b.z + b.d; z++) {
      occupied.set(`${x},${y},${z}`, i);
      if (occupied.size > 300000) return unchanged('Bounded colour cleanup cell limit exceeded: colours were retained.');
    }
  }
  const nodes: Node[] = [], nodeIds = new Map<string, number>(), cellNodes = new Map<string, number[]>();
  for (const [cell, brick] of occupied) {
    if (!editable.has(brick) || reserved.has(cell)) continue;
    const p = cell.split(',').map(Number) as Point;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      const other = [...p] as Point; other[axis] += sign;
      if (occupied.has(key(other))) continue;
      const id = nodes.length;
      nodes.push({ point: p, axis, sign, brick, area: axis === 1 ? 1 : 0.4, neighbours: [], sourceArea: 0, observedArea: 0, protectedArea: 0, rgb: [0, 0, 0], regions: new Map(), families: new Map(), sourceFaces: new Map() });
      nodeIds.set(`${cell}:${axis}:${sign}`, id);
      const list = cellNodes.get(cell) ?? []; list.push(id); cellNodes.set(cell, list);
    }
  }
  if (!nodes.length) return unchanged();
  const observations = new Map<number, Observation>();
  const sample = (face: number, x: number, y: number) => {
    const k = y * graph.raster.width + x;
    if (face < 0 || face >= faces || k < 0 || k >= graph.raster.foregroundMask.length || !graph.raster.foregroundMask[k]) return;
    let o = observations.get(face);
    if (!o) { o = { weight: 0, rgb: [0, 0, 0], regions: new Map() }; observations.set(face, o); }
    o.weight++;
    for (let a = 0; a < 3; a++) o.rgb[a] += graph.raster.rgba[k * 4 + a];
    add(o.regions, graph.raster.rawRegionIds[k], 1);
  };
  const projection = graph.projection;
  for (let i = 0; i < projection.observed.length; i++) if (projection.observed[i]) sample(projection.pixelFaces[i], projection.sourcePixelXY[i * 2], projection.sourcePixelXY[i * 2 + 1]);
  const centroids = projection.centroids;
  for (let i = 0; i < centroids.faces.length; i++) sample(centroids.faces[i], centroids.sourcePixelXY[i * 2], centroids.sourcePixelXY[i * 2 + 1]);
  // Reuse the existing exact-edge CSR; never weld by proximity. These geometric
  // families are independent of palette IDs and cannot cross holes or creases.
  const families = new Int32Array(faces).fill(-1), edges = graph.sharedEdges;
  const normal = (f: number) => Array.from(graph.faceNormals.subarray(f * 3, f * 3 + 3));
  const center = (f: number) => [0, 1, 2].map((a) => (mesh.positions[f * 9 + a] + mesh.positions[f * 9 + 3 + a] + mesh.positions[f * 9 + 6 + a]) / 3);
  let family = 0;
  for (let seed = 0; seed < faces; seed++) {
    if (families[seed] >= 0) continue;
    const q = [seed], n = normal(seed), c = center(seed); families[seed] = family;
    for (let h = 0; h < q.length; h++) {
      const f = q[h], fn = normal(f);
      for (let local = 0; local < 3; local++) {
        const e = edges.faceEdgeIds[f * 3 + local];
        if (e < 0 || edges.kinds[e] !== SOURCE_EDGE_KIND.manifold) continue;
        for (let slot = edges.offsets[e]; slot < edges.offsets[e + 1]; slot++) {
          const g = edges.faces[slot];
          if (families[g] >= 0) continue;
          const gn = normal(g);
          if (dot(n, gn) < 0.94 || dot(fn, gn) < 0.94 || Math.abs(dot(center(g).map((v, a) => v - c[a]), n)) * scale > 0.25) continue;
          families[g] = family; q.push(g);
        }
      }
    }
    family++;
  }
  const designed = designMeshSurfaces(mesh, resolution).mesh.positions;
  const size = hi.map((v, a) => Math.max(1, Math.ceil((v - lo[a]) * scale / (a === 1 ? 0.4 : 1)))) as Point;
  let tested = 0;
  for (let f = 0; f < faces; f++) {
    const n = normal(f), axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
    if (Math.abs(n[axis]) < 0.94) continue;
    const sign = n[axis] < 0 ? -1 : 1;
    const tri = [0, 1, 2].map((v) => [0, 1, 2].map((a) => (designed[f * 9 + v * 3 + a] - lo[a]) * scale / (a === 1 ? 0.4 : 1)) as Point);
    const o = observations.get(f);
    tested += triangleMaterialAreas(tri, size, (x, y, z, area) => {
      const sourceCell: Point = [x + 1, y + 2, z + 1];
      let id = nodeIds.get(`${key(sourceCell)}:${axis}:${sign}`);
      // A cast shell or a snapped design plane can put the source intersection
      // one occupied layer behind the actual exposed brick face. Follow only
      // its normal through that adjacent occupied cell; never search tangents.
      // At an exact grid boundary the clipping cell can instead be on the empty
      // side of the face. Bind it only when the source and built planes coincide
      // within 0.05 stud: that is a shared boundary, not traversal across a gap.
      // No pixel is reprojected and unrelated source geometry is never joined.
      if (id === undefined) {
        for (const step of [sign, -sign]) {
          const candidate = [...sourceCell] as Point; candidate[axis] += step;
          const other = nodeIds.get(`${key(candidate)}:${axis}:${sign}`);
          if (other === undefined) continue;
          const sourcePlane = tri.reduce((sum, p) => sum + p[axis], 0) / 3;
          const builtPlane = candidate[axis] - (axis === 1 ? 2 : 1) + (sign > 0 ? 1 : 0);
          if (Math.abs(sourcePlane - builtPlane) * (axis === 1 ? 0.4 : 1) > (occupied.has(key(sourceCell)) ? 1 : 0.05)) continue;
          id = other; break;
        }
      }
      if (id === undefined && mode === 'coherent') {
        const sourcePlane = tri.reduce((sum, p) => sum + p[axis], 0) / 3;
        // Packing can hide the first face of an exact source crease behind its
        // neighbour. Float32 snapping can put that plane just below a cell
        // boundary. Test adjacent normal cells, but require the SAME plane.
        for (const step of [0, sign, -sign]) {
          const candidate = [...sourceCell] as Point; candidate[axis] += step;
          const brick = occupied.get(key(candidate));
          const builtPlane = candidate[axis] - (axis === 1 ? 2 : 1) + (sign > 0 ? 1 : 0);
          if (brick === undefined || !editable.has(brick) || reserved.has(key(candidate)) || Math.abs(sourcePlane - builtPlane) * (axis === 1 ? 0.4 : 1) > 0.05) continue;
          id = nodeIds.get(`${key(candidate)}:${axis}:${sign}`);
          if (id === undefined) {
            id = nodes.length;
            nodes.push({ point: candidate, axis, sign, brick, area: axis === 1 ? 1 : 0.4, neighbours: [], sourceArea: 0, observedArea: 0, protectedArea: 0, rgb: [0, 0, 0], regions: new Map(), families: new Map(), sourceFaces: new Map() });
            nodeIds.set(`${key(candidate)}:${axis}:${sign}`, id);
          }
          break;
        }
      }
      if (id === undefined) return;
      const node = nodes[id]; node.sourceArea += area; add(node.families, families[f], area); if (mode === 'coherent') add(node.sourceFaces, f, area);
      if (mesh.features && (mesh.features[f] & MESH_FEATURE.foliage)) node.protectedArea += area;
      if (!o) return;
      node.observedArea += area;
      for (let a = 0; a < 3; a++) node.rgb[a] += area * o.rgb[a] / o.weight;
      for (const [region, weight] of o.regions) add(node.regions, region, area * weight / o.weight);
    });
    if (tested > 8000000) return unchanged('Bounded source-area traversal exceeded: colours were retained.');
  }
  if (mode === 'coherent') return coherentMaterialDesign({ model, mesh, nodes, nodeIds, occupied, observations, families, familyCount: family, scale, design, immutableBricks });
  const dominantFamilies = nodes.map((n) => majority(n.families));
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.sourceArea < n.area * 0.15 || dominantFamilies[i].fraction < 0.6) continue;
    for (let tangent = 0; tangent < 3; tangent++) if (tangent !== n.axis) for (const step of [-1, 1]) {
      const p = [...n.point] as Point; p[tangent] += step;
      const other = nodeIds.get(`${key(p)}:${n.axis}:${n.sign}`);
      if (other === undefined) continue;
      const d = nodes[other];
      if (d.sourceArea >= d.area * 0.15 && dominantFamilies[other].fraction >= 0.6 && dominantFamilies[i].id === dominantFamilies[other].id) n.neighbours.push(other);
    }
  }
  // Region boundaries retain original radiance. Only measured, locally gradual
  // boundaries can support a larger shade design; no global majority donor.
  const boundary = new Map<string, { count: number; smooth: number }>();
  const boundaryKey = (a: number, b: number) => a < b ? `${a},${b}` : `${b},${a}`;
  const pixelLab = new Float32Array(graph.raster.width * graph.raster.height * 3);
  const pixelChroma = new Float32Array(pixelLab.length);
  for (let k = 0; k < graph.raster.foregroundMask.length; k++) if (graph.raster.foregroundMask[k]) {
    const c = Array.from(graph.raster.rgba.subarray(k * 4, k * 4 + 3));
    pixelLab.set(lab(...c as Point), k * 3); pixelChroma.set(chromaticity(c), k * 3);
  }
  for (let k = 0; k < graph.raster.foregroundMask.length; k++) if (graph.raster.foregroundMask[k]) {
    const x = k % graph.raster.width;
    for (const other of [x + 1 < graph.raster.width ? k + 1 : -1, k + graph.raster.width]) {
      if (other < 0 || other >= graph.raster.foregroundMask.length || !graph.raster.foregroundMask[other]) continue;
      const a = graph.raster.rawRegionIds[k], b = graph.raster.rawRegionIds[other];
      if (a < 0 || b < 0 || a === b) continue;
      const id = boundaryKey(a, b), r = boundary.get(id) ?? { count: 0, smooth: 0 };
      r.count++;
      if (Math.abs(pixelLab[k * 3] - pixelLab[other * 3]) <= 10 && distance(Array.from(pixelChroma.subarray(k * 3, k * 3 + 3)), Array.from(pixelChroma.subarray(other * 3, other * 3 + 3))) <= 0.055) r.smooth++;
      boundary.set(id, r);
    }
  }
  // The existing gradient classifier supplies evidence of internally varying
  // radiance, not truth about material. Bind it to the unchanged raw labels;
  // an intrinsic candidate or an unrelated region list cannot become evidence.
  const radiance = referenceMaterials({ width: graph.raster.width, height: graph.raster.height, data: graph.raster.rgba }, graph.raster.foregroundMask, true);
  const matchingLabels = radiance.labels.every((id, i) => id === graph.raster.rawRegionIds[i]);
  const illuminationRegions = new Set(matchingLabels ? radiance.design.regions.filter((r) => r.inferredIllumination).map((r) => r.id) : []);
  const proposal = new Map<number, { color: number; reason: ColorDesign['changes'][number]['reason']; weight: number }[]>();
  const proposedNodes = new Set<number>();
  const eligibleArea = new Map<number, number>(), eligibleNodes = new Set<number>(), protectedBricks = new Set<number>(), seen = new Uint8Array(nodes.length);
  for (let seed = 0; seed < nodes.length; seed++) {
    if (seen[seed] || !nodes[seed].neighbours.length) continue;
    const patch = [seed]; seen[seed] = 1;
    for (let h = 0; h < patch.length; h++) for (const g of nodes[patch[h]].neighbours) if (!seen[g]) { seen[g] = 1; patch.push(g); }
    const axis = nodes[seed].axis, axes = [0, 1, 2].filter((a) => a !== axis);
    const area = patch.reduce((s, id) => s + nodes[id].area, 0);
    const spans = axes.map((a) => (Math.max(...patch.map((id) => nodes[id].point[a])) - Math.min(...patch.map((id) => nodes[id].point[a])) + 1) * (a === 1 ? 0.4 : 1));
    const broadPlane = spans.every((s) => s >= 4);
    // Long one-stud column/eave faces are structural planes too. Their small
    // width must not turn an entire shaded side into an immutable paint stripe;
    // colour changes still need an immediately connected source witness below.
    const structuralBand = area >= 8 && Math.min(...spans) >= 0.8 && Math.max(...spans) >= 6;
    if ((!broadPlane || area < 16) && !structuralBand) continue;
    design.planarPatches++;
    const patchSet = new Set(patch), componentIds = new Map<number, number>(), components: number[][] = [];
    for (const id of patch) {
      if (componentIds.has(id)) continue;
      const q = [id], c = model.bricks[nodes[id].brick].color, cid = components.length; componentIds.set(id, cid);
      for (let h = 0; h < q.length; h++) for (const g of nodes[q[h]].neighbours) if (patchSet.has(g) && !componentIds.has(g) && model.bricks[nodes[g].brick].color === c) { componentIds.set(g, cid); q.push(g); }
      components.push(q);
    }
    const prototypes = components.map((ids) => prototype(nodes, ids));
    for (let cid = 0; cid < components.length; cid++) {
      const ids = components[cid], p = prototypes[cid], neighbours = new Map<number, number>();
      for (const id of ids) {
        const n = nodes[id]; add(eligibleArea, n.brick, n.area); eligibleNodes.add(id);
        for (const g of n.neighbours) { const other = componentIds.get(g); if (other !== undefined && other !== cid) add(neighbours, other, Math.sqrt(Math.min(n.area, nodes[g].area))); }
      }
      // An island can split its surrounding paint into several connected
      // pieces. Count local boundary support by paint, not by arbitrary IDs;
      // only the immediately bordering pieces participate (never global votes).
      const boundaryColors = new Map<number, number>();
      for (const [other, weight] of neighbours) add(boundaryColors, model.bricks[nodes[components[other][0]].brick].color, weight);
      const best = majority(boundaryColors), target = best.id;
      const donorIds = [...neighbours.keys()].filter((other) => model.bricks[nodes[components[other][0]].brick].color === target).flatMap((other) => components[other]);
      const donor = donorIds.length ? prototype(nodes, donorIds) : undefined;
      if (!donor || best.fraction < 0.75 || donor.area < 6 || donor.protectedArea > donor.sourceArea * 0.1) continue;
      if (p.protectedArea > p.sourceArea * 0.1) { for (const id of ids) protectedBricks.add(nodes[id].brick); continue; }
      const observed = p.observedArea >= p.sourceArea * 0.1, donorObserved = donor.observedArea >= donor.sourceArea * 0.1;
      const originalColor = model.bricks[nodes[ids[0]].brick].color;
      // Absence of a pixel is not evidence against an eye, grey inlay, leaf or
      // flame. Only ordinary warm shade-family hypotheses can use an unobserved
      // continuation; distinct accent families require actual source support.
      if (!observed && ![7, 8, 9, 10].includes(originalColor)) continue;
      // Real grey, black, coloured logos, eyes/beaks and painted material edges
      // are not palette noise. Strong chromatic differences are always locked.
      const abDifference = distance(p.lab.slice(1), donor.lab.slice(1));
      const chromaDifference = distance(p.chroma, donor.chroma);
      const illuminationSupport = [...p.regions].reduce((n, [id, weight]) => n + (illuminationRegions.has(id) ? weight : 0), 0) / Math.max(1e-12, p.observedArea);
      // A dark region's upper-middle representative can still be dark if its
      // whole photograph patch is shaded. An immediate brighter same-plane
      // witness may then supply a design colour, but only for chromatically
      // coherent, internally varying regions. Neutral/grey inlays and stable
      // dark stripes do not satisfy this gate, even when palette IDs are close.
      const shadedRegion = observed && donorObserved && illuminationSupport >= 0.65 && compatibleShadedRadiance(p.lab, p.chroma, donor.rgb, donor.lab);
      const distinctive = observed && donorObserved && !shadedRegion && (abDifference > 10 || chromaDifference > 0.075);
      if (distinctive) { for (const id of ids) protectedBricks.add(nodes[id].brick); continue; }
      let shared = 0, gradual = 0, testedBoundary = 0;
      for (const [a, weight] of p.regions) {
        if (donor.regions.has(a)) shared += weight;
        for (const b of donor.regions.keys()) if (a !== b) {
          const evidence = boundary.get(boundaryKey(a, b));
          if (evidence && evidence.count >= 3) { testedBoundary += evidence.count; gradual += evidence.smooth; }
        }
      }
      const sameGradient = shared / Math.max(1e-12, p.observedArea) >= 0.65;
      const gradualBoundary = testedBoundary >= 3 && gradual / testedBoundary >= 0.85;
      const small = p.area <= 2 && p.area <= donor.area * 0.15;
      // Small palette islands need weak/compatible source support. In
      // particular a sharp, independently observed little grey tile is locked.
      const smallWeak = small && (!observed || (donorObserved && abDifference <= 8 && chromaDifference <= 0.055 && (sameGradient || gradualBoundary)));
      const shade = p.area <= area * 0.3 && p.area <= donor.area * 0.5 && donorObserved && (!observed || (p.lab[0] + 6 < donor.lab[0] && ((abDifference <= 10 && chromaDifference <= 0.055 && (sameGradient || gradualBoundary)) || shadedRegion)));
      const unseenContinuation = p.observedArea <= 1e-12 && donor.observedArea <= 1e-12 && p.area <= area * 0.15 && p.area <= donor.area * 0.2 && [7, 8, 9, 10].includes(originalColor) && [7, 8, 9, 10].includes(target) && paletteLab[target][0] >= paletteLab[originalColor][0] + 6;
      if (!smallWeak && !shade && !unseenContinuation) continue;
      for (const id of ids) {
        const n = nodes[id], list = proposal.get(n.brick) ?? [];
        list.push({ color: target, reason: unseenContinuation ? 'unobserved-surface-design' : smallWeak ? 'small-weak-colour-island' : shadedRegion && !sameGradient && !gradualBoundary ? 'shaded-region-design' : 'continuous-radiance-design', weight: n.area }); proposal.set(n.brick, list); proposedNodes.add(id);
      }
    }
  }
  // A column's broad side can be entirely shaded: same-plane majority cannot
  // help when that plane has no bright patch. Reuse exact manifold continuations
  // between source plane families (including a real crease), not proximity or
  // a model-wide inclination consensus. Only the immediate observed family can
  // be a donor. This is an explicitly approximate material-design continuation.
  const familyArea = new Float64Array(family), familyObserved = new Float64Array(family), familyProtected = new Float64Array(family);
  const familyRGB = new Float64Array(family * 3), familyCenters = new Float64Array(family * 3), familyNormals = new Float64Array(family * 3), familyPaint = Array.from({ length: family }, () => new Float64Array(PALETTE.length));
  const familyRegions = Array.from({ length: family }, () => new Map<number, number>());
  const familyNeighbours = Array.from({ length: family }, () => new Set<number>());
  for (let f = 0; f < faces; f++) {
    const id = families[f], area = graph.faceAreas[f] * scale * scale, o = observations.get(f);
    familyArea[id] += area;
    const c = center(f), n = normal(f);
    for (let a = 0; a < 3; a++) { familyCenters[id * 3 + a] += area * c[a]; familyNormals[id * 3 + a] += area * n[a]; }
    if (mesh.features && (mesh.features[f] & MESH_FEATURE.foliage)) familyProtected[id] += area;
    if (o) {
      familyObserved[id] += area;
      for (const [region, weight] of o.regions) add(familyRegions[id], region, area * weight / o.weight);
      for (let a = 0; a < 3; a++) familyRGB[id * 3 + a] += area * o.rgb[a] / o.weight;
      familyPaint[id][nearestColor(mesh.colors[f * 3], mesh.colors[f * 3 + 1], mesh.colors[f * 3 + 2], true)] += area;
    }
  }
  for (let e = 0; e < edges.kinds.length; e++) if (edges.kinds[e] === SOURCE_EDGE_KIND.manifold) {
    const f = edges.faces[edges.offsets[e]], g = edges.faces[edges.offsets[e] + 1], a = families[f], b = families[g];
    if (a !== b && dot(normal(f), normal(g)) >= -0.1) { familyNeighbours[a].add(b); familyNeighbours[b].add(a); }
  }
  for (let id = 0; id < family; id++) {
    const length = Math.hypot(...familyNormals.subarray(id * 3, id * 3 + 3));
    for (let a = 0; a < 3; a++) { familyCenters[id * 3 + a] /= Math.max(1e-12, familyArea[id]); familyNormals[id * 3 + a] /= Math.max(1e-12, length); }
  }
  const familyNodes = new Map<string, number[]>();
  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id];
    if (!eligibleNodes.has(id) || n.sourceArea < n.area * 0.15 || dominantFamilies[id].fraction < 0.6) continue;
    const family = dominantFamilies[id].id, color = model.bricks[n.brick].color;
    if (![7, 8, 9, 10].includes(color)) continue;
    const group = `${family}:${color}`, list = familyNodes.get(group) ?? []; list.push(id); familyNodes.set(group, list);
  }
  for (const [group, ids] of familyNodes) {
    const [sourceFamily, originalColor] = group.split(':').map(Number), p = prototype(nodes, ids);
    if (p.protectedArea > p.sourceArea * 0.1 || familyProtected[sourceFamily] > familyArea[sourceFamily] * 0.1) continue;
    const observed = p.observedArea >= p.sourceArea * 0.1;
    const illuminationSupport = [...p.regions].reduce((n, [id, weight]) => n + (illuminationRegions.has(id) ? weight : 0), 0) / Math.max(1e-12, p.observedArea);
    let selected: { color: number; score: number; reason: 'shaded-region-design' | 'orientation-tone-design' | 'unobserved-surface-design' } | undefined;
    // Marching-cubes bevels insert small transition families at a real corner.
    // A bounded chain of such faces can reach the adjacent broad plane; it
    // cannot walk through another broad region or a coloured/foliage boundary.
    const adjacent = new Set<number>(), visited = new Set([sourceFamily]);
    const queue = [{ id: sourceFamily, hops: 0, transitionArea: 0 }];
    for (let head = 0; head < queue.length; head++) {
      const entry = queue[head];
      for (const next of familyNeighbours[entry.id]) {
        if (visited.has(next)) continue; visited.add(next);
        if (familyArea[next] >= 16) { adjacent.add(next); continue; }
        const nextPaint = majority(new Map(Array.from(familyPaint[next], (weight, color) => [color, weight] as const)));
        if (entry.hops >= 3 || familyArea[next] > 4 || entry.transitionArea + familyArea[next] > 8 || familyProtected[next] > familyArea[next] * 0.1 || (familyObserved[next] > 0 && ![7, 8, 9, 10].includes(nextPaint.id))) continue;
        queue.push({ id: next, hops: entry.hops + 1, transitionArea: entry.transitionArea + familyArea[next] });
      }
    }
    const sourceNormal = Array.from(familyNormals.subarray(sourceFamily * 3, sourceFamily * 3 + 3));
    for (const donor of adjacent) {
      const donorNormal = Array.from(familyNormals.subarray(donor * 3, donor * 3 + 3));
      const normalDot = dot(sourceNormal, donorNormal);
      const planeOffset = Math.abs(dot([0, 1, 2].map((a) => familyCenters[donor * 3 + a] - familyCenters[sourceFamily * 3 + a]), sourceNormal)) * scale;
      if (normalDot < -0.1 || (normalDot >= 0.94 && planeOffset > 0.6)) continue;
      if (familyArea[donor] < 16 || familyObserved[donor] < Math.max(4, familyArea[donor] * 0.15) || familyProtected[donor] > familyArea[donor] * 0.1) continue;
      const paints = new Map(Array.from(familyPaint[donor], (weight, color) => [color, weight] as const)), paint = majority(paints);
      if (paint.fraction < 0.75 || paint.id === originalColor || paletteLab[paint.id][0] <= paletteLab[originalColor][0] + 3) continue;
      const donorRGB = [0, 1, 2].map((a) => familyRGB[donor * 3 + a] / familyObserved[donor]), donorLab = lab(...donorRGB as Point), donorChroma = Math.hypot(donorLab[1], donorLab[2]);
      if (donorChroma < 18) continue;
      // A continuous raw gradient is a stronger witness than a mean-RGB hue
      // match: warm lighting can shift shadow chromaticity as it gets deeper.
      // Require that the ORIGINAL inferred-illumination region actually spans
      // this immediate source-edge continuation, not merely similar palette IDs.
      const sharedRadiance = [...p.regions].reduce((n, [id, weight]) => n + (illuminationRegions.has(id) && (familyRegions[donor].get(id) ?? 0) >= Math.max(0.5, familyObserved[donor] * 0.02) ? weight : 0), 0) / Math.max(1e-12, p.observedArea);
      const sourceChroma = Math.hypot(p.lab[1], p.lab[2]);
      const hueDifference = Math.abs(Math.atan2(Math.sin(Math.atan2(p.lab[2], p.lab[1]) - Math.atan2(donorLab[2], donorLab[1])), Math.cos(Math.atan2(p.lab[2], p.lab[1]) - Math.atan2(donorLab[2], donorLab[1])))) * 180 / Math.PI;
      const continuousShade = observed && sharedRadiance >= 0.65 && p.lab[0] + 6 < donorLab[0] && sourceChroma >= 8 && hueDifference <= 35 && distance(p.chroma, chromaticity(donorRGB)) <= 0.3;
      // Compare the actual proposed paint group's source area, not the entire
      // family's unrelated colours. A small shaded band on a large facade does
      // not require a donor bigger than the whole facade.
      if (p.sourceArea > familyArea[donor] * (continuousShade ? 2 : 1)) continue;
      if (observed && !continuousShade && !compatibleShadedRadiance(p.lab, p.chroma, donorRGB, donorLab)) continue;
      // A sharp radiance change at a real geometric crease can be directional
      // shading even if each side is internally quite uniform. Only a broad
      // connected structural face, a different orientation and a tightly
      // matching hue/chromaticity may use this explicit tone design. Coplanar
      // painted stripes, neutral inlays, strongly saturated timber/accents and
      // offset recess/back planes stay protected.
      const orientationTone = observed && illuminationSupport < 0.65 && normalDot <= 0.8 && Math.hypot(p.lab[1], p.lab[2]) <= donorChroma * 1.35 && distance(p.chroma, chromaticity(donorRGB)) <= 0.15;
      if (observed && illuminationSupport < 0.65 && !orientationTone) continue;
      const score = familyObserved[donor];
      if (!selected || score > selected.score) selected = { color: paint.id, score, reason: !observed ? 'unobserved-surface-design' : orientationTone ? 'orientation-tone-design' : 'shaded-region-design' };
    }
    if (!selected) continue;
    for (const id of ids) {
      const n = nodes[id];
      if (proposedNodes.has(id) || protectedBricks.has(n.brick)) continue;
      const list = proposal.get(n.brick) ?? [];
      list.push({ color: selected.color, reason: selected.reason, weight: n.area }); proposal.set(n.brick, list); proposedNodes.add(id);
    }
  }
  design.eligibleBricks = eligibleArea.size; design.protectedBricks = protectedBricks.size;
  const bricks = model.bricks.map((b, i) => {
    const list = proposal.get(i);
    if (!list || protectedBricks.has(i)) return b;
    const votes = new Map<number, number>(); for (const p of list) add(votes, p.color, p.weight);
    const selected = majority(votes), areaSupport = (votes.get(selected.id) ?? 0) / Math.max(1e-12, eligibleArea.get(i) ?? 0);
    if (selected.fraction < 0.9 || areaSupport < 0.65 || selected.id === b.color) return b;
    // A reviewed negative catalog combination cannot be introduced by cleaning.
    if (choosePartColor(b.part, selected.id).color !== selected.id) { design.catalogBlocked++; return b; }
    const reason = list.find((p) => p.color === selected.id)!.reason;
    design.changes.push({ brickId: b.id, from: b.color, to: selected.id, reason, areaSupport });
    return { ...b, color: selected.id };
  });
  design.changedBricks = design.changes.length; design.afterColorCounts = count(bricks);
  return {
    ...model, bricks, colorDesign: design,
    ...(model.assembly ? { assembly: { ...model.assembly, reference: `${model.assembly.reference} 干净配色为设计近似：按同结构面与原图渐变/局部面积证据整理 ${design.changedBricks} 块颜色；保留原始观测、真实拼色边界与组件，阴影和深色涂装仍可能混淆。` } } : {}),
  };
}

export function cleanModelColors(model: Model, mesh: TriangleMesh, resolution = model.resolution): Model {
  return modelColors(model, mesh, resolution, 'clean');
}

export function coherentModelColors(model: Model, mesh: TriangleMesh, resolution = model.resolution): Model {
  return modelColors(model, mesh, resolution, 'coherent');
}

export function designModelColors(model: Model, mesh: TriangleMesh, resolution: number, options?: MeshColorOptions): Model {
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'colorMode') || (options.colorMode !== undefined && !['clean', 'coherent', 'faithful'].includes(options.colorMode)))) throw Error('Mesh colour design options are invalid.');
  // Already materialized before packing. Re-reading dark raw observation RGB here
  // would reintroduce photograph tones into the chosen material palette.
  if (options?.colorMode === 'coherent' && mesh.materialDesign?.materialFirst)
    return model;
  return options?.colorMode === 'clean' ? cleanModelColors(model, mesh, resolution) : options?.colorMode === 'coherent' ? coherentModelColors(model, mesh, resolution) : model;
}
