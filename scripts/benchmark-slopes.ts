import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { rotate, ASSEMBLY_PARTS } from '../lib/assembly-catalog.ts';
import { connectors } from '../lib/assembly-validation.ts';
import { gridConnections } from '../lib/grid-connections.ts';
import type { Model } from '../lib/brick-engine.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

const directory = resolve(process.argv[2] || 'outputs/slope-calibration');
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const audit = read(join(directory, 'support-results.json'));
const current = conversionFingerprint();
if (!audit.passed || audit.conversionFingerprint !== current)
  throw Error('Replay conversions and emitted order first.');
const baseline = read('benchmarks/surface-order-2026-10-01.json');
let failed = false;
const cases = audit.cases.map(
  (row: {
    id: string;
    resolution: number;
    modelSha256: string;
    bricks: number;
    supports: number;
  }) => {
    const file = row.id.startsWith('temple-')
      ? join(directory, `${row.id}-${row.resolution}.json`)
      : `outputs/image-benchmark/${row.id}/bricks-${row.resolution}.json`;
    const bytes = readFileSync(file),
      model = JSON.parse(bytes.toString()) as Model;
    const graph = gridConnections(
      model.bricks.filter((b) => !b.section?.startsWith('component-')),
    );
    let failures = 0;
    const replacements = (model.slopeDesign?.replacements || []).map((r) => {
      const part = model.bricks.find(
        (b) =>
          b.part === r.part &&
          b.x === r.x &&
          b.y === r.y &&
          b.z === r.z &&
          b.rotation === r.rotation &&
          b.color === r.color,
      );
      let covered = 0;
      if (part)
        for (let dx = 0; dx < part.w * 2; dx++)
          for (let dz = 0; dz < part.d * 2; dz++) {
            const high = [
              Math.floor(dz / 2) === part.d - 1,
              Math.floor(dx / 2) === part.w - 1,
              Math.floor(dz / 2) === 0,
              Math.floor(dx / 2) === 0,
            ][r.rotation];
            const x = part.x + (dx + 0.5) / 2,
              z = part.z + (dz + 0.5) / 2;
            if (
              high &&
              model.bricks.some(
                (b) =>
                  b.id !== part.id &&
                  b.y === part.y + part.h &&
                  x > b.x &&
                  x < b.x + b.w &&
                  z > b.z &&
                  z < b.z + b.d,
              )
            )
              covered++;
          }
      const gridParents = part
        ? [...(graph.get(part.id) || [])].filter(
            (id) =>
              model.bricks.find((b) => b.id === id)!.y +
                model.bricks.find((b) => b.id === id)!.h ===
              part.y,
          )
        : [];
      const ports = part ? connectors(part) : { studs: [], sockets: [] };
      const passed =
        !!part &&
        r.rmsStuds + 0.04 < r.voxelRmsStuds &&
        r.maxErrorStuds <= 0.5 &&
        r.coveredSamples === covered &&
        part.pose!.matrix.every((v, k) => v === rotate(r.rotation)[k]) &&
        ports.studs.length === ASSEMBLY_PARTS[r.part].w &&
        gridParents.length > 0;
      if (!passed) failures++;
      return {
        ...r,
        emittedId: part?.id,
        coveredSamplesInFinalModel: covered,
        studs: ports.studs.length,
        gridParents,
        passed,
      };
    });
    if (createHash('sha256').update(bytes).digest('hex') !== row.modelSha256)
      failures++;
    if (
      model.bricks.filter(
        (b) =>
          !b.section?.startsWith('component-') &&
          ['3039', '3040b'].includes(b.part),
      ).length !== replacements.length
    )
      failures++;
    if (failures) failed = true;
    const old = baseline.cases.find(
      (r: { id: string; resolution: number }) =>
        r.id === row.id && r.resolution === row.resolution,
    );
    return {
      ...row,
      passed: failures === 0,
      failures,
      replacements,
      baseline: old
        ? { bricks: old.bricks, supports: old.supports }
        : undefined,
      appearance:
        'Draft; inspect catalog renders. Local sampled error is not photo similarity or physical build verification.',
    };
  },
);
const output = {
  date: '2026-10-01',
  conversionFingerprint: current,
  passed: !failed,
  scope: audit.scope,
  cases,
  limits:
    'Source-evidenced upright slopes only. Unobserved backs, curved surface design, material inference, kit appearance, procurement, full insertion paths, joint force and human step trials remain incomplete.',
};
writeFileSync(
  join(directory, 'slope-results.json'),
  JSON.stringify(output, null, 2),
);
console.log(
  JSON.stringify({
    passed: !failed,
    cases: cases.length,
    slopes: cases.reduce(
      (n: number, c: { replacements: unknown[] }) =>
        Number(n) + c.replacements.length,
      0,
    ),
  }),
);
if (failed) process.exitCode = 1;
