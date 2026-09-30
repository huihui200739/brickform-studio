import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, SphereGeometry } from 'three';
import { buildMeshVolume } from './mesh-design.ts';
import {
  applyPlatform,
  fitPlatform,
  auditPlatform,
} from './platform-design.ts';
import type { TriangleMesh } from './mesh-types.ts';
import type { Model } from './brick-engine.ts';

function boxes(items: number[][]): TriangleMesh {
  const positions: number[] = [],
    colors: number[] = [];
  for (const [x, y, z, w, h, d] of items) {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    positions.push(...g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count / 3; i++)
      colors.push(215, 186, 140);
    g.dispose();
  }
  return {
    positions: new Float32Array(positions),
    colors: new Uint8Array(colors),
    name: 'measured floor',
  };
}

void test('observed platform corrects multi-plate sampling noise without flattening steps, plinths, holes or colour patterns', () => {
  const mesh = boxes([
    [0, 0, 0, 20, 2.4, 20],
    [0, 2.4, 0, 3, 17.6, 3],
    [8, 2.4, 8, 4, 0.4, 4], // One-plate step: cannot be treated as sampling noise.
    [14, 2.4, 14, 3, 1.2, 3],
  ]);
  const volume = buildMeshVolume(mesh, 20),
    cells = new Map(volume.cells);
  const level = volume.platform!.topY;
  for (let y = level + 1; y <= level + 2; y++)
    cells.set(`5,${y},5`, { color: 7, support: false });
  for (let y = level - 1; y <= level + 2; y++) cells.delete(`6,${y},6`);
  for (let y = 2; y <= level + 2; y++) cells.delete(`13,${y},13`);
  const stripe = `7,${level + 1},7`;
  cells.set(stripe, { color: 11, support: false });
  const stepBefore = [...cells].filter(
    ([k]) => k.startsWith('10,') && k.endsWith(',10'),
  );
  const plinthBefore = [...cells].filter(
    ([k]) => k.startsWith('16,') && k.endsWith(',16'),
  );
  const plan = fitPlatform(mesh, 20, cells, volume.w, volume.h, volume.d)!;
  assert.ok(plan);
  assert.ok(applyPlatform(cells, plan) > 2);
  assert.equal(cells.has(`5,${level + 1},5`), false);
  assert.equal(cells.has(`6,${level},6`), true);
  assert.equal(cells.has(`13,${level},13`), false);
  assert.equal(cells.get(`7,${level},7`)?.color, 11);
  assert.deepEqual(
    [...cells].filter(([k]) => k.startsWith('10,') && k.endsWith(',10')),
    stepBefore,
  );
  assert.deepEqual(
    [...cells].filter(([k]) => k.startsWith('16,') && k.endsWith(',16')),
    plinthBefore,
  );
});

void test('a curved lower surface does not authorize a platform', () => {
  const g = new SphereGeometry(10, 32, 24).toNonIndexed();
  g.translate(10, 10, 10);
  const mesh: TriangleMesh = {
    positions: g.attributes.position.array as Float32Array,
    colors: new Uint8Array(g.attributes.position.count).fill(150),
    name: 'curved subject',
  };
  const volume = buildMeshVolume(mesh, 20);
  assert.equal(volume.platform, undefined);
  g.dispose();
});

void test('final platform validation rejects post-packing holes, raised bricks and unwanted studs', () => {
  const plan = {
    source: 'reconstructed-mesh' as const,
    intent: 'level-display-surface' as const,
    topY: 5,
    columns: ['0,0', '1,0', '2,0', '3,0'],
    adjustedColumns: 1,
    evidence: {
      samples: 2,
      areaStudsSquared: 400,
      lowSurfaceConsensus: 1,
      rmsePlates: 0,
    },
  };
  const model = {
    bricks: [
      { id: 1, part: '3070b', x: 0, y: 5, z: 0, w: 1, d: 1, h: 1, color: 7 },
      { id: 2, part: '3070b', x: 1, y: 6, z: 0, w: 1, d: 1, h: 1, color: 7 },
      { id: 3, part: '3024', x: 2, y: 5, z: 0, w: 1, d: 1, h: 1, color: 7 },
    ],
  } as Model;
  const check = auditPlatform(model, plan, new Set());
  assert.equal(check.passed, false);
  assert.deepEqual(
    [check.uneven, check.exposedStuds, check.missing],
    [1, 1, 1],
  );
  assert.equal(
    auditPlatform(model, plan, new Set(['1,0', '2,0', '3,0'])).passed,
    true,
  );
});
