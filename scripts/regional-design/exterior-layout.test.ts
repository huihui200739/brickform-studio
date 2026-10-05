import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Brick, Model } from '../../lib/brick-engine.ts';
import { instructionModel } from '../../lib/build-instructions.ts';
import {
  proposeExteriorLayouts,
  type ExteriorLayoutInput,
} from './exterior-layout.ts';
import { uprightCatalogBrick } from './upright-layout.ts';

function emptyModel(width = 6, height = 8, depth = 4): Model {
  return {
    name: 'known exterior target',
    width,
    height,
    depth,
    bricks: [],
    levels: [0, 1, 2, 3, 4, 5, 6, 7],
    source: 'sample',
    shape: 'sculpture',
    resolution: width,
    supportCount: 2,
    assemblyStrategy: 'connector-graph',
  };
}
function xPanel(x: number, y0 = 0.4, y1 = 0.8, z0 = 1, z1 = 2) {
  return {
    positions: [
      x,
      y0,
      z0,
      x,
      y1,
      z0,
      x,
      y1,
      z1,
      x,
      y0,
      z0,
      x,
      y1,
      z1,
      x,
      y0,
      z1,
    ],
    faceIds: [0, 1],
    complete: true,
  };
}
function zPanel(z: number, x0 = 1, x1 = 2, y0 = 0.4, y1 = 0.8) {
  return {
    positions: [
      x0,
      y0,
      z,
      x1,
      y0,
      z,
      x1,
      y1,
      z,
      x0,
      y0,
      z,
      x1,
      y1,
      z,
      x0,
      y1,
      z,
    ],
    faceIds: [0, 1],
    complete: true,
  };
}
function sideSupportFixture(dropBoth = false): ExteriorLayoutInput {
  const m = emptyModel();
  m.bricks = [
    uprightCatalogBrick('3020', 0, 0, 1, 0, 7, 1, m),
    {
      ...uprightCatalogBrick('3024', 1, 1, 1, 0, 7, 2, m),
      support: true,
      section: 'supports',
    },
    {
      ...uprightCatalogBrick('3024', 2, 1, 1, 0, 7, 3, m),
      support: true,
      section: 'supports',
    },
    { ...uprightCatalogBrick('3023', 1, 2, 1, 0, 7, 4, m), section: 'subject' },
    uprightCatalogBrick('3024', 0, 1, 1, 0, 7, 5, m),
  ];
  return {
    source: xPanel(dropBoth ? 0.99 : 1.99),
    axis: 0,
    direction: 1,
    baselineModel: instructionModel(m),
  };
}
function occupancy(bricks: readonly Brick[]) {
  const out = new Map<string, number>();
  for (const b of bricks)
    for (let x = b.x; x < b.x + b.w; x++)
      for (let y = b.y; y < b.y + b.h; y++)
        for (let z = b.z; z < b.z + b.d; z++) {
          const key = `${x},${y},${z}`;
          assert.ok(!out.has(key), `unexpected overlap ${key}`);
          out.set(key, b.color);
        }
  return out;
}
function unchangedOutside(
  input: ExteriorLayoutInput,
  result: ReturnType<typeof proposeExteriorLayouts>,
) {
  const before = occupancy(input.baselineModel.bricks),
    editable = new Set(result.editableCells);
  for (const c of result.candidates) {
    const after = occupancy(c.layout.bricks);
    for (const k of new Set([...before.keys(), ...after.keys()]))
      if (!editable.has(k))
        assert.equal(
          after.get(k),
          before.get(k),
          `outside occupancy/color ${k}`,
        );
    assert.ok(c.layout.changedCells.length <= 512);
    assert.ok(
      c.layout.changedCells.every(
        (change) => editable.has(change.key) && change.before && !change.after,
      ),
    );
  }
}

