import type { Brick } from './brick-engine.ts';
import { nearestColor } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';
import { ASSEMBLY_PARTS } from './assembly-catalog.ts';
import { gridConnections } from './grid-connections.ts';

type Cells = Map<string, { color: number; support: boolean }>;
export type SurfaceSample = {
  height: number;
  gx: number;
  gz: number;
  color: number;
};
type Candidate = {
  part: string;
  x: number;
  z: number;
  w: number;
  d: number;
  q: number;
  y: number;
  color: number;
  rms: number;
  old: number;
  maxError: number;
  evaluatedSamples: number;
  coveredSamples: number;
  planeResidualStuds: number;
  normalSupport: number;
};
export type SlopeDesign = {
  method: 'source-surface-slopes';
  regions: {
    id: string;
    rotation: number;
    color: number;
    pieces: number;
    chainedJoints: number;
    evaluatedSamples: number;
    rmsStuds: number;
    voxelRmsStuds: number;
  }[];
  replacements: {
    regionId: string;
    part: string;
    x: number;
    y: number;
    z: number;
    rotation: number;
    color: number;
    rmsStuds: number;
    voxelRmsStuds: number;
    maxErrorStuds: number;
    evaluatedSamples: number;
    coveredSamples: number;
    planeResidualStuds: number;
    normalSupport: number;
  }[];
};

/** Quarter-stud surface samples (two per column axis), retaining the highest
 * actual triangle intersection. Shadows cannot create slope evidence. */
export function slopeSurface(mesh: TriangleMesh, resolution: number) {
  const p = mesh.positions,
    min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3], p[i]);
    max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  const scale = resolution / Math.max(...max.map((v, a) => v - min[a]));
  const samples = new Map<string, SurfaceSample>();
  for (let i = 0; i < p.length; i += 9) {
    const v = [0, 1, 2].map((j) =>
      [0, 1, 2].map((a) => (p[i + j * 3 + a] - min[a]) * scale),
    );
    const a = v[1].map((n, k) => n - v[0][k]),
      b = v[2].map((n, k) => n - v[0][k]);
    const n = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    if (n[1] <= 1e-10) continue;
    const gx = -n[0] / n[1],
      gz = -n[2] / n[1];
    const color = nearestColor(
      ...(Array.from(mesh.colors.slice(i / 3, i / 3 + 3)) as [
        number,
        number,
        number,
      ]),
      true,
    );
    for (
      let sx = Math.max(
        0,
        Math.ceil(Math.min(...v.map((c) => c[0])) * 2 - 0.5),
      );
      sx <= Math.floor(Math.max(...v.map((c) => c[0])) * 2 - 0.5);
      sx++
    )
      for (
        let sz = Math.max(
          0,
          Math.ceil(Math.min(...v.map((c) => c[2])) * 2 - 0.5),
        );
        sz <= Math.floor(Math.max(...v.map((c) => c[2])) * 2 - 0.5);
        sz++
      ) {
        const x = (sx + 0.5) / 2,
          z = (sz + 0.5) / 2;
        const den =
          (v[1][2] - v[2][2]) * (v[0][0] - v[2][0]) +
          (v[2][0] - v[1][0]) * (v[0][2] - v[2][2]);
        const u =
          ((v[1][2] - v[2][2]) * (x - v[2][0]) +
            (v[2][0] - v[1][0]) * (z - v[2][2])) /
          den;
        const t =
          ((v[2][2] - v[0][2]) * (x - v[2][0]) +
            (v[0][0] - v[2][0]) * (z - v[2][2])) /
          den;
        if (u < -1e-6 || t < -1e-6 || u + t > 1 + 1e-6) continue;
        const height = u * v[0][1] + t * v[1][1] + (1 - u - t) * v[2][1] + 0.8;
        const key = `${sx},${sz}`;
        if (height > (samples.get(key)?.height ?? -Infinity))
          samples.set(key, { height, gx, gz, color });
      }
  }
  return samples;
}

/** Catalog low edge at 20 LDU, rise to 0, then one flat studded row.
 * Run is measured from vendored geometry, not the marketed angle. */
export function slopeTop(localRise: number, run = 1) {
  return 0.2 + Math.min(1, localRise / run);
}

