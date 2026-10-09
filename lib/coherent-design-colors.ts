import { PALETTE, nearestColor, type Model } from './brick-engine.ts';
import { lab, colors as paletteLab } from './material-color-space.ts';
import { choosePartColor } from './part-color-policy.ts';
import { SOURCE_EDGE_KIND } from './scene-surface-graph.ts';
import { MESH_FEATURE, type TriangleMesh } from './mesh-types.ts';
import type { ColorDesign } from './clean-design-colors.ts';
import { sourceScalarRelation, hasChromaticScalarSignal, sourceFactorMaterialKey } from './source-shadow-colors.ts';

type Point = [number, number, number];
type FaceNode = {
  point: Point; axis: number; sign: number; brick: number; area: number;
  sourceArea: number; observedArea: number; protectedArea: number;
  rgb: number[]; families: Map<number, number>; sourceFaces: Map<number, number>;
};
type Observation = { weight: number; rgb: number[] };
type Context = {
  model: Model; mesh: TriangleMesh; nodes: FaceNode[]; nodeIds: Map<string, number>;
  occupied: Map<string, number>; observations: Map<number, Observation>;
  families: Int32Array; familyCount: number; scale: number; design: ColorDesign;
  immutableBricks: Map<number, string[]>; licensedAnchorFamilies?: Set<number>;
};
export const COHERENT_LIMITATIONS = [
  'Explicit user-selected coherent material design, NOT single-image intrinsic-material recovery. Source-scalar-shadow design uses locally connected raw colour/exposure evidence; source-local-material design separately retains the authorised bounded warm structural approximation and may merge genuinely painted warm trim.',
  'No palette ID or low Lab chroma proves paint or shade. Stable positive-area source anchors are required. Neutral radiance without a restricted non-baked material clue and geometric/gradual support remains unknown; single white proxy materials, defaults, centroid-only/tiny witnesses, global donors and disconnected inference are not identity evidence.',
  'Colours and design metadata only: source RGBA, positions, observations, face IDs, parts, poses, geometry and physical support are unchanged. Observed horizontal patterns, incompatible whole-brick materials, foliage, components, reserved cells, support, special parts and reviewed catalog substitutions are protected. Exact target catalog acceptance is required; current stock remains unverified.',
];
const warm = (c: number) => [7, 8, 9, 10].includes(c);
const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const delta = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]));
const add = (m: Map<number, number>, id: number, w: number) => m.set(id, (m.get(id) ?? 0) + w);
const dominant = (m: Map<number, number>) => [...m].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1;
const hueGap = (a: number[], b: number[]) => Math.abs(Math.atan2(Math.sin(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])), Math.cos(Math.atan2(a[2], a[1]) - Math.atan2(b[2], b[1])))) * 180 / Math.PI;

/** Shares only the conservative pass's read-only source binding; decisions below
 * are a distinct, disclosed design mode, not stronger claims about the image. */
