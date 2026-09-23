import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PACKING_CASES } from '../benchmarks/packing-cases.ts';
import { analyzeStructure } from '../lib/structure-metrics.ts';
import type { Model } from '../lib/brick-engine.ts';

const baselineUrl = new URL(
  '../benchmarks/packing-baseline.json',
  import.meta.url,
);
const update = process.argv.includes('--update');
const check = process.argv.includes('--check');
const json = process.argv.includes('--json');

function modelHash(model: Model) {
  const placements = model.bricks.map((brick) => ({
    part: brick.part,
    x: brick.x,
    y: brick.y,
    z: brick.z,
    w: brick.w,
    d: brick.d,
    h: brick.h,
    color: brick.color,
    support: !!brick.support,
  }));
  return createHash('sha256')
    .update(JSON.stringify(placements))
    .digest('hex')
    .slice(0, 16);
}

const runs = PACKING_CASES.map(({ id, create }) => {
  const start = performance.now();
  const model = create();
  const metrics = analyzeStructure(model);
  const elapsedMs = performance.now() - start;
  const hash = modelHash(model);
  const repeatHash = modelHash(create());
  return {
    id,
    elapsedMs,
    snapshot: {
      id,
      hash,
      deterministic: hash === repeatHash,
      metrics,
    },
  };
});

const snapshot = { version: 1, cases: runs.map((run) => run.snapshot) };
const invalidCases = snapshot.cases.filter(
  ({ deterministic, metrics }) =>
    !deterministic ||
    metrics.validation.collisions > 0 ||
    metrics.validation.unsupported > 0 ||
    metrics.validation.invalidParts > 0 ||
    !metrics.validation.connected,
);

if (json) console.log(JSON.stringify(snapshot, null, 2));
else
  console.table(
    runs.map(({ id, elapsedMs, snapshot: value }) => ({
      case: id,
      parts: value.metrics.totalParts,
      supports: value.metrics.addedSupportParts,
      small: `${(value.metrics.smallPartRate * 100).toFixed(1)}%`,
      exactStack: `${(value.metrics.exactStackRate * 100).toFixed(1)}%`,
      multiSupport: `${(value.metrics.multiSupportRate * 100).toFixed(1)}%`,
      maxStackRun: value.metrics.maxExactStackRun,
      valid:
        !value.metrics.validation.collisions &&
        !value.metrics.validation.unsupported &&
        !value.metrics.validation.invalidParts &&
        value.metrics.validation.connected,
      deterministic: value.deterministic,
      ms: elapsedMs.toFixed(1),
    })),
  );

if (update && invalidCases.length) {
  console.error(
    `Refusing to update an invalid baseline: ${invalidCases.map((item) => item.id).join(', ')}`,
  );
  process.exitCode = 1;
} else if (update) {
  writeFileSync(baselineUrl, JSON.stringify(snapshot, null, 2) + '\n');
  console.log('Updated benchmarks/packing-baseline.json');
} else {
  const baseline = JSON.parse(
    readFileSync(baselineUrl, 'utf8'),
  ) as typeof snapshot;
  const expected = new Map(baseline.cases.map((item) => [item.id, item]));
  const changed = snapshot.cases.filter(
    (item) => JSON.stringify(item) !== JSON.stringify(expected.get(item.id)),
  );
  if (changed.length) {
    console.error(
      `Packing baseline changed for: ${changed.map((item) => item.id).join(', ')}`,
    );
    console.error(
      'Review the metrics, then run npm run benchmark -- --update.',
    );
    if (check) process.exitCode = 1;
  } else if (!json) console.log('Packing baseline matches.');
}

if (check && invalidCases.length) process.exitCode = 1;
