'use client';
import { useEffect, useRef, useState } from 'react';
import { Box, Upload, LoaderCircle } from 'lucide-react';
import type { Model, Raster } from '@/lib/brick-engine';
import { PALETTE } from '@/lib/brick-engine';
import type { TriangleMesh } from '@/lib/mesh-types';
import { readGLB } from '@/lib/read-glb';
import ComponentEditor from './component-editor';
import PlacementReview from './placement-review';
import type { PlacementReport } from '@/lib/placement-policy';
import type { ComponentRegion } from '@/lib/semantic-components';
import { VIEW_LABELS, type ViewAxis } from '@/lib/multiview';
import { estimatePitch } from '@/lib/brick-reader';
import { referenceMask } from '@/lib/reference-colors';
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
    [picking, setPicking] = useState(false),
    [autoComponents, setAutoComponents] = useState(true),
    [statueGuess, setStatueGuess] = useState(true),
    [componentNote, setComponentNote] = useState(''),
    [placementReports, setPlacementReports] = useState<PlacementReport[]>([]),
    [autoBusy, setAutoBusy] = useState(false);
  // Three-view mode: outlines are intersected instead of guessing a volume.
  const [inputMode, setInputMode] = useState<'single' | 'views' | 'face'>(
      'single',
    ),
    [face, setFace] = useState<{
      raster: Raster;
      preview: string;
      coverage: number;
      spanX: number;
      studs: number;
      auto: number;
    } | null>(null),
    [faceDepth, setFaceDepth] = useState(8),
    [faceError, setFaceError] = useState(''),
    [views, setViews] = useState<
      Partial<
        Record<
          ViewAxis,
          {
            raster: Raster;
            url: string;
            preview: string;
            coverage: number;
            mirrored: boolean;
          }
        >
      >
    >({}),
    [viewError, setViewError] = useState('');
  const faceInput = useRef<HTMLInputElement | null>(null),
    viewFiles = useRef<Partial<Record<ViewAxis, HTMLInputElement | null>>>({}),
    viewsRef = useRef(views);
  viewsRef.current = views;
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
  const autoGeneration = useRef(0);
  const alive = useRef(true),
    controller = useRef<AbortController | null>(null),
    worker = useRef<Worker | null>(null),
    fileInput = useRef<HTMLInputElement>(null),
    original = useRef<TriangleMesh | null>(null),
    referenceUrl = useRef(''),
    autoDone = useRef<{ mesh: TriangleMesh | null; key: string }>({
      mesh: null,
      key: '',
    });
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
  async function runWorkerMessage(
    payload: unknown,
    timeout = 90000,
  ): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const w = new Worker(new URL(workerUrl, window.location.href), {
        type: 'module',
      });
      worker.current = w;
      const cleanup = () => {
        clearTimeout(timer);
        w.terminate();
        if (worker.current === w) worker.current = null;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(Error('转换超时，请降低积木尺寸。'));
      }, timeout);
      w.onmessage = (event) => {
        cleanup();
        const data = event.data as Record<string, unknown>;
        if (data.error) reject(Error(String(data.error)));
        else resolve(data);
      };
      w.onerror = () => {
        cleanup();
        reject(Error('积木转换程序未能启动，请刷新后重试。'));
      };
      w.postMessage(payload);
    });
  }
  async function runWorker<T>(
    payload: unknown,
    result: 'mesh' | 'model',
  ): Promise<T> {
    const data = await runWorkerMessage(payload);
    if (data[result]) return data[result] as T;
    throw Error('转换失败。');
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
  // Ignore stale requests when geometry or options change. Recolouring alone
  // preserves confirmed mounting points instead of starting another search.
  useEffect(() => {
    if (!draft) {
      autoGeneration.current++;
      setAutoBusy(false);
      setPlacementReports([]);
      return;
    }
    const key = `${autoComponents ? 1 : 0}:${statueGuess ? 1 : 0}:${resolution}`;
    if (autoDone.current.mesh === draft && autoDone.current.key === key) return;
    // A manual single-colour override keeps the same geometry: the components
    // were found from the reference picture, so they stay where they are.
    const recoloured =
      !draft.coloring &&
      !!autoDone.current.mesh &&
      autoDone.current.mesh.positions === draft.positions;
    const sameOptions = autoDone.current.key === key;
    autoDone.current = { mesh: draft, key };
    if (recoloured && sameOptions) {
      autoGeneration.current++;
      setAutoBusy(false);
      return;
    }
    setPlacementReports([]);
    if (!autoComponents) {
      autoGeneration.current++;
      setAutoBusy(false);
      setRegions([]);
      setSelected('');
      setComponentNote(
        '已关闭自动放入目录组件：将直接按网格转换，也可以在下方手动添加。',
      );
      return;
    }
    void autoDetect(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, autoComponents, statueGuess, resolution]);
  async function autoDetect(mesh: TriangleMesh) {
    const generation = ++autoGeneration.current;
    setAutoBusy(true);
    setComponentNote('正在自动识别枝叶、火焰与人物候选，并检查安装位置…');
    try {
      const data = await runWorkerMessage({
        action: 'components',
        mesh,
        options: { resolution },
        statue: statueGuess,
      });
      if (!alive.current || generation !== autoGeneration.current) return;
      const found = (data.regions as ComponentRegion[]) || [],
        dropped = (data.dropped as string[]) || [];
      setRegions(found);
      setPlacementReports((data.reports as PlacementReport[]) || []);
      setSelected('');
      setPicking(false);
      setComponentNote(
        found.length
          ? `找到 ${found.length} 处候选，${found.length - dropped.length} 件可在原位附近安装${dropped.length ? `，${dropped.length} 处需要调整，保留原网格` : ''}。请查看位置检查。`
          : '没有找到可靠的枝叶、火焰或人物候选；将直接按网格转换，也可以在下方手动添加。',
      );
    } catch (e) {
      if (alive.current && generation === autoGeneration.current) {
        setRegions([]);
        setPlacementReports([]);
        setComponentNote(
          `自动放置未完成（${e instanceof Error ? e.message : '未知错误'}），将直接按网格转换。`,
        );
      }
    } finally {
      if (alive.current && generation === autoGeneration.current)
        setAutoBusy(false);
    }
  }
  async function convert() {
    if (!draft) return;
    setBusy(true);
    setError('');
    setPhase('正在把三维体积转换为积木，并检查连接');
    try {
      const data = await runWorkerMessage({
        mesh: draft,
        options: { resolution },
        regions,
      });
      const model = data.model as Model;
      if (alive.current) {
        const applied = Number(data.applied || 0),
          dropped = (data.dropped as string[]) || [];
        setRegions((data.regions as ComponentRegion[]) || regions);
        setPlacementReports((data.reports as PlacementReport[]) || []);
        onModel(model);
        setPhase(
          `积木已生成：${model.bricks.length} 块，${model.meshDesign?.smoothTiles || 0} 块光面收口${applied ? `，含 ${applied} 件目录组件` : ''}${dropped.length ? `；${dropped.length} 件组件未能在原位附近安装，保留原网格` : ''}。清单与步骤已同步。`,
        );
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : '积木转换失败。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function loadView(axis: ViewAxis, file?: File) {
    if (!file) return;
    setViewError('');
    try {
      if (!file.type.startsWith('image/'))
        throw Error('请选择 PNG、JPG 或 WebP 图片。');
      const url = URL.createObjectURL(file),
        img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 480 / Math.max(img.width, img.height)),
        canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('无法读取这张图片。');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const raster: Raster = {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
      // What the carver will treat as the object, drawn over the picture, so a
      // shadow or a background that was not separated is visible straight away.
      const { mask } = referenceMask(raster);
      let subject = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) subject++;
      const overlay = ctx.getImageData(0, 0, canvas.width, canvas.height),
        pixels = overlay.data;
      for (let i = 0; i < mask.length; i++)
        if (!mask[i]) {
          pixels[i * 4] = Math.round(pixels[i * 4] * 0.35 + 210 * 0.65);
          pixels[i * 4 + 1] = Math.round(pixels[i * 4 + 1] * 0.35 + 60 * 0.65);
          pixels[i * 4 + 2] = Math.round(pixels[i * 4 + 2] * 0.35 + 60 * 0.65);
        }
      ctx.putImageData(overlay, 0, 0);
      const preview = canvas.toDataURL('image/png');
      setViews((current) => {
        const previous = current[axis];
        if (previous) URL.revokeObjectURL(previous.url);
        return {
          ...current,
          [axis]: {
            raster,
            url,
            preview,
            coverage: subject / mask.length,
            mirrored: previous?.mirrored || false,
          },
        };
      });
    } catch (e) {
      if (alive.current)
        setViewError(e instanceof Error ? e.message : '无法读取这张图片。');
    }
  }
  function removeView(axis: ViewAxis) {
    setViews((current) => {
      const view = current[axis];
      if (view) URL.revokeObjectURL(view.url);
      const next = { ...current };
      delete next[axis];
      return next;
    });
    setViewError('');
  }
  async function carveViews() {
    const list = (['front', 'side', 'top'] as ViewAxis[])
      .filter((axis) => views[axis])
      .map((axis) => ({
        axis,
        image: views[axis]!.raster,
        mirrored: views[axis]!.mirrored,
      }));
    setBusy(true);
    setViewError('');
    try {
      if (list.length < 2)
        throw Error('请至少上传正视图和侧视图：一个方向的轮廓无法确定体积。');
      const data = await runWorkerMessage({
        action: 'views',
        views: list,
        options: { resolution },
        name: '三视图积木',
      });
      const model = data.model as Model;
      if (alive.current) {
        onModel(model);
        setPhase(
          `三视图雕刻完成：${model.bricks.length} 块零件，体积由轮廓相交得到，没有经过生成式推测。`,
        );
      }
    } catch (e) {
      if (alive.current)
        setViewError(e instanceof Error ? e.message : '三视图转换失败。');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function loadFace(file?: File) {
    if (!file) return;
    setFaceError('');
    try {
      if (!file.type.startsWith('image/'))
        throw Error('请选择 PNG、JPG 或 WebP 图片。');
      const url = URL.createObjectURL(file),
        img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(1, 720 / Math.max(img.width, img.height)),
        canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('无法读取这张图片。');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const raster: Raster = {
        width: canvas.width,
        height: canvas.height,
        data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      };
      URL.revokeObjectURL(url);
      const { mask, left, right } = referenceMask(raster);
      let subject = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) subject++;
      const overlay = ctx.getImageData(0, 0, canvas.width, canvas.height),
        pixels = overlay.data;
      for (let i = 0; i < mask.length; i++)
        if (!mask[i]) {
          pixels[i * 4] = Math.round(pixels[i * 4] * 0.3 + 210 * 0.7);
          pixels[i * 4 + 1] = Math.round(pixels[i * 4 + 1] * 0.3 + 60 * 0.7);
          pixels[i * 4 + 2] = Math.round(pixels[i * 4 + 2] * 0.3 + 60 * 0.7);
        }
      ctx.putImageData(overlay, 0, 0);
      const spanX = right - left + 1,
        estimate = estimatePitch(raster),
        auto = estimate.pitch
          ? Math.max(4, Math.round(spanX / estimate.pitch))
          : 0;
      setFace({
        raster,
        preview: canvas.toDataURL('image/png'),
        coverage: subject / mask.length,
        spanX,
        studs: auto || 40,
        auto,
      });
      if (!auto || estimate.confidence < 0.35)
        setFaceError(
          '凸点间距没有可靠识别出来，请手动填写正面宽度（凸点数）—— 可以数底板上的凸点。',
        );
    } catch (e) {
      if (alive.current)
        setFaceError(e instanceof Error ? e.message : '无法读取这张图片。');
    }
  }
  async function readFace() {
    if (!face) return;
    setBusy(true);
    setFaceError('');
    try {
      const data = await runWorkerMessage({
        action: 'blueprint',
        raster: face.raster,
        pitch: face.spanX / Math.max(2, face.studs),
        depth: faceDepth,
        options: { resolution },
        name: '正面图纸',
      });
      const model = data.model as Model;
      if (alive.current) {
        onModel(model);
        setPhase(
          `正面图纸：读出 ${model.blueprintDesign?.bricks ?? 0} 块零件，正面宽度 ${model.blueprintDesign?.studs ?? 0} 凸点。`,
        );
      }
    } catch (e) {
      if (alive.current)
        setFaceError(e instanceof Error ? e.message : '读图失败。');
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
  const modeSwitch = (
    <div className="reconstruction-actions input-mode-switch">
      <button
        className={inputMode === 'single' ? 'primary' : ''}
        aria-pressed={inputMode === 'single'}
        onClick={() => setInputMode('single')}
      >
        单图重建
      </button>
      <button
        className={inputMode === 'views' ? 'primary' : ''}
        aria-pressed={inputMode === 'views'}
        onClick={() => setInputMode('views')}
      >
        三视图重建
      </button>
      <button
        className={inputMode === 'face' ? 'primary' : ''}
        aria-pressed={inputMode === 'face'}
        onClick={() => setInputMode('face')}
      >
        正面图纸
      </button>
      <span>
        {inputMode === 'views'
          ? '正交轮廓相交求体积：不做 AI 推测，也不会因相机拟合而错位。'
          : inputMode === 'face'
            ? '参考图本身就是乐高模型时，直接读出砖块排布。'
            : '一张图重建三维草稿，背面与配色为推测。'}
      </span>
    </div>
  );
  if (inputMode === 'face')
    return (
      <section className="reconstruction-panel">
        <div className="reconstruction-heading">
          <Box size={23} />
          <div>
            <h2>正面图纸</h2>
            <p>按凸点间距读出正面的砖块排布，逐块还原。</p>
          </div>
        </div>
        {modeSwitch}
        <p className="field-hint">
          需要一张<strong>正对</strong>
          的乐高模型图（正交或接近正交、无明显透视）。
          凸点间距从图上的凸点周期估计，估不准时请手动填写正面宽度 ——
          数一下底板上的凸点即可。
          只有正面被读到：侧面、背面与内部结构是假设值。
        </p>
        <div className="view-slots single">
          <div className={`view-slot ${face ? 'ready' : ''}`}>
            <strong>
              正面图
              <small>必填</small>
            </strong>
            {face ? (
              <>
                <img src={face.preview} alt="正面图与识别到的主体" />
                <small className="view-slot-coverage">
                  主体占画面 {(face.coverage * 100).toFixed(0)}%
                </small>
              </>
            ) : (
              <span className="view-slot-empty">还没有图片</span>
            )}
            <div className="view-slot-actions">
              <button onClick={() => faceInput.current?.click()}>
                {face ? '换一张' : '选择图片'}
              </button>
            </div>
            <input
              ref={faceInput}
              className="sr-only"
              type="file"
              accept="image/*"
              aria-label="上传正面图"
              onChange={(e) => {
                void loadFace(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>
          <div className="face-fields">
            <label>
              正面宽度（凸点）
              <input
                type="number"
                min="4"
                max="200"
                value={face?.studs ?? 40}
                disabled={!face}
                onChange={(e) =>
                  setFace((current) =>
                    current
                      ? {
                          ...current,
                          studs: Math.max(
                            4,
                            Math.min(200, +e.target.value || 4),
                          ),
                        }
                      : current,
                  )
                }
              />
              <small>
                {face?.auto
                  ? `自动估计 ${face.auto} 凸点`
                  : '自动估计不可靠，请手动填写'}
              </small>
            </label>
            <label>
              进深（凸点）
              <input
                type="number"
                min="2"
                max="48"
                value={faceDepth}
                onChange={(e) =>
                  setFaceDepth(Math.max(2, Math.min(48, +e.target.value || 2)))
                }
              />
              <small>侧面读不到，按此值拉伸</small>
            </label>
          </div>
        </div>
        <div className="reconstruction-actions convert-actions">
          <button
            className="primary"
            disabled={busy || !face}
            onClick={() => void readFace()}
          >
            {busy ? <LoaderCircle size={17} className="spin" /> : null}
            生成积木成品 →
          </button>
          <span>{resolution} 凸点精度 · 正面逐块还原，进深为假设值</span>
        </div>
        {phase && <output className="reconstruction-status">{phase}</output>}
        {faceError && (
          <p className="reconstruction-error" role="alert">
            {faceError}
          </p>
        )}
      </section>
    );
  if (inputMode === 'views')
    return (
      <section className="reconstruction-panel">
        <div className="reconstruction-heading">
          <Box size={23} />
          <div>
            <h2>三视图重建</h2>
            <p>正 / 侧 / 俯三个轮廓相交，直接算出体积。</p>
          </div>
        </div>
        {modeSwitch}
        <p className="field-hint">
          三张图必须是<strong>同一个模型</strong>
          的正交投影，不是分别画出来的三张插画： 可以用同一个三维模型导出正交正
          / 侧 / 俯视图，或让图像工具生成时明确要求
          「正交投影、无透视、无光影、纯色背景、同一模型同一比例」。
          侧视图按「从右侧看」：物体正面在画面左边；俯视图按「从上方看」：物体正面在画面下方，
          方向不对时点「左右翻转」。
        </p>
        <p className="field-hint">
          俯视图可选，而且只有<strong>真正的平面图</strong>
          才有用：如果俯视图还能看到塔的竖直侧面，
          那是鸟瞰透视图，会把体积撑大，请直接不要上传它，只用正视 + 侧视。
          三张图的比例对不上时（宽深比差 15% 以上）会直接报错并给出数字。
        </p>
        <div className="view-slots">
          {(['front', 'side', 'top'] as ViewAxis[]).map((axis) => (
            <div
              className={`view-slot ${views[axis] ? 'ready' : ''}`}
              key={axis}
            >
              <strong>
                {VIEW_LABELS[axis]}
                <small>{axis === 'top' ? '可选' : '必填'}</small>
              </strong>
              {views[axis] ? (
                <>
                  <img
                    className={views[axis]!.mirrored ? 'mirrored' : ''}
                    src={views[axis]!.preview}
                    alt={`${VIEW_LABELS[axis]}参考图与识别到的主体`}
                  />
                  <small className="view-slot-coverage">
                    主体占画面 {(views[axis]!.coverage * 100).toFixed(0)}%
                    {views[axis]!.coverage > 0.85
                      ? ' · 背景可能没有分离干净'
                      : ''}
                  </small>
                </>
              ) : (
                <span className="view-slot-empty">还没有图片</span>
              )}
              <div className="view-slot-actions">
                <button onClick={() => viewFiles.current[axis]?.click()}>
                  {views[axis] ? '换一张' : '选择图片'}
                </button>
                {views[axis] && (
                  <>
                    <button
                      className={views[axis]!.mirrored ? 'active' : ''}
                      onClick={() =>
                        setViews((current) => ({
                          ...current,
                          [axis]: {
                            ...current[axis]!,
                            mirrored: !current[axis]!.mirrored,
                          },
                        }))
                      }
                    >
                      左右翻转
                    </button>
                    <button onClick={() => removeView(axis)}>移除</button>
                  </>
                )}
              </div>
              <input
                ref={(node) => {
                  viewFiles.current[axis] = node;
                }}
                className="sr-only"
                type="file"
                accept="image/*"
                aria-label={`上传${VIEW_LABELS[axis]}图片`}
                onChange={(e) => {
                  void loadView(axis, e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
          ))}
        </div>
        <div className="reconstruction-actions convert-actions">
          <button
            className="primary"
            disabled={busy || Object.keys(views).length < 2}
            onClick={() => void carveViews()}
          >
            {busy ? <LoaderCircle size={17} className="spin" /> : null}
            生成积木成品 →
          </button>
          <span>
            {resolution} 凸点精度 ·{' '}
            {Object.keys(views).length < 2
              ? '至少需要正视与侧视'
              : `已上传 ${Object.keys(views).length} 个视图`}
          </span>
        </div>
        {phase && <output className="reconstruction-status">{phase}</output>}
        {viewError && (
          <p className="reconstruction-error" role="alert">
            {viewError}
          </p>
        )}
        <p className="field-hint">
          只能复活轮廓里有的东西：被遮挡的凹面、任何视图都看不到的内部结构无法恢复，
          也不能凭空加出照片里没有的细节。转换后仍会做零件连接检查。
        </p>
      </section>
    );
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
      {modeSwitch}
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
              if (busy || autoBusy) return;
              setRegions((current) =>
                current.map((r) =>
                  r.id === selected
                    ? {
                        ...r,
                        anchor,
                        referenceAnchor: anchor,
                        positionLocked: true,
                        placed: true,
                        placementStatus: undefined,
                      }
                    : r,
                ),
              );
              setPlacementReports((current) =>
                current.filter((r) => r.id !== selected),
              );
              setPicking(false);
            }}
          />
          <ComponentEditor
            disabled={busy || autoBusy}
            mesh={draft}
            resolution={resolution}
            regions={regions}
            onChange={(next) => {
              setRegions(next);
              setPlacementReports([]);
            }}
            selected={selected}
            onSelect={setSelected}
            picking={picking}
            onPicking={setPicking}
            autoStatus={componentNote}
            autoBusy={autoBusy}
            onAuto={() => void autoDetect(draft)}
          />
          <PlacementReview
            reports={placementReports}
            onSelect={(id) => {
              setSelected(id);
              setPicking(false);
            }}
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
              disabled={busy || autoBusy}
              onClick={() => void convert()}
            >
              {busy ? <LoaderCircle size={17} className="spin" /> : null}
              生成积木成品 →
            </button>
            <span>{resolution} 凸点精度 · 同步生成零件清单与拼装步骤</span>
          </div>
          <label className="reconstruction-color">
            <input
              type="checkbox"
              checked={autoComponents}
              disabled={busy}
              onChange={(e) => setAutoComponents(e.target.checked)}
            />
            自动放入目录组件{' '}
            <span>
              自动识别火焰，并按形状猜测树与人物位置；位置仅供复核，可随时移除。
            </span>
          </label>
          <label className="reconstruction-color">
            <input
              type="checkbox"
              checked={statueGuess}
              disabled={busy || !autoComponents}
              onChange={(e) => setStatueGuess(e.target.checked)}
            />
            自动猜测树与人物位置{' '}
            <span>
              单张图片无法可靠识别它们：树按地面上孤立的深色小体积猜测，人物放在两个火盆之间，务必核对。
            </span>
          </label>
          {autoBusy && (
            <output className="reconstruction-status">
              正在自动放置目录组件并检查安装位置…
            </output>
          )}
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
