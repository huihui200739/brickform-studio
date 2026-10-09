'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Download,
  HelpCircle,
  LoaderCircle,
  Box,
  Sparkles,
} from 'lucide-react';
import AssemblyViewer from '@/components/assembly-viewer';
import ModelViewer from '@/components/model-viewer';
import MeshDraftViewer from '@/components/mesh-draft-viewer';
import BuildGuide from '@/components/build-guide';
import {
  PALETTE,
  toLDraw,
  validateModel,
  type Model,
  type Options,
} from '@/lib/brick-engine';
import type { TriangleMesh } from '@/lib/mesh-types';
import type { WorkspaceSource } from '@/lib/workspace-source';
import { readGLB } from '@/lib/read-glb';
import { colorDesignSummary } from '@/lib/color-design-summary';
import { workspaceWorker } from '@/lib/workspace-worker';
import {
  generateWorkspaceDesign,
  type WorkspaceDesignResult,
  type WorkspaceDesignQuality,
} from '@/lib/workspace-design';
import {
  reconstructionService,
  submitReconstruction,
  followReconstruction,
  ReconstructionStopped,
  ReconstructionSubmissionUnknown,
  type ReconstructionJob,
  type ReconstructionService,
} from '@/lib/workspace-reconstruction';
import {
  procurementReport,
  purchaseInventoryCSV,
} from '@/lib/purchase-inventory';
import { csv, download, manualHTML } from '@/lib/manual';
import './design-tokens.css';
import './workspace.css';
import './workspace-live.css';

type Draft =
  | { kind: 'mesh'; mesh: TriangleMesh }
  | { kind: 'image'; model: Model };
type Engine = 'mesh' | 'image';

