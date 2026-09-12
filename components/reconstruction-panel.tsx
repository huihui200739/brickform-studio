'use client';
import { useEffect, useRef, useState } from 'react';
import { Box, Upload, LoaderCircle } from 'lucide-react';
import type { Model } from '@/lib/brick-engine';
import { PALETTE } from '@/lib/brick-engine';
import type { TriangleMesh } from '@/lib/mesh-types';
import { readGLB } from '@/lib/read-glb';
import MeshDraftViewer from './mesh-draft-viewer';
// oxlint-disable-next-line import/default -- Vite exports the public worker asset URL.
import workerUrl from '@/lib/image-design.worker.ts?worker&url';

type ApiResponse = {
  configured?: boolean;
  provider?: string;
  error?: string;
  status?: string;
  progress?: number;
  ready?: boolean;
  id?: string;
  ticket?: string;
};
type Job = { id: string; ticket: string };
export default function ReconstructionPanel({
  image,
  name,
  resolution,
  onModel,
}: {
  image?: string;
  name: string;
  resolution: number;
  onModel: (model: Model) => void;
}) {
  const [configured, setConfigured] = useState<boolean | null>(null),
    [provider, setProvider] = useState(''),
    [error, setError] = useState(''),
    [phase, setPhase] = useState(''),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [glbUrl, setGlbUrl] = useState(''),
    [job, setJob] = useState<Job | null>(null),
    [draft, setDraft] = useState<TriangleMesh | null>(null);
  const alive = useRef(true),
    controller = useRef<AbortController | null>(null),
    worker = useRef<Worker | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    alive.current = true;
    const c = new AbortController();
    void fetch('/api/reconstruction', { signal: c.signal })
      .then(async (r) => {
        const body = (await r.json()) as ApiResponse;
        if (!r.ok) throw Error(body.error || '无法查询服务状态');
        if (alive.current) {
          setConfigured(!!body.configured);
          setProvider(body.provider || '');
        }
      })
      .catch((e) => {
        if (alive.current && e.name !== 'AbortError')
          setError('无法查询三维服务状态，请刷新页面。');
      });
    return () => {
      alive.current = false;
      c.abort();
      controller.current?.abort();
      worker.current?.terminate();
    };
  }, []);
  useEffect(
    () => () => {
      if (glbUrl) URL.revokeObjectURL(glbUrl);
    },
    [glbUrl],
  );
  async function api(path: string, init?: RequestInit) {
    const r = await fetch('/api/reconstruction' + path, {
      ...init,
      signal: controller.current?.signal,
    });
    const body = (await r.json()) as ApiResponse;
    if (!r.ok) throw Error(body.error || '三维服务请求失败。');
    return body;
  }
  async function follow(task: Job) {
    for (let attempt = 0; attempt < 180; attempt++) {
      if (!alive.current) return;
      const q = `?id=${encodeURIComponent(task.id)}&ticket=${encodeURIComponent(task.ticket)}`;
      const status = await api(q);
      setProgress(status.progress || 0);
      if (status.status === 'FAILED' || status.status === 'CANCELED')
        throw Error(status.error || '三维任务已停止。');
      if (status.ready) {
        setPhase('正在读取三维草稿');
        const r = await fetch('/api/reconstruction' + q + '&download=1', {
          signal: controller.current?.signal,
        });
        if (!r.ok) {
          const e = (await r.json()) as ApiResponse;
          throw Error(e.error || '模型下载失败');
        }
        const buffer = await r.arrayBuffer();
        const mesh = await readGLB(buffer, name);
        if (alive.current) {
          setGlbUrl(
            URL.createObjectURL(
              new Blob([buffer], { type: 'model/gltf-binary' }),
            ),
          );
          setDraft(mesh);
          setPhase('草稿已就绪，请旋转检查形状');
        }
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const signal = controller.current?.signal;
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException('Stopped', 'AbortError'));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', abort);
          resolve();
        }, 5000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
    throw Error('任务仍在运行。请稍后点击“继续查看任务”，不会重新扣费提交。');
  }
  async function reconstruct(resume = false) {
    setError('');
    setBusy(true);
    setPhase('正在提交图片');
    controller.current = new AbortController();
    try {
      if (!resume && !image) throw Error('请先上传图片。');
      const task =
        resume && job
          ? job
          : ((await api('', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ image }),
            })) as Job);
      if (!task.id || !task.ticket)
        throw Error('服务没有返回任务凭证，请检查服务状态后重试。');
      setJob(task);
      setPhase('正在重建三维结构');
      await follow(task);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : '三维重建失败。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function importMesh(file?: File) {
    if (!file) return;
    setError('');
    setBusy(true);
    setPhase('正在读取 GLB 模型');
    try {
      if (
        !file.name.toLowerCase().endsWith('.glb') ||
        file.size > 24 * 1024 * 1024
      )
        throw Error('请选择不超过 24 MB 的 GLB 文件。');
      const buffer = await file.arrayBuffer();
      const mesh = await readGLB(
        buffer,
        file.name.replace(/\.glb$/i, '').slice(0, 24),
      );
      if (alive.current) {
        setGlbUrl(
          URL.createObjectURL(
            new Blob([buffer], { type: 'model/gltf-binary' }),
          ),
        );
        setDraft(mesh);
        setPhase('已导入三维网格，请检查方向与体积');
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : '无法读取模型。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function convert() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setPhase('正在把三维体积转换为积木，并检查连接');
    try {
      const model = await new Promise<Model>((resolve, reject) => {
        const w = new Worker(new URL(workerUrl, window.location.href), {
          type: 'module',
        });
        worker.current = w;
        const cleanup = () => {
          clearTimeout(timer);
          w.terminate();
          worker.current = null;
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(Error('转换超时，请降低积木尺寸。'));
        }, 90000);
        w.onmessage = (event) => {
          cleanup();
          if (event.data.model) resolve(event.data.model);
          else reject(Error(event.data.error || '转换失败。'));
        };
        w.onerror = () => {
          cleanup();
          reject(Error('积木转换程序未能启动，请刷新后重试。'));
        };
        w.postMessage({ mesh: draft, options: { resolution } });
      });
      if (alive.current) {
        onModel(model);
        setPhase(
          `积木已生成：${model.bricks.length} 块。可在下方对照模型、清单与步骤。`,
        );
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : '积木转换失败。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function recolor(hex: string) {
    if (!draft) return;
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const colors = new Uint8Array(draft.colors.length);
    for (let i = 0; i < colors.length; i += 3) colors.set(rgb, i);
    setDraft({ ...draft, colors });
  }
  return (
    <section className="reconstruction-panel">
      <div className="reconstruction-heading">
        <Box size={23} />
        <div>
          <h2>先还原三维结构，再生成积木</h2>
          <p>① 上传参考图 → ② 检查三维草稿 → ③ 生成积木与步骤</p>
        </div>
      </div>
      {configured === false && (
        <div className="reconstruction-message">
          <strong>无需 Meshy 账号，也可以在 Mac 上生成</strong>
          <p>
            使用已安装的本机重建工作台，图片留在电脑上处理，无按次调用费。
            启动本机工作台后，从下方入口上传图片。也可以直接导入其他工具生成的
            GLB。
          </p>
          <a href="http://localhost:3000/" target="_blank" rel="noreferrer">
            打开本机重建工作台 ↗
          </a>
        </div>
      )}
      <div className="reconstruction-actions">
        <button
          className="primary"
          disabled={busy || !configured || !image || !!job}
          onClick={() => void reconstruct()}
        >
          {busy ? (
            <LoaderCircle size={17} className="spin" />
          ) : (
            <Box size={17} />
          )}
          {provider === 'local' ? '在本机生成三维草稿' : '生成三维草稿'}
        </button>
        {job && (
          <button disabled={busy} onClick={() => void reconstruct(true)}>
            继续查看任务
          </button>
        )}
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          accept=".glb"
          aria-label="导入 GLB 三维模型"
          onChange={(e) => {
            void importMesh(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
        <button disabled={busy} onClick={() => fileInput.current?.click()}>
          <Upload size={16} />
          导入已有 GLB
        </button>
      </div>
      <p className="reconstruction-cost">
        {provider === 'local'
          ? '本机 Hunyuan3D · 无需账号。先生成不带纹理的形状草稿，颜色可稍后调整。请保持工作台和本机程序开启。'
          : configured
            ? '云端生成会将图片发送给 Meshy，并使用其 API 额度。'
            : '在线工作台可以导入 GLB；无账号图片重建在本机工作台运行。'}{' '}
        草稿仍可能推测错误，请先检查形状再转换。
      </p>
      {phase && (
        <output className="reconstruction-status">
          {phase}
          {busy && job && !draft ? ` · ${progress}%` : ''}
        </output>
      )}
      {error && (
        <p className="reconstruction-error" role="alert">
          {error}
        </p>
      )}
      {draft ? (
        <>
          <MeshDraftViewer mesh={draft} />
          <label className="reconstruction-color">
            单色积木配色
            <select
              disabled={busy}
              defaultValue=""
              onChange={(e) => {
                if (e.target.value) recolor(e.target.value);
              }}
            >
              <option value="" disabled>
                保留当前颜色
              </option>
              {PALETTE.map((color) => (
                <option key={color.hex} value={color.hex}>
                  {color.name}
                </option>
              ))}
            </select>
            <span>无纹理草稿可选单色；这不会还原照片纹理。</span>
          </label>
          <div className="reconstruction-actions">
            {glbUrl && (
              <a href={glbUrl} download={`${name}-三维草稿.glb`}>
                下载原始三维草稿
              </a>
            )}
            <button
              className="primary"
              disabled={busy}
              onClick={() => void convert()}
            >
              形状已检查，转换为积木
            </button>
            <span>
              按左侧 {resolution} 凸点尺寸转换 ·{' '}
              {Math.round(draft.positions.length / 9).toLocaleString()} 个三角面
            </span>
          </div>
          <p className="field-hint">
            检查台阶、门洞和前后体积是否存在。若草稿不像原图，请先换图或调整三维模型，不要用增加积木数量弥补。
          </p>
        </>
      ) : (
        <div className="reconstruction-empty">
          <Box size={38} />
          <h3>三维草稿将在这里显示</h3>
          <p>上传主体清晰的图片，或导入 GLB。这里不会用旧模型冒充新结果。</p>
        </div>
      )}
    </section>
  );
}
