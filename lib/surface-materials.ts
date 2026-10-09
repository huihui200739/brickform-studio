import { rgb } from './material-color-space.ts';
import { sourceFactorMaterialKey } from './source-shadow-colors.ts';
import {
  SOURCE_COLOR_KIND,
  unobservedMaterialPolicy,
  type NativeAppearanceProvenance,
  type UnobservedMaterialPolicy,
} from './source-material-provenance.ts';

export type SurfaceMaterialOptions = {
  unobservedPolicy?: UnobservedMaterialPolicy;
  nativeAppearance?: NativeAppearanceProvenance;
};

export type SurfaceMaterialRegion = {
  id: number;
  faces: number;
  area: number;
  normal: number[];
  center: number[];
  observedFaces: number;
  observedArea: number;
  inferredFaces: number;
  observedPixels: number;
  materialPixels: number[];
  // Suggested color for inferred members; observed members retain their paint.
  color: number;
  source:
    | 'local-observation'
    | 'compatible-surface'
    | 'inclination-consensus'
    | 'source-topology'
    | 'reference-default';
  donorRegionIds: number[];
  topologySupport?: {
    method: 'exact-manifold-source-path';
    anchorFaceIds: number[];
    nativeMaterialIds: number[];
    inference: true;
  };
  inferredSupport?: {
    voteUnit: 'visible-reference-pixel';
    materialVotes: number[];
    supportFraction: number;
  };
};
export type SurfaceMaterialDesign = {
  method: 'connected-surface-materials';
  regions: SurfaceMaterialRegion[];
  inferredFaces: number;
  defaultFaces: number;
  unobservedPolicy?: UnobservedMaterialPolicy;
  donorPolicy: {
    minimumNormalDot: 0.9;
    maximumPlaneOffsetFraction: 0.03;
    maximumInclinationDifference: 0.12;
    minimumConsensusFraction: 0.6;
  };
};

/** Infer missing paint from connected, similarly oriented surface regions.
 * Never alter an observed face. Neither geometric proximity nor a shared
 * normal proves material identity on an unseen side; record every inference. */
