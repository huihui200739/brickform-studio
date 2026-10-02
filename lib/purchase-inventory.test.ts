import test from 'node:test';
import assert from 'node:assert/strict';
import { componentBricks } from './component-parts.ts';
import { type Brick } from './brick-engine.ts';
import {
  purchaseInventory,
  purchaseInventoryCSV,
  procurementReport,
  PURCHASE_CATALOG_CHECKED_AT,
} from './purchase-inventory.ts';

const fixture = (part: string, color = 11, id = 1): Brick => ({
  id,
  part,
  color,
  x: 0,
  y: 0,
  z: 0,
  w: 1,
  d: 1,
  h: 1,
});
const statue = (section = 'component-statue-1') =>
  componentBricks('statue').map((b) => ({ ...b, section }));
const trace = (bricks: readonly Brick[]) =>
  purchaseInventory(bricks)
    .flatMap((line) => line.brickIds)
    .sort((a, b) => a - b);
const sourceIds = (bricks: readonly Brick[]) =>
  bricks.map((b) => b.id).sort((a, b) => a - b);

void test('actual statue has traced same-color torso and leg purchase units without changing geometry', () => {
  const bricks = statue();
  const before = JSON.stringify(bricks);
  const report = procurementReport({ bricks });
  const legs = report.lines.find((line) => line.part === '970c00')!;
  const torso = report.lines.find((line) => line.part === '973c000')!;
  assert.equal(legs.status, 'catalog-confirmed');
  assert.equal(torso.status, 'catalog-confirmed');
  assert.equal(legs.bricklinkColor, 86);
  assert.equal(torso.bricklinkColor, 86);
  assert.deepEqual(legs.ldrawParts, ['3815b', '3816c', '3817c']);
  assert.deepEqual(torso.ldrawParts, ['3818', '3819', '3820', '973']);
  assert.equal(legs.brickIds.length, 3);
  assert.equal(torso.brickIds.length, 5);
  assert.equal(report.assembledQuantity, 2);
  assert.equal(report.assemblyStepsRequireReview, true);
  assert.equal(report.purchaseQuantity, bricks.length - 6);
  assert.equal(report.sourceBrickCount, bricks.length);
  assert.deepEqual(trace(bricks), sourceIds(bricks));
  assert.equal(JSON.stringify(bricks), before);
  for (const line of [legs, torso]) {
    assert.equal(line.checkedAt, PURCHASE_CATALOG_CHECKED_AT);
    assert.equal(
      line.sourceUrl,
      `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${line.part}`,
    );
    assert.equal(line.quantity, 1);
    assert.equal(line.assembled, true);
    assert.match(line.reason, /需核对安装步骤和总成姿态/);
  }
  assert.equal(report.stockChecked, false);
  assert.equal(report.requiresReview, true);
});

void test('purchase quantity aggregates complete instances while retaining every source ID', () => {
  const first = statue();
  const second = statue('component-statue-2').map((b) => ({
    ...b,
    id: b.id + 100,
  }));
  const bricks = [...first, ...second];
  const lines = purchaseInventory(bricks);
  assert.equal(lines.find((line) => line.part === '970c00')?.quantity, 2);
  assert.equal(lines.find((line) => line.part === '973c000')?.quantity, 2);
  assert.deepEqual(trace(bricks), sourceIds(bricks));
});

void test('catalog-confirmed assembly colors still require review of assembly poses and split steps', () => {
  const members = statue().filter((b) =>
    ['973', '3818', '3819', '3820'].includes(b.part),
  );
  const moved = members.map((b) => ({
    ...b,
    pose: b.pose
      ? {
          ...b.pose,
          position: [1000 + b.id, 0, 0] as [number, number, number],
        }
      : undefined,
  }));
  const report = procurementReport(moved);
  assert.equal(report.catalogConfirmed, 1);
  assert.equal(report.assembledQuantity, 1);
  assert.equal(report.assemblyStepsRequireReview, true);
  assert.equal(report.requiresReview, true);
  assert.equal(report.stockChecked, false);
});

void test('incomplete and mixed-color torso families remain separate purchase lines', () => {
  const incomplete = statue().filter((b) => b.part !== '3818');
  const mixed = statue().map((b) =>
    b.part === '3818' ? { ...b, color: 1 } : b,
  );
  for (const bricks of [incomplete, mixed]) {
    const lines = purchaseInventory(bricks);
    assert.ok(!lines.some((line) => line.part === '973c000'));
    assert.ok(lines.some((line) => line.part === '970c00'));
    assert.equal(
      lines.find((line) => line.part === '3819')?.status,
      'unverified',
    );
    assert.deepEqual(trace(bricks), sourceIds(bricks));
  }
});

