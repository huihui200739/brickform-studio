// Audit the exact final models already pinned by the emitted-order replay.
// Usage: node --experimental-strip-types scripts/benchmark-procurement.ts [output-directory]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PALETTE, type Brick, type Model } from '../lib/brick-engine.ts';
import {
  procurementReport,
  purchaseInventoryCSV,
  PURCHASE_CATALOG_CHECKED_AT,
  type PurchaseLine,
} from '../lib/purchase-inventory.ts';
import { conversionFingerprint } from './benchmark-evidence.ts';

type SupportCase = {
  id: string;
  resolution: number;
  passed: boolean;
  bricks: number;
  modelSha256: string;
};
type SupportAudit = {
  passed: boolean;
  conversionFingerprint: string;
  cases: SupportCase[];
};
const directory = resolve(
  process.argv[2] || 'outputs/region-consensus-calibration',
);
const supportPath = join(directory, 'support-results.json');
const supportBytes = readFileSync(supportPath);
const support = JSON.parse(supportBytes.toString()) as SupportAudit;
const current = conversionFingerprint();
const sha = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
const supportSha256 = sha(supportBytes);
if (!support.passed || support.conversionFingerprint !== current)
  throw Error(
    'Replay current conversions and emitted order before procurement auditing.',
  );
if (!Array.isArray(support.cases) || support.cases.length !== 12)
  throw Error('Procurement evidence requires the current 12 final cases.');
const keys = new Set<string>();
for (const row of support.cases) {
  const key = `${row.id}:${row.resolution}`;
  if (
    !row.passed ||
    !row.id ||
    !Number.isInteger(row.resolution) ||
    row.resolution <= 0 ||
    !Number.isInteger(row.bricks) ||
    !/^[a-f0-9]{64}$/.test(row.modelSha256) ||
    keys.has(key)
  )
    throw Error(`Missing, duplicate or unpinned final model evidence: ${key}`);
  keys.add(key);
}

// Positive Known Colors observations from the primary pages checked on
// 2026-10-02. This bounded ledger deliberately omits 3010 Dark Brown; absence
// from this ledger remains unverified. It does not copy live seller lots.
const coreLegoColors = [
  1, 26, 21, 24, 23, 28, 106, 5, 138, 192, 308, 194, 199, 151,
];
const coreEvidence = [
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
].map((id) => ({
  id,
  legoColors:
    id === '3010'
      ? coreLegoColors.filter((color) => color !== 308)
      : coreLegoColors,
  sourceUrl: `https://www.bricklink.com/v2/catalog/catalogitem.page?P=${id}`,
  checkedAt: '2026-10-02',
  evidence:
    'Primary catalog Known Colors; recorded production/color evidence, no inventory claim.',
}));
const coreById = new Map(coreEvidence.map((entry) => [entry.id, entry]));
const assemblies: Record<
  string,
  { members: Record<string, number>; sourceUrl: string }
> = {
  '970c00': {
    members: { '3815b': 1, '3816c': 1, '3817c': 1 },
    sourceUrl: 'https://www.bricklink.com/v2/catalog/catalogitem.page?P=970c00',
  },
  '973c000': {
    members: { '973': 1, '3818': 1, '3819': 1, '3820': 2 },
    sourceUrl:
      'https://www.bricklink.com/v2/catalog/catalogitem.page?P=973c000',
  },
};
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const sorted = (ids: readonly number[]) => [...ids].sort((a, b) => a - b);
const countParts = (bricks: readonly Brick[]) => {
  const counts: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  for (const brick of bricks)
    counts[brick.part] = (counts[brick.part] || 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
};
const times = (counts: Record<string, number>, quantity: number) =>
  Object.fromEntries(
    Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([part, count]) => [part, count * quantity]),
  );

