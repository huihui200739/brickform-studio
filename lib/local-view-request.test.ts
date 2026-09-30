import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeLocalViews } from './local-view-request.ts';
const image =
  'data:image/png;base64,' +
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64');
void test('joint request requires three unique axes and orders front first', () => {
  const views = ['top', 'front', 'side'].map((axis) => ({ axis, image }));
  assert.deepEqual(
    decodeLocalViews(views).map((v) => v.axis),
    ['front', 'side', 'top'],
  );
  assert.throws(() => decodeLocalViews(views.slice(0, 2)), /三张/);
  assert.throws(
    () => decodeLocalViews([views[0], views[0], views[1]]),
    /只有一张/,
  );
});
void test('joint request rejects disguised and excessive image content', () => {
  const views = ['front', 'side', 'top'].map((axis) => ({ axis, image }));
  assert.throws(
    () =>
      decodeLocalViews([
        { ...views[0], image: 'data:image/png;base64,AAAA' },
        ...views.slice(1),
      ]),
    /不匹配/,
  );
  assert.throws(
    () =>
      decodeLocalViews([
        {
          ...views[0],
          image: 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024),
        },
        ...views.slice(1),
      ]),
    /太大/,
  );
});
