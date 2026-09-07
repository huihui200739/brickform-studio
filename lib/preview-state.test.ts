import test from 'node:test';
import assert from 'node:assert/strict';
import {
  previewRange,
  visibleInPreview,
  previewFrame,
} from './preview-state.ts';
import type { Brick } from './brick-engine.ts';
const pieces = Array.from(
  { length: 6 },
  (_, i) =>
    ({
      id: i + 1,
      step: Math.floor(i / 2),
      section: i < 4 ? 'body' : 'head',
    }) as Brick,
);
void test('complete preview ignores a single-piece guide focus, including the final stage', () => {
  for (const layer of [1, 2, 3]) {
    const range = {
      ...previewRange('complete', 3, layer, layer * 2 - 1),
      section: 'all',
    };
    assert.equal(pieces.filter((b) => visibleInPreview(b, range)).length, 6);
  }
});
void test('following instructions shows only the completed prefix and restores all pieces on exit', () => {
  const follow = { ...previewRange('steps', 3, 2, 3), section: 'all' };
  assert.deepEqual(
    pieces.filter((b) => visibleInPreview(b, follow)).map((b) => b.id),
    [1, 2, 3],
  );
  assert.equal(
    pieces.filter((b) =>
      visibleInPreview(b, {
        ...previewRange('complete', 3, 2, 3),
        section: 'head',
      }),
    ).length,
    2,
  );
});

void test('a single plate is framed locally and narrow viewports retain the complete visible bounds', () => {
  const plate = previewFrame([2, 0, -4], [6, 0.6, -2], 1.6);
  const whole = previewFrame([-7, 0, -11], [7, 20, 11], 1.6);
  assert.deepEqual(plate.target, [4, 0.3, -3]);
  assert.ok(plate.distance < whole.distance / 4);
  const portrait = previewFrame([2, 0, -4], [6, 0.6, -2], 0.4);
  assert.ok(portrait.distance > plate.distance);
  assert.ok(Number.isFinite(previewFrame([0, 0, 0], [0, 0, 0], 0).distance));
});