const cases = support.cases.map((row) => {
  const modelPath = row.id.startsWith('temple-')
    ? join(directory, `${row.id}-${row.resolution}.json`)
    : resolve(
        `outputs/image-benchmark/${row.id}/bricks-${row.resolution}.json`,
      );
  const bytes = readFileSync(modelPath);
  if (sha(bytes) !== row.modelSha256)
    throw Error(`Model changed after emitted-order audit: ${modelPath}`);
  const model = JSON.parse(bytes.toString()) as Model;
  const before = JSON.stringify(model);
  const failures: string[] = [];
  const check = (condition: boolean, reason: string) => {
    if (!condition) failures.push(reason);
  };
  check(
    model.bricks.length === row.bricks,
    'Source brick count differs from support replay.',
  );
  const byId = new Map(model.bricks.map((brick) => [brick.id, brick]));
  check(
    byId.size === model.bricks.length,
    'Source model contains duplicate brick IDs.',
  );
  check(
    model.bricks.every((b) => Number.isInteger(b.id) && b.id > 0),
    'Source brick IDs are invalid.',
  );
  const report = procurementReport(model);
  const csv = purchaseInventoryCSV(model.bricks);
  const traceIds = report.lines.flatMap((line) => line.brickIds);
  check(
    same(sorted(traceIds), sorted(model.bricks.map((b) => b.id))),
    'Purchase trace does not cover every source brick exactly once.',
  );
  check(
    new Set(traceIds).size === model.bricks.length,
    'Purchase trace duplicates or omits source IDs.',
  );
  check(
    report.sourceBrickCount === model.bricks.length,
    'Report source count is inconsistent.',
  );
  check(
    report.purchaseQuantity ===
      report.lines.reduce((n, line) => n + line.quantity, 0),
    'Purchase quantities are inconsistent.',
  );
  check(
    report.catalogConfirmed + report.unverified + report.unsupportedColors ===
      report.lines.length,
    'Report statuses do not cover every purchase line.',
  );
  check(
    report.assembledQuantity ===
      report.lines.reduce(
        (n, line) => n + (line.assembled ? line.quantity : 0),
        0,
      ),
    'Assembly quantity is inconsistent.',
  );
  check(
    report.assemblyStepsRequireReview === report.assembledQuantity > 0,
    'Assembly steps review flag is inconsistent.',
  );
  check(
    report.requiresReview ===
      (report.unverified + report.unsupportedColors > 0 ||
        report.assemblyStepsRequireReview),
    'Required review flag is inconsistent.',
  );
  check(
    report.stockChecked === false,
    'Report must not claim live stock verification.',
  );
  let checkedCoreClaims = 0;
  const lineFailures = new Map<PurchaseLine, string[]>();
  for (const line of report.lines) {
    const lineChecks: string[] = [];
    const fail = (condition: boolean, reason: string) => {
      if (!condition) lineChecks.push(reason);
    };
    const members = line.brickIds.map((id) => byId.get(id));
    fail(
      members.every((brick) => !!brick),
      'Trace includes an unknown source ID.',
    );
    const knownMembers = members.filter((brick): brick is Brick => !!brick);
    fail(
      Number.isInteger(line.quantity) && line.quantity > 0,
      'Invalid purchase quantity.',
    );
    fail(
      knownMembers.every((brick) => brick.color === line.color),
      'Purchase line combines different source colors.',
    );
    fail(
      same(
        line.ldrawParts,
        [...new Set(knownMembers.map((b) => b.part))].sort(),
      ),
      'LDraw member IDs are inconsistent.',
    );
    if (line.assembled) {
      const assembly = Object.hasOwn(assemblies, line.part)
        ? assemblies[line.part]
        : undefined;
      fail(!!assembly, 'Unrecognized assembled catalog unit.');
      if (assembly) {
        fail(
          line.bricklinkId === line.part,
          'Assembly catalog ID differs from purchase ID.',
        );
        fail(
          line.mappingSource?.url === assembly.sourceUrl,
          'Assembly lacks its reviewed primary catalog source.',
        );
        fail(
          same(
            countParts(knownMembers),
            times(assembly.members, line.quantity),
          ),
          'Aggregate assembly trace has incorrect members.',
        );
        fail(
          line.brickIds.length ===
            line.quantity *
              Object.values(assembly.members).reduce(
                (n, count) => n + count,
                0,
              ),
          'Assembly purchase quantity does not match source members.',
        );
        const sections = new Map<string, Brick[]>();
        for (const brick of knownMembers) {
          if (
            !brick.section?.startsWith('component-') ||
            brick.section.length <= 10
          ) {
            lineChecks.push(
              'Assembly members lack a recognized component section.',
            );
            continue;
          }
          const group = sections.get(brick.section) || [];
          group.push(brick);
          sections.set(brick.section, group);
        }
        fail(
          sections.size === line.quantity,
          'Assembly quantity differs from distinct component sections.',
        );
        for (const section of sections.values())
          fail(
            same(countParts(section), times(assembly.members, 1)),
            'Component section has incomplete or ambiguous assembly members.',
          );
        fail(
          report.assemblyStepsRequireReview &&
            line.reason.includes('需核对安装步骤和总成姿态'),
          'Assembly grouping must not assert correct geometry or split instructions.',
        );
      }
    } else {
      fail(
        line.brickIds.length === line.quantity,
        'Individual part quantity differs from trace length.',
      );
      fail(
        knownMembers.every((b) => b.part === line.part),
        'Individual line changes a source LDraw ID.',
      );
    }
    if (line.status === 'catalog-confirmed') {
      fail(
        !!line.bricklinkId && line.bricklinkColor !== undefined,
        'Confirmed combination lacks procurement IDs.',
      );
      fail(
        line.colorSource?.kind === 'bricklink-catalog' &&
          line.checkedAt === PURCHASE_CATALOG_CHECKED_AT,
        'Confirmed combination lacks dated primary-source color evidence.',
      );
      const core = coreById.get(line.part);
      if (core) {
        checkedCoreClaims++;
        const legoColor = PALETTE[line.color]?.lego;
        fail(
          legoColor !== undefined && core.legoColors.includes(legoColor),
          'Core color claim lacks a recorded Known Colors observation.',
        );
        fail(
          line.bricklinkId === core.id &&
            line.colorSource?.url === core.sourceUrl &&
            line.sourceUrl === core.sourceUrl &&
            line.checkedAt === core.checkedAt,
          'Core catalog source does not match the reviewed ledger.',
        );
      }
    }
    if (line.status === 'unsupported-color') {
      fail(
        !!line.colorSource && line.checkedAt === PURCHASE_CATALOG_CHECKED_AT,
        'Unsupported combination lacks dated catalog evidence.',
      );
      fail(
        line.reason.includes('Known Colors 未收录') &&
          line.reason.includes('不代表不存在或缺货'),
        'Unsupported colors must not claim impossibility or current stock status.',
      );
    }
    if (!line.bricklinkId)
      fail(
        line.status === 'unverified',
        'Unknown catalog mapping is not explicitly unverified.',
      );
    if (lineChecks.length) {
      lineFailures.set(line, lineChecks);
      failures.push(
        ...lineChecks.map((reason) => `${line.part}/${line.color}: ${reason}`),
      );
    }
  }
  const unchangedBytes = readFileSync(modelPath);
  const sourceModelUnchanged =
    bytes.equals(unchangedBytes) && sha(unchangedBytes) === row.modelSha256;
  const inMemoryModelUnchanged = JSON.stringify(model) === before;
  check(
    sourceModelUnchanged,
    'Source model file bytes/hash changed during procurement audit.',
  );
  check(
    inMemoryModelUnchanged,
    'Procurement inventory or CSV mutated the loaded model.',
  );
  const catalogRecordsComplete =
    report.unverified + report.unsupportedColors === 0;
  const blockers = [
    ...(report.unverified ? ['unverified-catalog-records'] : []),
    ...(report.unsupportedColors
      ? ['unsupported-known-color-combinations']
      : []),
    ...(report.assemblyStepsRequireReview
      ? ['assembly-steps-and-poses-require-review']
      : []),
    'live-stock-not-checked',
  ];
  return {
    id: row.id,
    resolution: row.resolution,
    passed: failures.length === 0,
    modelPath,
    modelSha256: row.modelSha256,
    sourceModelUnchanged,
    inMemoryModelUnchanged,
    everySourceBrickTracedExactlyOnce:
      same(sorted(traceIds), sorted(model.bricks.map((b) => b.id))) &&
      new Set(traceIds).size === model.bricks.length,
    sourceBrickCount: report.sourceBrickCount,
    purchaseQuantity: report.purchaseQuantity,
    catalogConfirmed: report.catalogConfirmed,
    unverified: report.unverified,
    unsupportedColors: report.unsupportedColors,
    assembledQuantity: report.assembledQuantity,
    assemblyStepsRequireReview: report.assemblyStepsRequireReview,
    requiresReview: report.requiresReview,
    catalogRecordsComplete,
    procurementReady: false,
    blockers,
    stockChecked: report.stockChecked,
    physicalBuildVerified: false,
    checkedCoreClaims,
    csvSha256: sha(csv),
    lines: report.lines.map((line) => ({
      ...line,
      auditFailures: lineFailures.get(line) || [],
    })),
    failures,
  };
});
if (conversionFingerprint() !== current)
  throw Error(
    'Production code changed during procurement audit; replay again.',
  );