void test('real noisy exterior deletes a generated support and audits complete final geometry without mutating inputs or outside colors', () => {
  const input = sideSupportFixture();
  input.baselineModel.bricks.find((b) => b.id === 5)!.color = 9;
  const snapshot = JSON.stringify(input),
    result = proposeExteriorLayouts(input);
  assert.equal(result.status, 'software-candidate', JSON.stringify(result));
  assert.deepEqual(result.views, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
  assert.deepEqual(result.editableCells, ['2,1,1']);
  assert.ok(result.candidates.length);
  for (const c of result.candidates)
    if (c.improvement.status === 'improving')
      assert.ok(c.audit?.assemblyAudited);
  assert.equal(
    result.model.bricks.some((b) => b.id === 3),
    false,
  );
  assert.equal(result.accepted, false);
  assert.equal(result.appearanceAccepted, false);
  assert.equal(result.fullInsertionPathVerified, false);
  unchangedOutside(input, result);
  assert.equal(JSON.stringify(input), snapshot);
});

void test('source exterior cannot remove an active beam, installed/color-reviewed/semantic/tile or non-upright part', () => {
  const changes: ((b: Brick) => void)[] = [
    (b) => {
      b.construction = {
        origin: 'cavity-lintel',
        openingId: 'known-door',
        role: 'bridge',
      };
    },
    (b) => {
      b.installation = 'retain deliberate connection';
    },
    (b) => {
      b.section = 'component-known-door';
    },
    (b) => {
      b.colorChoice = {
        requestedColor: 7,
        selectedColor: 7,
        reason: 'reviewed-unsupported-catalog-color',
        source: {
          url: 'https://example.invalid/control',
          checkedAt: '2026-10-04',
          kind: 'vendored-ldraw-header',
        },
      };
    },
    (b) => {
      Object.assign(
        b,
        uprightCatalogBrick(
          '3070b',
          b.x,
          b.y,
          b.z,
          0,
          b.color,
          b.id,
          emptyModel(),
        ),
      );
    },
    (b) => {
      b.pose!.position[0] += 1;
    },
  ];
  for (const change of changes) {
    const input = sideSupportFixture();
    const protectedPart = input.baselineModel.bricks.find((b) => b.id === 3)!;
    change(protectedPart);
    const snapshot = JSON.stringify(input),
      result = proposeExteriorLayouts(input);
    assert.equal(result.status, 'noop', JSON.stringify(result));
    assert.deepEqual(
      result.model.bricks.find((b) => b.id === 3),
      protectedPart,
    );
    assert.ok(
      result.protectedExteriorCells.some(
        (c) => c.key === '2,1,1' && c.partIds.includes(3),
      ),
    );
    assert.equal(JSON.stringify(input), snapshot);
  }
});

void test('a genuinely disconnected overhead structure rejects every improving layout and adds no hidden support', () => {
  const input = sideSupportFixture(true),
    snapshot = JSON.stringify(input);
  const result = proposeExteriorLayouts(input);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.equal(result.softwareCandidateIndices.length, 0);
  const improving = result.candidates.filter(
    (c) => c.improvement.status === 'improving',
  );
  assert.ok(improving.length);
  assert.ok(improving.every((c) => c.audit?.status === 'rejected'));
  assert.ok(
    improving.every(
      (c) =>
        c.audit?.status === 'rejected' &&
        c.audit.unresolvedPartIds?.includes(4),
    ),
  );
  assert.equal(result.supportRetry.attempted, false);
  assert.deepEqual(result.model, input.baselineModel);
  unchangedOutside(input, result);
  assert.equal(JSON.stringify(input), snapshot);
});

void test('sampled improvement and software connectivity cannot override a declared geometry constraint', () => {
  const input = sideSupportFixture();
  input.baselineModel.designGeometry = {
    version: 1,
    coordinates: 'brick-grid',
    planes: [
      {
        id: 'deliberate-front-cell',
        axis: 0,
        direction: 1,
        coordinate: 3,
        bounds: { min: [2, 1, 1], max: [3, 2, 2] },
        material: {
          color: 7,
          source: 'local-reference-region',
          supportFraction: 1,
          inferredShadows: true,
        },
        evidence: {
          source: 'mesh-and-reference',
          samples: 1,
          inlierFraction: 1,
          rmseStuds: 0,
          imageCoverage: 1,
          observedCrossRange: [1, 2],
        },
      },
    ],
    openings: [],
    warnings: [],
  };
  const snapshot = JSON.stringify(input),
    result = proposeExteriorLayouts(input);
  assert.equal(result.status, 'rejected', JSON.stringify(result));
  assert.ok(result.candidates.length);
  assert.ok(
    result.candidates.every(
      (c) =>
        c.improvement.status === 'improving' &&
        c.audit?.status === 'audited' &&
        c.audit.softwareConnected &&
        c.audit.declaredGeometryPassed === false &&
        !c.softwareCandidate,
    ),
  );
  assert.equal(result.softwareCandidateIndices.length, 0);
  assert.deepEqual(result.model, input.baselineModel);
  assert.equal(JSON.stringify(input), snapshot);
});

function bridgeFixture(): ExteriorLayoutInput {
  const m = emptyModel();
  m.bricks = [
    { ...uprightCatalogBrick('3020', 1, 0, 0, 0, 7, 1, m), section: 'subject' },
    {
      ...uprightCatalogBrick('3024', 1, 1, 1, 0, 7, 2, m),
      support: true,
      section: 'supports',
    },
    {
      ...uprightCatalogBrick('3024', 2, 1, 1, 0, 7, 3, m),
      support: true,
      section: 'supports',
    },
    { ...uprightCatalogBrick('3024', 2, 2, 1, 0, 7, 4, m), section: 'subject' },
    {
      ...uprightCatalogBrick('3005', 1, 2, 1, 0, 7, 5, m),
      support: true,
      section: 'supports',
    },
    { ...uprightCatalogBrick('3024', 1, 5, 1, 0, 7, 6, m), section: 'subject' },
    { ...uprightCatalogBrick('3024', 1, 1, 0, 0, 7, 7, m), section: 'subject' },
  ];
  return {
    source: zPanel(0.99),
    axis: 2,
    direction: 1,
    baselineModel: instructionModel(m),
  };
}
void test('one finite same-color interface retry bridges a failed support with actual catalog parts and no extra volume', () => {
  const input = bridgeFixture(),
    snapshot = JSON.stringify(input),
    result = proposeExteriorLayouts(input);
  assert.equal(result.status, 'software-candidate', JSON.stringify(result));
  assert.equal(result.supportRetry.attempted, true);
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts.every((a) => a.candidateIndices.length <= 3));
  assert.deepEqual(
    result.attempts[1].interfacePartIds.sort((a, b) => a - b),
    [4, 5],
  );
  const first = result.candidates.filter((c) => c.attempt === 'initial');
  assert.ok(
    first.length &&
      first.every(
        (c) =>
          c.improvement.status === 'improving' &&
          c.audit?.status === 'rejected',
      ),
  );
  assert.ok(
    result.candidates.some(
      (c) => c.attempt === 'support-interface-retry' && c.softwareCandidate,
    ),
  );
  unchangedOutside(input, result);
  assert.equal(JSON.stringify(input), snapshot);
});

