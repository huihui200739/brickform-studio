import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconstructionService,
  submitReconstruction,
  followReconstruction,
  reconstructionQuery,
  ReconstructionStopped,
  abortableDelay,
} from './workspace-reconstruction.ts';
const signal = () => new AbortController().signal;
const response = (body: unknown, status = 200) =>
  Response.json(body, { status });
function transport(sequence: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url:
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    const next = sequence.shift();
    assert.ok(next, 'unexpected request');
    return next;
  }) as typeof fetch;
  return { signal: signal(), fetcher, calls, delay: async () => {} };
}
void test('reads configured local service without submitting any image', async () => {
  const t = transport([response({ configured: true, provider: 'local' })]);
  assert.equal((await reconstructionService(t)).provider, 'local');
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].init?.cache, 'no-store');
});
void test('submission carries a real image and requires id/ticket', async () => {
  const t = transport([response({ id: 'a', ticket: 't' })]);
  assert.deepEqual(
    await submitReconstruction('data:image/png;base64,AA==', t),
    { id: 'a', ticket: 't' },
  );
  assert.equal(t.calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(t.calls[0].init?.body as string), {
    image: 'data:image/png;base64,AA==',
  });
  await assert.rejects(
    submitReconstruction('image', transport([response({ id: 'a' })])),
    /凭证/,
  );
});
void test('HTTP errors and non-JSON responses are actionable', async () => {
  await assert.rejects(
    reconstructionService(transport([response({ error: '电脑忙' }, 409)])),
    /电脑忙/,
  );
  await assert.rejects(
    reconstructionService(
      transport([new Response('<html>bad gateway</html>', { status: 502 })]),
    ),
    /HTTP 502/,
  );
  await assert.rejects(
    reconstructionService(transport([response(null)])),
    /数据不完整/,
  );
});
void test('query encodes credentials rather than allowing parameter injection', () => {
  assert.equal(
    reconstructionQuery({ id: 'a&download=1', ticket: 'a?b#c' }),
    '?id=a%26download%3D1&ticket=a%3Fb%23c',
  );
});
void test('polls real progress and downloads GLB only on ready; resume never POSTs', async () => {
  const t = transport([
    response({ status: 'RUNNING', progress: 123 }),
    response({ ready: true, progress: 100 }),
    new Response(new Uint8Array(16)),
  ]);
  const progress: Array<number | undefined> = [];
  const buffer = await followReconstruction(
    { id: 'id', ticket: 'ticket' },
    { ...t, onProgress: (status) => progress.push(status.progress) },
  );
  assert.equal(buffer.byteLength, 16);
  assert.deepEqual(progress, [100, 100]);
  assert.equal(t.calls.length, 3);
  assert.match(t.calls[2].url, /download=1$/);
  assert.ok(t.calls.every((call) => call.init?.method !== 'POST'));
});
void test('failed/canceled tasks have terminal error and do not download', async () => {
  for (const status of ['FAILED', 'CANCELED']) {
    const t = transport([response({ status, error: '已停止' })]);
    await assert.rejects(
      followReconstruction({ id: 'i', ticket: 't' }, t),
      ReconstructionStopped,
    );
    assert.equal(t.calls.length, 1);
  }
});
void test('long tasks provide resume advice without inventing a completed result', async () => {
  const t = transport([response({ status: 'RUNNING' })]);
  await assert.rejects(
    followReconstruction({ id: 'i', ticket: 't' }, { ...t, attempts: 1 }),
    /继续查看任务/,
  );
  assert.equal(t.calls.length, 1);
});
void test('rejects incomplete GLB and server download errors', async () => {
  await assert.rejects(
    followReconstruction(
      { id: 'i', ticket: 't' },
      transport([response({ ready: true }), new Response(new Uint8Array(3))]),
    ),
    /不完整/,
  );
  await assert.rejects(
    followReconstruction(
      { id: 'i', ticket: 't' },
      transport([
        response({ ready: true }),
        response({ error: '尚未完成' }, 409),
      ]),
    ),
    /尚未完成/,
  );
});
void test('aborted operations neither submit nor poll; waiting cancels promptly', async () => {
  const c = new AbortController();
  c.abort();
  const t = transport([]);
  await assert.rejects(
    submitReconstruction('image', { ...t, signal: c.signal }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    followReconstruction({ id: 'i', ticket: 't' }, { ...t, signal: c.signal }),
    { name: 'AbortError' },
  );
  assert.equal(t.calls.length, 0);
  const waiting = new AbortController();
  const promise = abortableDelay(60000, waiting.signal);
  waiting.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});