if (sha(readFileSync(supportPath)) !== supportSha256)
  throw Error(
    'Support evidence changed during procurement audit; replay again.',
  );
for (const row of cases) {
  if (sha(readFileSync(row.modelPath)) !== row.modelSha256)
    throw Error(
      `A final model changed during procurement audit: ${row.modelPath}`,
    );
}
const passed = cases.every((row) => row.passed);
const output = {
  date: '2026-10-02',
  conversionFingerprint: current,
  supportAudit: { path: supportPath, sha256: supportSha256 },
  scope:
    'Independent procurement/traceability audit of the 12 exact final models pinned by support-results.json. No regeneration, new catalog lookup, substitutions or model edits.',
  catalogEvidence: coreEvidence,
  cases,
  passed,
  procurementReady: false,
  stockChecked: false,
  physicalBuildVerified: false,
  limits:
    'Catalog records establish previously observed part/color combinations. They do not verify current stock, authenticity of seller listings, legal assembly poses, forces, stability, physical build or human instructions. Assembly grouping is a procurement count only; existing split steps require review.',
};
writeFileSync(
  join(directory, 'procurement-results.json'),
  JSON.stringify(output, null, 2),
);
console.log(
  JSON.stringify({
    passed,
    cases: cases.length,
    procurementReady: false,
    catalogConfirmed: cases.reduce((n, row) => n + row.catalogConfirmed, 0),
    unverified: cases.reduce((n, row) => n + row.unverified, 0),
    unsupportedColors: cases.reduce((n, row) => n + row.unsupportedColors, 0),
    assembledQuantity: cases.reduce((n, row) => n + row.assembledQuantity, 0),
  }),
);
if (!passed) process.exitCode = 1;
