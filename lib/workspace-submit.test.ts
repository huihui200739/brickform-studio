import test from 'node:test';
import assert from 'node:assert/strict';
import {
  submitReconstruction,
  followReconstruction,
  ReconstructionSubmissionUnknown,
  ReconstructionStopped,
} from './workspace-reconstruction.ts';
const signal = () => new AbortController().signal;
void test('a lost submission response blocks unsafe repeated creation', async () => {
  const fetcher = (async () => {
    throw Error('connection lost after POST');
  }) as typeof fetch;
  await assert.rejects(
    submitReconstruction('image', { signal: signal(), fetcher }),
    ReconstructionSubmissionUnknown,
  );
});
void test('successful submission without a valid handle is also uncertain', async () => {
  for (const body of [{ id: 'id' }, { id: 123, ticket: 't' }, null]) {
    const fetcher = (async () =>
      Response.json(body, { status: 202 })) as typeof fetch;
    await assert.rejects(
      submitReconstruction('image', { signal: signal(), fetcher }),
      ReconstructionSubmissionUnknown,
    );
  }
});
void test('explicit server rejection can be retried, not an uncertain submission', async () => {
  const fetcher = (async () =>
    Response.json({ error: '电脑忙' }, { status: 409 })) as typeof fetch;
  await assert.rejects(
    submitReconstruction('image', { signal: signal(), fetcher }),
    (error: unknown) =>
      error instanceof Error &&
      !(error instanceof ReconstructionSubmissionUnknown) &&
      error.message === '电脑忙',
  );
});
void test('gateway errors are not evidence that no paid task was accepted', async () => {
  for (const status of [408, 500, 502, 503, 504]) {
    const fetcher = (async () =>
      Response.json(
        { error: '上游没有返回任务编号' },
        { status },
      )) as typeof fetch;
    await assert.rejects(
      submitReconstruction('image', { signal: signal(), fetcher }),
      ReconstructionSubmissionUnknown,
    );
  }
});
void test('lost or expired job credentials are terminal, not endless resume', async () => {
  const fetcher = (async () =>
    Response.json({ error: '任务不存在' }, { status: 403 })) as typeof fetch;
  await assert.rejects(
    followReconstruction(
      { id: 'i', ticket: 't' },
      { signal: signal(), fetcher },
    ),
    ReconstructionStopped,
  );
});
