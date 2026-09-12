import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  requireReconstructionUser,
  taskTicket,
  verifyTicket,
  meshyRequest,
  modelDownload,
} from './meshy-server.ts';

void test('cloud reconstruction requires authenticated user and same origin on submission', () => {
  assert.throws(
    () =>
      requireReconstructionUser(
        new Request('https://brickform.example/api/reconstruction'),
      ),
    /登录/,
  );
  assert.throws(
    () =>
      requireReconstructionUser(
        new Request('https://brickform.example/api/reconstruction', {
          method: 'POST',
          headers: {
            'oai-authenticated-user-id': 'a',
            origin: 'https://another.example',
          },
        }),
      ),
    /来源/,
  );
});
void test('task tickets cannot be reused for a different account or task', async () => {
  const t = await taskTicket('task-1', 'user-1', 'test-only-secret');
  await verifyTicket('task-1', t, 'user-1', 'test-only-secret');
  await assert.rejects(
    verifyTicket('task-2', t, 'user-1', 'test-only-secret'),
    /无权/,
  );
  await assert.rejects(
    verifyTicket('task-1', t, 'user-2', 'test-only-secret'),
    /无权/,
  );
});
void test('no credits are requested when configuration or image is invalid', async () => {
  let calls = 0;
  const f = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  await assert.rejects(meshyRequest('', undefined, 'image', f), /配置/);
  await assert.rejects(
    meshyRequest('test', undefined, 'https://example.com/a.png', f),
    /图片/,
  );
  await assert.rejects(
    modelDownload('http://127.0.0.1/private.glb', f),
    /不受支持/,
  );
  assert.equal(calls, 0);
});
