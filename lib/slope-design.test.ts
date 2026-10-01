import test from 'node:test';
import assert from 'node:assert/strict';
import { brickFaces } from './assembly-diagram.ts';
import { manualHTML } from './manual.ts';
import { IDENTITY, ASSEMBLY_PARTS } from './assembly-catalog.ts';
import { gridConnections } from './grid-connections.ts';
import { connectors, validateAssembly } from './assembly-validation.ts';
import { instructionModel, installationText } from './build-instructions.ts';
import {
  finishModel,
  inventory,
  toLDraw,
  type Model,
  type Brick,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { designSlopes, slopeSurface } from './slope-design.ts';
import { buildMeshVolume, meshToDesign } from './mesh-design.ts';
import type { TriangleMesh } from './mesh-types.ts';

function model(bricks: Brick[]): Model {
  return {
    name: 'slope',
    width: 8,
    depth: 8,
    height: 8,
    bricks,
    levels: [0, 3],
    source: 'image',
    resolution: 28,
    shape: 'sculpture',
    supportCount: 0,
    assemblyStrategy: 'connector-graph',
  };
}
void test('four slope orientations expose only the real high-row studs and agree with catalog poses', () => {
  for (const part of ['3039', '3040b', '3298', '4286'])
    for (let q = 0; q < 4; q++) {
      const { w: partWidth, d: partDepth } = ASSEMBLY_PARTS[part];
      const slope: Brick = {
        id: 1,
        part,
        x: 2,
        y: 0,
        z: 2,
        w: q % 2 ? partDepth : partWidth,
        d: q % 2 ? partWidth : partDepth,
        h: 3,
        color: 7,
        rotation: q,
      };
      const bricks = [slope];
      for (let x = 2; x < 2 + slope.w; x++)
        for (let z = 2; z < 2 + slope.d; z++)
          bricks.push({
            id: bricks.length + 1,
            part: '3024',
            x,
            y: 3,
            z,
            w: 1,
            d: 1,
            h: 1,
            color: 7,
          });
      const graph = gridConnections(bricks),
        posed = instructionModel(model(bricks));
      const tops = connectors(posed.bricks[0]).studs;
      assert.equal(tops.length, partWidth);
      for (const b of posed.bricks.slice(1)) {
        const actual = connectors(b).sockets.some((p) =>
          tops.some((t) =>
            t.point.every((n, k) => Math.abs(n - p.point[k]) < 1e-5),
          ),
        );
        assert.equal(
          graph.get(1)!.has(b.id),
          actual,
          `yaw ${q}, ${b.x},${b.z}`,
        );
      }
      assert.equal(graph.get(1)!.size, partWidth);
      const low = posed.bricks.filter(
        (b) => b.id === 1 || !graph.get(1)!.has(b.id),
      );
      assert.equal(
        validateAssembly({ ...posed, bricks: low }).unsupported,
        partWidth * (partDepth - 1),
      );
    }
});

function roof(stairs = false, grade = 0.5): TriangleMesh {
  const positions: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) =>
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  // Twenty-stud source surface; real horizontal stair treads must not qualify.
  for (let z = 0; z < 20; z++) {
    const y = 4 + z * grade,
      high = stairs ? y : y + grade;
    quad([0, y, z], [0, high, z + 1], [20, high, z + 1], [20, y, z]);
    if (stairs)
      quad(
        [0, y, z + 1],
        [0, y + grade, z + 1],
        [20, y + grade, z + 1],
        [20, y, z + 1],
      );
  }
  quad([0, 0, 0], [20, 0, 0], [20, 0, 20], [0, 0, 20]);
  quad([0, 0, 0], [0, 4, 0], [20, 4, 0], [20, 0, 0]);
  quad(
    [0, 0, 20],
    [20, 0, 20],
    [20, 4 + 20 * grade, 20],
    [0, 4 + 20 * grade, 20],
  );
  quad([0, 0, 0], [0, 0, 20], [0, 4 + 20 * grade, 20], [0, 4, 0]);
  quad([20, 0, 0], [20, 4, 0], [20, 4 + 20 * grade, 20], [20, 0, 20]);
  return {
    name: 'oblique source',
    positions: Float32Array.from(positions),
    colors: Uint8Array.from(
      Array(positions.length / 9)
        .fill([215, 186, 140])
        .flat(),
    ),
  };
}
void test('source roof replaces voxel terraces with catalog slopes and preserves connections, orientation and inventory', () => {
  const mesh = roof(),
    volume = buildMeshVolume(mesh, 20),
    cells = new Map(volume.cells);
  const result = designSlopes(
    volume.slopeSamples,
    cells,
    volume.w + 2,
    volume.d + 2,
    () => false,
  );
  assert.ok(result.bricks.length > 20);
  const slopes = result.bricks.map((b, i) => ({ ...b, id: i + 1 }));
  const graph = gridConnections(slopes);
  assert.ok(
    [...graph.values()].some((links) => links.size > 0),
    'a continuous roof must use the high-row studs to join successive slopes',
  );
  // Check actual transformed catalog sockets and studs, independently of the
  // source fitting and region grouping, including the three-stud shallow parts.
  const posedSlopes = instructionModel(model(slopes)).bricks;
  for (const a of posedSlopes)
    for (const id of graph.get(a.id)!) {
      const b = posedSlopes.find((b) => b.id === id)!;
      const portsA = connectors(a),
        portsB = connectors(b);
      const mates = (
        studs: typeof portsA.studs,
        sockets: typeof portsA.sockets,
      ) =>
        studs.some((s) =>
          sockets.some((p) =>
            s.point.every((n, k) => Math.abs(n - p.point[k]) < 1e-5),
          ),
        );
      assert.ok(
        mates(portsA.studs, portsB.sockets) ||
          mates(portsB.studs, portsA.sockets),
      );
    }
  assert.ok(
    result.design.replacements.every(
      (r) => r.rmsStuds + 0.04 < r.voxelRmsStuds && r.maxErrorStuds <= 0.5,
    ),
  );
  const raw = finishModel(
    cells,
    volume.w + 2,
    volume.h + 2,
    volume.d + 2,
    'image',
    'roof',
    20,
    7,
    undefined,
    result.bricks,
    'connector-graph',
  );
  const m = groupImageAssembly(raw),
    v = validateAssembly(m);
  assert.equal(v.invalidParts + v.collisions + v.unsupported, 0);
  assert.ok(v.connected);
  assert.equal(
    inventory(m.bricks).reduce((n, p) => n + p.quantity, 0),
    m.bricks.length,
  );
  assert.ok(
    /3298\.dat/.test(toLDraw(m)),
    'shallow roof exports real 33-degree slopes',
  );
  assert.doesNotMatch(manualHTML(m), /undefined/);
  const s = m.bricks.find((b) => b.part === '3298')!;
  assert.match(installationText(m, s), /按紧/);
  const full = meshToDesign(mesh, 20);
  assert.equal(full.slopeDesign!.replacements.length, result.bricks.length);
  assert.equal(
    validateAssembly(full).unsupported,
    0,
    'surface tiling must retain slope foundations',
  );
});
void test('stair treads, declared openings and material boundaries do not get converted to slopes', () => {
  const stair = roof(true),
    v = buildMeshVolume(stair, 20);
  assert.equal(
    designSlopes(
      slopeSurface(stair, 20),
      new Map(v.cells),
      v.w + 2,
      v.d + 2,
      () => false,
    ).bricks.length,
    0,
  );
  const mesh = roof(),
    volume = buildMeshVolume(mesh, 20);
  assert.equal(
    designSlopes(
      volume.slopeSamples,
      new Map(volume.cells),
      volume.w + 2,
      volume.d + 2,
      () => true,
    ).bricks.length,
    0,
  );
  const cells = new Map(volume.cells);
  for (const [key, cell] of cells)
    if (Number(key.split(',')[0]) % 2 === 0)
      cells.set(key, { ...cell, color: 2 });
  const colored = designSlopes(
    volume.slopeSamples,
    cells,
    volume.w + 2,
    volume.d + 2,
    () => false,
  );
  assert.ok(
    colored.bricks.every((b) => b.w === 1 && b.x % 2 === 1 && b.color === 7),
  );
  for (const key of volume.cells.keys())
    if (Number(key.split(',')[0]) % 2 === 0)
      assert.equal(cells.get(key)?.color, 2);
});

