'use client';
import { useEffect, useRef, useState } from 'react';
import { Box, Upload, LoaderCircle } from 'lucide-react';
import type { Model, Raster } from '@/lib/brick-engine';
import { PALETTE } from '@/lib/brick-engine';
import type { TriangleMesh } from '@/lib/mesh-types';
import { readGLB } from '@/lib/read-glb';
import ComponentEditor from './component-editor';
import type { ComponentRegion } from '@/lib/semantic-components';
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
  active = true,
  image,
  name,
  resolution,
  onModel,
}: {
  active?: boolean;
  image?: string;
  name: string;
  resolution: number;
  onModel: (model: Model) => void;
}) {
  const [regions, setRegions] = useState<ComponentRegion[]>([]),
    [selected, setSelected] = useState(''),
    [picking, setPicking] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null),
    [provider, setProvider] = useState(''),
    [softenShadows, setSoftenShadows] = useState(true),
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
    fileInput = useRef<HTMLInputElement>(null),
    original = useRef<TriangleMesh | null>(null),
    referenceUrl = useRef('');
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
          original.current = mesh;
          setRegions([]);
          setSelected('');
          setPicking(false);
          setDraft(mesh);
          if (provider === 'local') {
            referenceUrl.current = '/api/reconstruction' + q + '&reference=1';
            try {
              const colored = await projectColors(mesh, referenceUrl.current);
              if (alive.current) setDraft(colored);
            } catch (e) {
              if (alive.current)
                setError(
                  `形状已保留，但参考图配色未完成：${e instanceof Error ? e.message : '请重试配色'}`,
                );
            }
          }
          if (alive.current) setPhase('草稿已就绪，请旋转检查形状与配色');
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
        original.current = mesh;
        setRegions([]);
        setSelected('');
        setPicking(false);
        referenceUrl.current = '';
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
  async function runWorker<T>(
    payload: unknown,
    result: 'mesh' | 'model',
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
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
        if (event.data[result]) resolve(event.data[result]);
        else reject(Error(event.data.error || '转换失败。'));
      };
      w.onerror = () => {
        cleanup();
        reject(Error('积木转换程序未能启动，请刷新后重试。'));
      };
      w.postMessage(payload);
    });
  }
  async function projectColors(mesh: TriangleMesh, url: string) {
    setPhase('正在对齐参考图视角并恢复配色');
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 320 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('无法读取参考图颜色。');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const raster: Raster = {
      width: canvas.width,
      height: canvas.height,
      data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    };
    return runWorker<TriangleMesh>(
      { action: 'color', mesh, raster, softenShadows },
      'mesh',
    );
  }
  async function applyReference() {
    if (!draft || !image) return;
    setBusy(true);
    setError('');
    try {
      const colored = await projectColors(
        original.current || draft,
        referenceUrl.current || image,
      );
      if (alive.current) {
        setDraft(colored);
        setPhase('参考图配色已应用，请检查颜色与形状后再转换');
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : '参考图配色失败。');
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
      const model = await runWorker<Model>(
        { mesh: draft, options: { resolution }, regions },
        'model',
      );
      if (alive.current) {
        onModel(model);
        setPhase(
          `积木已生成：${model.bricks.length} 块，${model.meshDesign?.smoothTiles || 0} 块光面收口。清单与步骤已同步。`,
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
    setDraft({ ...draft, colors, coloring: undefined });
  }
  if (!active) return null;
  return (
    <section className="reconstruction-panel">
      <div className="reconstruction-heading">
        <Box size={23} />
        <div>
          <h2>形状与配色</h2>
          <p>先检查草稿，再转换成可拼搭的零件。</p>
        </div>
      </div>
      {configured === false && (
        <div className="reconstruction-message">
          <strong>在本机免费重建三维草稿</strong>
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
        {job && !draft && (
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
          ? '本机处理 · 图片留在电脑上。背面形状与配色为推测。'
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
          <MeshDraftViewer
            mesh={draft}
            regions={regions}
            resolution={resolution}
            selected={selected}
            picking={picking}
            onPick={(anchor) => {
              if (busy) return;
              setRegions((current) =>
                current.map((r) =>
                  r.id === selected ? { ...r, anchor, placed: true } : r,
                ),
              );
              setPicking(false);
            }}
          />
          <ComponentEditor
            disabled={busy}
            mesh={draft}
            resolution={resolution}
            regions={regions}
            onChange={setRegions}
            selected={selected}
            onSelect={setSelected}
            picking={picking}
            onPicking={setPicking}
          />
          <details className="color-settings">
            <summary>
              调整配色{' '}
              <span>
                {draft.coloring ? '已应用参考图颜色' : '原始模型颜色'}
              </span>
            </summary>
            <div className="reconstruction-actions">
              <button
                disabled={busy || !image}
                onClick={() => void applyReference()}
              >
                按参考图恢复配色
              </button>
              <button
                disabled={busy || !original.current}
                onClick={() => {
                  if (original.current) setDraft(original.current);
                }}
              >
                恢复原始颜色
              </button>
              <span>
                {draft.coloring
                  ? '已按照片配色 · 背面颜色为估计'
                  : '可为无纹理模型恢复参考图配色'}
              </span>
            </div>
            <label className="reconstruction-color">
              <input
                type="checkbox"
                checked={softenShadows}
                disabled={busy}
                onChange={(e) => setSoftenShadows(e.target.checked)}
              />
              减少阴影杂色{' '}
              <span>
                修改后点击“按参考图恢复配色”；保留不同色相的装饰颜色。
              </span>
            </label>
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
              <span>可手动覆盖为单色，再点击“按参考图恢复配色”重新取色。</span>
            </label>
          </details>
          <div className="reconstruction-actions convert-actions">
            {glbUrl && (
              <a href={glbUrl} download={`${name}-三维草稿.glb`}>
                下载原始三维草稿
              </a>
            )}
            <button
              className="primary"
              disabled={busy || regions.some((r) => r.placed === false)}
              onClick={() => void convert()}
            >
              生成积木成品 →
            </button>
            <span>{resolution} 凸点精度 · 同步生成零件清单与拼装步骤</span>
          </div>
          <p className="field-hint">
            组件按真实零件尺寸装配；未标记区域继续按网格转换。人物关节、附件插接及具体颜色组合仍需复核。
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
