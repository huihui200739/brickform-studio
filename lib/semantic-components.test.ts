import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import {
  componentBricks,
  positionedComponent,
  regionPlacement,
  validateRegions,
  type ComponentKind,
  type ComponentRegion,
  COMPONENT_SIZES,
} from './semantic-components.ts';
import { validateAssembly } from './assembly-validation.ts';
import { meshToDesign, meshToDesignAuto } from './mesh-design.ts';
import { inventory, toLDraw, type Model } from './brick-engine.ts';
import { installationText, detailDiagram } from './build-instructions.ts';
import { brickFaces } from './assembly-diagram.ts';
const kinds: ComponentKind[] = ['tree', 'brazier', 'statue'];
function fixture() {
  const pos: number[] = [],
    colors: number[] = [];
  for (const [x, y, z, w, h, d] of [
    [0, 0, 0, 20, 0.8, 20],
    [7, 0.8, 7, 4, 8, 4],
  ]) {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    pos.push(...g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count / 3; i++)
      colors.push(215, 186, 140);
    g.dispose();
  }
  return {
    positions: new Float32Array(pos),
    colors: new Uint8Array(colors),
    name: '替换测试',
  };
}
function region(kind: ComponentKind): ComponentRegion {
  return {
    id: kind,
    kind,
    anchor: [0.45, 0.8 / 8.8, 0.45],
    ...COMPONENT_SIZES[kind],
    width: 10,
    depth: 10,
    height: 30,
    rotation: 0,
  };
}
for (const kind of kinds)
  void test(`${kind}: replace the entire old volume, keep fixed part shapes, BOM and steps aligned`, () => {
    const mesh = fixture(),
      r = region(kind),
      m = meshToDesign(mesh, 20, [r]);
    const check = validateAssembly(m);
    assert.equal(check.connected, true);
    assert.equal(check.unsupported, 0);
    assert.equal(check.collisions, 0);
    assert.ok(m.semanticDesign!.removedCells > 0);
    assert.equal(m.semanticDesign!.reviewRequired, true);
    const box = regionPlacement(r, [20, 22, 20]);
    assert.ok(
      !m.bricks.some(
        (b) =>
          !b.section?.startsWith('component-') &&
          b.x < box.max[0] &&
          b.x + b.w > box.min[0] &&
          b.y < box.max[1] &&
          b.y + b.h > box.min[1] &&
          b.z < box.max[2] &&
          b.z + b.d > box.min[2],
      ),
    );
    const specials = m.bricks.filter((b) =>
      b.section?.startsWith('component-'),
    );
    assert.equal(specials.length, componentBricks(kind).length);
    assert.equal(
      inventory(m.bricks).reduce((sum, p) => sum + p.quantity, 0),
      m.bricks.length,
    );
    assert.equal(
      toLDraw(m)
        .split('\n')
        .filter((l) => l.startsWith('1 ')).length,
      m.bricks.length,
    );
    for (const b of specials) {
      assert.ok(installationText(m, b).length > 10);
      assert.ok(brickFaces(b).length > 0);
      assert.ok(toLDraw(m).includes(`${b.part}.dat`));
      if (b.part === '3846')
        assert.ok(
          !detailDiagram(m, b.step!, 0).includes('data-placement-arrow'),
        );
    }
    // Displacing a single accessory must break the joint graph, never silently pass.
    const last = m.bricks.at(-1)!;
    last.pose!.position[0] += 3;
    assert.ok(validateAssembly(m).unsupported > 0);
  });