export default function WorkspacePage({
  source,
  onBack,
}: {
  source: WorkspaceSource;
  onBack: () => void;
}) {
  const [service, setService] = useState<ReconstructionService | null>(null);
  const [serviceError, setServiceError] = useState('');
  const [serviceRevision, setServiceRevision] = useState(0);
  const [engine, setEngine] = useState<Engine>('image');
  const [resolution, setResolution] = useState(28);
  const [detailEnhancement, setDetailEnhancement] = useState(true);
  const [colorMode, setColorMode] = useState<'coherent' | 'clean' | 'faithful'>(
    'coherent',
  );
  const [quality, setQuality] = useState<WorkspaceDesignQuality | null>(null);
  const [depth, setDepth] = useState(8);
  const [background, setBackground] = useState<Options['background']>('auto');
  const [threshold, setThreshold] = useState(70);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionBlocked, setSubmissionBlocked] = useState(false);
  const submittingRef = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [job, setJob] = useState<ReconstructionJob | null>(null);
  const [help, setHelp] = useState(false);
  const [cloudConsent, setCloudConsent] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const pendingJob = useRef<ReconstructionJob | null>(null);
  const engineTouched = useRef(false);
  const local = service?.provider === 'local';

  useEffect(() => {
    alive.current = true;
    const statusController = new AbortController();
    void reconstructionService({ signal: statusController.signal })
      .then((status) => {
        if (statusController.signal.aborted) return;
        setService(status);
        if (
          !engineTouched.current &&
          status.configured &&
          status.provider === 'local'
        )
          setEngine('mesh');
      })
      .catch((e: unknown) => {
        if (!statusController.signal.aborted)
          setServiceError(
            e instanceof Error ? e.message : '无法查询三维服务。',
          );
      });
    return () => {
      alive.current = false;
      generation.current = generation.current + 1;
      statusController.abort();
      controller.current?.abort();
    };
  }, [serviceRevision]);

  function rememberJob(next: ReconstructionJob | null) {
    pendingJob.current = next;
    setJob(next);
  }
  function invalidate() {
    setModel(null);
    setError('');
    setNotice('');
    // A mesh is independent of packing precision; image drafts already include it.
    if (draft?.kind === 'image') setDraft(null);
  }
  async function task(
    work: (signal: AbortSignal, current: () => boolean) => Promise<void>,
  ) {
    if (active.current) return;
    active.current = true;
    const version = ++generation.current;
    const c = new AbortController();
    controller.current = c;
    const current = () =>
      alive.current && version === generation.current && !c.signal.aborted;
    setBusy(true);
    setError('');
    setNotice('');
    setProgress(null);
    try {
      await work(c.signal, current);
    } catch (e) {
      if (current()) {
        if (e instanceof ReconstructionStopped) rememberJob(null);
        if (e instanceof ReconstructionSubmissionUnknown)
          setSubmissionBlocked(true);
        setError(e instanceof Error ? e.message : '生成失败，请重试。');
      }
    } finally {
      if (version === generation.current) {
        active.current = false;
        controller.current = null;
        if (alive.current) {
          setBusy(false);
          setPhase('');
        }
      }
    }
  }
  function cancel() {
    if (submittingRef.current) return;
    controller.current?.abort();
    generation.current++;
    active.current = false;
    controller.current = null;
    setBusy(false);
    setPhase('');
    setNotice(
      pendingJob.current
        ? '已暂停查看。后台重建可能仍在运行，可继续查看同一任务，避免重复提交。'
        : '已取消转换，可以调整参数后重试。',
    );
  }
  function generateDraft() {
    if (submissionBlocked && engine === 'mesh') return;
    engineTouched.current = true;
    void task(async (signal, current) => {
      setModel(null);
      setDraft(null);
      if (engine === 'image') {
        setPhase('正在读取图片轮廓、匹配配色并计算连接');
        const next = await workspaceWorker<Model>(
          {
            raster: source.raster,
            name: source.name,
            options: { resolution, depth, threshold, background, mode: 'auto' },
          },
          'model',
          signal,
        );
        if (current()) setDraft({ kind: 'image', model: next });
        return;
      }
      if (!service?.configured)
        throw Error('三维服务未就绪，请选择本机轮廓模式或检查本地引擎安装。');
      if (!local && !cloudConsent)
        throw Error('请先确认将图片发送给云端重建服务。');
      let handle = pendingJob.current;
      if (!handle) {
        setPhase('正在向重建服务提交图片');
        submittingRef.current = true;
        setSubmitting(true);
        try {
          handle = await submitReconstruction(source.imageData, { signal });
          if (!current()) return;
          rememberJob(handle);
        } finally {
          submittingRef.current = false;
          if (alive.current) setSubmitting(false);
        }
      }
      setPhase(
        local ? '本机正在重建三维结构，请保持页面打开' : '云端正在重建三维结构',
      );
      const buffer = await followReconstruction(handle, {
        signal,
        onProgress: (status) => {
          if (current()) setProgress(status.progress ?? null);
        },
      });
      setProgress(null);
      setPhase('正在读取三维草稿和恢复参考图配色');
      const raw = await readGLB(buffer, source.name);
      signal.throwIfAborted();
      let mesh = raw;
      try {
        mesh = await workspaceWorker<TriangleMesh>(
          {
            action: 'color',
            mesh: raw,
            raster: source.analysisRaster,
            softenShadows: true,
            materialMode: colorMode === 'coherent' ? 'material-first' : 'radiance',
          },
          'mesh',
          signal,
        );
      } catch (e) {
        signal.throwIfAborted();
        if (current())
          setNotice(
            `形状已生成，参考图配色未完成，保留原网格颜色：${e instanceof Error ? e.message : '请重试'}`,
          );
      }
      if (current()) {
        setDraft({ kind: 'mesh', mesh });
        rememberJob(null);
      }
    });
  }
  function convert() {
    if (!draft) return;
    void task(async (signal, current) => {
      setQuality(null);
      setPhase('正在优化积木装配并检查零件连接');
      const design =
        draft.kind === 'mesh'
          ? await generateWorkspaceDesign(
              {
                mesh: draft.mesh,
                raster: source.analysisRaster,
                resolution,
                detailEnhancement,
                colorMode,
                signal,
                onPhase: (message) => {
                  if (current()) setPhase(message);
                },
              },
              {
                convert: (payload, workerSignal, timeout) =>
                  workspaceWorker<WorkspaceDesignResult>(
                    payload,
                    'design',
                    workerSignal,
                    timeout,
                  ),
              },
            )
          : null;
      const next =
        design?.model ?? (draft.kind === 'image' ? draft.model : null);
      if (!next) throw Error('没有返回可用模型，请重试。');
      signal.throwIfAborted();
      if (!next.bricks.length || !next.levels.length)
        throw Error('模型中没有有效零件，请调整图片或参数后重试。');
      const validation = validateModel(next);
      if (
        validation.collisions ||
        validation.unsupported ||
        validation.invalidParts ||
        !validation.connected
      )
        throw Error(
          '模型未通过重叠与连接检查，请降低精度或更换生成模式后重试。',
        );
      if (current()) {
        setQuality(design?.quality ?? null);
        setModel(next);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
  const previewModel = draft?.kind === 'image' ? draft.model : null;
  return (
    <div className="workspace-page">
      <header className="workspace-header">
        <div className="container">
          <div className="header-content">
            <button
              className="back-button"
              aria-label="重新上传"
              disabled={submitting}
              onClick={onBack}
            >
              <ArrowLeft size={18} />
              <span>重新上传</span>
            </button>
            <div className="workspace-heading">
              <span>Brickform</span>
              <small>DESIGN WORKSPACE</small>
            </div>
            <div className="progress-bar" aria-label="设计进度">
              {['上传', '预览', '生成'].map((label, i) => (
                <div
                  className={`progress-step ${i === 0 || (i === 1 && model) ? 'done' : i === (model ? 2 : 1) ? 'active' : ''}`}
                  key={label}
                >
                  <div className="step-dot">{i + 1}</div>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <button
              className="help-button"
              aria-label="使用说明"
              aria-expanded={help}
              onClick={() => setHelp((v) => !v)}
            >
              <HelpCircle size={19} />
              <span>使用说明</span>
            </button>
          </div>
        </div>
      </header>
      <main className="workspace-main">
        <div className="container">
          {help && (
            <section className="card workspace-help">
              <h2>从参考图到积木设计</h2>
              <p>
                选择模式与尺寸 → 生成真实草稿并旋转检查 → 确认转换 →
                下载清单与说明书。本机重建和轮廓模式不发送图片到云端；选择云端服务时需明确确认。不可见部分仍是推测，未做受力仿真或实物试拼。刷新或重新上传会清空当前设计，请先下载。
              </p>
              <p>
                三视图、GLB 导入与组件编辑可在{' '}
                <Link
                  href="/advanced"
                  prefetch={false}
                  aria-disabled={submitting}
                  onClick={(event) => {
                    event.preventDefault();
                    if (submittingRef.current) return;
                    window.location.assign('/advanced');
                  }}
                >
                  高级工作台
                </Link>{' '}
                使用。
              </p>
            </section>
          )}
          {error && (
            <div className="workspace-message error" role="alert">
              {error}
            </div>
          )}
          {notice && <output className="workspace-message">{notice}</output>}
          {model ? (
            <ResultStep
              model={model}
              quality={quality}
              onRevise={() => setModel(null)}
              onNotice={setNotice}
              onError={setError}
            />
          ) : (
            <div className="preview-layout">
              <aside className="preview-sidebar">
                <section className="card">
                  <h2 className="card-title">参考图片</h2>
                  <div className="reference-image">
                    <Image
                      unoptimized
                      width={1024}
                      height={1024}
                      src={source.preview}
                      alt={`参考图：${source.name}`}
                    />
                  </div>
                  <p className="source-name">{source.name}</p>
                  <p className="card-description">
                    参考图已读取。建议单个物体、干净背景；不会把背景检测当作物体识别。
                  </p>
                </section>
                <section className="card quick-settings">
                  <h2 className="card-title">快速设置</h2>
                  <label className="setting-field">
                    生成方式
                    <select
                      aria-label="生成方式"
                      disabled={busy}
                      value={engine}
                      onChange={(e) => {
                        engineTouched.current = true;
                        setEngine(e.target.value as Engine);
                        if (e.target.value === 'image' && resolution === 48)
                          setResolution(36);
                        setDraft(null);
                        invalidate();
                      }}
                    >
                      <option value="image">本机轮廓 / 浮雕</option>
                      <option value="mesh" disabled={!service?.configured}>
                        {local ? '本机 AI 三维重建' : '三维重建服务'}
                        {!service?.configured ? '（未就绪）' : ''}
                      </option>
                    </select>
                  </label>
                  <output className="card-description service-status">
                    {service === null && !serviceError
                      ? '正在检查三维服务…'
                      : serviceError
                        ? `${serviceError} 轮廓模式仍可使用。`
                        : service?.configured
                          ? `${local ? '本机' : '云端'}引擎已就绪：${service.model || service.provider}`
                          : '本机三维引擎未安装完整，轮廓模式仍可使用。'}
                  </output>
                  <button
                    className="btn btn-secondary"
                    disabled={busy}
                    onClick={() => {
                      setService(null);
                      setServiceError('');
                      setServiceRevision((value) => value + 1);
                    }}
                  >
                    重新检查服务
                  </button>
                  {engine === 'image' ? (
                    <p className="mode-note">
                      按图片轮廓估算厚度或保留为浮雕，不是真实三维扫描。
                    </p>
                  ) : (
                    <p className="mode-note">
                      先重建三维网格供检查，再转换成积木。第一次加载模型可能需要数分钟。
                    </p>
                  )}
                  {engine === 'mesh' && !local && (
                    <label className="consent-field">
                      <input
                        type="checkbox"
                        checked={cloudConsent}
                        disabled={busy}
                        onChange={(e) => setCloudConsent(e.target.checked)}
                      />
                      我同意将此参考图片发送给云端重建服务（可能计费）。
                    </label>
                  )}
                  <div className="setting-group">
                    <span className="setting-label">
                      模型尺寸
                      <span className="label-hint">精度，不是固定零件数</span>
                    </span>
                    <div className="size-options">
                      {[
                        [20, '小'],
                        [28, '中'],
                        [36, '大'],
                        ...(engine === 'mesh' ? [[48, '超精']] : []),
                      ].map(([value, label]) => (
                        <button
                          key={value}
                          className={`size-option ${resolution === value ? 'active' : ''}`}
                          aria-pressed={resolution === value}
                          disabled={busy}
                          onClick={() => {
                            setResolution(Number(value));
                            invalidate();
                          }}
                        >
                          <span className="size-label">{label}</span>
                          <span className="size-value">{value} 凸点</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  {engine === 'mesh' && (
                    <div className="quality-setting">
                      <label className="setting-field">
                        积木配色
                        <select
                          aria-label="积木配色"
                          value={colorMode}
                          disabled={busy}
                          onChange={(e) => {
                            setColorMode(
                              e.target.value as
                                | 'coherent'
                                | 'clean'
                                | 'faithful',
                            );
                            invalidate();
                          }}
                        >
                          <option value="coherent">材质优先 · 推荐</option>
                          <option value="clean">保守清理阴影与杂色</option>
                          <option value="faithful">保留参考图映射</option>
                        </select>
                      </label>
                      <p className="quality-footnote">
                        {colorMode === 'coherent'
                          ? '先选稳定材质色，再投影和装配，不把照片明暗逐像素拆成新的零件颜色。保留明确不同色的材料、绿植和火焰；来源绑定为单一材质的雕像不再沿用灰色模板。相似色涂装、强色光和完全黑暗区域仍需核对。这是材质设计，不是材质测量。'
                          : '保守清理仅整理有较强证据的阴影异色和零碎杂色，保留结构化拼色；原图映射不进行设计改色。'}
                        可切回保守清理或原映射。复用三维草稿，无需重新重建。
                      </p>
                      <span className="setting-label">细节策略</span>
                      <label className="detail-toggle">
                        <input
                          type="checkbox"
                          aria-label="增强小型细节"
                          checked={detailEnhancement}
                          disabled={busy}
                          onChange={(e) => {
                            setDetailEnhancement(e.target.checked);
                            invalidate();
                          }}
                        />
                        <span>
                          <b>增强小型细节 · 推荐</b>
                          <small>
                            识别树木、雕像与火盆等对象，匹配真实积木组件并验证安装。
                          </small>
                        </span>
                      </label>
                      <p className="quality-footnote">
                        身份或连接不确定的部分会保留原形，不会硬套模板。增强未完成会在结果中明确提示。
                      </p>
                    </div>
                  )}
                  {engine === 'image' && (
                    <details className="advanced-toggle">
                      <summary>高级选项</summary>
                      <div className="advanced-content">
                        <label className="setting-field">
                          厚度（凸点）
                          <input
                            aria-label="厚度（凸点）"
                            type="number"
                            min={4}
                            max={20}
                            value={depth}
                            disabled={busy}
                            onChange={(e) => {
                              setDepth(Number(e.target.value));
                              invalidate();
                            }}
                          />
                        </label>
                        <label className="setting-field">
                          背景处理
                          <select
                            aria-label="背景处理"
                            disabled={busy}
                            value={background}
                            onChange={(e) => {
                              setBackground(
                                e.target.value as Options['background'],
                              );
                              invalidate();
                            }}
                          >
                            <option value="auto">自动去除背景</option>
                            <option value="white">去除白色背景</option>
                            <option value="keep">保留完整图片</option>
                          </select>
                        </label>
                        <label className="setting-field">
                          去除强度：{threshold}
                          <input
                            type="range"
                            min={10}
                            max={180}
                            value={threshold}
                            disabled={busy || background === 'keep'}
                            onChange={(e) => {
                              setThreshold(Number(e.target.value));
                              invalidate();
                            }}
                          />
                        </label>
                      </div>
                    </details>
                  )}
                </section>
              </aside>
              <div className="preview-main">
                <section className="card preview-card">
                  <div className="preview-header">
                    <h2 className="card-title">
                      {draft?.kind === 'mesh'
                        ? '3D 草稿预览'
                        : engine === 'mesh'
                          ? '三维设计画布'
                          : '积木轮廓草稿'}
                    </h2>
                    <span className="label-hint">
                      {draft ? '拖动旋转 · 滚轮缩放' : '生成后可旋转检查'}
                    </span>
                  </div>
                  {draft?.kind === 'mesh' ? (
                    <div className="live-mesh">
                      <MeshDraftViewer
                        mesh={draft.mesh}
                        resolution={resolution}
                      />
                    </div>
                  ) : previewModel ? (
                    <BrickPreview model={previewModel} />
                  ) : (
                    <div className="canvas-container">
                      <div className="canvas-placeholder">
                        <div className="placeholder-glyph" aria-hidden="true">
                          <Box size={54} strokeWidth={1.2} />
                        </div>
                        <span className="placeholder-kicker">
                          YOUR DESIGN CANVAS
                        </span>
                        <h2 className="placeholder-title">
                          {busy ? '正在建立你的三维草稿' : '从这张参考图开始'}
                        </h2>
                        <p className="placeholder-description">
                          {busy
                            ? phase || '正在处理参考图，请保持页面打开。'
                            : '先生成草稿，旋转检查形状，再转换成可拼搭的积木。'}
                        </p>
                        <div className="placeholder-flow">
                          <span>参考图片</span>
                          <ArrowRight size={14} />
                          <span>三维草稿</span>
                          <ArrowRight size={14} />
                          <span>积木设计</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {previewModel && (
                    <div className="preview-footer">
                      <div className="preview-stats">
                        <span>
                          {previewModel.width} × {previewModel.depth} 凸点 · 高{' '}
                          {previewModel.height} 薄板单位
                        </span>
                        <span>
                          {previewModel.bricks.length.toLocaleString()} 块 ·{' '}
                          {previewModel.levels.length} 组步骤
                        </span>
                      </div>
                    </div>
                  )}
                  {draft?.kind === 'mesh' && (
                    <p className="mode-note">
                      请检查正面、侧面和背面；积木尺寸与数量将在转换后计算。
                    </p>
                  )}
                </section>
                {busy && (
                  <section
                    className="task-progress"
                    aria-live="polite"
                    aria-label="真实任务进度"
                  >
                    <LoaderCircle className="spin" size={21} />
                    <div>
                      <strong>{phase}</strong>
                      {progress !== null ? (
                        <>
                          <progress
                            max={100}
                            value={progress}
                            aria-label="重建进度"
                          />
                          <span>{Math.round(progress)}%（引擎报告）</span>
                        </>
                      ) : (
                        <p>正在处理真实任务，请勿刷新。</p>
                      )}
                    </div>
                    <button
                      className="btn btn-secondary"
                      disabled={submitting}
                      onClick={cancel}
                    >
                      {submitting
                        ? '提交中，请稍候'
                        : job
                          ? '暂停查看'
                          : '取消转换'}
                    </button>
                  </section>
                )}
                <div className="action-bar">
                  <button
                    className="btn btn-secondary"
                    disabled={
                      busy ||
                      (engine === 'mesh' &&
                        (submissionBlocked || (!local && !cloudConsent)))
                    }
                    onClick={generateDraft}
                  >
                    {engine === 'mesh' && job
                      ? '继续查看任务'
                      : draft
                        ? '重新生成草稿'
                        : engine === 'mesh'
                          ? '生成 3D 草稿'
                          : '生成轮廓草稿'}
                  </button>
                  <button
                    className="btn btn-primary btn-large"
                    disabled={busy || !draft}
                    onClick={convert}
                  >
                    确认生成积木模型
                    <ArrowRight size={18} />
                  </button>
                </div>
                <p className="workspace-fineprint">
                  {engine === 'mesh' && local
                    ? '图片与重建文件留在本机。'
                    : engine === 'image'
                      ? '轮廓与配色在浏览器本机计算。'
                      : '云端任务暂停查看不等于取消计费。'}{' '}
                  零件数、清单和说明书由同一份实际模型生成。
                </p>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function BrickPreview({
  model,
  layer = model.levels.length,
  focusId,
}: {
  model: Model;
  layer?: number;
  focusId?: number;
}) {
  const [exploded, setExploded] = useState(false);
  return model.assembly ? (
    <AssemblyViewer
      model={model}
      layer={layer}
      focusId={focusId}
      exploded={exploded}
      onExplode={() => setExploded((v) => !v)}
    />
  ) : (
    <ModelViewer
      model={model}
      layer={layer}
      exploded={exploded}
      onExplode={() => setExploded((v) => !v)}
    />
  );
}
function ResultStep({
  model,
  quality,
  onRevise,
  onNotice,
  onError,
}: {
  model: Model;
  quality: WorkspaceDesignQuality | null;
  onRevise: () => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const procurement = useMemo(() => procurementReport(model), [model]);
  const [tab, setTab] = useState<'parts' | 'guide'>('parts');
  const [stage, setStage] = useState(0);
  const [focusId, setFocusId] = useState<number>();
  const [chapter, setChapter] = useState(0);
  const [search, setSearch] = useState('');
  const chapters =
    model.assembly && model.bricks.length > 1200
      ? Math.ceil(model.levels.length / 30)
      : 1;
  const lines = procurement.lines.filter((line) =>
    `${line.name} ${line.part} ${line.bricklinkId || ''} ${PALETTE[line.color].name}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  function save(kind: 'html' | 'csv' | 'ldr' | 'geometry') {
    try {
      onError('');
      const slug =
        Array.from(model.name)
          .filter((char) => char.charCodeAt(0) >= 32)
          .join('')
          .replace(/[\\/:*?"<>|]/g, '-')
          .slice(0, 50) || 'brickform';
      if (kind === 'html')
        download(
          manualHTML(
            model,
            chapters > 1
              ? {
                  start: chapter * 30,
                  end: Math.min((chapter + 1) * 30, model.levels.length),
                }
              : undefined,
          ),
          `${slug}-guide${chapters > 1 ? `-${chapter + 1}` : ''}.html`,
          'text/html;charset=utf-8',
        );
      if (kind === 'csv')
        download(
          purchaseInventoryCSV(model.bricks),
          `${slug}-purchase.csv`,
          'text/csv;charset=utf-8',
        );
      if (kind === 'geometry')
        download(csv(model), `${slug}-geometry.csv`, 'text/csv;charset=utf-8');
      if (kind === 'ldr') download(toLDraw(model), `${slug}.ldr`);
      onNotice('已导出当前模型。HTML 说明书可离线打开，打印或另存为 PDF。');
    } catch (e) {
      onError(e instanceof Error ? e.message : '导出失败，请重试。');
    }
  }
  return (
    <>
      <div className="result-layout">
        <div className="result-preview">
          <section className="card">
            <div className="result-header">
              <div className="success-badge">
                <Check size={18} />
                生成完成 · 连接检查通过
              </div>
              <h1>{model.name}</h1>
            </div>
            <BrickPreview
              model={model}
              layer={tab === 'guide' ? stage + 1 : model.levels.length}
              focusId={tab === 'guide' ? focusId : undefined}
            />
            <div className="key-metrics">
              {[
                [model.bricks.length.toLocaleString(), '块模型零件'],
                [new Set(model.bricks.map((b) => b.part)).size, '种零件'],
                [model.levels.length, '组拼装步骤'],
              ].map(([value, label]) => (
                <div className="metric" key={label}>
                  <div className="metric-content">
                    <span className="metric-value">{value}</span>
                    <span className="metric-label">{label}</span>
                  </div>
                </div>
              ))}
            </div>
            {model.materialDesign?.materialFirst && (
              <section className="quality-summary" aria-label="材质配色设计">
                <div className="quality-heading">
                  <Sparkles size={17} />
                  <strong>材质优先 · {model.materialDesign.materialFirst.materials.length} 种参考材质选择</strong>
                </div>
                <p className="quality-details">
                  装配前已整理 {model.materialDesign.materialFirst.changedPixels} 个参考图像素的材料选择。
                  模型、说明书与采购清单使用同一份实际砖块配色。
                </p>
                <p className="quality-footnote" data-colour-uncertainty>
                  这是材质设计，不是材质测量；相似色涂装、强色光、完全黑暗和未观测区域仍需核对。
                </p>
              </section>
            )}
            {model.colorDesign && (
              <section className="quality-summary" aria-label="积木配色质量">
                <div className="quality-heading">
                  <Sparkles size={17} />
                  <strong>
                    {colorDesignSummary(model.colorDesign).heading}
                  </strong>
                </div>
                <p className="quality-details">
                  模型、说明书与采购清单使用同一份实际砖块配色。
                  {colorDesignSummary(model.colorDesign).details}
                </p>
                {colorDesignSummary(model.colorDesign).uncertainty && (
                  <p className="quality-details" data-colour-uncertainty>
                    {colorDesignSummary(model.colorDesign).uncertainty}
                  </p>
                )}
                <p className="quality-footnote">
                  这是设计配色近似，不是材质复原。可返回参数切换“保守清理阴影与杂色”或“保留参考图映射”，复用原三维草稿。
                </p>
              </section>
            )}
            {quality && (
              <section
                className={`quality-summary ${quality.status === 'degraded' || quality.status === 'preserved' ? 'quality-warning' : ''}`}
                aria-label="模型细节质量"
              >
                <div className="quality-heading">
                  <Sparkles size={17} />
                  <strong>
                    {quality.status === 'enhanced'
                      ? `已增强 ${quality.applied} 处细节`
                      : quality.status === 'basic'
                        ? '基础转换 · 细节增强已关闭'
                        : quality.status === 'degraded'
                          ? '细节增强未完成'
                          : '保留原形 · 没有安全替换'}
                  </strong>
                </div>
                <p className="quality-details">{quality.summary}</p>
                <p className="quality-footnote">
                  只有通过身份、可见性与真实连接检查的组件才会替换。连接通过不代表所有图像细节已经还原。
                </p>
              </section>
            )}
            <p className="mode-note">
              {model.imageDesign?.note ||
                '由三维网格转换生成。不可见部分为模型推测。'}{' '}
              实物稳定性尚未验证。
            </p>
          </section>
        </div>
        <aside className="result-sidebar">
          <section className="card action-card">
            <h2 className="card-title">下载文件</h2>
            {chapters > 1 && (
              <label className="setting-field">
                说明书分册
                <select
                  value={chapter}
                  onChange={(e) => setChapter(Number(e.target.value))}
                >
                  {Array.from({ length: chapters }, (_, i) => (
                    <option key={i} value={i}>
                      第 {i + 1} 册 · 步骤组 {i * 30 + 1}–
                      {Math.min((i + 1) * 30, model.levels.length)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="download-actions">
              <button
                className="download-btn primary"
                onClick={() => save('html')}
              >
                <Download size={18} />
                拼装说明书 (HTML)
              </button>
              <button className="download-btn" onClick={() => save('csv')}>
                <Download size={18} />
                零件清单 (CSV)
              </button>
              <button className="download-btn" onClick={() => save('ldr')}>
                <Download size={18} />
                3D 模型 (LDraw)
              </button>
              <button className="download-btn" onClick={() => save('geometry')}>
                <Download size={18} />
                三维子件清单 (CSV)
              </button>
            </div>
          </section>
          <section className="card">
            <h2 className="card-title">模型信息</h2>
            <div className="info-list">
              <div className="info-item">
                <span>底面尺寸</span>
                <span>
                  {model.width} × {model.depth} 凸点
                </span>
              </div>
              <div className="info-item">
                <span>实际尺寸（约）</span>
                <span>
                  {(model.width * 0.8).toFixed(1)} ×{' '}
                  {(model.depth * 0.8).toFixed(1)} ×{' '}
                  {(model.height * 0.32).toFixed(1)} cm
                </span>
              </div>
              <div className="info-item">
                <span>采购数量</span>
                <span>{procurement.purchaseQuantity} 件</span>
              </div>
            </div>
            <p className="mode-note">
              数量包含支撑。高度不含凸点；没有实时价格报价。
            </p>
          </section>
          <section className="card">
            <h2 className="card-title">购买与复核</h2>
            <p className="card-description">
              目录已收录 {procurement.catalogConfirmed} 项，未核实{' '}
              {procurement.unverified} 项，颜色待替换{' '}
              {procurement.unsupportedColors} 项。目录不代表实时库存。
            </p>
            <div className="store-links">
              <a
                className="store-link"
                href="https://www.bricklink.com/"
                target="_blank"
                rel="noopener noreferrer"
              >
                BrickLink ↗
              </a>
              <a
                className="store-link"
                href="https://www.lego.com/en-us/pick-and-build/pick-a-brick"
                target="_blank"
                rel="noopener noreferrer"
              >
                LEGO Pick a Brick ↗
              </a>
            </div>
          </section>
          <button className="btn btn-secondary" onClick={onRevise}>
            <ArrowLeft size={18} />
            调整参数与草稿
          </button>
        </aside>
      </div>
      <section className="card result-details">
        <fieldset className="result-tabs" aria-label="结果详情">
          <button
            className="btn btn-secondary"
            aria-pressed={tab === 'parts'}
            onClick={() => setTab('parts')}
          >
            采购清单
          </button>
          <button
            className="btn btn-secondary"
            aria-pressed={tab === 'guide'}
            onClick={() => setTab('guide')}
          >
            拼装步骤
          </button>
        </fieldset>
        {tab === 'guide' ? (
          <BuildGuide
            model={model}
            stage={stage}
            onStageChange={(next) => {
              setStage(next);
              setFocusId(undefined);
            }}
            onFocus={setFocusId}
          />
        ) : (
          <>
            <label className="parts-search">
              搜索零件或颜色
              <input
                value={search}
                placeholder="编号 / 名称 / 颜色"
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <section className="parts-table-scroll" aria-label="零件采购表">
              <table className="workspace-parts">
                <thead>
                  <tr>
                    <th>零件</th>
                    <th>编号</th>
                    <th>颜色</th>
                    <th>数量</th>
                    <th>目录记录</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={`${line.part}-${line.color}`}>
                      <td>{line.name}</td>
                      <td>
                        {line.catalogUrl ? (
                          <a
                            href={line.catalogUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {line.bricklinkId} ↗
                          </a>
                        ) : (
                          line.part
                        )}
                      </td>
                      <td>
                        <span
                          className="color-dot"
                          style={{ background: PALETTE[line.color].hex }}
                        />
                        {PALETTE[line.color].name}
                      </td>
                      <td>{line.quantity}</td>
                      <td title={line.reason}>
                        {line.status === 'catalog-confirmed'
                          ? '组合已收录'
                          : line.status === 'unsupported-color'
                            ? '颜色需复核'
                            : '待核实'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {!lines.length && <p className="mode-note">没有匹配的零件。</p>}
            </section>
            {procurement.assemblyStepsRequireReview && (
              <p className="mode-note">
                人仔按已装配总成采购，说明书中的子件安装步骤需复核，请勿拆卸人仔。
              </p>
            )}
          </>
        )}
      </section>
    </>
  );
}
