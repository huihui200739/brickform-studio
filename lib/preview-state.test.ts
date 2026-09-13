import test from 'node:test';
import assert from 'node:assert/strict';
import {
  previewRange,
  visibleInPreview,
  previewFrame,
  explodedLayers,
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

void test('explosion separates construction layers inside the same body without changing the source model', () => {
  const bricks = [
    { id: 1, step: 0, section: 'body', y: 0, h: 1 },
    { id: 2, step: 1, section: 'body', y: 1, h: 3 },
    { id: 3, step: 2, section: 'body', y: 2, h: 1 },
    { id: 4, step: 2, section: 'body', y: 7, h: 2 },
  ] as Brick[];
  const original = JSON.stringify(bricks),
    layout = explodedLayers(bricks, 0, 6, 1);
  assert.equal(layout.layers.length, 3);
  for (let step = 1; step < 3; step++) {
    const below = bricks.filter((b) => b.step === step - 1),
      above = bricks.filter((b) => b.step === step);
    const top = Math.max(
      ...below.map((b) => (b.y + b.h) * 0.4 + layout.offsets.get(step - 1)!),
    );
    const bottom = Math.min(
      ...above.map((b) => b.y * 0.4 + layout.offsets.get(step)!),
    );
    assert.ok(Math.abs(bottom - top - 1) < 1e-7);
  }
  assert.deepEqual([...explodedLayers(bricks, 1, 1, 0.5).offsets.keys()], [1]);
  assert.equal(JSON.stringify(bricks), original);
  assert.deepEqual(explodedLayers([], 0, 6, 1).layers, []);
  const filtered = bricks.slice(1).map((b) => ({ ...b, step: b.step! + 10 }));
  assert.deepEqual(
    [...explodedLayers(filtered, 0, 6, 1).offsets.keys()],
    [11, 12],
  );
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

void test('direction-aware framing fits a wide platform without the diagonal-sphere empty margin', () => {
  const tight = previewFrame([-5, 0, -5], [5, 5, 5], 1.5, 34, [1.3, 0.8, 2]);
  const sphere = previewFrame([-5, 0, -5], [5, 5, 5], 1.5, 34);
  assert.ok(Number.isFinite(tight.distance));
  assert.ok(tight.distance < sphere.distance);
  assert.deepEqual(tight.target, sphere.target);
});