void test('incomplete and mixed-color leg families are not bought as a complete leg unit', () => {
  const incomplete = statue().filter((b) => b.part !== '3816c');
  const mixed = statue().map((b) =>
    b.part === '3816c' ? { ...b, color: 1 } : b,
  );
  for (const bricks of [incomplete, mixed]) {
    const lines = purchaseInventory(bricks);
    assert.ok(!lines.some((line) => line.part === '970c00'));
    assert.ok(lines.some((line) => line.part === '973c000'));
    assert.deepEqual(trace(bricks), sourceIds(bricks));
  }
});

void test('missing or different component sections cannot combine figure members', () => {
  const missing = componentBricks('statue');
  const otherSection = statue('body');
  const divided = statue().map((b) =>
    b.part === '3820' ? { ...b, section: 'component-other' } : b,
  );
  for (const bricks of [missing, otherSection]) {
    assert.ok(!purchaseInventory(bricks).some((line) => line.assembled));
    assert.deepEqual(trace(bricks), sourceIds(bricks));
  }
  assert.ok(
    !purchaseInventory(divided).some((line) => line.part === '973c000'),
  );
  assert.deepEqual(trace(divided), sourceIds(divided));
  const unknownColors = statue().map((b) => ({ ...b, color: 999 }));
  assert.ok(!purchaseInventory(unknownColors).some((line) => line.assembled));
});

void test('extra members and duplicate source IDs prevent ambiguous assembly aggregation', () => {
  const bricks = statue();
  const extraArm = [
    ...bricks,
    { ...bricks.find((b) => b.part === '3819')!, id: 100 },
  ];
  const extraLeg = [
    ...bricks,
    { ...bricks.find((b) => b.part === '3816c')!, id: 101 },
  ];
  const duplicateId = [
    ...bricks,
    fixture('3005', 11, bricks.find((b) => b.part === '3818')!.id),
  ];
  for (const [modified, id] of [
    [extraArm, '973c000'],
    [extraLeg, '970c00'],
    [duplicateId, '973c000'],
  ] as const) {
    assert.ok(!purchaseInventory(modified).some((line) => line.part === id));
    assert.deepEqual(trace(modified), sourceIds(modified));
  }
});

void test('vendored BrickLink aliases do not falsely confirm their color combinations', () => {
  const aliases = {
    '3068b': '3068',
    '3069b': '3069',
    '3070b': '3070',
    '3040b': '3040',
    '3062b': '3062',
    '3815b': '970',
    '3816c': '971',
    '3817c': '972',
    '3818': '982',
    '3819': '981',
    '3820': '983',
    '3626c': '3626',
  };
  for (const [part, bricklinkId] of Object.entries(aliases)) {
    const [line] = purchaseInventory([fixture(part)]);
    assert.equal(line.bricklinkId, bricklinkId);
    assert.equal(line.part, part);
    assert.equal(line.status, 'unverified');
    assert.equal(line.mappingSource?.kind, 'vendored-ldraw-header');
    assert.equal(
      line.mappingSource?.url,
      `https://library.ldraw.org/library/official/parts/${part}.dat`,
    );
  }
});

void test('unreviewed catalog parts, unknown IDs and invalid colors stay explicitly unverified', () => {
  for (const brick of [
    fixture('15068'),
    fixture('unknown-part'),
    fixture('constructor'),
    fixture('__proto__'),
    fixture('toString'),
    fixture('3001', 999),
    fixture('3001', NaN),
  ]) {
    const [line] = purchaseInventory([brick]);
    assert.equal(line.status, 'unverified');
    assert.ok(line.reason.length > 0);
  }
  for (const part of ['constructor', '__proto__', 'toString']) {
    const [line] = purchaseInventory([fixture(part)]);
    assert.equal(line.bricklinkId, undefined);
    assert.equal(line.catalogUrl, undefined);
    assert.equal(line.name, part);
  }
  const [unknown] = purchaseInventory([fixture('unknown-part')]);
  assert.equal(unknown.bricklinkId, undefined);
  assert.equal(unknown.catalogUrl, undefined);
  const [uncheckedColor] = purchaseInventory([fixture('3010', 10)]);
  assert.equal(uncheckedColor.bricklinkId, '3010');
  assert.equal(uncheckedColor.status, 'unverified');
  assert.equal(uncheckedColor.bricklinkColor, 120);
});