void test('the replacement profile matches vendored catalog triangles, including the flat high row', async () => {
  const { readFileSync } = await import('node:fs');
  const { slopeTop } = await import('./slope-design.ts');
  const geometry = JSON.parse(
    readFileSync(
      new URL('../public/parts/geometry.json', import.meta.url),
      'utf8',
    ),
  );
  for (const id of ['3039', '3040b', '3298', '4286']) {
    const catalog = ASSEMBLY_PARTS[id];
    const shape = brickFaces({
      id: 1,
      part: id,
      x: 0,
      y: 0,
      z: 0,
      w: catalog.w,
      d: catalog.d,
      h: 3,
      color: 7,
      pose: { position: [0, 0, 0], matrix: IDENTITY },
    });
    assert.ok(
      shape.some(
        (f) =>
          f.points.length === 4 &&
          f.points.every((p) => p[1] === 0) &&
          Math.min(...f.points.map((p) => p[2])) === -10 &&
          Math.max(...f.points.map((p) => p[2])) === 10,
      ),
    );
    const p: number[] = geometry[id].positions,
      w = catalog.w;
    for (let x = 0.25; x < w; x += 0.5)
      for (let z = 0.25; z < catalog.d; z += 0.5) {
        const xx = (x - w / 2) * 20,
          zz = catalog.centerZ! - catalog.d * 10 + z * 20;
        let top = Infinity;
        for (let i = 0; i < p.length; i += 9) {
          const a = p.slice(i, i + 3),
            b = p.slice(i + 3, i + 6),
            c = p.slice(i + 6, i + 9);
          const den =
            (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
          if (Math.abs(den) < 1e-9) continue;
          const u =
            ((b[2] - c[2]) * (xx - c[0]) + (c[0] - b[0]) * (zz - c[2])) / den;
          const v =
            ((c[2] - a[2]) * (xx - c[0]) + (a[0] - c[0]) * (zz - c[2])) / den;
          if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
            top = Math.min(top, u * a[1] + v * b[1] + (1 - u - v) * c[1]);
        }
        assert.ok(
          Math.abs((24 - top) / 20 - slopeTop(z, catalog.d - 1)) < 1e-5,
          `${id} at ${x},${z}`,
        );
      }
  }
});
