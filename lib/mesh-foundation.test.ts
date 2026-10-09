import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { buildMeshVolume, meshToDesign } from './mesh-design.ts';
import {
  finishModel,
  inventory,
  validateModel,
  type Model,
} from './brick-engine.ts';
import { validateAssembly } from './assembly-validation.ts';
import type { TriangleMesh } from './mesh-types.ts';

function rectangularMesh(): TriangleMesh {
  // The native browser failure had a 20x15 voxel footprint: its generated
  // 22x17 foundation ended in a one-stud row of independently stacked strips.
  // This generic prism reproduces that packing defect without a duck template,
  // native inference, external files, or altered reference-color algorithms.
  const geometry = new BoxGeometry(20, 8, 15).toNonIndexed();
  const positions = new Float32Array(geometry.attributes.position.array);
  const colors = new Uint8Array(positions.length / 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([242, 205, 55], i);
  geometry.dispose();
  return { positions, colors, name: '错缝基础回归' };
}

function occupied(model: Model) {
  const cells = new Map<string, number>();
  for (const brick of model.bricks)
    for (let x = brick.x; x < brick.x + brick.w; x++)
      for (let y = brick.y; y < brick.y + brick.h; y++)
        for (let z = brick.z; z < brick.z + brick.d; z++) {
          const key = `${x},${y},${z}`;
          assert.equal(cells.has(key), false, `no overlapping cell ${key}`);
          cells.set(key, brick.color);
        }
  return cells;
}

for (const resolution of [20, 28, 36])
  void test(`odd-depth foundation is physically connected at ${resolution} without changing source volume or colors`, () => {
    const mesh = rectangularMesh();
    const positions = mesh.positions.slice();
    const colors = mesh.colors.slice();
    const volume = buildMeshVolume(mesh, resolution);
    const original = finishModel(
      new Map([...volume.cells].map(([key, value]) => [key, { ...value }])),
      volume.w + 2,
      volume.h + 2,
      volume.d + 2,
      'image',
      mesh.name,
      resolution,
      volume.dominant,
      undefined,
      [],
      'connector-graph',
    );
    const before = validateModel(original);
    assert.equal(
      before.connected,
      false,
      'fixture reproduces isolated far-edge base strips',
    );
    assert.equal(
      before.collisions + before.unsupported + before.invalidParts,
      0,
    );

    const model = meshToDesign(mesh, resolution);
    const check = validateAssembly(model);
    assert.equal(check.connected, true);
    assert.equal(check.collisions + check.unsupported + check.invalidParts, 0);
    assert.equal(
      model.meshDesign!.resolution,
      resolution,
      'precision is not silently changed',
    );
    assert.match(model.assembly!.reference, /底板第二层使用错缝纵向板/);
    assert.deepEqual(
      occupied(model),
      occupied(original),
      'every occupied cell and its color are unchanged',
    );
    assert.deepEqual(
      mesh.positions,
      positions,
      'source triangles are unchanged',
    );
    assert.deepEqual(mesh.colors, colors, 'source colors are unchanged');
    assert.equal(
      inventory(model.bricks).reduce((sum, line) => sum + line.quantity, 0),
      model.bricks.length,
    );
    assert.equal(
      new Set(model.bricks.map((b) => b.id)).size,
      model.bricks.length,
    );
    assert.ok(model.assembly!.steps.length > 0);
  });
