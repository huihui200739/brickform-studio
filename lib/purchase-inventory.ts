import { PALETTE, PARTS, type Brick } from './brick-engine.ts';
import type { PartColorSubstitution } from './part-color-policy.ts';

/** A bounded audit snapshot, not a live stock or physical-build check. */
export const PURCHASE_CATALOG_CHECKED_AT = '2026-10-02';
export type PurchaseStatus =
  | 'catalog-confirmed'
  | 'unverified'
  | 'unsupported-color';
export type PurchaseSource = {
  url: string;
  checkedAt: string;
  kind: 'vendored-ldraw-header' | 'bricklink-catalog';
};
type PurchasePart = {
  bricklinkId: string;
  mappingSource: PurchaseSource;
  /** Positive evidence only; absent colors remain unverified. */
  confirmedLegoColors?: readonly number[];
  /** Explicitly reviewed omissions from Known Colors, not stock information. */
  unsupportedLegoColors?: readonly number[];
  colorSource?: PurchaseSource;
};
export type PurchaseLine = {
  part: string;
  name: string;
  color: number;
  quantity: number;
  ldrawParts: string[];
  brickIds: number[];
  assembled: boolean;
  colorChoices: Array<PartColorSubstitution & { brickId: number }>;
  bricklinkId?: string;
  bricklinkColor?: number;
  status: PurchaseStatus;
  reason: string;
  catalogUrl?: string;
  mappingSource?: PurchaseSource;
  colorSource?: PurchaseSource;
  sourceUrl?: string;
  checkedAt?: string;
};
export type ProcurementReport = {
  lines: PurchaseLine[];
  sourceBrickCount: number;
  purchaseQuantity: number;
  catalogConfirmed: number;
  unverified: number;
  unsupportedColors: number;
  assembledQuantity: number;
  assemblyStepsRequireReview: boolean;
  requiresReview: boolean;
  stockChecked: false;
};
const catalogSource = (id: string): PurchaseSource => ({
  url: `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${id}`,
  checkedAt: PURCHASE_CATALOG_CHECKED_AT,
  kind: 'bricklink-catalog',
});
const headerSource = (id: string): PurchaseSource => ({
  url: `https://library.ldraw.org/library/official/parts/${id}.dat`,
  checkedAt: PURCHASE_CATALOG_CHECKED_AT,
  kind: 'vendored-ldraw-header',
});

// These ten direct IDs were checked against the corresponding catalog pages.
// Every listed color is present in Known Colors; this is not a complete catalog.
const CORE_COLORS = [
  1, 26, 21, 24, 23, 28, 106, 5, 138, 192, 308, 194, 199, 151,
];
const PURCHASE_PARTS = Object.create(null) as Record<string, PurchasePart>;
for (const id of [
  '3001',
  '3003',
  '3010',
  '3004',
  '3005',
  '3020',
  '3022',
  '3710',
  '3023',
  '3024',
]) {
  const source = catalogSource(id);
  PURCHASE_PARTS[id] = {
    bricklinkId: id,
    mappingSource: source,
    confirmedLegoColors:
      id === '3010' ? CORE_COLORS.filter((c) => c !== 308) : CORE_COLORS,
    colorSource: source,
  };
}
// The alias evidence is the explicit !KEYWORDS BrickLink entry in each vendored
// .dat header. A valid alias alone does not confirm any part/color combination.
for (const [ldrawId, bricklinkId] of Object.entries({
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
})) {
  PURCHASE_PARTS[ldrawId] = {
    bricklinkId,
    mappingSource: headerSource(ldrawId),
  };
}
PURCHASE_PARTS['6126b'] = {
  bricklinkId: '6126b',
  mappingSource: catalogSource('6126b'),
  confirmedLegoColors: [182],
  unsupportedLegoColors: [106],
  colorSource: catalogSource('6126b'),
};
PURCHASE_PARTS['4497'] = {
  bricklinkId: '4497',
  mappingSource: catalogSource('4497'),
  confirmedLegoColors: [26, 28, 192, 308],
  unsupportedLegoColors: [194],
  colorSource: catalogSource('4497'),
};
for (const [id, colors] of [
  ['3844', [1, 26, 28, 194, 151]],
  ['3846', [1, 26, 24, 192, 194]],
] as const) {
  PURCHASE_PARTS[id] = {
    bricklinkId: id,
    mappingSource: catalogSource(id),
    confirmedLegoColors: colors,
    colorSource: catalogSource(id),
  };
}