void test('legacy unsupported flame and spear colors remain flagged without silently recoloring imported geometry', () => {
  const legacy = [fixture('6126b', 6, 1), fixture('4497', 11, 2)];
  const before = JSON.stringify(legacy);
  const lines = purchaseInventory(legacy);
  const flame = lines.find((line) => line.part === '6126b')!;
  const spear = lines.find((line) => line.part === '4497')!;
  for (const line of [flame, spear]) {
    assert.equal(line.status, 'unsupported-color');
    assert.equal(line.checkedAt, PURCHASE_CATALOG_CHECKED_AT);
    assert.match(line.reason, /Known Colors 未收录/);
    assert.match(line.reason, /不代表不存在或缺货/);
    assert.equal(line.colorSource?.kind, 'bricklink-catalog');
    assert.deepEqual(line.colorChoices, []);
  }
  assert.equal(flame.bricklinkColor, 4);
  assert.equal(spear.bricklinkColor, 86);
  assert.equal(JSON.stringify(legacy), before);
});

void test('generated flame and spear use checked catalog colors and retain requested-color provenance', () => {
  const flame = purchaseInventory(componentBricks('brazier')).find(
    (line) => line.part === '6126b',
  )!;
  const spear = purchaseInventory(statue()).find(
    (line) => line.part === '4497',
  )!;
  for (const line of [flame, spear]) {
    assert.equal(line.status, 'catalog-confirmed');
    assert.equal(line.checkedAt, PURCHASE_CATALOG_CHECKED_AT);
    assert.match(line.reason, /库存尚未查询/);
    assert.equal(line.colorSource?.kind, 'bricklink-catalog');
  }
  assert.equal(flame.color, 14);
  assert.equal(flame.bricklinkColor, 98);
  assert.equal(spear.color, 1);
  assert.equal(spear.bricklinkColor, 11);
  assert.equal(flame.colorChoices[0].requestedColor, 6);
  assert.equal(flame.colorChoices[0].selectedColor, 14);
  assert.equal(spear.colorChoices[0].requestedColor, 11);
  assert.equal(spear.colorChoices[0].selectedColor, 1);
  for (const line of [flame, spear]) {
    assert.deepEqual(
      line.colorChoices.map((c) => c.brickId),
      line.brickIds,
    );
    assert.equal(line.colorChoices[0].source.url, line.colorSource!.url);
  }
  assert.equal(procurementReport(statue()).unsupportedColors, 0);
  const [blackSpear] = purchaseInventory([fixture('4497', 1)]);
  assert.equal(blackSpear.status, 'catalog-confirmed');
});

void test('CSV includes assembled purchase units, status and evidence while quoting arbitrary names', () => {
  const csv = purchaseInventoryCSV(statue());
  assert.ok(csv.startsWith('\uFEFF"LDraw编号"'));
  assert.match(csv, /"973c000"/);
  assert.match(csv, /"970c00"/);
  assert.match(csv, /"catalog-confirmed"/);
  assert.match(csv, /生成时颜色替代/);
  assert.match(csv, /浅灰色 → 黑色/);
  assert.match(csv, /2026-10-02/);
  assert.match(csv, /bricklink\.com/);
  const quoted = purchaseInventoryCSV([fixture('unknown,"part')]);
  assert.ok(quoted.includes('"unknown,""part"'));
});

void test('aggregated selected-color lines retain each request and source ID', () => {
  const changed = componentBricks('brazier').at(-1)!;
  const unchanged = { ...changed, id: 100, colorChoice: undefined };
  const changedAgain = { ...changed, id: 101 };
  const [line] = purchaseInventory([changed, unchanged, changedAgain]);
  assert.equal(line.quantity, 3);
  assert.deepEqual(line.brickIds, [changed.id, 100, 101]);
  assert.deepEqual(
    line.colorChoices.map((c) => c.brickId),
    [changed.id, 101],
  );
  assert.equal(
    line.colorChoices.every(
      (c) => c.requestedColor === 6 && c.selectedColor === 14,
    ),
    true,
  );
});

void test('empty procurement report has no required review and no stock claim', () => {
  const report = procurementReport([]);
  assert.equal(report.purchaseQuantity, 0);
  assert.equal(report.sourceBrickCount, 0);
  assert.equal(report.requiresReview, false);
  assert.equal(report.assemblyStepsRequireReview, false);
  assert.equal(report.stockChecked, false);
  assert.deepEqual(report.lines, []);
});
