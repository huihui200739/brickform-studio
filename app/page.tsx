'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  ArrowRight,
  Layers3,
  FileText,
  Blocks,
  Download,
  Check,
  Info,
  Sparkles,
  ImagePlus,
  ArrowUpRight,
  X,
  LoaderCircle,
  BookOpen,
  ShieldCheck,
} from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import ModelViewer from '@/components/model-viewer';
import AssemblyViewer from '@/components/assembly-viewer';
import BuildGuide from '@/components/build-guide';
import { previewRange, type PreviewMode } from '@/lib/preview-state';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableCell,
  TableHead,
} from '@/components/ui/table';
import {
  imageToModel,
  inventory,
  validateModel,
  toLDraw,
  PARTS,
  PALETTE,
  type Raster,
  type Options,
} from '@/lib/brick-engine';
import {
  designDuck,
  referenceDuck,
  DEFAULT_DUCK,
  type DuckParameters,
} from '@/lib/duck-designer';
import { roundedDuck, fitDuckImage, SAMPLE_FIT } from '@/lib/rounded-duck';
import { csv, download, manualHTML } from '@/lib/manual';
const backgroundItems = [
  { value: 'auto', label: '自动去除背景' },
  { value: 'white', label: '去除白色背景' },
  { value: 'keep', label: '保留完整图片' },
];
type Mode = 'round' | 'duck' | 'relief';
export default function Home() {
  const [model, setModel] = useState(() => roundedDuck());
  const [mode, setMode] = useState<Mode>('round');
  const [roundSize, setRoundSize] = useState(18);
  const [fullness, setFullness] = useState(1);
  const [duck, setDuck] = useState<DuckParameters>(DEFAULT_DUCK);
  const [autoReference, setAutoReference] = useState(true);
  const [resolution, setResolution] = useState(28),
    [depth, setDepth] = useState(12);
  const [threshold, setThreshold] = useState(70),
    [background, setBackground] = useState<Options['background']>('auto');
  const [source, setSource] = useState<{
    raster: Raster;
    url: string;
    name: string;
  } | null>(null);
  const [layer, setLayer] = useState(model.levels.length),
    [exploded, setExploded] = useState(false),
    [section, setSection] = useState('all');
  const [previewMode, setPreviewMode] = useState<PreviewMode>('complete');
  const [tab, setTab] = useState('parts'),
    [search, setSearch] = useState('');
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false);
  const [help, setHelp] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    uploadToken = useRef(0),
    sourceUrl = useRef('');
  const parts = useMemo(() => inventory(model.bricks), [model]);
  const validation = useMemo(() => validateModel(model), [model]);
  const shownParts = parts.filter((p) =>
    `${p.part} ${PARTS[p.part]} ${PALETTE[p.color].name}`.includes(
      search.trim(),
    ),
  );
  const [guideFocus, setGuideFocus] = useState<{
    model: typeof model;
    layer: number;
    id: number | undefined;
  } | null>(null);
  const focusId =
    tab === 'steps'
      ? guideFocus?.model === model && guideFocus.layer === layer
        ? guideFocus.id
        : model.bricks.find((b) => b.step === layer - 1)?.id
      : undefined;
  const preview = previewRange(
    previewMode,
    model.levels.length,
    layer,
    focusId,
  );
  const changeDuck = (patch: Partial<DuckParameters>) => {
    setDuck((p) => ({ ...p, ...patch }));
    setAutoReference(false);
    setDirty(true);
  };
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 5500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(
    () => () => {
      if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    },
    [],
  );
  async function upload(file?: File) {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setError('请选择 PNG、JPG 或 WebP 图片。');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('图片超过 10 MB，请压缩后重试。');
      return;
    }
    const token = ++uploadToken.current;
    setBusy(true);
    setError('');
    let url = '';
    try {
      url = URL.createObjectURL(file);
      const img = new window.Image();
      img.src = url;
      await img.decode();
      if (img.naturalWidth * img.naturalHeight > 40000000)
        throw Error('图片尺寸过大，请缩小到 4000 万像素以内。');
      const ratio = Math.min(
          1,
          128 / Math.max(img.naturalWidth, img.naturalHeight),
        ),
        canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw Error('浏览器无法读取图片，请换一张图片。');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (token !== uploadToken.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
      sourceUrl.current = url;
      setSource({
        raster: {
          width: pixels.width,
          height: pixels.height,
          data: pixels.data,
        },
        url,
        name: /^(exec-|codex-|image|IMG_|[a-f0-9-]{24})/i.test(file.name)
          ? '参考图片'
          : file.name.replace(/\.[^.]+$/, '').slice(0, 24),
      });
      setAutoReference(true);
      setDirty(true);
      setNotice(
        mode === 'round'
          ? '参考图已就绪。生成时会测量小鸭比例并重建体积。'
          : mode === 'duck'
            ? '参考图已就绪。生成时会提取配色和比例，应用到小鸭结构。'
            : '图片已就绪，点击生成查看模型。',
      );
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      setError(e instanceof Error ? e.message : '无法读取图片，请重试。');
    } finally {
      if (token === uploadToken.current) setBusy(false);
    }
  }
  function resetSample() {
    if (sourceUrl.current) URL.revokeObjectURL(sourceUrl.current);
    sourceUrl.current = '';
    setSource(null);
    setMode('round');
    setRoundSize(18);
    setFullness(1);
    setDuck(DEFAULT_DUCK);
    setAutoReference(true);
    setDirty(true);
    setError('');
    setNotice('已恢复小黄鸭示例，点击生成应用。');
  }
  async function generate() {
    setBusy(true);
    setError('');
    setNotice('');
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    try {
      if (mode === 'relief' && !source)
        throw Error('请先上传参考图片，再使用图片轮廓模式。');
      const parameters =
        mode === 'duck' && source && autoReference
          ? referenceDuck(source.raster, { background, threshold })
          : duck;
      const next =
        mode === 'round'
          ? roundedDuck(
              source
                ? fitDuckImage(source.raster, { background, threshold })
                : SAMPLE_FIT,
              roundSize,
              fullness,
              !!source,
            )
          : mode === 'duck'
            ? designDuck(parameters, !!source)
            : imageToModel(
                source!.raster,
                { resolution, depth, threshold, background, shape: mode },
                source!.name,
              );
      if (mode === 'duck') setDuck(parameters);
      if (mode === 'duck' && next.assembly && source && !autoReference)
        next.assembly.reference = '使用手动配色与比例；参考图片仅供对照。';
      const v = validateModel(next);
      if (v.collisions || v.unsupported || v.invalidParts || !v.connected)
        throw Error('模型未通过连接检查，请调整参数后重试。');
      setModel(next);
      setLayer(tab === 'steps' ? 1 : next.levels.length);
      setPreviewMode('complete');
      setSection('all');
      setExploded(false);
      setDirty(false);
      setNotice(
        `设计已生成：${next.bricks.length} 块零件，${next.levels.length} 个步骤。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  function save(kind: 'csv' | 'ldr' | 'html') {
    if (kind === 'csv')
      download(csv(model), 'brickform-parts.csv', 'text/csv;charset=utf-8');
    if (kind === 'ldr') download(toLDraw(model), 'brickform-model.ldr');
    if (kind === 'html')
      download(
        manualHTML(model),
        'brickform-guide.html',
        'text/html;charset=utf-8',
      );
    setNotice('已导出当前模型。离线说明书可用浏览器打开并打印为 PDF。');
  }
  function printManual() {
    const win = window.open('', '_blank');
    if (!win) {
      setNotice('浏览器拦截了新窗口，请下载离线说明书后打印。');
      return;
    }
    win.opener = null;
    const url = URL.createObjectURL(
      new Blob([manualHTML(model)], { type: 'text/html;charset=utf-8' }),
    );
    win.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setExportOpen(false);
  }
  function selectLayer(n: number) {
    setGuideFocus(null);
    setLayer(n);
    setSection('all');
  }
  return (
    <main className="studio studio-v3">
      <header className="topbar">
        <Link className="brand" href="/">
          <span className="brand-icon">
            <Blocks size={21} />
          </span>
          brickform<span className="brand-cn">积木工坊</span>
          <span className="beta">V8</span>
        </Link>
        <span className="workspace-title">设计工作台</span>
        <button className="header-help" onClick={() => setHelp(true)}>
          <BookOpen size={16} />
          使用说明
        </button>
      </header>
      <div className="studio-layout">
        <aside className="settings-card">
          <div className="settings-heading">
            <h1>从图片开始</h1>
            <span className="tiny-tag">本机处理</span>
          </div>
          <input
            className="sr-only"
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="上传参考图片"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <button
            className={`reference-upload ${drag ? 'dragging' : ''}`}
            disabled={busy}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              if (!busy) void upload(e.dataTransfer.files[0]);
            }}
          >
            <Image
              unoptimized
              width={256}
              height={190}
              src={source?.url || '/reference-duck.png'}
              alt={source ? `参考图：${source.name}` : '小黄鸭示例参考图'}
            />
            <span className="reference-badge">
              {source ? '你的参考图' : '示例参考图'}
            </span>
            <span className="reference-upload-action">
              <ImagePlus size={15} />
              {source ? '更换图片' : '上传你的图片'}
            </span>
          </button>
          <div className="reference-caption">
            <span>{source?.name || 'PNG / JPG / WebP · 最大 10 MB'}</span>
            {source && (
              <button
                aria-label="移除图片并恢复示例"
                disabled={busy}
                onClick={resetSample}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <div className="field-title" id="mode-label">
            生成方式
          </div>
          <RadioGroup
            className="design-modes"
            value={mode}
            aria-labelledby="mode-label"
            disabled={busy}
            onValueChange={(v) => {
              setMode(v as Mode);
              if (v === 'round' && background === 'keep') setBackground('auto');
              setDirty(true);
            }}
          >
            {[
              ['round', '圆润重建', '小鸭侧面图 · 测量比例与特征位置'],
              ['duck', '部件模板', '旧版小鸭 · 手动搭配比例'],
              ['relief', '平面浮雕', '其他图片 · 保留平面轮廓'],
            ].map(([v, t, h]) => (
              <label
                className={mode === v ? 'chosen' : ''}
                key={v}
                htmlFor={`choice-${t}`}
              >
                <RadioGroupItem id={`choice-${t}`} value={v} />
                <span>
                  <b>{t}</b>
                  <small>{h}</small>
                </span>
              </label>
            ))}
          </RadioGroup>
          {mode === 'round' ? (
            <>
              <div className="reconstruction-note">
                <span className="tiny-tag">V8 · 小鸭重建实验</span>
                <p>
                  头部背面增加连续弧面，颈前和翅膀以宽弧面衔接；分层视图可逐组查看安装结构。
                </p>
                <small>
                  目前支持干净背景、红 / 橙嘴的小鸭侧面图；背面按对称体积推测。
                </small>
              </div>
              <div className="field-title" id="round-size-label">
                作品尺寸 <span>{roundSize} 凸点基准</span>
              </div>
              <RadioGroup
                className="detail-options"
                aria-labelledby="round-size-label"
                value={String(roundSize)}
                disabled={busy}
                onValueChange={(v) => {
                  setRoundSize(Number(v));
                  setDirty(true);
                }}
              >
                {[
                  [18, '小巧'],
                  [20, '均衡'],
                  [22, '细致'],
                ].map(([v, t]) => (
                  <label
                    key={v}
                    className={roundSize === v ? 'chosen' : ''}
                    htmlFor={`round-size-${v}`}
                  >
                    <RadioGroupItem id={`round-size-${v}`} value={String(v)} />
                    <span>{t}</span>
                  </label>
                ))}
              </RadioGroup>
              <div className="field-title" id="fullness-label">
                身体饱满度 <span>{Math.round(fullness * 100)}%</span>
              </div>
              <Slider
                aria-labelledby="fullness-label"
                min={85}
                max={115}
                step={5}
                value={[Math.round(fullness * 100)]}
                disabled={busy}
                onValueChange={(v) => {
                  setFullness((Array.isArray(v) ? v[0] : v) / 100);
                  setDirty(true);
                }}
              />
              <p className="field-hint">
                调节左右宽度；保留从侧面图测量的头、身体和鸭嘴比例。
              </p>
            </>
          ) : mode === 'duck' ? (
            <>
              <p className="design-scope">
                这是旧版部件模板，参考图只影响配色和粗略比例。新造型请选「圆润重建」。
              </p>
              {source && (
                <RadioGroup
                  className="parameter-origin"
                  aria-label="设计参数来源"
                  value={autoReference ? 'image' : 'manual'}
                  onValueChange={(v) => {
                    setAutoReference(v === 'image');
                    setDirty(true);
                  }}
                  disabled={busy}
                >
                  <label htmlFor="reference-auto">
                    <RadioGroupItem id="reference-auto" value="image" />
                    从参考图提取配色与比例
                  </label>
                  <label htmlFor="reference-manual">
                    <RadioGroupItem id="reference-manual" value="manual" />
                    使用下方手动参数
                  </label>
                </RadioGroup>
              )}
              <div className="field-title" id="head-size-label">
                头身比例{' '}
                <span>{duck.headWidth === 6 ? '大头萌趣' : '小头轻巧'}</span>
              </div>
              <RadioGroup
                className="detail-options"
                aria-labelledby="head-size-label"
                disabled={busy}
                value={String(duck.headWidth)}
                onValueChange={(v) => changeDuck({ headWidth: Number(v) })}
              >
                {[
                  [4, '轻巧'],
                  [6, '萌趣'],
                ].map(([v, t]) => (
                  <label
                    key={v}
                    className={duck.headWidth === v ? 'chosen' : ''}
                    htmlFor={`choice-${t}`}
                  >
                    <RadioGroupItem id={`choice-${t}`} value={String(v)} />
                    <span>{t}</span>
                  </label>
                ))}
              </RadioGroup>
              <div className="field-title" id="body-size-label">
                身体比例
              </div>
              <RadioGroup
                className="detail-options"
                aria-labelledby="body-size-label"
                disabled={busy}
                value={String(duck.bodyLength)}
                onValueChange={(v) => changeDuck({ bodyLength: Number(v) })}
              >
                {[
                  [8, '圆短'],
                  [10, '修长'],
                ].map(([v, t]) => (
                  <label
                    key={v}
                    className={duck.bodyLength === v ? 'chosen' : ''}
                    htmlFor={`choice-${t}`}
                  >
                    <RadioGroupItem id={`choice-${t}`} value={String(v)} />
                    <span>{t}</span>
                  </label>
                ))}
              </RadioGroup>
              <div className="field-title" id="body-color-label">
                主体配色 <span>{PALETTE[duck.bodyColor].name}</span>
              </div>
              <RadioGroup
                className="color-choice"
                aria-labelledby="body-color-label"
                disabled={busy}
                value={String(duck.bodyColor)}
                onValueChange={(v) => changeDuck({ bodyColor: Number(v) })}
              >
                {PALETTE.map((p, i) => (
                  <label
                    title={p.name}
                    className={duck.bodyColor === i ? 'selected' : ''}
                    key={p.name}
                    style={{ '--swatch': p.hex } as React.CSSProperties}
                    htmlFor={`palette-${i}`}
                  >
                    <RadioGroupItem
                      id={`palette-${i}`}
                      value={String(i)}
                      aria-label={p.name}
                    />
                  </label>
                ))}
              </RadioGroup>
              <div className="field-title" id="beak-color-label">
                鸭嘴配色
              </div>
              <RadioGroup
                className="detail-options"
                aria-labelledby="beak-color-label"
                disabled={busy}
                value={String(duck.beakColor)}
                onValueChange={(v) => changeDuck({ beakColor: Number(v) })}
              >
                {[
                  [6, '亮橙色'],
                  [2, '亮红色'],
                ].map(([v, t]) => (
                  <label
                    key={v}
                    className={duck.beakColor === v ? 'chosen' : ''}
                    htmlFor={`choice-${t}`}
                  >
                    <RadioGroupItem id={`choice-${t}`} value={String(v)} />
                    <span>{t}</span>
                  </label>
                ))}
              </RadioGroup>
            </>
          ) : (
            <>
              <div className="field-title" id="resolution-label">
                模型精细度 <span>{resolution} 凸点</span>
              </div>
              <RadioGroup
                className="detail-options"
                aria-labelledby="resolution-label"
                disabled={busy}
                value={String(resolution)}
                onValueChange={(v) => {
                  setResolution(Number(v));
                  setDirty(true);
                }}
              >
                {[
                  [20, '简约'],
                  [28, '标准'],
                  [36, '精细'],
                ].map(([v, t]) => (
                  <label
                    key={v}
                    className={resolution === v ? 'chosen' : ''}
                    htmlFor={`choice-${t}`}
                  >
                    <RadioGroupItem id={`choice-${t}`} value={String(v)} />
                    <span>{t}</span>
                  </label>
                ))}
              </RadioGroup>
              <div className="field-title" id="depth-label">
                模型厚度 <span>{depth} 凸点</span>
              </div>
              <Slider
                aria-labelledby="depth-label"
                value={[depth]}
                min={4}
                max={20}
                step={2}
                disabled={busy}
                onValueChange={(v) => {
                  setDepth(Array.isArray(v) ? v[0] : v);
                  setDirty(true);
                }}
              />
              <p className="field-hint">
                将图片做成有厚度的平面浮雕；不会重建物体真实背面。
              </p>
            </>
          )}
          {source && (
            <div className="background-settings">
              <div className="field-title" id="background-label">
                参考图背景
              </div>
              <Select
                items={backgroundItems}
                value={background}
                disabled={busy}
                onValueChange={(v) => {
                  if (v) {
                    setBackground(v as Options['background']);
                    setDirty(true);
                  }
                }}
              >
                <SelectTrigger
                  className="background-select"
                  aria-labelledby="background-label"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {backgroundItems
                    .filter((o) => mode !== 'round' || o.value !== 'keep')
                    .map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="field-title" id="threshold-label">
                去除强度 <span>{threshold}</span>
              </div>
              <Slider
                aria-labelledby="threshold-label"
                value={[threshold]}
                min={10}
                max={180}
                step={5}
                disabled={busy || background === 'keep'}
                onValueChange={(v) => {
                  setThreshold(Array.isArray(v) ? v[0] : v);
                  setDirty(true);
                }}
              />
            </div>
          )}
          <div className="generate-area">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void generate()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <Sparkles size={18} />
              )}{' '}
              {busy ? '正在构建设计' : '生成积木设计'}
              <ArrowRight size={18} />
            </button>
            <p>
              {dirty
                ? '参数已改变，生成后更新预览'
                : '模型、清单与说明书已同步'}
            </p>
          </div>
        </aside>
        <div className="studio-main">
          <section className="preview-panel">
            <div className="design-topline">
              <div className="design-title-group">
                <span className="design-type">
                  {model.assembly
                    ? model.reconstruction
                      ? '体积重建 / 小鸭侧面图'
                      : '部件模板 / 小鸭'
                    : '平面浮雕设计'}
                </span>
                <input
                  className="design-name"
                  aria-label="设计名称"
                  title="点击修改设计名称"
                  key={model.name}
                  defaultValue={model.name}
                  maxLength={24}
                  onBlur={(e) => {
                    const name = e.target.value.trim() || '我的积木作品';
                    if (name !== model.name) setModel((m) => ({ ...m, name }));
                  }}
                />
              </div>
              <button
                className="primary export-main"
                onClick={() => setExportOpen(true)}
              >
                <Download size={16} />
                导出设计
              </button>
            </div>
            <div className="design-metrics">
              <span>
                <b>{model.bricks.length.toLocaleString()}</b> 块零件
              </span>
              <span>
                <b>{new Set(model.bricks.map((b) => b.part)).size}</b> 种零件
              </span>
              <span>
                <b>{model.levels.length}</b> 个步骤
              </span>
              <span className="metric-dimensions">
                {(model.width * 0.8).toFixed(1)} ×{' '}
                {(model.depth * 0.8).toFixed(1)} ×{' '}
                {(model.height * 0.32).toFixed(1)} cm
              </span>
              <span className={`sync-pill ${dirty ? 'pending' : ''}`}>
                {dirty ? '待生成更新' : '已同步'}
              </span>
            </div>
            <div className="preview-mode-bar">
              <fieldset aria-label="预览范围">
                <button
                  aria-pressed={previewMode === 'complete'}
                  onClick={() => {
                    setPreviewMode('complete');
                    setSection('all');
                    setExploded(false);
                  }}
                >
                  完整作品
                </button>
                <button
                  aria-pressed={previewMode === 'steps'}
                  onClick={() => {
                    setPreviewMode('steps');
                    setSection('all');
                    setExploded(false);
                  }}
                >
                  跟随拼装
                </button>
              </fieldset>
              <span>
                {previewMode === 'complete'
                  ? '阅读步骤时，完整作品保持可见'
                  : `当前显示第 ${layer} 组的搭建进度`}
              </span>
            </div>
            {model.assembly ? (
              <AssemblyViewer
                model={model}
                layer={preview.layer}
                focusId={preview.focusId}
                exploded={exploded}
                section={section}
                onExplode={() => setExploded((v) => !v)}
              />
            ) : (
              <ModelViewer
                model={model}
                layer={preview.layer}
                exploded={exploded}
                onExplode={() => setExploded((v) => !v)}
              />
            )}
            {model.assembly && (
              <div className="section-filter">
                <span>单独查看</span>
                <fieldset aria-label="查看模型部件">
                  {[
                    { id: 'all', name: '完整模型' },
                    ...model.assembly.sections,
                  ].map((s) => (
                    <button
                      key={s.id}
                      aria-pressed={
                        previewMode === 'complete' && section === s.id
                      }
                      onClick={() => {
                        setSection(s.id);
                        setPreviewMode('complete');
                      }}
                    >
                      {s.name}
                      {s.id !== 'all' && (
                        <small>
                          {
                            model.bricks.filter((b) => b.section === s.id)
                              .length
                          }
                        </small>
                      )}
                    </button>
                  ))}
                </fieldset>
              </div>
            )}
            <div className="layer-control">
              <span>
                <Layers3 size={16} />
                搭建进度
              </span>
              <Slider
                aria-label="搭建进度"
                value={[layer]}
                min={1}
                max={model.levels.length}
                step={1}
                onValueChange={(v) => {
                  selectLayer(Array.isArray(v) ? v[0] : v);
                  setPreviewMode('steps');
                }}
              />
              <b>
                {layer}
                <small> / {model.levels.length}</small>
              </b>
              <button
                onClick={() => {
                  setPreviewMode('complete');
                  setSection('all');
                  setExploded(false);
                }}
              >
                完整模型
              </button>
            </div>
            <div className="validation-strip">
              <span>
                <ShieldCheck size={15} />
                {validation.collisions === 0 &&
                validation.unsupported === 0 &&
                validation.connected
                  ? '连接与重叠检查通过'
                  : '结构需要检查'}
              </span>
              <span>
                {model.assembly
                  ? '实物稳定性尚未验证'
                  : '厚度由轮廓估算 · 实物稳定性尚未验证'}
              </span>
              <button onClick={() => setHelp(true)}>
                了解检查范围
                <ArrowUpRight size={12} />
              </button>
            </div>
          </section>
          <section className="output-panel">
            <Tabs
              value={tab}
              onValueChange={(v) => {
                setTab(String(v));
                setPreviewMode('complete');
                if (v === 'steps') {
                  setGuideFocus(null);
                  setLayer(1);
                  setSection('all');
                  setExploded(false);
                }
              }}
            >
              <div className="output-header">
                <TabsList variant="line">
                  <TabsTrigger value="parts">
                    <Blocks />
                    零件清单<span>{parts.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="steps">
                    <FileText />
                    拼装步骤
                  </TabsTrigger>
                </TabsList>
                <button className="text-button" onClick={() => save('csv')}>
                  <Download size={14} />
                  导出 CSV
                </button>
              </div>
              <TabsContent value="parts">
                <div className="table-intro">
                  <span>
                    {model.assembly
                      ? '包含全部部件，侧装连接件已计入'
                      : '包含主体、底座及辅助支撑'}
                  </span>
                  <input
                    aria-label="搜索零件或颜色"
                    placeholder="搜索编号 / 颜色"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <div className="parts-scroll">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>零件</TableHead>
                        <TableHead>设计编号</TableHead>
                        <TableHead>颜色</TableHead>
                        <TableHead className="quantity">数量</TableHead>
                        <TableHead />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shownParts.map((p) => (
                        <TableRow key={`${p.part}-${p.color}`}>
                          <TableCell>
                            <span className="part-name">
                              <Box
                                size={20}
                                style={{ color: PALETTE[p.color].hex }}
                              />
                              {PARTS[p.part]}
                            </span>
                          </TableCell>
                          <TableCell className="part-code">{p.part}</TableCell>
                          <TableCell>
                            <span className="color-cell">
                              <i style={{ background: PALETTE[p.color].hex }} />
                              {PALETTE[p.color].name}
                            </span>
                          </TableCell>
                          <TableCell className="quantity">
                            {p.quantity}
                          </TableCell>
                          <TableCell>
                            <a
                              className="part-link"
                              href={`https://www.lego.com/en-us/pick-and-build/pick-a-brick?query=${p.part.replace(/b$/, '')}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`到乐高官网核对 ${p.part}`}
                            >
                              <ArrowUpRight size={15} />
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {!shownParts.length && (
                    <p className="empty-search">
                      没有匹配的零件，请更换编号或颜色。
                    </p>
                  )}
                </div>
                <div className="table-foot">
                  零件与颜色组合、在售情况需购买前核对
                  <span>
                    总计 <b>{model.bricks.length}</b> 块
                  </span>
                </div>
              </TabsContent>
              <TabsContent value="steps">
                <BuildGuide
                  key={layer}
                  model={model}
                  stage={layer - 1}
                  onStageChange={(n) => selectLayer(n + 1)}
                  onFocus={(id) => setGuideFocus({ model, layer, id })}
                />
              </TabsContent>
            </Tabs>
          </section>
          <p className="model-provenance">
            {model.assembly?.reference ||
              '图片轮廓估算厚度；尚未从单张图片还原真实三维结构。'}{' '}
            <a href="/parts/ATTRIBUTION.txt" target="_blank" rel="noreferrer">
              零件几何来源 <ArrowUpRight size={12} />
            </a>
          </p>
        </div>
      </div>
      {(notice || error) && (
        <div
          className={`status-toast ${error ? 'error' : ''}`}
          role={error ? 'alert' : 'status'}
        >
          {error ? <Info size={18} /> : <Check size={18} />}
          <span>{error || notice}</span>
          <button
            aria-label="关闭提示"
            onClick={() => {
              setError('');
              setNotice('');
            }}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <footer className="site-footer">
        <span>
          <Blocks size={15} />
          Brickform Studio · V8
        </span>
        <span>独立创作工具，与 LEGO Group 无关联或认证。</span>
      </footer>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="help-dialog">
          <DialogTitle>V8 · 圆润重建工作台</DialogTitle>
          <DialogDescription>
            这一轮聚焦小鸭侧面图：从二维特征测量出发，推测对称体积，再铺设实际零件。
          </DialogDescription>
          <ol className="help-steps">
            <li>
              <b>参考图或手动设计</b>
              <p>
                圆润重建测量头部、身体、嘴和眼睛的位置与比例，再拟合立体形状。它目前只适用于小鸭侧面图，背面通过对称假设推测，尚未接入通用
                AI 图片理解。部件模板保留旧版设计方式。
              </p>
            </li>
            <li>
              <b>查看完整造型与部件</b>
              <p>
                使用正面、侧面、背面、俯视按钮检查形状。分层展开按拼装步骤逐组分离，可每次查看
                6 层或全部展开，并调整层间距；收起后恢复真实安装位置。
              </p>
            </li>
            <li>
              <b>带走设计</b>
              <p>
                3D 使用 LDraw.org 社区维护的官方库几何，LDraw
                导出、数量清单与安装位置来自同一份模型。说明书使用简化示意图，支持下载
                HTML 或打印为 PDF。
              </p>
            </li>
          </ol>
          <div className="help-limits">
            <strong>检查范围</strong>
            <p>
              立体模式检查零件外包框重叠、顶部与侧面凸点连接，以及步骤中的连接依赖。未做受力、抗倾倒、夹持力仿真或实物试拼。轮廓模式仍使用基础砖与薄板，检查网格承托和连通。
            </p>
            <p>
              零件编号来自 LDraw，带 b 等后缀的编号表示其库中的形态版本。具体
              LEGO
              设计编号、颜色组合与库存需购买前核对。图片仅在本机处理，刷新后本次设计会清空。
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="export-dialog">
          <DialogTitle>带走你的积木设计</DialogTitle>
          <DialogDescription>
            {model.name} · {model.bricks.length} 块零件 · {model.levels.length}{' '}
            个步骤。导出的是当前预览对应的完整模型。
          </DialogDescription>
          {dirty && (
            <p className="export-disclaimer">
              参数有未应用的修改。若要导出新参数的结果，请先关闭此窗口并生成设计。
            </p>
          )}
          <button className="export-option" onClick={printManual}>
            <FileText />
            <span>
              <b>打开说明书 · 打印为 PDF</b>
              <small>逐块详细版：每页最多 4 块，含整组定位图</small>
            </span>
            <ArrowUpRight />
          </button>
          <button className="export-option" onClick={() => save('html')}>
            <BookOpen />
            <span>
              <b>下载离线说明书</b>
              <small>HTML 格式，无需联网即可浏览与打印</small>
            </span>
          </button>
          <button className="export-option" onClick={() => save('ldr')}>
            <Box />
            <span>
              <b>下载 LDraw 模型</b>
              <small>保留每个零件的位置、旋转与搭建步骤</small>
            </span>
          </button>
          <button className="export-option" onClick={() => save('csv')}>
            <Blocks />
            <span>
              <b>下载零件清单</b>
              <small>CSV 格式，可在 Excel 中查看</small>
            </span>
          </button>
          <p className="export-disclaimer">
            请先核对零件与颜色组合，并做实物试拼。
          </p>
        </DialogContent>
      </Dialog>
    </main>
  );
}