// Fit source heights rather than inferring a plane from each tiny triangle's
// noisy normal. Original ray heights and colours stay unchanged for part fit.
function surfacePlane(points: { x: number; z: number; s: SurfaceSample }[]) {
  const mean = [0, 0, 0];
  for (const p of points) {
    mean[0] += p.x;
    mean[1] += p.z;
    mean[2] += p.s.height;
  }
  for (let i = 0; i < 3; i++) mean[i] /= points.length;
  let xx = 0,
    zz = 0,
    xz = 0,
    xy = 0,
    zy = 0;
  for (const p of points) {
    const x = p.x - mean[0],
      z = p.z - mean[1],
      y = p.s.height - mean[2];
    xx += x * x;
    zz += z * z;
    xz += x * z;
    xy += x * y;
    zy += z * y;
  }
  const det = xx * zz - xz * xz;
  if (det < 1e-8) return undefined;
  const gx = (xy * zz - zy * xz) / det,
    gz = (zy * xx - xy * xz) / det;
  const rms = Math.sqrt(
    points.reduce(
      (n, p) =>
        n +
        (p.s.height - mean[2] - gx * (p.x - mean[0]) - gz * (p.z - mean[1])) **
          2,
      0,
    ) / points.length,
  );
  return { gx, gz, rms };
}
export function designSlopes(
  samples: Map<string, SurfaceSample>,
  cells: Cells,
  width: number,
  depth: number,
  blocked: (x: number, y: number, z: number) => boolean,
) {
  const design: SlopeDesign = {
    method: 'source-surface-slopes',
    replacements: [],
    regions: [],
  };
  const tops = new Map<string, number>();
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    const k = `${x},${z}`;
    tops.set(k, Math.max(tops.get(k) ?? -1, y + 1));
  }
  const eligible: Candidate[] = [],
    bricks: Brick[] = [];
  for (const part of ['3298', '4286', '3039', '3040b'])
    for (let z = 1; z < depth - 1; z++)
      for (let x = 1; x < width - 1; x++) {
        for (let q = 0; q < 4; q++) {
          const p = ASSEMBLY_PARTS[part],
            run = p.d - 1;
          const w = q % 2 ? p.d : p.w,
            d = q % 2 ? p.w : p.d;
          if (x + w >= width || z + d >= depth) continue;
          const local: {
            s: SurfaceSample;
            rise: number;
            x: number;
            z: number;
          }[] = [];
          for (let dx = 0; dx < w * 2; dx++)
            for (let dz = 0; dz < d * 2; dz++) {
              const s = samples.get(`${(x - 1) * 2 + dx},${(z - 1) * 2 + dz}`);
              if (s)
                local.push({
                  s,
                  rise: [
                    (dz + 0.5) / 2,
                    (dx + 0.5) / 2,
                    d - (dz + 0.5) / 2,
                    w - (dx + 0.5) / 2,
                  ][q],
                  x: x + Math.floor(dx / 2),
                  z: z + Math.floor(dz / 2),
                });
            }
          if (local.length !== w * d * 4) continue;
          // A continuous oblique surface is required. Flat treads/riser edges do
          // not qualify, nor do isolated fragments of an animal or an ornament.
          const around: { x: number; z: number; s: SurfaceSample }[] = [];
          for (let dx = -2; dx < w * 2 + 2; dx++)
            for (let dz = -2; dz < d * 2 + 2; dz++) {
              const s = samples.get(`${(x - 1) * 2 + dx},${(z - 1) * 2 + dz}`);
              if (s) around.push({ x: (dx + 0.5) / 2, z: (dz + 0.5) / 2, s });
            }
          const rising = (s: SurfaceSample) => [s.gz, s.gx, -s.gz, -s.gx][q];
          const across = (s: SurfaceSample) => (q % 2 ? s.gz : s.gx);
          if (around.length < (w * 2 + 4) * (d * 2 + 4) * 0.9) continue;
          const plane = surfacePlane(around);
          if (
            !plane ||
            plane.rms > 0.15 ||
            rising({ ...plane, height: 0, color: 0 }) < 0.25 ||
            rising({ ...plane, height: 0, color: 0 }) > 1.4 ||
            Math.abs(across({ ...plane, height: 0, color: 0 })) > 0.2
          )
            continue;
          const normalSupport =
            around.filter(
              ({ s }) =>
                rising(s) > 0.1 &&
                (1 + s.gx * plane.gx + s.gz * plane.gz) /
                  (Math.hypot(1, s.gx, s.gz) *
                    Math.hypot(1, plane.gx, plane.gz)) >
                  0.9,
            ).length / around.length;
          if (normalSupport < 0.85) continue;
          const offsets = local
            .filter(({ rise }) => rise < run)
            .map(({ s, rise }) => s.height - slopeTop(rise, run))
            .sort((a, b) => a - b);
          const base = offsets[Math.floor(offsets.length / 2)] / 0.4;
          for (const y of new Set([Math.floor(base), Math.ceil(base)])) {
            if (y < 3) continue;
            let valid = true;
            const colors = new Set<number>();
            for (let dx = 0; dx < w; dx++)
              for (let dz = 0; dz < d; dz++) {
                const xx = x + dx,
                  zz = z + dz,
                  top = tops.get(`${xx},${zz}`);
                const below = cells.get(`${xx},${y - 1},${zz}`);
                if (
                  !below ||
                  below.support ||
                  !cells.has(`${xx},${y},${zz}`) ||
                  !top ||
                  (![dz === d - 1, dx === w - 1, dz === 0, dx === 0][q] &&
                    top > y + 4) ||
                  top < y + 1
                )
                  valid = false;
                const highRow = [
                  dz === d - 1,
                  dx === w - 1,
                  dz === 0,
                  dx === 0,
                ][q];
                const hidden = highRow && cells.has(`${xx},${y + 3},${zz}`);
                const topCell = top
                  ? cells.get(`${xx},${top - 1},${zz}`)
                  : undefined;
                if (!hidden) {
                  if (topCell) colors.add(topCell.color);
                  else valid = false;
                }
                for (
                  let yy = y;
                  yy < (highRow ? y + 3 : Math.max(y + 3, top ?? 0));
                  yy++
                )
                  if (blocked(xx, yy, zz)) valid = false;
              }
            const visible = local.filter(
              ({ rise, x, z }) =>
                rise < run || !cells.has(`${x},${y + 3},${z}`),
            );
            if (
              !valid ||
              colors.size !== 1 ||
              visible.some(({ s }) => !colors.has(s.color))
            )
              continue;
            // Retain side paint at a colour boundary; an unseen interior colour
            // alone is not evidence for the exposed face of the replacement.
            const color = [...colors][0];
            for (let dx = 0; dx < w; dx++)
              for (let dz = 0; dz < d; dz++)
                for (let yy = y; yy < y + 3; yy++) {
                  const xx = x + dx,
                    zz = z + dz,
                    cell = cells.get(`${xx},${yy},${zz}`);
                  if (
                    cell &&
                    cell.color !== color &&
                    [
                      [1, 0],
                      [-1, 0],
                      [0, 1],
                      [0, -1],
                    ].some(([a, b]) => !cells.has(`${xx + a},${yy},${zz + b}`))
                  )
                    valid = false;
                }
            if (!valid) continue;
            const errors = visible.map(
              ({ s, rise }) => y * 0.4 + slopeTop(rise, run) - s.height,
            );
            const rms = Math.sqrt(
              errors.reduce((n, e) => n + e * e, 0) / errors.length,
            );
            const old = Math.sqrt(
              visible.reduce(
                (n, { s, x, z }) =>
                  n + (tops.get(`${x},${z}`)! * 0.4 - s.height) ** 2,
                0,
              ) / visible.length,
            );
            const maxError = Math.max(...errors.map(Math.abs));
            if (rms > 0.28 || maxError > 0.5 || rms + 0.04 >= old) continue;
            eligible.push({
              x,
              z,
              part,
              w,
              d,
              q,
              y,
              rms,
              old,
              maxError,
              color: [...colors][0],
              evaluatedSamples: visible.length,
              coveredSamples: local.length - visible.length,
              planeResidualStuds: plane.rms,
              normalSupport,
            });
          }
        }
      }
  // Evaluate against the immutable source volume before selecting parts. A
  // high row can support the next row at +3 plates; banning its whole column
  // made the previous independent search leave terraces between candidates.
  const occupied = new Set<string>();
  const boxKeys = (c: Candidate) => {
    const keys: string[] = [];
    for (let x = c.x; x < c.x + c.w; x++)
      for (let z = c.z; z < c.z + c.d; z++)
        for (let y = c.y; y < c.y + 3; y++) keys.push(`${x},${y},${z}`);
    return keys;
  };
  const compatible = (c: Candidate) =>
    boxKeys(c).every((k) => !occupied.has(k));
  const adjacent = (a: Candidate, b: Candidate) => {
    if (a.q !== b.q || a.color !== b.color) return false;
    const runA = a.q % 2 ? a.x : a.z,
      runB = b.q % 2 ? b.x : b.z;
    const lenA = a.q % 2 ? a.w : a.d,
      lenB = b.q % 2 ? b.w : b.d;
    const crossA = a.q % 2 ? a.z : a.x,
      crossB = b.q % 2 ? b.z : b.x;
    const wideA = a.q % 2 ? a.d : a.w,
      wideB = b.q % 2 ? b.d : b.w;
    if (a.y === b.y && runA === runB && lenA === lenB)
      return crossA + wideA === crossB || crossB + wideB === crossA;
    if (crossA >= crossB + wideB || crossB >= crossA + wideA) return false;
    const direction = a.q < 2 ? 1 : -1;
    const frontA = direction > 0 ? runA : runA + lenA,
      frontB = direction > 0 ? runB : runB + lenB;
    const run = (frontB - frontA) * direction,
      rise = b.y - a.y;
    return (
      (rise === 3 && run === lenA - 1) ||
      (rise === -3 && run === -(lenB - 1)) ||
      ([2, 3].includes(rise) && run === lenA) ||
      ([-2, -3].includes(rise) && run === -lenB)
    );
  };
  const gain = (c: Candidate) =>
    c.evaluatedSamples * (c.old * c.old - c.rms * c.rms);
  const pending = new Set(eligible),
    selected: Candidate[] = [];
  while (pending.size) {
    let best: Candidate | undefined,
      score = -Infinity;
    for (const c of pending) {
      if (!compatible(c)) {
        pending.delete(c);
        continue;
      }
      const connections = selected.filter((b) => adjacent(b, c)).length;
      const value = gain(c) + connections * 2 + c.w * c.d * 0.0625;
      if (value > score) {
        best = c;
        score = value;
      }
    }
    if (!best) break;
    pending.delete(best);
    selected.push(best);
    for (const key of boxKeys(best)) occupied.add(key);
  }
  // Surface regions are measured over accepted layouts, not claims that all
  // members connect directly or that an entire architectural roof was found.
  const remaining = new Set(selected),
    regionOf = new Map<Candidate, string>();
  while (remaining.size) {
    const seed = remaining.values().next().value!;
    const members: Candidate[] = [],
      queue = [seed];
    remaining.delete(seed);
    while (queue.length) {
      const c = queue.pop()!;
      members.push(c);
      for (const b of remaining)
        if (adjacent(c, b)) {
          remaining.delete(b);
          queue.push(b);
        }
    }
    const id = `slope-region-${design.regions.length + 1}`;
    for (const c of members) regionOf.set(c, id);
    const memberBricks = members.map((c, i) => ({
      id: i + 1,
      part: c.part,
      x: c.x,
      y: c.y,
      z: c.z,
      w: c.w,
      d: c.d,
      h: 3,
      color: c.color,
      rotation: c.q,
    }));
    const links = gridConnections(memberBricks);
    const chainedJoints =
      [...links.values()].reduce((n, ids) => n + ids.size, 0) / 2;
    const samples = members.reduce((n, c) => n + c.evaluatedSamples, 0);
    design.regions.push({
      id,
      rotation: seed.q,
      color: seed.color,
      pieces: members.length,
      chainedJoints,
      evaluatedSamples: samples,
      rmsStuds: Math.sqrt(
        members.reduce((n, c) => n + c.rms * c.rms * c.evaluatedSamples, 0) /
          samples,
      ),
      voxelRmsStuds: Math.sqrt(
        members.reduce((n, c) => n + c.old * c.old * c.evaluatedSamples, 0) /
          samples,
      ),
    });
  }
  for (const c of selected) {
    for (let dx = 0; dx < c.w; dx++)
      for (let dz = 0; dz < c.d; dz++) {
        const xx = c.x + dx,
          zz = c.z + dz;
        const high = [dz === c.d - 1, dx === c.w - 1, dz === 0, dx === 0][c.q];
        for (
          let yy = c.y;
          yy < (high ? c.y + 3 : Math.max(c.y + 3, tops.get(`${xx},${zz}`)!));
          yy++
        )
          cells.delete(`${xx},${yy},${zz}`);
      }
    bricks.push({
      id: 0,
      part: c.part,
      x: c.x,
      y: c.y,
      z: c.z,
      w: c.w,
      d: c.d,
      h: 3,
      color: c.color,
      rotation: c.q,
    });
    design.replacements.push({
      regionId: regionOf.get(c)!,
      part: c.part,
      x: c.x,
      y: c.y,
      z: c.z,
      rotation: c.q,
      color: c.color,
      rmsStuds: c.rms,
      voxelRmsStuds: c.old,
      maxErrorStuds: c.maxError,
      evaluatedSamples: c.evaluatedSamples,
      coveredSamples: c.coveredSamples,
      planeResidualStuds: c.planeResidualStuds,
      normalSupport: c.normalSupport,
    });
  }
  return { bricks, design };
}