void test('four orientations keep catalog geometry rigid and preserve connector matches', () => {
  for (const kind of kinds)
    for (let q = 0; q < 4; q++) {
      const bricks = positionedComponent(kind, [0, 0, 0], q, {
        width: 14,
        depth: 14,
      }).map((b, i) => ({ ...b, step: i, section: 'component-test' }));
      const m = {
        bricks,
        semanticDesign: { reviewRequired: true },
        width: 14,
        depth: 14,
      } as Model;
      assert.equal(validateAssembly(m).connected, true);
      assert.equal(validateAssembly(m).unsupported, 0);
      for (const b of bricks) {
        const a = b.pose!.matrix;
        const det =
          a[0] * (a[4] * a[8] - a[5] * a[7]) -
          a[1] * (a[3] * a[8] - a[5] * a[6]) +
          a[2] * (a[3] * a[7] - a[4] * a[6]);
        assert.ok(Math.abs(det - 1) < 1e-8);
      }
    }
});
void test('invalid and overlapping replacement boxes fail before changing geometry', () => {
  assert.throws(
    () =>
      validateRegions(
        [region('tree'), { ...region('brazier'), id: 'other' }],
        [20, 22, 20],
      ),
    /重叠/,
  );
  assert.throws(
    () => validateRegions([{ ...region('tree'), height: NaN }], [20, 22, 20]),
    /无效/,
  );
  assert.throws(
    () =>
      validateRegions(
        [{ ...region('tree'), anchor: [-1, 0, 0] }],
        [20, 22, 20],
      ),
    /无效/,
  );
});
void test('an unplaced component cannot silently appear at the default origin', () => {
  assert.throws(
    () => validateRegions([{ ...region('tree'), placed: false }], [20, 22, 20]),
    /定位/,
  );
});
void test('removing a statue preserves a real full-width bridge above the opening', () => {
  const positions: number[] = [],
    colors: number[] = [];
  for (const [x, y, z, w, h, d] of [
    [0, 0, 0, 20, 0.8, 20],
    [5, 0.8, 7, 2, 10.4, 6],
    [13, 0.8, 7, 2, 10.4, 6],
    [5, 11.2, 7, 10, 0.8, 6],
    [9, 0.8, 9, 2, 10.4, 2],
  ]) {
    const g = new BoxGeometry(w, h, d).toNonIndexed();
    g.translate(x + w / 2, y + h / 2, z + d / 2);
    positions.push(...g.attributes.position.array);
    for (let i = 0; i < g.attributes.position.count / 3; i++)
      colors.push(215, 186, 140);
    g.dispose();
  }
  const m = meshToDesign(
    {
      positions: new Float32Array(positions),
      colors: new Uint8Array(colors),
      name: 'portal',
    },
    20,
    [
      {
        id: 'portal',
        kind: 'statue',
        anchor: [0.5, 0.8 / 12, 0.5],
        width: 6,
        depth: 6,
        height: 26,
        rotation: 2,
      },
    ],
  );
  const bridges = m.bricks.filter(
    (b) => b.part === '3034' && b.installation?.includes('横跨'),
  );
  assert.ok(bridges.length > 0);
  assert.ok(bridges.every((b) => b.w === 8 && b.d === 2 && b.h === 1));
  assert.equal(validateAssembly(m).connected, true);
});

for (const kind of ['tree', 'brazier'] as const) {
  void test(`${kind}: reliable automatic proposal commits bricks, BOM and instructions without a user confirmation`, () => {
    const mesh=fixture();
    const input={...region(kind),source:'color' as const,autoRefinement:true,confirmed:false,replacementConfidence:0.9};
    const result=meshToDesignAuto(mesh,28,[input]);
    assert.equal(result.applied.length,1);
    assert.equal(result.applied[0].confirmed,true);
    assert.equal(result.applied[0].autoConfirmed,true);
    assert.equal(result.applied[0].source,'color');
    assert.equal(result.reports[0].status,'auto-applied');
    const section=`component-${input.id}`;
    const parts=result.model.bricks.filter((b)=>b.section===section);
    assert.equal(parts.length,componentBricks(kind).length);
    assert.ok(result.model.assembly!.sections.some((s)=>s.id===section));
    assert.equal(result.model.assembly!.steps.filter((s)=>s.section===section).length,parts.length);
    for(const b of parts) {
      assert.ok(inventory(result.model.bricks).some((p)=>p.part===b.part&&p.color===b.color));
      assert.ok(toLDraw(result.model).includes(`${b.part}.dat`));
    }
    assert.equal(input.confirmed,false);
    const baseline=meshToDesign(mesh,28);
    const low=meshToDesignAuto(mesh,28,[{...input,replacementConfidence:0.4}]);
    assert.equal(low.reports[0].status,'preserved');
    assert.deepEqual(low.model.bricks,baseline.bricks);
    const failed=meshToDesignAuto(mesh,28,[{...input,width:100}]);
    assert.ok(failed.attempts>0);
    assert.equal(failed.applied.length,0);
    assert.equal(failed.reports[0].status,'preserved');
    assert.deepEqual(failed.model.bricks,baseline.bricks);
  });
}
