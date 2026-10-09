export type ReconstructionService = {
  configured?: boolean;
  provider?: string;
  model?: string;
  error?: string;
};
export type ReconstructionJob = { id: string; ticket: string };
export type ReconstructionStatus = {
  status?: string;
  ready?: boolean;
  progress?: number;
  error?: string;
};
export class ReconstructionStopped extends Error {}

type Transport = {
  fetcher?: typeof fetch;
  signal: AbortSignal;
  requestTimeout?: number;
};
async function request(url: string, init: RequestInit, transport: Transport) {
  transport.signal.throwIfAborted();
  const timeout = AbortSignal.timeout(transport.requestTimeout ?? 30000);
  try {
    return await (transport.fetcher ?? fetch)(url, {
      ...init,
      cache: 'no-store',
      signal: AbortSignal.any([transport.signal, timeout]),
    });
  } catch (error) {
    transport.signal.throwIfAborted();
    if (timeout.aborted)
      throw Error('服务请求超时。可以继续查看已有任务，不必重新提交图片。');
    throw error;
  }
}
async function json<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw Error(
      `服务未返回有效数据（HTTP ${response.status}），请检查本机服务是否正在运行。`,
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw Error('服务返回的数据不完整，请检查本机服务。');
  if (!response.ok) {
    const message = (body as { error?: unknown }).error;
    throw Error(
      typeof message === 'string'
        ? message
        : `服务请求失败（HTTP ${response.status}）。`,
    );
  }
  return body as T;
}
export async function reconstructionService(transport: Transport) {
  return json<ReconstructionService>(
    await request('/api/reconstruction', {}, transport),
  );
}
export class ReconstructionSubmissionUnknown extends Error {}
export async function submitReconstruction(
  image: string,
  transport: Transport,
) {
  transport.signal.throwIfAborted();
  let response: Response;
  try {
    response = await request(
      '/api/reconstruction',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image }),
      },
      { ...transport, requestTimeout: transport.requestTimeout ?? 60000 },
    );
  } catch {
    throw new ReconstructionSubmissionUnknown(
      '提交结果未知：服务端可能已经创建任务。请勿直接重复提交；先检查服务端任务，再重新上传。',
    );
  }
  // A gateway/server failure can occur after the provider has accepted a paid
  // task (the cloud route also uses 502 for a missing upstream handle). Do not
  // treat a 5xx/408 response as proof that no task was created.
  if (response.status >= 500 || response.status === 408) {
    let detail = `服务返回 HTTP ${response.status}`;
    try {
      await json<ReconstructionJob>(response);
    } catch (error) {
      if (error instanceof Error) detail = error.message;
    }
    throw new ReconstructionSubmissionUnknown(
      `${detail} 提交结果未知：请先核对服务端任务，勿直接重复提交。`,
    );
  }
  // Explicit validation/auth/quota rejection is safe to retry after correction.
  if (!response.ok) return json<ReconstructionJob>(response);
  try {
    const body = await json<Partial<ReconstructionJob>>(response);
    if (
      typeof body.id !== 'string' ||
      !body.id ||
      typeof body.ticket !== 'string' ||
      !body.ticket
    )
      throw Error('服务没有返回任务凭证。');
    return { id: body.id, ticket: body.ticket };
  } catch {
    throw new ReconstructionSubmissionUnknown(
      '服务没有返回有效任务凭证，提交结果未知。请勿重复提交，先检查服务端任务。',
    );
  }
}
export function reconstructionQuery(job: ReconstructionJob) {
  return `?id=${encodeURIComponent(job.id)}&ticket=${encodeURIComponent(job.ticket)}`;
}
export function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function followReconstruction(
  job: ReconstructionJob,
  transport: Transport & {
    onProgress?: (status: ReconstructionStatus) => void;
    attempts?: number;
    interval?: number;
    delay?: typeof abortableDelay;
  },
): Promise<ArrayBuffer> {
  const query = reconstructionQuery(job);
  for (let i = 0; i < (transport.attempts ?? 180); i++) {
    transport.signal.throwIfAborted();
    const statusResponse = await request(
      '/api/reconstruction' + query,
      {},
      transport,
    );
    if (statusResponse.status === 403)
      throw new ReconstructionStopped(
        '任务凭证已失效（本机服务可能已重启）。请重新生成。',
      );
    const status = await json<ReconstructionStatus>(statusResponse);
    transport.signal.throwIfAborted();
    transport.onProgress?.({
      ...status,
      progress:
        typeof status.progress === 'number' && Number.isFinite(status.progress)
          ? Math.max(0, Math.min(100, status.progress))
          : undefined,
    });
    if (status.status === 'FAILED' || status.status === 'CANCELED')
      throw new ReconstructionStopped(
        status.error || '三维任务已停止，请重新生成。',
      );
    if (status.ready === true) {
      const response = await request(
        '/api/reconstruction' + query + '&download=1',
        {},
        transport,
      );
      if (!response.ok) await json(response);
      const buffer = await response.arrayBuffer();
      transport.signal.throwIfAborted();
      if (buffer.byteLength < 12)
        throw Error('下载的三维模型不完整，请继续查看任务重试。');
      return buffer;
    }
    await (transport.delay ?? abortableDelay)(
      transport.interval ?? 5000,
      transport.signal,
    );
  }
  throw Error('任务仍在运行。请点击“继续查看任务”，不会重新提交图片。');
}