export function surfaceMaterials(
  p: Float32Array,
  observed: Int16Array,
  pixels: { face: number; color: number }[],
  fallback: number,
  options?: SurfaceMaterialOptions,
) {
  const policy = unobservedMaterialPolicy(options?.unobservedPolicy);
  const n = p.length / 9;
  const native = options?.nativeAppearance;
  if (
    native &&
    (native.originalRGB.length !== n * 3 || native.materialIds.length !== n)
  )
    throw Error('Native appearance does not match source faces.');
  const sameNativeMaterial = (a: number, b: number) =>
    !native || native.materialIds[a] === native.materialIds[b];
  const normals = new Float64Array(n * 3),
    centers = new Float64Array(n * 3),
    areas = new Float64Array(n),
    labels = new Int32Array(n).fill(-1);
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], p[i]);
    hi[i % 3] = Math.max(hi[i % 3], p[i]);
  }
  const extent = Math.max(...hi.map((v, a) => v - lo[a]));
  // Weld only coincident source vertices; do not connect across cracks, holes
  // or merely nearby surfaces. Non-manifold edges have no reliable continuation.
  const vertices = new Map<string, number>(),
    edges = new Map<string, number[]>();
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < n; t++) {
    const i = t * 9,
      ids: number[] = [];
    for (let v = 0; v < 3; v++) {
      const key = [0, 1, 2].map((a) => p[i + v * 3 + a]).join(',');
      if (!vertices.has(key)) vertices.set(key, vertices.size);
      ids.push(vertices.get(key)!);
      for (let a = 0; a < 3; a++) centers[t * 3 + a] += p[i + v * 3 + a] / 3;
    }
    const a = [0, 1, 2].map((k) => p[i + 3 + k] - p[i + k]);
    const b = [0, 1, 2].map((k) => p[i + 6 + k] - p[i + k]);
    const cross = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const length = Math.hypot(...cross);
    areas[t] = length / 2;
    if (length > 0)
      for (let k = 0; k < 3; k++) normals[t * 3 + k] = cross[k] / length;
    for (let e = 0; e < 3; e++) {
      const a = ids[e],
        b = ids[(e + 1) % 3];
      if (a === b) continue;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edges.get(key);
      if (list) list.push(t);
      else edges.set(key, [t]);
    }
  }
  for (const faces of edges.values())
    if (faces.length === 2) {
      neighbours[faces[0]].push(faces[1]);
      neighbours[faces[1]].push(faces[0]);
    }
  const dot = (a: number, b: number) =>
    [0, 1, 2].reduce((s, k) => s + normals[a * 3 + k] * normals[b * 3 + k], 0);
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => areas[b] - areas[a] || a - b,
  );
  const regions: SurfaceMaterialRegion[] = [];
  for (const seed of order) {
    if (labels[seed] >= 0) continue;
    const id = regions.length,
      queue = [seed];
    labels[seed] = id;
    let paint = observed[seed];
    const r: SurfaceMaterialRegion = {
      id,
      faces: 0,
      area: 0,
      normal: [0, 0, 0],
      center: [0, 0, 0],
      observedFaces: 0,
      observedArea: 0,
      inferredFaces: 0,
      observedPixels: 0,
      materialPixels: Array(rgb.length).fill(0),
      color: fallback,
      source: 'reference-default',
      donorRegionIds: [],
    };
    for (let head = 0; head < queue.length; head++) {
      const t = queue[head];
      r.faces++;
      r.area += areas[t];
      if (observed[t] >= 0) {
        r.observedFaces++;
        r.observedArea += areas[t];
      } else r.inferredFaces++;
      for (let k = 0; k < 3; k++) {
        r.normal[k] += normals[t * 3 + k] * areas[t];
        r.center[k] += centers[t * 3 + k] * areas[t];
      }
      for (const next of neighbours[t]) {
        if (
          labels[next] >= 0 ||
          dot(seed, next) < 0.9 ||
          dot(t, next) < 0.8 ||
          (policy === 'source-topology-only' && !sameNativeMaterial(t, next))
        )
          continue;
        // An unobserved detour cannot merge two observed paints into one patch.
        if (observed[next] >= 0 && paint >= 0 && observed[next] !== paint)
          continue;
        if (paint < 0 && observed[next] >= 0) paint = observed[next];
        labels[next] = id;
        queue.push(next);
      }
    }
    if (r.area > 0) for (let k = 0; k < 3; k++) r.center[k] /= r.area;
    const length = Math.hypot(...r.normal);
    if (length) r.normal = r.normal.map((v) => v / length);
    regions.push(r);
  }
  for (const { face, color } of pixels)
    if (face >= 0 && labels[face] >= 0) {
      const r = regions[labels[face]];
      r.materialPixels[color]++;
      r.observedPixels++;
    }
  const choose = (votes: number[]) => {
    let best = -1;
    for (let c = 0; c < votes.length; c++)
      if (votes[c] > 0 && (best < 0 || votes[c] > votes[best])) best = c;
    return best;
  };
  // Only real projected pixels vote. A dense patch gets no advantage from its
  // triangle count, and a one-pixel speck cannot paint an entire unseen region.
  const donors = regions.filter(
    // A flame, badge or tiny painted trim can keep its own material, but its
    // small geometric footprint is not evidence for paint on other surfaces.
    (r) =>
      r.observedPixels >= 8 &&
      r.observedArea >= extent * extent * 0.001 &&
      choose(r.materialPixels) >= 0,
  );
  // Opt-in: positive paint anchors must be reachable through exact manifold
  // source edges. Native material IDs may support a real crease continuation,
  // but imported appearance is still not verified albedo. Missing/default
  // material does not authorize crossing a crease. Conflicting observed paints
  // in an unknown detour abstain rather than becoming a majority hypothesis.
  if (policy === 'source-topology-only') {
    // Shared positive clue, not slot ID alone: imported texture/vertex/default
    // samples, nonopaque factors and one-white proxy slots cannot bridge a
    // crease. Both faces must qualify; slot IDs still act as negative boundaries.
    const source = native
      ? { positions: p, colors: native.originalRGB, nativeAppearance: native, name: 'source topology material evidence' }
      : undefined;
    const factorKeys = Int32Array.from({ length: n }, (_, face) =>
      source ? sourceFactorMaterialKey(source, face) : -1,
    );
    const authoredCrease = (a: number, b: number) =>
      factorKeys[a] >= 0 && factorKeys[a] === factorKeys[b];
    const domainIds = new Int32Array(n).fill(-1);
    const domains: number[][] = [];
    for (const seed of order) {
      if (domainIds[seed] >= 0) continue;
      const id = domains.length,
        queue = [seed];
      domainIds[seed] = id;
      for (let head = 0; head < queue.length; head++) {
        const face = queue[head];
        for (const next of neighbours[face]) {
          if (domainIds[next] >= 0 || !sameNativeMaterial(face, next)) continue;
          if (
            observed[face] >= 0 &&
            observed[next] >= 0 &&
            observed[face] !== observed[next]
          )
            continue;
          const explicitMaterial = authoredCrease(face, next);
          if (
            explicitMaterial
              ? dot(face, next) < -0.1
              : dot(seed, next) < 0.9 || dot(face, next) < 0.8
          )
            continue;
          domainIds[next] = id;
          queue.push(next);
        }
      }
      domains.push(queue);
    }
    const donorIds = new Set(donors.map((r) => r.id));
    const pixelSupport = new Uint32Array(n);
    for (const pixel of pixels)
      if (pixel.face >= 0 && pixel.face < n && observed[pixel.face] >= 0)
        pixelSupport[pixel.face]++;
    const parents = new Int32Array(n).fill(-1);
    const topologyColors = new Int16Array(n).fill(-1);
    const roots = new Int32Array(n).fill(-1);
    for (let id = 0; id < domains.length; id++) {
      const domain = domains[id];
      const paint = new Set(
        domain.filter((f) => observed[f] >= 0).map((f) => observed[f]),
      );
      const anchors =
        paint.size === 1
          ? domain.filter((f) => pixelSupport[f] > 0 && donorIds.has(labels[f]))
          : [];
      if (!anchors.length) continue;
      const color = observed[anchors[0]],
        queue = [...anchors];
      for (const f of anchors) {
        parents[f] = f;
        roots[f] = f;
        topologyColors[f] = color;
      }
      for (let head = 0; head < queue.length; head++) {
        const f = queue[head];
        for (const next of neighbours[f]) {
          if (parents[next] >= 0 || domainIds[next] !== id) continue;
          const explicitMaterial = authoredCrease(f, next);
          if (dot(f, next) < (explicitMaterial ? -0.1 : 0.8)) continue;
          parents[next] = f;
          roots[next] = roots[f];
          topologyColors[next] = color;
          queue.push(next);
        }
      }
    }
    const colors = observed.slice();
    const perFaceSourceKind = new Uint8Array(n);
    const regionMembers = Array.from(
      { length: regions.length },
      () => [] as number[],
    );
    for (let f = 0; f < n; f++) {
      regionMembers[labels[f]].push(f);
      if (observed[f] >= 0)
        perFaceSourceKind[f] = SOURCE_COLOR_KIND.referenceObserved;
      else if (parents[f] >= 0) {
        colors[f] = topologyColors[f];
        perFaceSourceKind[f] = SOURCE_COLOR_KIND.sourceTopologyInferred;
      } else {
        colors[f] = fallback;
        perFaceSourceKind[f] = SOURCE_COLOR_KIND.referenceDefault;
      }
    }
    for (const r of regions) {
      const inferred = regionMembers[r.id].filter((f) => observed[f] < 0);
      const anchored = inferred.filter((f) => parents[f] >= 0);
      const local = choose(r.materialPixels);
      if (!inferred.length && local >= 0) {
        r.color = local;
        r.source = 'local-observation';
      } else if (anchored.length === inferred.length && anchored.length > 0) {
        r.color = colors[anchored[0]];
        r.source = 'source-topology';
        const anchors = [...new Set(anchored.map((f) => roots[f]))];
        r.donorRegionIds = [...new Set(anchors.map((f) => labels[f]))];
        r.topologySupport = {
          method: 'exact-manifold-source-path',
          anchorFaceIds: anchors,
          nativeMaterialIds: native
            ? [...new Set(anchors.map((f) => native.materialIds[f]))]
            : [],
          inference: true,
        };
      }
    }
    return {
      colors,
      regionIds: labels,
      perFaceSourceKind,
      disconnectedInference: new Uint8Array(n),
      topologyParentFaces: parents,
      sourceDomainIds: domainIds,
      design: {
        method: 'connected-surface-materials' as const,
        unobservedPolicy: policy,
        donorPolicy: {
          minimumNormalDot: 0.9 as const,
          maximumPlaneOffsetFraction: 0.03 as const,
          maximumInclinationDifference: 0.12 as const,
          minimumConsensusFraction: 0.6 as const,
        },
        regions,
        inferredFaces: observed.reduce((sum, c) => sum + Number(c < 0), 0),
        defaultFaces: perFaceSourceKind.reduce(
          (sum, kind) =>
            sum + Number(kind === SOURCE_COLOR_KIND.referenceDefault),
          0,
        ),
      },
    };
  }
  for (const r of regions) {
    const local = choose(r.materialPixels);
    if (local >= 0 && r.observedPixels >= 8) {
      r.color = local;
      r.source = 'local-observation';
      continue;
    }
    const family = donors
      .map((d) => {
        const inclination = Math.abs(
          Math.abs(d.normal[1]) - Math.abs(r.normal[1]),
        );
        const distance = Math.hypot(
          ...r.center.map((v, k) => (v - d.center[k]) / extent),
        );
        const normalDot = r.normal.reduce(
          (sum, v, k) => sum + v * d.normal[k],
          0,
        );
        const delta = r.center.map((v, k) => (v - d.center[k]) / extent);
        const planeOffset = Math.max(
          Math.abs(delta.reduce((sum, v, k) => sum + v * r.normal[k], 0)),
          Math.abs(delta.reduce((sum, v, k) => sum + v * d.normal[k], 0)),
        );
        // Inclination identifies a broad geometric family, not a neighboring
        // material patch. Opposite cavity and rear walls both have normalY=0.
        const sameInclination =
          inclination <= 0.12 && !(d.normal[1] * r.normal[1] < -0.1);
        return {
          d,
          distance,
          inclination,
          normalDot,
          planeOffset,
          sameInclination,
        };
      })
      .filter((c) => c.sameInclination);
    const candidates = family
      .filter(
        (c) => c.normalDot >= 0.9 && c.planeOffset <= 0.03 && c.distance < 0.8,
      )
      .sort((a, b) => a.distance - b.distance || a.d.id - b.d.id)
      .slice(0, 4);
    if (candidates.length) {
      const votes = Array(rgb.length).fill(0);
      for (const { d, distance, inclination } of candidates)
        for (let c = 0; c < votes.length; c++)
          votes[c] +=
            d.materialPixels[c] / (0.02 + distance * distance + inclination);
      const color = choose(votes);
      if (color >= 0) {
        r.color = color;
        r.source = 'compatible-surface';
        r.donorRegionIds = candidates.map(({ d }) => d.id);
        r.inferredSupport = {
          voteUnit: 'visible-reference-pixel',
          materialVotes: votes,
          supportFraction: votes[color] / votes.reduce((sum, v) => sum + v, 0),
        };
        continue;
      }
    }
    // If a local continuation is absent, infer from the observed large faces
    // of this inclination family, without nearest-cavity distance weighting.
    // The roof's image majority must not become a wall's fallback material.
    // This is explicitly a hidden-color hypothesis; observations stay intact.
    const consensusVotes = Array(rgb.length).fill(0);
    for (const { d } of family)
      for (let c = 0; c < consensusVotes.length; c++)
        consensusVotes[c] += d.materialPixels[c];
    const consensusColor = choose(consensusVotes);
    const totalVotes = consensusVotes.reduce((sum, v) => sum + v, 0);
    if (
      consensusColor >= 0 &&
      consensusVotes[consensusColor] / totalVotes >= 0.6
    ) {
      r.color = consensusColor;
      r.source = 'inclination-consensus';
      r.donorRegionIds = family.map(({ d }) => d.id);
      r.inferredSupport = {
        voteUnit: 'visible-reference-pixel',
        materialVotes: consensusVotes,
        supportFraction: consensusVotes[consensusColor] / totalVotes,
      };
    }
  }
  const colors = observed.slice();
  const perFaceSourceKind = new Uint8Array(n),
    disconnectedInference = new Uint8Array(n);
  const components = new Int32Array(n).fill(-1);
  let component = 0;
  for (let seed = 0; seed < n; seed++) {
    if (components[seed] >= 0) continue;
    const queue = [seed];
    components[seed] = component;
    for (let head = 0; head < queue.length; head++)
      for (const next of neighbours[queue[head]]) {
        if (components[next] >= 0) continue;
        components[next] = component;
        queue.push(next);
      }
    component++;
  }
  const regionComponent = new Int32Array(regions.length);
  for (let f = 0; f < n; f++) regionComponent[labels[f]] = components[f];
  for (let t = 0; t < n; t++) {
    if (colors[t] >= 0) {
      perFaceSourceKind[t] = SOURCE_COLOR_KIND.referenceObserved;
      continue;
    }
    const r = regions[labels[t]];
    colors[t] = r.color;
    perFaceSourceKind[t] =
      r.source === 'local-observation'
        ? SOURCE_COLOR_KIND.legacyLocalInferred
        : r.source === 'compatible-surface'
          ? SOURCE_COLOR_KIND.legacyCompatibleInferred
          : r.source === 'inclination-consensus'
            ? SOURCE_COLOR_KIND.legacyInclinationInferred
            : SOURCE_COLOR_KIND.referenceDefault;
    if (r.donorRegionIds.some((id) => regionComponent[id] !== components[t]))
      disconnectedInference[t] = 1;
  }
  return {
    colors,
    regionIds: labels,
    perFaceSourceKind,
    disconnectedInference,
    topologyParentFaces: undefined,
    sourceDomainIds: undefined,
    design: {
      method: 'connected-surface-materials' as const,
      unobservedPolicy: policy,
      donorPolicy: {
        minimumNormalDot: 0.9 as const,
        maximumPlaneOffsetFraction: 0.03 as const,
        maximumInclinationDifference: 0.12 as const,
        minimumConsensusFraction: 0.6 as const,
      },
      regions,
      inferredFaces: regions.reduce((s, r) => s + r.inferredFaces, 0),
      defaultFaces: regions
        .filter((r) => r.source === 'reference-default')
        .reduce((s, r) => s + r.inferredFaces, 0),
    },
  };
}