// LEGO and BrickLink color namespaces differ. Keep this independent of palette
// order and reject additions until their mapping has actually been checked.
const COLOR_IDS: Record<number, { bricklink: number; ldraw: number }> = {
  1: { bricklink: 1, ldraw: 15 },
  26: { bricklink: 11, ldraw: 0 },
  21: { bricklink: 5, ldraw: 4 },
  24: { bricklink: 3, ldraw: 14 },
  23: { bricklink: 7, ldraw: 1 },
  28: { bricklink: 6, ldraw: 2 },
  106: { bricklink: 4, ldraw: 25 },
  5: { bricklink: 2, ldraw: 19 },
  138: { bricklink: 69, ldraw: 28 },
  192: { bricklink: 88, ldraw: 70 },
  308: { bricklink: 120, ldraw: 308 },
  194: { bricklink: 86, ldraw: 71 },
  199: { bricklink: 85, ldraw: 72 },
  151: { bricklink: 48, ldraw: 378 },
  182: { bricklink: 98, ldraw: 57 },
};
export const PURCHASE_COLOR_SOURCE = {
  url: 'https://v2.bricklink.com/en-us/catalog/color-guide',
  checkedAt: PURCHASE_CATALOG_CHECKED_AT,
  kind: 'bricklink-catalog',
} satisfies PurchaseSource;

/** Only checked positive and negative catalog evidence can drive selection.
 * An unknown entry or absent color stays unverified, rather than being rejected. */
export function partColorEvidence(part: string) {
  const entry = PURCHASE_PARTS[part];
  if (!entry?.colorSource) return undefined;
  return {
    confirmedPaletteColors: PALETTE.flatMap((color, index) =>
      entry.confirmedLegoColors?.includes(color.lego) &&
      COLOR_IDS[color.lego]?.ldraw === color.ldraw
        ? [index]
        : [],
    ),
    unsupportedLegoColors: [...(entry.unsupportedLegoColors ?? [])],
    source: { ...entry.colorSource },
  };
}

const ASSEMBLIES = [
  {
    id: '970c00',
    name: '人仔腿部总成 · 同色髋部和双腿',
    members: { '3815b': 1, '3816c': 1, '3817c': 1 },
    colors: CORE_COLORS,
  },
  {
    id: '973c000',
    name: '人仔躯干总成 · 同色手臂和双手',
    members: { '973': 1, '3818': 1, '3819': 1, '3820': 2 },
    colors: [1, 26, 21, 24, 23, 106, 5, 192, 308, 194, 199, 151],
  },
] as const;

function lineFor(
  members: readonly Brick[],
  part: string,
  name: string,
  entry?: PurchasePart,
  assembled = false,
): PurchaseLine {
  const color = members[0].color;
  const palette = Number.isInteger(color) ? PALETTE[color] : undefined;
  const colorIds = palette ? COLOR_IDS[palette.lego] : undefined;
  const bricklinkColor =
    colorIds?.ldraw === palette?.ldraw ? colorIds?.bricklink : undefined;
  let status: PurchaseStatus = 'unverified';
  let reason = !entry
    ? '尚未记录该 LDraw 零件的采购编号映射。'
    : '采购编号已有来源，此零件与颜色组合尚未核实。';
  if (!palette || bricklinkColor === undefined) {
    reason = '颜色编号或对应采购色号尚未核实。';
  } else if (entry?.unsupportedLegoColors?.includes(palette.lego)) {
    status = 'unsupported-color';
    reason =
      '当前目录 Known Colors 未收录此组合；不代表不存在或缺货，需核对替代颜色。';
  } else if (entry?.confirmedLegoColors?.includes(palette.lego)) {
    status = 'catalog-confirmed';
    reason = '公开目录收录此零件与颜色组合；库存尚未查询。';
  }
  if (assembled) {
    reason +=
      '采购按总成计数；模型仍以拆分零件描述，需核对安装步骤和总成姿态。';
  }
  const source = entry?.colorSource || entry?.mappingSource;
  return {
    part,
    name,
    color,
    quantity: 1,
    ldrawParts: [...new Set(members.map((b) => b.part))].sort(),
    brickIds: members.map((b) => b.id).sort((a, b) => a - b),
    assembled,
    colorChoices: members.flatMap((b) =>
      b.colorChoice ? [{ ...b.colorChoice, brickId: b.id }] : [],
    ),
    bricklinkId: entry?.bricklinkId,
    bricklinkColor,
    status,
    reason,
    catalogUrl: entry
      ? `${catalogSource(entry.bricklinkId).url}${bricklinkColor === undefined ? '' : `&idColor=${bricklinkColor}`}`
      : undefined,
    mappingSource: entry?.mappingSource,
    colorSource: entry?.colorSource,
    sourceUrl: source?.url,
    checkedAt: source?.checkedAt,
  };
}