function warmMaterialDesign(ctx: Context): Model {
  const { model, mesh, nodes, nodeIds, occupied, observations, families, familyCount, scale, design } = ctx;
  const graph = mesh.sourceObservations!, edges = graph.sharedEdges;
  const area = new Float64Array(familyCount), observed = new Float64Array(familyCount), protectedArea = new Float64Array(familyCount);
  const rgb = new Float64Array(familyCount * 3), centers = new Float64Array(familyCount * 3), normals = new Float64Array(familyCount * 3);
  const links = Array.from({ length: familyCount }, () => new Set<number>());
  const sourceNormal = (f: number) => Array.from(graph.faceNormals.subarray(f * 3, f * 3 + 3));
  for (let f = 0; f < families.length; f++) {
    const id = families[f], w = graph.faceAreas[f] * scale * scale, o = observations.get(f);
    area[id] += w;
    for (let a = 0; a < 3; a++) {
      centers[id * 3 + a] += w * (mesh.positions[f * 9 + a] + mesh.positions[f * 9 + a + 3] + mesh.positions[f * 9 + a + 6]) / 3;
      normals[id * 3 + a] += w * graph.faceNormals[f * 3 + a];
      if (o) rgb[id * 3 + a] += w * o.rgb[a] / o.weight;
    }
    if (o) observed[id] += w;
    if (mesh.features && (mesh.features[f] & MESH_FEATURE.foliage)) protectedArea[id] += w;
  }
  for (let e = 0; e < edges.kinds.length; e++) if (edges.kinds[e] === SOURCE_EDGE_KIND.manifold) {
    const f = edges.faces[edges.offsets[e]], g = edges.faces[edges.offsets[e] + 1], a = families[f], b = families[g];
    if (a !== b && dot(sourceNormal(f), sourceNormal(g)) >= -0.1) { links[a].add(b); links[b].add(a); }
  }
  const familyRGB = (id: number) => [0, 1, 2].map(a => rgb[id * 3 + a] / Math.max(1e-12, observed[id]));
  const familyNormal = (id: number) => Array.from(normals.subarray(id * 3, id * 3 + 3));
  for (let id = 0; id < familyCount; id++) {
    const length = Math.hypot(...familyNormal(id));
    for (let a = 0; a < 3; a++) { centers[id * 3 + a] /= Math.max(1e-12, area[id]); normals[id * 3 + a] /= Math.max(1e-12, length); }
  }
  const donorColor = (id: number) => {
    if (id < 0 || !ctx.licensedAnchorFamilies?.has(id) || observed[id] < 0.4 || protectedArea[id] > 1e-12) return -1;
    const c = familyRGB(id), l = lab(...c as Point), color = nearestColor(...c as Point, true);
    return warm(color) && l[0] >= 55 && Math.hypot(l[1], l[2]) >= 12 ? color : -1;
  };
  const boundFamily = nodes.map(n => n.sourceArea >= n.area * 0.05 ? dominant(n.families) : -1);
  const locked = new Set<number>(), paintedFamilies = new Set<number>();
  for (let f = 0; f < familyCount; f++) if (observed[f] >= 0.4) {
    const l = lab(...familyRGB(f) as Point), c = nearestColor(...familyRGB(f) as Point, true);
    if (Math.hypot(l[1], l[2]) < 8 || hueGap(l, paletteLab[7]) > 45 || (c !== 7 && delta(l, paletteLab[c]) < 2)) paintedFamilies.add(f);
  }
  for (let id = 0; id < nodes.length; id++) if (nodes[id].protectedArea > 1e-12 || (boundFamily[id] >= 0 && (protectedArea[boundFamily[id]] > 1e-12 || paintedFamilies.has(boundFamily[id])))) locked.add(nodes[id].brick);
  // Protect genuinely observed neutral/saturated paint even when palette rounding
  // happened to assign a warm colour. Exact stable catalog paint is also evidence,
  // not an uncertain radiance band eligible for the user's material choice.
  for (const n of nodes) if (n.observedArea > 0) {
    const c = model.bricks[n.brick].color, l = lab(...n.rgb.map(v => v / n.observedArea) as Point);
    if (Math.hypot(l[1], l[2]) < 8 || hueGap(l, paletteLab[7]) > 45 || (c !== 7 && delta(l, paletteLab[c]) < 2)) locked.add(n.brick);
  }
  // Protect a broad upward mixed-material layout as whole bricks, including
  // its exposed side faces. A narrow eave/cap is not a paving layout.
  const topSeen = new Uint8Array(nodes.length);
  for (let seed = 0; seed < nodes.length; seed++) {
    if (topSeen[seed] || nodes[seed].axis !== 1 || nodes[seed].sign !== 1) continue;
    const patch = [seed]; topSeen[seed] = 1;
    for (let h = 0; h < patch.length; h++) for (const a of [0, 2]) for (const step of [-1, 1]) {
      const p = [...nodes[patch[h]].point]; p[a] += step;
      const id = nodeIds.get(`${p.join(',')}:1:1`);
      if (id === undefined || topSeen[id]) continue;
      topSeen[id] = 1; patch.push(id);
    }
    const spans = [0, 2].map(a => Math.max(...patch.map(id => nodes[id].point[a])) - Math.min(...patch.map(id => nodes[id].point[a])) + 1);
    const paints = new Set(patch.map(id => model.bricks[nodes[id].brick].color));
    if (patch.length >= 16 && Math.min(...spans) >= 4 && paints.size > 1 && patch.some(id => nodes[id].observedArea > 0)) for (const id of patch) locked.add(nodes[id].brick);
  }
  const limits = [0, 1, 2].map(a => Math.max(...model.bricks.map(b => [b.x + b.w, b.y + b.h, b.z + b.d][a])));
  const exterior = (n: FaceNode) => {
    const p = [...n.point];
    // A back plane looking into an opening sees an occupied outer skin along
    // its normal; these dark planes are not exterior material continuations.
    for (let step = 1; step <= 3; step++) {
      p[n.axis] += n.sign;
      if (p[n.axis] < 0 || p[n.axis] > limits[n.axis]) break;
      if (occupied.has(p.join(','))) return false;
    }
    return true;
  };
  const coplanarCache = new Map<string, boolean>();
  const coplanarLink = (a: number, b: number) => {
    if (a === b || links[a].has(b)) return true;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (coplanarCache.has(key)) return coplanarCache.get(key)!;
    const n = familyNormal(a), offset = dot([0, 1, 2].map(axis => centers[b * 3 + axis] - centers[a * 3 + axis]), n) * scale;
    if (dot(n, familyNormal(b)) < 0.94 || Math.abs(offset) > 0.6) { coplanarCache.set(key, false); return false; }
    const seen = new Set([a]), queue = [{ id: a, hops: 0, transition: 0 }];
    for (let h = 0; h < queue.length; h++) for (const next of links[queue[h].id]) {
      if (next === b) { coplanarCache.set(key, true); return true; }
      if (seen.has(next) || queue[h].hops >= 4 || area[next] > 4 || queue[h].transition + area[next] > 8 || protectedArea[next] > 0 || paintedFamilies.has(next)) continue;
      seen.add(next); queue.push({ id: next, hops: queue[h].hops + 1, transition: queue[h].transition + area[next] });
    }
    coplanarCache.set(key, false); return false;
  };
  const familyDonors = new Map<number, { family: number; color: number }[]>();
  const donors = (source: number) => {
    if (familyDonors.has(source)) return familyDonors.get(source)!;
    const result: { family: number; color: number }[] = [], seen = new Set([source]), queue = [{ id: source, hops: 0, transition: 0 }];
    const n = familyNormal(source);
    for (let head = 0; head < queue.length; head++) {
      const entry = queue[head], color = donorColor(entry.id);
      const offset = dot([0, 1, 2].map(a => centers[entry.id * 3 + a] - centers[source * 3 + a]), n) * scale;
      // A donor in front of a darker source plane is a concave recess surround,
      // not an exterior crease. Preserve door backs and dark inset cavities.
      if ((offset > 0.6 && Math.abs(familyNormal(entry.id)[1]) < 0.94) || dot(n, familyNormal(entry.id)) < -0.1 || protectedArea[entry.id] > 0) continue;
      if (color >= 0) result.push({ family: entry.id, color });
      if (entry.hops >= 4 || (entry.id !== source && area[entry.id] > 4)) continue;
      for (const next of links[entry.id]) {
        if (seen.has(next)) continue; seen.add(next);
        if (entry.transition + (area[entry.id] <= 4 ? area[entry.id] : 0) > 8) continue;
        queue.push({ id: next, hops: entry.hops + 1, transition: entry.transition + (area[entry.id] <= 4 ? area[entry.id] : 0) });
      }
    }
    familyDonors.set(source, result); return result;
  };
  const exposed = nodes.map((n, id) => {
    if (exterior(n)) return true;
    const f = boundFamily[id]; if (f < 0) return false;
    // A narrow rail/eave can look toward nearby steps rather than open sky.
    // Only its own nearby exact-edge observed cap may override that local ray;
    // an offset outer facade or distant ground cannot unlock a cavity back.
    return donors(f).some(d => Math.abs(familyNormal(d.family)[1]) >= 0.94 && Math.abs(dot([0, 1, 2].map(a => centers[d.family * 3 + a] - centers[f * 3 + a]), familyNormal(f))) * scale <= 1.6);
  });
  const adjacency = nodes.map(() => [] as number[]);
  for (let id = 0; id < nodes.length; id++) {
    const n = nodes[id];
    if (n.axis === 1 || !warm(model.bricks[n.brick].color) || locked.has(n.brick) || !exposed[id]) continue;
    for (let a = 0; a < 3; a++) if (a !== n.axis) for (const step of [-1, 1]) {
      const p = [...n.point]; p[a] += step;
      const other = nodeIds.get(`${p.join(',')}:${n.axis}:${n.sign}`);
      if (other === undefined) continue;
      const g = nodes[other];
      if (!warm(model.bricks[g.brick].color) || locked.has(g.brick) || !exposed[other]) continue;
      const f = boundFamily[id], h = boundFamily[other];
      if (f >= 0 && h >= 0 && !coplanarLink(f, h)) continue;
      adjacency[id].push(other);
    }
  }
  const proposals = new Map<number, Map<number, number>>(), eligible = new Map<number, number>(), seen = new Uint8Array(nodes.length);
  for (let seed = 0; seed < nodes.length; seed++) {
    if (seen[seed] || !adjacency[seed].length) continue;
    const patch = [seed]; seen[seed] = 1;
    for (let h = 0; h < patch.length; h++) for (const id of adjacency[patch[h]]) if (!seen[id]) { seen[id] = 1; patch.push(id); }
    const tangents = [0, 1, 2].filter(a => a !== nodes[seed].axis);
    const spans = tangents.map(a => (Math.max(...patch.map(id => nodes[id].point[a])) - Math.min(...patch.map(id => nodes[id].point[a])) + 1) * (a === 1 ? 0.4 : 1));
    const patchArea = patch.reduce((sum, id) => sum + nodes[id].area, 0);
    if (patchArea < 3.2 || Math.min(...spans) < 0.4 || Math.max(...spans) < 6) continue;
    const sourceFamilies = new Set(patch.map(id => boundFamily[id]).filter(f => f >= 0));
    if (!sourceFamilies.size) continue;
    const targets = new Map<number, number>(), localAnchors = new Map<number, Set<number>>();
    for (const id of patch) {
      const n = nodes[id], f = boundFamily[id];
      if (f < 0 || n.observedArea < 0.04) continue;
      const c = n.rgb.map(v => v / n.observedArea), l = lab(...c as Point), color = nearestColor(...c as Point, true);
      if (!ctx.licensedAnchorFamilies?.has(f) || !warm(color) || l[0] < 55 || Math.hypot(l[1], l[2]) < 12) continue;
      add(targets, color, n.observedArea);
      const colors = localAnchors.get(f) ?? new Set<number>(); colors.add(color); localAnchors.set(f, colors);
    }
    for (const f of sourceFamilies) for (const d of donors(f)) add(targets, d.color, observed[d.family]);
    const target = [...targets.keys()].sort((a, b) => paletteLab[b][0] - paletteLab[a][0])[0];
    if (target === undefined) continue;
    // No source gap may be bridged by an unknown built cell. The anchor must
    // belong to this connected source family or its immediate exact-edge crease.
    const allowedFamilies = new Set([...sourceFamilies].filter(f => localAnchors.get(f)?.has(target) || donors(f).some(d => d.color === target)));
    const connectedFamilies = new Set([sourceFamilies.values().next().value!]);
    for (let previous = -1; previous !== connectedFamilies.size;) {
      previous = connectedFamilies.size;
      for (const f of sourceFamilies) if (!connectedFamilies.has(f) && [...connectedFamilies].some(g => coplanarLink(f, g))) connectedFamilies.add(f);
    }
    // Built packing may fill a source hole. When this built patch contains
    // disconnected source domains, unknown nodes are not licensed to bridge it.
    const unknownContinuation = connectedFamilies.size === sourceFamilies.size;
    const reachable = new Set<number>(), queue = patch.filter(id => allowedFamilies.has(boundFamily[id]));
    for (const id of queue) reachable.add(id);
    for (let h = 0; h < queue.length; h++) for (const id of adjacency[queue[h]]) {
      if (reachable.has(id) || (boundFamily[id] < 0 && !unknownContinuation) || (boundFamily[id] >= 0 && !allowedFamilies.has(boundFamily[id]))) continue;
      reachable.add(id); queue.push(id);
    }
    design.planarPatches++;
    for (const id of reachable) {
      const n = nodes[id], c = model.bricks[n.brick].color;
      add(eligible, n.brick, n.area);
      if (c === target || paletteLab[target][0] <= paletteLab[c][0] + 3) continue;
      const votes = proposals.get(n.brick) ?? new Map<number, number>(); add(votes, target, n.area); proposals.set(n.brick, votes);
    }
  }
  design.eligibleBricks = eligible.size; design.protectedBricks = locked.size;
  const bricks = model.bricks.map((b, i) => {
    const votes = proposals.get(i); if (!votes || locked.has(i)) return b;
    const target = dominant(votes), total = [...votes.values()].reduce((n, v) => n + v, 0), support = (votes.get(target) ?? 0) / Math.max(1e-12, eligible.get(i) ?? 0);
    if ((votes.get(target) ?? 0) < total * 0.9 || support < 0.65 || target === b.color) return b;
    if (choosePartColor(b.part, target).color !== target) { design.catalogBlocked++; return b; }
    design.changes.push({ brickId: b.id, from: b.color, to: target, reason: 'source-local-material-design', areaSupport: support });
    return { ...b, color: target };
  });
  // Counts and ledger are taken from the returned actual Model, not proposed faces.
  design.changedBricks = design.changes.length; design.afterColorCounts = Array(PALETTE.length).fill(0);
  for (const b of bricks) design.afterColorCounts[b.color]++;
  return { ...model, bricks, colorDesign: design,
    ...(model.assembly ? { assembly: { ...model.assembly, reference: `${model.assembly.reference} 用户明确选择更统一建筑主体材料：局部源锚定的暖色外墙、屋檐和栏杆统一 ${design.changedBricks} 块；这是人工设计配色近似，不是单图真实材质复原，可能合并原图真实暖色饰带。地坪拼色、深色门洞、灰框线、绿植火焰与特殊组件保留；未知目录颜色与库存需核实。` } } : {}),
  };
}