void test('bridge retry cannot cross a true color boundary or active construction', () => {
  for (const constraint of ['color', 'construction']) {
    const input = bridgeFixture(),
      neighbor = input.baselineModel.bricks.find((b) => b.id === 4)!;
    if (constraint === 'color') neighbor.color = 9;
    else
      neighbor.construction = {
        origin: 'cavity-lintel',
        openingId: 'known-door',
        role: 'bridge',
      };
    const result = proposeExteriorLayouts(input);
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.supportRetry.attempted, false);
    assert.deepEqual(result.model, input.baselineModel);
    unchangedOutside(input, result);
  }
});

void test('complete boundary brick repacking scores and audits every improving candidate rather than only the best', () => {
  const m = emptyModel(8, 6, 5);
  m.bricks = [uprightCatalogBrick('3001', 1, 0, 1, 0, 7, 1, m)];
  const input: ExteriorLayoutInput = {
    source: xPanel(2.99, 0, 1.2, 1, 3),
    axis: 0,
    direction: 1,
    baselineModel: instructionModel(m),
  };
  const result = proposeExteriorLayouts(input);
  assert.equal(result.status, 'software-candidate', JSON.stringify(result));
  assert.ok(
    result.attempts[0].candidateIndices.length >= 2 &&
      result.attempts[0].candidateIndices.length <= 3,
  );
  assert.ok(
    result.candidates.every(
      (c) => c.improvement.status === 'improving' && c.audit?.assemblyAudited,
    ),
  );
  assert.ok(
    result.candidates.every(
      (c) => c.layout.removedIDs.includes(1) && c.layout.addedIDs.length,
    ),
  );
  unchangedOutside(input, result);
});

void test('preserved/semantic cells block source deletions and source incompleteness or score exhaustion never qualifies', () => {
  const preserved = sideSupportFixture();
  preserved.preserveCells = new Set(['2,1,1']);
  assert.equal(proposeExteriorLayouts(preserved).status, 'noop');
  const semantic = sideSupportFixture();
  semantic.baselineModel.semanticReservedCells = ['2,1,1'];
  assert.equal(proposeExteriorLayouts(semantic).status, 'noop');
  const incomplete = sideSupportFixture();
  incomplete.source.complete = false;
  assert.equal(proposeExteriorLayouts(incomplete).status, 'unresolved');
  const exhausted = sideSupportFixture();
  exhausted.scoreLimits = { rayTriangleTests: 1 };
  const snapshot = JSON.stringify(exhausted),
    result = proposeExteriorLayouts(exhausted);
  assert.equal(result.status, 'unresolved');
  assert.ok(
    result.candidates.every(
      (c) => c.improvement.status === 'unavailable' && !c.audit,
    ),
  );
  assert.equal(result.softwareCandidateIndices.length, 0);
  assert.equal(JSON.stringify(exhausted), snapshot);
});

void test('more than 512 actual deletions returns unresolved without silently trimming source-owned cells', () => {
  const m = emptyModel(516, 2, 2);
  m.bricks = Array.from({ length: 513 }, (_, i) =>
    uprightCatalogBrick('3024', i + 1, 0, 0, 0, 7, i + 1, m),
  );
  const input: ExteriorLayoutInput = {
    source: xPanel(0.99, 0, 0.4, 0, 1),
    axis: 0,
    direction: 1,
    baselineModel: instructionModel(m),
  };
  const result = proposeExteriorLayouts(input);
  assert.equal(result.status, 'unresolved');
  assert.equal(result.editableCells.length, 513);
  assert.equal(result.candidates.length, 0);
  assert.match(result.reasons.join(' '), /513.*not trimmed/);
  assert.deepEqual(result.model, input.baselineModel);
});