/** Procurement units retain every source ID without altering the model BOM. */
export function purchaseInventory(bricks: readonly Brick[]): PurchaseLine[] {
  const sourceIdCounts = new Map<number, number>();
  const sections = new Map<string, Brick[]>();
  for (const brick of bricks) {
    sourceIdCounts.set(brick.id, (sourceIdCounts.get(brick.id) || 0) + 1);
    if (brick.section?.startsWith('component-') && brick.section.length > 10) {
      const group = sections.get(brick.section) || [];
      group.push(brick);
      sections.set(brick.section, group);
    }
  }
  const consumed = new Set<Brick>();
  const units: PurchaseLine[] = [];
  for (const group of sections.values()) {
    for (const assembly of ASSEMBLIES) {
      const expected = Object.entries(assembly.members);
      const members = group.filter((b) =>
        expected.some(([part]) => b.part === part),
      );
      if (
        !members.length ||
        expected.some(
          ([part, count]) =>
            members.filter((b) => b.part === part).length !== count,
        ) ||
        members.some(
          (b) =>
            b.color !== members[0].color ||
            !Number.isInteger(b.color) ||
            !PALETTE[b.color] ||
            !Number.isInteger(b.id) ||
            b.id <= 0 ||
            sourceIdCounts.get(b.id) !== 1,
        )
      )
        continue;
      const source = catalogSource(assembly.id);
      units.push(
        lineFor(
          members,
          assembly.id,
          assembly.name,
          {
            bricklinkId: assembly.id,
            mappingSource: source,
            confirmedLegoColors: assembly.colors,
            colorSource: source,
          },
          true,
        ),
      );
      members.forEach((b) => consumed.add(b));
    }
  }
  for (const brick of bricks) {
    if (!consumed.has(brick)) {
      units.push(
        lineFor(
          [brick],
          brick.part,
          Object.hasOwn(PARTS, brick.part) ? PARTS[brick.part] : brick.part,
          PURCHASE_PARTS[brick.part],
        ),
      );
    }
  }
  const grouped = new Map<string, PurchaseLine>();
  for (const unit of units) {
    const key = JSON.stringify([unit.part, String(unit.color), unit.assembled]);
    const line = grouped.get(key);
    if (line) {
      line.quantity++;
      line.brickIds.push(...unit.brickIds);
      line.colorChoices.push(...unit.colorChoices);
    } else
      grouped.set(key, {
        ...unit,
        brickIds: [...unit.brickIds],
        colorChoices: [...unit.colorChoices],
      });
  }
  return [...grouped.values()]
    .map((line) => ({
      ...line,
      brickIds: line.brickIds.sort((a, b) => a - b),
      colorChoices: line.colorChoices.sort((a, b) => a.brickId - b.brickId),
    }))
    .sort(
      (a, b) =>
        b.quantity - a.quantity ||
        a.part.localeCompare(b.part) ||
        a.color - b.color,
    );
}

export function procurementReport(
  input: { bricks: readonly Brick[] } | readonly Brick[],
): ProcurementReport {
  const bricks = 'bricks' in input ? input.bricks : input;
  const lines = purchaseInventory(bricks);
  const assembledQuantity = lines.reduce(
    (n, line) => n + (line.assembled ? line.quantity : 0),
    0,
  );
  return {
    lines,
    sourceBrickCount: bricks.length,
    purchaseQuantity: lines.reduce((n, line) => n + line.quantity, 0),
    catalogConfirmed: lines.filter(
      (line) => line.status === 'catalog-confirmed',
    ).length,
    unverified: lines.filter((line) => line.status === 'unverified').length,
    unsupportedColors: lines.filter(
      (line) => line.status === 'unsupported-color',
    ).length,
    assembledQuantity,
    assemblyStepsRequireReview: assembledQuantity > 0,
    requiresReview:
      assembledQuantity > 0 ||
      lines.some((line) => line.status !== 'catalog-confirmed'),
    stockChecked: false,
  };
}

export function purchaseColorChoiceSummary(
  line: Pick<PurchaseLine, 'colorChoices'>,
) {
  return [
    ...new Set(
      line.colorChoices.map(
        (choice) =>
          `${PALETTE[choice.requestedColor]?.name ?? choice.requestedColor} → ${PALETTE[choice.selectedColor]?.name ?? choice.selectedColor}`,
      ),
    ),
  ].join('；');
}

/** Quoted columns keep traceability and evidence intact when exported to CSV. */
export function purchaseInventoryCSV(bricks: readonly Brick[]): string {
  const quote = (value: string | number | undefined) =>
    `"${String(value ?? '').replaceAll('"', '""')}"`;
  const headers = [
    'LDraw编号',
    '采购名称',
    'BrickLink零件编号',
    'LEGO颜色编号',
    'BrickLink颜色编号',
    '颜色',
    '采购数量',
    '来源零件序号',
    '核对状态',
    '核对说明',
    '来源',
    '核对日期',
    '生成时颜色替代',
    '颜色替代依据',
  ];
  const rows = purchaseInventory(bricks).map((line) => {
    const color = PALETTE[line.color];
    return [
      line.ldrawParts.join(' / '),
      line.name,
      line.bricklinkId,
      color?.lego,
      line.bricklinkColor,
      color?.name,
      line.quantity,
      line.brickIds.join(' / '),
      line.status,
      line.reason,
      line.sourceUrl,
      line.checkedAt,
      line.colorChoices
        .map(
          (c) =>
            `#${c.brickId}: ${PALETTE[c.requestedColor]?.name ?? c.requestedColor} → ${PALETTE[c.selectedColor]?.name ?? c.selectedColor}`,
        )
        .join(' / '),
      [
        ...new Set(
          line.colorChoices.map(
            (c) => `${c.source.url} (${c.source.checkedAt})`,
          ),
        ),
      ].join(' / '),
    ];
  });
  return (
    '\uFEFF' +
    [headers, ...rows].map((row) => row.map(quote).join(',')).join('\r\n')
  );
}
