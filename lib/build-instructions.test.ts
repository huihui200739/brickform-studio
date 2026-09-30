import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { roundedDuck } from './rounded-duck.ts';
import { designDuck } from './duck-designer.ts';
import {
  partThumbnail,
  placementContext,
  stageBricks,
  gridAddress,
  detailDiagram,
  topDiagram,
  installationText,
  cleanStageName,
  connectedBelow,
  connectionInstruction,
} from './build-instructions.ts';
import { manualHTML } from './manual.ts';
import { positionedComponent } from './semantic-components.ts';
import type { Model } from './brick-engine.ts';

void test('flame instructions identify the earlier hollow stud by its bar connection', () => {
  const bricks = positionedComponent('brazier', [0, 0, 0], 0, { width: 12, depth: 12 })
    .map((b, step) => ({ ...b, id: step + 1, step, section: 'component-flame' }));
  const m: Model = { name: 'flame-guide', source: 'image', shape: 'sculpture', resolution: 20,
    width: 12, depth: 12, height: 16, bricks, supportCount: 0,
    levels: bricks.map(b => b.step), assembly: { sections: [],
      parameters: { bodyLength: 0, headWidth: 0, bodyColor: 7, beakColor: 2 },
      reference: '', steps: bricks.map(b => ({ name: b.part, description: '', section: b.section })),
    },
  };
  const flame = bricks.at(-1)!, holder = bricks.at(-2)!;
  assert.deepEqual(connectedBelow(m, flame).map(b => b.id), [holder.id]);
  assert.match(connectionInstruction(m, flame), new RegExp(`#${holder.id}`));
  assert.equal((detailDiagram(m, flame.step, 0).match(/data-connection-ring=/g) || []).length, 1);
  const html = manualHTML(m, { start: flame.step, end: flame.step + 1 });
  assert.match(html, /class="local-position"/);
  assert.match(html, /安装底面高度/);
  assert.ok(html.includes(connectionInstruction(m, flame)));
});

void test('one-piece instructions never reveal future placements, including same-group dependencies', () => {
  const m = roundedDuck();
  for (let stage = 0; stage < m.levels.length; stage++) {
    const batch = stageBricks(m, stage);
    for (let i = 0; i < batch.length; i++) {
      const c = placementContext(m, stage, i);
      assert.equal(c.active.id, batch[i].id);
      assert.deepEqual(
        c.visible.filter((b) => b.step === stage).map((b) => b.id),
        batch.slice(0, i + 1).map((b) => b.id),
      );
      assert.ok(c.visible.every((b) => b.step! <= stage));
    }
  }
});
void test('locations use a stable stud grid and side mounting is explained without a downward instruction', () => {
  const m = designDuck(),
    b = m.bricks.find((b) => b.y === 0)!;
  assert.match(gridAddress(m, b), /^[A-Z]+\d+$/);
  const address = gridAddress(m, { ...b, z: b.z + 1 });
  assert.equal(
    Number(address.match(/\d+/)![0]),
    Number(gridAddress(m, b).match(/\d+/)![0]) + 1,
  );
  const eye = m.bricks.find((b) => b.part === '98138')!;
  assert.equal(gridAddress(m, eye), '侧面连接点');
  assert.match(installationText(m, eye), /不用向下压/);
  assert.equal(cleanStageName('第 2 步 · 腹部与尾部'), '腹部与尾部');
  assert.ok(!detailDiagram(m, eye.step!, 0).includes('NaN'));
  assert.match(topDiagram(m, 1, 0), /前方（鸭嘴）/);
});
void test('print guide has an offline positioning map for every group and at most four placements per page', () => {
  const m = designDuck();
  m.name = '<script>test</script>';
  const html = manualHTML(m);
  assert.ok(!html.includes('<script>test'));
  assert.equal(
    html.split('class="diagram group-map"').length - 1,
    m.levels.length,
  );
  for (const b of m.bricks)
    assert.equal(html.split(`<td>#${b.id} · `).length - 1, 1);
  for (const page of html
    .split('<section class="page instruction-page">')
    .slice(1)) {
    const count =
      page.split('</section>')[0].split('class="instruction-card"').length - 1;
    assert.ok(count >= 1 && count <= 4);
  }
  assert.ok(html.length < 12_000_000);
});

void test('a 2 by 4 plate shows eight raised studs and a downward placement arrow', () => {
  const m = roundedDuck(),
    b = m.bricks.find((b) => b.part === '3020')!;
  const thumb = partThumbnail(b);
  assert.equal((thumb.match(/data-stud-top=/g) || []).length, 8);
  const stage = b.step!,
    index = stageBricks(m, stage).findIndex((p) => p.id === b.id);
  const svg = detailDiagram(m, stage, index);
  const arrow = svg.match(
    /data-placement-arrow="true"><path d="M ([\d.-]+) ([\d.-]+) L ([\d.-]+) ([\d.-]+)/,
  )!;
  assert.ok(arrow);
  assert.equal(Number(arrow[1]), Number(arrow[3]));
  assert.ok(Number(arrow[4]) > Number(arrow[2]));
  assert.ok(
    !detailDiagram(m, stage, index, true).includes('data-placement-arrow'),
  );
});
void test('side placement marks real connection points and local maps keep global addresses', () => {
  const m = roundedDuck();
  // Find a front-facing mounted panel independently of assembly order.
  const panel = m.bricks
    .filter((b) => b.part === '88930' && b.section === 'body')
    .at(-1)!;
  const stage = panel.step!,
    i = stageBricks(m, stage).findIndex((p) => p.id === panel.id);
  const svg = detailDiagram(m, stage, i);
  assert.equal((svg.match(/data-connection-ring=/g) || []).length, 4);
  assert.ok(!svg.includes('NaN'));
  // Both complete wing shells must locate all four real side studs, rather
  // than reusing the two-stud instructions for the old split wings.
  for (const wing of m.bricks.filter((b) => b.section === 'wings')) {
    const wi = stageBricks(m, wing.step!).findIndex((b) => b.id === wing.id),
      diagram = detailDiagram(m, wing.step!, wi);
    assert.equal((diagram.match(/data-connection-ring=/g) || []).length, 4);
    assert.ok(!diagram.includes('NaN'));
  }
  const first = m.bricks[0],
    local = topDiagram(m, first.step!, 0, false, true);
  const address = gridAddress(m, first),
    [letter, row] = [address.match(/[A-Z]+/)![0], address.match(/\d+/)![0]];
  assert.ok(local.includes(`>${letter}</text>`));
  assert.ok(local.includes(`>${row}</text>`));
});
