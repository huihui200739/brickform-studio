// oxlint-disable-next-line import/default -- Vite's query exports the emitted worker URL.
import workerUrl from './image-design.worker.ts?worker&url';

/** One cancellable job per worker; never leave a pending promise on termination. */
export function workspaceWorker<T>(
  payload: unknown,
  result: 'model' | 'mesh' | 'design',
  signal: AbortSignal,
  timeout = 120000,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(workerUrl, window.location.href), {
      type: 'module',
    });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(Error('转换用时过长，请降低尺寸后重试。'));
    }, timeout);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<Record<string, unknown>>) => {
      cleanup();
      if (typeof event.data.error === 'string') reject(Error(event.data.error));
      else if (event.data[result]) resolve(event.data[result] as T);
      else reject(Error('转换没有返回模型，请重新生成。'));
    };
    worker.onerror = () => {
      cleanup();
      reject(Error('转换程序无法启动，请刷新页面后重试。'));
    };
    if (signal.aborted) return abort();
    try {
      worker.postMessage(payload);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}