/** Two independent proposals read ONLY the original Model and source ledger.
 * Scalar domains take precedence over the older, explicitly approximate warm
 * structural choice. Neither returned design is ever used as source evidence. */
export function coherentMaterialDesign(ctx: Context): Model {
  const { model, mesh, nodes, families, design, immutableBricks } = ctx;
  const graph = mesh.sourceObservations!, count = families.length, edges = graph.sharedEdges;
  const parent = Int32Array.from({ length: count }, (_, i) => i), boundArea = new Float64Array(count);
  const faceRGB = Array.from({ length: count }, (_, f) => {
    const o = ctx.observations.get(f); return o ? o.rgb.map(v => v / o.weight) : undefined;
  });
  const pixels = Array.from({ length: count }, () => new Set<number>());
  const sampleRGB = Array.from({ length: count }, () => [] as number[][]);
  const projection = graph.projection;
  for (let i = 0; i < projection.observed.length; i++) if (projection.observed[i]) {
    const f = projection.pixelFaces[i]; if (f < 0 || f >= count) continue;
    const pixel = projection.sourcePixelXY[i * 2 + 1] * graph.raster.width + projection.sourcePixelXY[i * 2];
    if (!pixels[f].has(pixel)) { pixels[f].add(pixel); sampleRGB[f].push(Array.from(projection.rawRGB.subarray(i * 3, i * 3 + 3))); }
  }
  const root = (f: number): number => { let r = f; while (parent[r] !== r) r = parent[r]; while (parent[f] !== f) { const next = parent[f]; parent[f] = r; f = next; } return r; };
  const reasons = new Map<number, Set<string>>([...immutableBricks].map(([b, rs]) => [b, new Set(rs)]));
  const protect = (b: number, reason: string) => { const rs = reasons.get(b) ?? new Set<string>(); rs.add(reason); reasons.set(b, rs); };
  const blocked = new Uint8Array(count);
  for (const n of nodes) for (const [f, a] of n.sourceFaces) {
    boundArea[f] += a;
    if (n.protectedArea > 1e-12) { blocked[f] = 1; protect(n.brick, 'source-foliage'); }
  }
  for (let f = 0; f < count; f++) {
    if (mesh.features && (mesh.features[f] & MESH_FEATURE.foliage)) blocked[f] = 1;
    const c = faceRGB[f];
    // A mean across different paints is not a scalar observation.
    if (c && sampleRGB[f].some(s => !sourceScalarRelation(s, c) && !sourceScalarRelation(c, s))) blocked[f] = 1;
  }
  const normalDot = (f: number, g: number) => [0, 1, 2].reduce((sum, a) => sum + graph.faceNormals[f * 3 + a] * graph.faceNormals[g * 3 + a], 0);
  const explicitSlot = (f: number) => mesh.nativeAppearance?.materialIds[f] ?? -1;
  for (let e = 0; e < edges.kinds.length; e++) if (edges.kinds[e] === SOURCE_EDGE_KIND.manifold) {
    const f = edges.faces[edges.offsets[e]], g = edges.faces[edges.offsets[e] + 1], a = faceRGB[f], b = faceRGB[g];
    // Source continuity is independent of which triangles remain exposed after
    // packing. A hidden crease face may carry the only exact-edge connection;
    // coverage is required for anchors and targets below, not for source edges.
    if (!a || !b || blocked[f] || blocked[g] || normalDot(f, g) < -0.1) continue;
    if (explicitSlot(f) >= 0 && explicitSlot(g) >= 0 && explicitSlot(f) !== explicitSlot(g)) continue;
    const bright = Math.max(...a) >= Math.max(...b) ? a : b, dark = bright === a ? b : a;
    const relation = sourceScalarRelation(dark, bright); if (!relation) continue;
    const neutral = !hasChromaticScalarSignal(bright);
    const material = sourceFactorMaterialKey(mesh, f);
    // Equal neutral paint can connect; a changed neutral exposure additionally
    // needs a restricted native clue AND a crease or measured gradual step.
    if (neutral && relation.scale < 0.94 && !(material >= 0 && material === sourceFactorMaterialKey(mesh, g) && (normalDot(f, g) < 0.94 || delta(a, b) <= 12))) continue;
    parent[root(g)] = root(f);
  }
  const domains = new Map<number, number[]>();
  for (let f = 0; f < count; f++) if (faceRGB[f] && !blocked[f] && boundArea[f] > 0) {
    const id = root(f), list = domains.get(id) ?? []; list.push(f); domains.set(id, list);
  }
  type Anchor = { rgb: number[]; color: number; contrast: boolean };
  const anchors = new Map<number, Anchor>(), licensedAnchorFamilies = new Set<number>();
  for (const [id, fs] of domains) {
    const total = fs.reduce((sum, f) => sum + boundArea[f], 0);
    const bins = new Map<number, number[]>();
    for (const f of fs) { const bin = Math.floor(Math.max(...faceRGB[f]!) / 12), list = bins.get(bin) ?? []; list.push(f); bins.set(bin, list); }
    for (const bin of [...bins.keys()].sort((a, b) => b - a)) {
      const cohort = [...(bins.get(bin) ?? []), ...(bins.get(bin - 1) ?? [])], witnesses = new Set<number>();
      let area = 0; const rgb = [0, 0, 0];
      for (const f of cohort) { area += boundArea[f]; for (const p of pixels[f]) witnesses.add(p); for (let a = 0; a < 3; a++) rgb[a] += faceRGB[f]![a] * boundArea[f]; }
      if (area < Math.max(2, total * 0.05) || witnesses.size < 12) continue;
      for (let a = 0; a < 3; a++) rgb[a] /= area;
      const color = nearestColor(...rgb as Point, true);
      const valid = fs.filter(f => sourceScalarRelation(faceRGB[f]!, rgb) || sourceScalarRelation(rgb, faceRGB[f]!));
      const contrast = valid.some(f => (sourceScalarRelation(faceRGB[f]!, rgb)?.scale ?? 1) < 0.85);
      anchors.set(id, { rgb, color, contrast });
      for (const f of cohort) licensedAnchorFamilies.add(families[f]);
      break;
    }
  }
  // A horizontal palette pattern can be scalar exposure on one material too.
  // Only a fully source-backed, positively observed SAME domain may bypass the
  // paving lock. Keep holes, mixed/blocked faces, disconnected domains and tiny
  // or centroid-only witnesses protected; no warm approximation uses this gate.
  const licensedScalarTop = (ids: number[]) => {
    let domain = -1, area = 0, shadowArea = 0;
    const witnesses = new Set<number>(), shadowWitnesses = new Set<number>();
    for (const i of ids) {
      const n = nodes[i];
      if (n.sourceArea < n.area * 0.65 || n.observedArea < n.sourceArea * 0.9) return false;
      let supported = 0;
      for (const [f, a] of n.sourceFaces) {
        if (a <= 1e-8) continue;
        const id = root(f), anchor = anchors.get(id), c = faceRGB[f];
        if (blocked[f] || !anchor?.contrast || !c || (domain >= 0 && domain !== id)) return false;
        const relation = sourceScalarRelation(c, anchor.rgb);
        if (!relation) return false;
        domain = id; supported += a; area += a;
        for (const pixel of pixels[f]) witnesses.add(pixel);
        if (relation.scale < 0.85) {
          shadowArea += a;
          for (const pixel of pixels[f]) shadowWitnesses.add(pixel);
        }
      }
      if (supported < n.sourceArea * 0.99) return false;
    }
    return domain >= 0 && area >= 2 && witnesses.size >= 12 && shadowArea >= Math.max(0.4, area * 0.02) && shadowWitnesses.size >= 5;
  };
  // Whole-brick horizontal pattern protection, not merely top-face protection.
  const seenTop = new Uint8Array(nodes.length);
  for (let seed = 0; seed < nodes.length; seed++) {
    if (seenTop[seed] || nodes[seed].axis !== 1 || nodes[seed].sign !== 1) continue;
    const q = [seed]; seenTop[seed] = 1;
    for (let h = 0; h < q.length; h++) for (const a of [0, 2]) for (const step of [-1, 1]) {
      const p = [...nodes[q[h]].point]; p[a] += step; const id = ctx.nodeIds.get(`${p.join(',')}:1:1`);
      if (id === undefined || seenTop[id]) continue; seenTop[id] = 1; q.push(id);
    }
    const spans = [0, 2].map(a => Math.max(...q.map(i => nodes[i].point[a])) - Math.min(...q.map(i => nodes[i].point[a])) + 1);
    if (q.length >= 16 && Math.min(...spans) >= 4 && new Set(q.map(i => model.bricks[nodes[i].brick].color)).size > 1 && q.some(i => nodes[i].observedArea > 0) && !licensedScalarTop(q)) for (const i of q) protect(nodes[i].brick, 'observed-horizontal-pattern');
  }
  const votes = new Map<number, Map<number, number>>(), sourceArea = new Map<number, number>();
  const brickMaterials = new Map<number, Set<number>>(), scalarNodes = new Map<number, { target: number; area: number; shadow: boolean }>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]; if (n.sourceArea < n.area * 0.15) continue;
    const materials = brickMaterials.get(n.brick) ?? new Set<number>();
    for (const [f, a] of n.sourceFaces) if (a >= 0.04 && faceRGB[f]) {
      const anchor = anchors.get(root(f));
      // Unknown and materially distinct observed faces are not erased by a
      // majority vote from another face of the same packed brick.
      materials.add(anchor?.color ?? nearestColor(...faceRGB[f]! as Point, true));
    }
    brickMaterials.set(n.brick, materials);
    const local = new Map<number, number>(); let shadowArea = 0;
    for (const [f, a] of n.sourceFaces) {
      const anchor = anchors.get(root(f)), c = faceRGB[f]; if (!anchor || !c || !anchor.contrast || blocked[f]) continue;
      const relation = sourceScalarRelation(c, anchor.rgb); if (!relation) continue;
      add(local, anchor.color, a); if (relation.scale < 0.9) shadowArea += a;
    }
    const target = dominant(local), a = local.get(target) ?? 0;
    if (target < 0 || a < n.sourceArea * 0.9) continue;
    add(sourceArea, n.brick, n.sourceArea);
    const v = votes.get(n.brick) ?? new Map<number, number>(); add(v, target, a); votes.set(n.brick, v);
    scalarNodes.set(i, { target, area: a, shadow: shadowArea > a * 0.5 });
  }
  for (const [b, materials] of brickMaterials) if (materials.size > 1) protect(b, 'whole-brick-material-conflict');
  // Do not run the authorised warm approximation without positive pixel/area
  // witnesses either. Its different, lower-confidence reason remains explicit.
  const warmDesign: ColorDesign = { ...design, changes: [], beforeColorCounts: [...design.beforeColorCounts], afterColorCounts: [...design.beforeColorCounts] };
  const warmResult = warmMaterialDesign({ ...ctx, design: warmDesign, licensedAnchorFamilies });
  const warmChanges = new Map(warmResult.colorDesign!.changes.map(c => [c.brickId, c]));
  const scalarEligible = new Set<number>(), catalogBlocked = new Set<number>();
  const bricks = model.bricks.map((b, i) => {
    if (reasons.has(i)) return b;
    let target = b.color, support = 0, reason: ColorDesign['changes'][number]['reason'] = 'source-local-material-design';
    const v = votes.get(i);
    if (v) {
      const c = dominant(v), a = v.get(c) ?? 0, total = [...v.values()].reduce((sum, n) => sum + n, 0);
      support = a / Math.max(1e-12, sourceArea.get(i) ?? 0);
      if (a >= total * 0.9 && support >= 0.65) { target = c; reason = 'source-scalar-shadow-design'; scalarEligible.add(i); }
    }
    if (target === b.color && !scalarEligible.has(i)) { const change = warmChanges.get(b.id); if (change) { target = change.to; support = change.areaSupport; } }
    if (target === b.color) return b;
    if (choosePartColor(b.part, target).color !== target) { catalogBlocked.add(i); protect(i, 'target-catalog-blocked'); return b; }
    design.changes.push({ brickId: b.id, from: b.color, to: target, reason, areaSupport: support }); return { ...b, color: target };
  });
  // Diagnose source-backed paint/unknowns even when their early palette IDs
  // previously excluded them from all statistics. Reasons may overlap.
  const observedNodes = new Map<number, FaceNode[]>();
  for (const n of nodes) if (n.observedArea > 0) { const own = observedNodes.get(n.brick) ?? []; own.push(n); observedNodes.set(n.brick, own); }
  const uncertain = new Set<number>(); design.protectionReasons = {}; design.uncertainReasons = {};
  const changed = new Set(design.changes.map(c => c.brickId));
  for (let i = 0; i < model.bricks.length; i++) if (!reasons.has(i) && !changed.has(model.bricks[i].id) && !scalarEligible.has(i)) {
    const own = observedNodes.get(i) ?? [];
    // A nearest palette match, even an exact black/grey RGB, is radiance rather
    // than proof of paint. Without licensed source evidence, preserve its colour
    // and expose uncertainty instead of claiming a protected intrinsic material.
    uncertain.add(i);
    const reason = own.length ? 'no-licensed-material-anchor' : 'unobserved-or-source-gap';
    design.uncertainReasons[reason] = (design.uncertainReasons[reason] ?? 0) + 1;
  }
  for (const rs of reasons.values()) for (const r of rs) design.protectionReasons[r] = (design.protectionReasons[r] ?? 0) + 1;
  design.protectedBricks = reasons.size; design.uncertainBricks = uncertain.size;
  const brickIndices = new Map(model.bricks.map((b, i) => [b.id, i]));
  design.eligibleBricks = new Set([...scalarEligible, ...design.changes.map(c => brickIndices.get(c.brickId)!)]).size;
  design.catalogBlocked = catalogBlocked.size + warmDesign.catalogBlocked;
  design.planarPatches = anchors.size + warmDesign.planarPatches;
  const metrics = { domainInconsistentAreaBefore: 0, domainInconsistentAreaAfter: 0, scalarShadowMismatchAreaBefore: 0, scalarShadowMismatchAreaAfter: 0, protectedObservedMaterialChangedArea: 0, scalarDesignBricks: 0, localApproximationBricks: 0 };
  for (const [i, s] of scalarNodes) {
    const b = nodes[i].brick;
    if (model.bricks[b].color !== s.target) { metrics.domainInconsistentAreaBefore += s.area; if (s.shadow) metrics.scalarShadowMismatchAreaBefore += s.area; }
    if (bricks[b].color !== s.target) { metrics.domainInconsistentAreaAfter += s.area; if (s.shadow) metrics.scalarShadowMismatchAreaAfter += s.area; }
  }
  for (const n of nodes) if (reasons.has(n.brick) && bricks[n.brick].color !== model.bricks[n.brick].color) metrics.protectedObservedMaterialChangedArea += n.observedArea;
  for (const c of design.changes) if (c.reason === 'source-scalar-shadow-design') metrics.scalarDesignBricks++; else metrics.localApproximationBricks++;
  design.materialMetrics = metrics; design.changedBricks = design.changes.length; design.afterColorCounts = Array(PALETTE.length).fill(0);
  for (const b of bricks) design.afterColorCounts[b.color]++;
  return { ...model, bricks, colorDesign: design,
    ...(model.assembly ? { assembly: { ...model.assembly, reference: `${model.assembly.reference} 用户明确选择局部源锚定材料设计：标量阴影证据整理 ${metrics.scalarDesignBricks} 块，另有人工暖色结构近似 ${metrics.localApproximationBricks} 块；未知 ${design.uncertainBricks} 块保持原色。这不是单图真实材质复原；几何、源观测、多材质/拼色与语义保护不变，目录颜色和实际库存仍需核实。` } } : {}),
  };
}
