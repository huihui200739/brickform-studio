import type { Brick } from './brick-engine.ts';
import { nearestColor } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';

type Cells = Map<string, { color: number; support: boolean }>;
type Sample = { height: number; gx: number; gz: number; color: number };
export type SlopeDesign = {
  method: 'source-surface-slopes';
  replacements: {
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
  const samples = new Map<string, Sample>();
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

/** Native 3039/3040b body: low edge at 20 LDU, slope to 0 over
 * one stud, then a one-stud flat studded row. The full bounding box is reserved. */
export function slopeTop(localRise: number) {
  return 0.2 + Math.min(1, localRise);
}
export function designSlopes(
  samples: Map<string, Sample>,
  cells: Cells,
  width: number,
  depth: number,
  blocked: (x: number, y: number, z: number) => boolean,
) {
  const design: SlopeDesign = {
    method: 'source-surface-slopes',
    replacements: [],
  };
  const tops = new Map<string, number>();
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number);
    const k = `${x},${z}`;
    tops.set(k, Math.max(tops.get(k) ?? -1, y + 1));
  }
  const reserved = new Set<string>(),
    bricks: Brick[] = [];
  for (const partWidth of [2, 1])
    for (let z = 1; z < depth - 1; z++)
      for (let x = 1; x < width - 1; x++) {
        const candidates = [];
        for (let q = 0; q < 4; q++) {
          const w = q % 2 ? 2 : partWidth,
            d = q % 2 ? partWidth : 2;
          if (x + w >= width || z + d >= depth) continue;
          const local: { s: Sample; rise: number; x: number; z: number }[] = [];
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
          const around: Sample[] = [];
          for (let dx = -2; dx < w * 2 + 2; dx++)
            for (let dz = -2; dz < d * 2 + 2; dz++) {
              const s = samples.get(`${(x - 1) * 2 + dx},${(z - 1) * 2 + dz}`);
              if (s) around.push(s);
            }
          const rising = (s: Sample) => [s.gz, s.gx, -s.gz, -s.gx][q];
          const across = (s: Sample) => (q % 2 ? s.gz : s.gx);
          if (
            around.length < (w * 2 + 4) * (d * 2 + 4) * 0.9 ||
            around.filter(
              (s) =>
                rising(s) > 0.25 &&
                rising(s) < 1.4 &&
                Math.abs(across(s)) < 0.2,
            ).length <
              around.length * 0.85
          )
            continue;
          const offsets = local
            .filter(({ rise }) => rise < 1)
            .map(({ s, rise }) => s.height - slopeTop(rise))
            .sort((a, b) => a - b);
          const y = Math.floor(offsets[Math.floor(offsets.length / 2)] / 0.4);
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
                reserved.has(`${xx},${zz}`) ||
                !below ||
                below.support ||
                !cells.has(`${xx},${y},${zz}`) ||
                !top ||
                (![dz === d - 1, dx === w - 1, dz === 0, dx === 0][q] &&
                  top > y + 4) ||
                top < y + 1
              )
                valid = false;
              const highRow = [dz === d - 1, dx === w - 1, dz === 0, dx === 0][
                q
              ];
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
            ({ rise, x, z }) => rise < 1 || !cells.has(`${x},${y + 3},${z}`),
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
            ({ s, rise }) => y * 0.4 + slopeTop(rise) - s.height,
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
          candidates.push({
            part: partWidth === 2 ? '3039' : '3040b',
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
          });
        }
        candidates.sort((a, b) => a.rms - b.rms);
        const c = candidates[0];
        if (!c) continue;
        for (let dx = 0; dx < c.w; dx++)
          for (let dz = 0; dz < c.d; dz++) {
            const xx = x + dx,
              zz = z + dz;
            reserved.add(`${xx},${zz}`);
            for (
              let yy = c.y;
              yy <
              ([dz === c.d - 1, dx === c.w - 1, dz === 0, dx === 0][c.q]
                ? c.y + 3
                : Math.max(c.y + 3, tops.get(`${xx},${zz}`)!));
              yy++
            )
              cells.delete(`${xx},${yy},${zz}`);
          }
        bricks.push({
          id: 0,
          part: c.part,
          x,
          y: c.y,
          z,
          w: c.w,
          d: c.d,
          h: 3,
          color: c.color,
          rotation: c.q,
        });
        design.replacements.push({
          part: c.part,
          x,
          y: c.y,
          z,
          rotation: c.q,
          color: c.color,
          rmsStuds: c.rms,
          voxelRmsStuds: c.old,
          maxErrorStuds: c.maxError,
          evaluatedSamples: c.evaluatedSamples,
          coveredSamples: c.coveredSamples,
        });
      }
  return { bricks, design };
}
