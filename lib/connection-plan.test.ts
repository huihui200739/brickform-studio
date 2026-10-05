import test from 'node:test';
import assert from 'node:assert/strict';
import type { Brick, Model } from './brick-engine.ts';
import { inventory, validateModel, toLDraw } from './brick-engine.ts';
import { planGridAssembly } from './connection-plan.ts';
import { connectUnsupportedGroups } from './support-design.ts';
import { groupImageAssembly } from './image-design.ts';
import {
  detailDiagram,
  installationText,
  stageBricks,
} from './build-instructions.ts';
import { manualHTML } from './manual.ts';
import { execFileSync } from 'node:child_process';

void test('long connected designs still plan with a restricted browser-like call stack', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--stack-size=128',
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import {planGridAssembly} from ${JSON.stringify(new URL('./connection-plan.ts', import.meta.url).href)};
       const bricks = Array.from({length: 800}, (_, i) => ({id:i+1,x:0,y:i,z:0,w:1,h:1,d:1,part:'3024',color:7}));
       const plan = planGridAssembly(bricks);
       assert.deepEqual(plan.unresolved, []);
       assert.equal(plan.ordered.length, 800);
       for (let i=0;i<800;i++) {
         assert.equal(plan.ordered[i].brick.id, i+1);
         assert.equal(plan.ordered[i].move.direction, 'down');
         assert.deepEqual(plan.ordered[i].move.parentIds, i ? [i] : []);
       }
       console.log('planned');`,
    ],
    { encoding: 'utf8', timeout: 20000 },
  );
  assert.equal(output.trim(), 'planned');
});

const brick = (
  id: number,
  x: number,
  y: number,
  part = '3024',
  w = 1,
  h = 1,
): Brick => ({ id, x, y, z: 0, part, w, h, d: 1, color: 7 });
const model = (bricks: Brick[]): Model => ({
  name: 'hanging-bridge',
  width: 2,
  depth: 1,
  height: 6,
  source: 'image',
  resolution: 28,
  shape: 'sculpture',
  supportCount: 0,
  assemblyStrategy: 'connector-graph',
  bricks,
  levels: [...new Set(bricks.map((b) => b.y))].sort((a, b) => a - b),
});
const cells = (bricks: Brick[]) => {
  const result = new Map<string, { color: number; support: boolean }>();
  for (const b of bricks)
    for (let x = b.x; x < b.x + b.w; x++)
      for (let y = b.y; y < b.y + b.h; y++)
        result.set(`${x},${y},0`, { color: b.color, support: false });
  return result;
};

// Replay actual swept final approaches independently of the planner. Every
// parent must precede the part, and neither end of a chain may trap its middle.
const assertApproaches = (bricks: Brick[]) => {
  const plan = planGridAssembly(bricks),
    occupied = new Set<string>(),
    placed = new Set<number>();
  assert.deepEqual(plan.unresolved, []);
  for (const { brick: b, move } of plan.ordered) {
    assert.ok(move.parentIds.every((id) => placed.has(id)));
    if (b.y > 0) assert.ok(move.parentIds.length > 0);
    const y = move.direction === 'down' ? b.y + b.h : b.y - 1;
    for (let x = b.x; x < b.x + b.w; x++)
      assert.ok(!occupied.has(`${x},${y},0`));
    for (let x = b.x; x < b.x + b.w; x++)
      for (let y = b.y; y < b.y + b.h; y++) occupied.add(`${x},${y},0`);
    placed.add(b.id);
  }
  return plan;
};

void test('a hanging part keeps its negative space, upper parent, upward arrow and inventory', () => {
  const bricks = [
    brick(1, 0, 0, '3023', 2),
    brick(2, 0, 1, '3005', 1, 3),
    brick(3, 0, 4, '3023', 2),
    brick(4, 1, 3),
  ];
  const volume = cells(bricks);
  const repair = connectUnsupportedGroups(volume, bricks, 1, 7);
  assert.equal(repair.groups + repair.addedCells, 0);
  assert.equal(volume.has('1,2,0'), false, 'the bridge void must stay empty');
  assert.equal(validateModel(model(bricks)).unsupported, 0);
  const plan = assertApproaches(bricks);
  assert.equal(
    plan.ordered.find((p) => p.brick.id === 4)!.move.direction,
    'up',
  );
  const m = groupImageAssembly(model(bricks));
  const active = m.bricks.find((b) => b.x === 1 && b.y === 3)!;
  assert.ok(active.assemblyMove!.parentIds.every((id) => id < active.id));
  assert.equal(validateModel(m).unsupported, 0);
  assert.equal(validateModel(m).connected, true);
  assert.match(installationText(m, active), /从下方.*向上/);
  const index = stageBricks(m, active.step!).findIndex(
    (b) => b.id === active.id,
  );
  const svg = detailDiagram(m, active.step!, index);
  const arrow = svg.match(
    /data-placement-arrow="true"><path d="M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/,
  )!;
  assert.ok(arrow);
  assert.ok(Number(arrow[4]) < Number(arrow[2]), 'arrow must point upward');
  const html = manualHTML(m);
  assert.match(html, /从下方.*向上/);
  for (const b of m.bricks)
    assert.equal(html.split(`<td>#${b.id} · `).length - 1, 1);
  assert.equal(
    inventory(m.bricks).reduce((n, p) => n + p.quantity, 0),
    bricks.length,
  );
  assert.equal(
    toLDraw(m)
      .split('\n')
      .filter((s) => s.startsWith('1 ')).length,
    bricks.length,
  );
});

void test('opposing branches do not close around a chain before its middle is installed', () => {
  const bricks = [
    brick(1, 0, 0, '3005', 1, 3),
    brick(2, 1, 0),
    brick(3, 0, 3, '3023', 2),
    brick(4, 1, 1),
    brick(5, 1, 2),
  ];
  assertApproaches(bricks);
  const m = groupImageAssembly(model(bricks));
  assert.equal(validateModel(m).unsupported, 0);
  assert.equal(validateModel(m).connected, true);
});

void test('a smooth tile cannot serve as a stud support and a protected gap cannot be filled', () => {
  const bricks = [brick(1, 0, 0, '3070b'), brick(2, 0, 2)];
  const volume = cells(bricks);
  const repair = connectUnsupportedGroups(volume, bricks, 1, 7);
  assert.equal(repair.groups, 1);
  assert.equal(repair.addedCells, 0);
  assert.equal(volume.has('0,1,0'), false);
  const gap = [brick(1, 0, 0), brick(2, 0, 2)];
  const protectedVolume = cells(gap);
  assert.equal(
    connectUnsupportedGroups(protectedVolume, gap, 1, 7, () => true).addedCells,
    0,
  );
  assert.equal(protectedVolume.has('0,1,0'), false);
  assert.ok(planGridAssembly(bricks).unresolved.length > 0);
  assert.throws(() => groupImageAssembly(model(bricks)), /无法规划/);
});
