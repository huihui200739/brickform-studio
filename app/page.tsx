'use client';
import { useMemo, useRef, useState } from 'react';
import {
  Box,
  Upload,
  ArrowRight,
  Layers3,
  FileText,
  Blocks,
  Download,
  Check,
  ChevronLeft,
  ChevronRight,
  Info,
  Sparkles,
  ImagePlus,
  ArrowUpRight,
  X,
  LoaderCircle,
  Ruler,
  Palette,
  ShieldCheck,
  BookOpen,
} from 'lucide-react';
import ModelViewer from '@/components/model-viewer';
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
  sampleModel,
  imageToModel,
  inventory,
  validateModel,
  toLDraw,
  PARTS,
  PALETTE,
  type Raster,
  type Options,
} from '@/lib/brick-engine';
import { csv, download, layerSVG, manualHTML } from '@/lib/manual';
const backgroundItems = [
  { value: 'auto', label: '自动识别背景' },
  { value: 'white', label: '去除白色背景' },
  { value: 'keep', label: '保留完整图片' },
];
export default function Home() {
  const [model, setModel] = useState(() => sampleModel());
  const [resolution, setResolution] = useState(20);
  const [depth, setDepth] = useState(8);
  const [threshold, setThreshold] = useState(70);
  const [background, setBackground] = useState<Options['background']>('auto');
  const [source, setSource] = useState<{
    raster: Raster;
    url: string;
    name: string;
  } | null>(null);
  const [layer, setLayer] = useState(model.height);
  const [exploded, setExploded] = useState(false);
  const [tab, setTab] = useState('parts');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [help, setHelp] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [drag, setDrag] = useState(false);
  const [search, setSearch] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const uploadToken = useRef(0);
  const parts = useMemo(() => inventory(model.bricks), [model]);
  const validation = useMemo(() => validateModel(model), [model]);
  const shownParts = parts.filter((p) =>
    `${p.part} ${PARTS[p.part]} ${PALETTE[p.color].name}`.includes(search),
  );
  const colors = [...new Set(model.bricks.map((b) => b.color))];
  const layerParts = model.bricks.filter((b) => b.y === layer - 1);
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
      const img = new Image();
      img.src = url;
      await img.decode();
      if (img.naturalWidth * img.naturalHeight > 40000000)
        throw new Error('图片尺寸过大，请缩小到 4000 万像素以内。');
      const ratio = Math.min(
        1,
        128 / Math.max(img.naturalWidth, img.naturalHeight),
      );
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('浏览器无法读取图片，请更换浏览器后重试。');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      if (token !== uploadToken.current) {
        URL.revokeObjectURL(url);
        return;
      }
      if (source) URL.revokeObjectURL(source.url);
      setSource({
        raster: {
          width: pixels.width,
          height: pixels.height,
          data: pixels.data,
        },
        url,
        name: file.name.replace(/\.[^.]+$/, '').slice(0, 60),
      });
      setDirty(true);
      setNotice('图片已就绪，点击「生成积木设计」查看结果。');
    } catch (e) {
      if (url) URL.revokeObjectURL(url);
      setError(
        e instanceof Error ? e.message : '无法读取图片，请更换图片重试。',
      );
    } finally {
      if (token === uploadToken.current) setBusy(false);
    }
  }
  async function generate() {
    setBusy(true);
    setError('');
    setNotice('');
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    try {
      const next = source
        ? imageToModel(
            source.raster,
            { resolution, depth, threshold, background },
            source.name,
          )
        : sampleModel(resolution, depth);
      const result = validateModel(next);
      if (result.collisions || result.unsupported || !result.connected)
        throw new Error('模型未通过连接检查，请降低精细度或更换图片。');
      setModel(next);
      setLayer(next.height);
      setExploded(false);
      setDirty(false);
      setNotice(
        `设计已生成，共 ${next.bricks.length} 块积木，${next.height} 层。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  function resetSample() {
    if (source) URL.revokeObjectURL(source.url);
    setSource(null);
    setError('');
    setNotice('已选择小黄鸭示例，可调整参数后生成。');
    setDirty(true);
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
    setNotice('文件已导出。说明书 HTML 可用浏览器打开，打印或另存为 PDF。');
  }
  function printManual() {
    const win = window.open('', '_blank');
    if (!win) {
      setNotice('浏览器拦截了新窗口，请下载 HTML 说明书后打开打印。');
      return;
    }
    win.opener = null;
    win.document.write(manualHTML(model));
    win.document.close();
    setExportOpen(false);
  }
  return (
    <main className="studio">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-icon">
            <Blocks size={22} />
          </span>
          brickform<span className="brand-cn">积木工坊</span>
          <span className="beta">BETA 01</span>
        </a>
        <nav>
          <span className="nav-active">设计工作台</span>
          <button onClick={() => setHelp(true)}>
            <BookOpen size={16} /> 使用说明
          </button>
        </nav>
        <span className="local-badge">
          <span className="live-dot" /> 图片仅在本机处理
        </span>
      </header>
      <div className="page-heading">
        <div>
          <p className="eyebrow">YOUR NEXT LITTLE CREATION</p>
          <h1>
            把喜欢的事物，拼出来<span className="title-dot">。</span>
          </h1>
          <p>一张参考图，一份属于你的积木设计。</p>
        </div>
        <div className="flow">
          <span className="flow-current">
            <b>1</b> 参考图片
          </span>
          <ChevronRight />
          <span>
            <b>2</b> 积木模型
          </span>
          <ChevronRight />
          <span>
            <b>3</b> 开始拼搭
          </span>
        </div>
      </div>
      <div className="workspace">
        <aside className="input-panel">
          <h2>
            01 <span>参考与设置</span>
          </h2>
          <input
            className="sr-only"
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(e) => {
              void upload(e.target.files?.[0]);
              e.target.value = '';
            }}
            aria-label="上传参考图片"
          />
          <button
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
            className={`upload-zone ${drag ? 'dragging' : ''} ${source ? 'has-image' : ''}`}
          >
            {source ? (
              <>
                <img src={source.url} alt={`参考图片：${source.name}`} />
                <span className="replace-image">
                  <ImagePlus size={14} /> 更换图片
                </span>
              </>
            ) : (
              <>
                <span className="upload-icon">
                  <Upload size={23} />
                </span>
                <strong>点击上传，或拖入图片</strong>
                <span>PNG / JPG / WebP，最大 10 MB</span>
              </>
            )}
          </button>
          {source ? (
            <div className="file-caption">
              <span>{source.name}</span>
              <button
                aria-label="移除参考图片"
                disabled={busy}
                onClick={resetSample}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="sample-row">
              <span>先试试看</span>
              <button disabled={busy} onClick={resetSample}>
                小黄鸭示例 <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          <div className="divider" />
          <label className="field-title" id="resolution-label">
            模型精细度 <span>{resolution} 凸点</span>
          </label>
          <RadioGroup
            className="detail-options"
            value={String(resolution)}
            onValueChange={(v) => {
              setResolution(Number(v));
              setDirty(true);
            }}
            aria-labelledby="resolution-label"
            disabled={busy}
          >
            {[
              { v: 12, t: '简约' },
              { v: 20, t: '标准' },
              { v: 28, t: '精细' },
            ].map((o) => (
              <label key={o.v} className={resolution === o.v ? 'chosen' : ''}>
                <RadioGroupItem value={String(o.v)} />
                <span>{o.t}</span>
              </label>
            ))}
          </RadioGroup>
          <p className="field-hint">越精细，轮廓越清晰，所需零件越多。</p>
          <label className="field-title" id="depth-label">
            模型厚度 <span>{depth} 凸点</span>
          </label>
          <Slider
            aria-labelledby="depth-label"
            value={[depth]}
            min={2}
            max={10}
            step={2}
            disabled={busy}
            onValueChange={(v) => {
              setDepth(Array.isArray(v) ? v[0] : v);
              setDirty(true);
            }}
          />
          <div className="range-label">
            <span>轻巧</span>
            <span>饱满</span>
          </div>
          <label className="field-title" id="background-label">
            图片背景
          </label>
          <Select
            items={backgroundItems}
            value={background}
            disabled={busy || !source}
            onValueChange={(v) => {
              if (v) {
                setBackground(v as Options['background']);
                setDirty(true);
              }
            }}
          >
            <SelectTrigger
              aria-labelledby="background-label"
              className="background-select"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {backgroundItems.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {source && background !== 'keep' && (
            <div className="threshold-field">
              <label className="field-title" id="threshold-label">
                去除强度 <span>{threshold}</span>
              </label>
              <Slider
                aria-labelledby="threshold-label"
                disabled={busy}
                min={10}
                max={180}
                step={5}
                value={[threshold]}
                onValueChange={(v) => {
                  setThreshold(Array.isArray(v) ? v[0] : v);
                  setDirty(true);
                }}
              />
            </div>
          )}
          <div className="palette-field">
            <label className="field-title">
              基础配色 <span>6 色</span>
            </label>
            <div className="swatches">
              {PALETTE.map((c) => (
                <span
                  key={c.name}
                  style={{ background: c.hex }}
                  title={`${c.name} · LEGO ${c.lego}`}
                />
              ))}
            </div>
          </div>
          <button
            className="primary generate"
            onClick={() => void generate()}
            disabled={busy}
          >
            {busy ? (
              <LoaderCircle size={17} className="spin" />
            ) : (
              <Sparkles size={17} />
            )}{' '}
            {busy ? '正在构建…' : dirty ? '生成积木设计' : '重新生成设计'}{' '}
            {!busy && <ArrowRight size={17} />}
          </button>
          <p className="below-action">使用 3 种基础砖块 · 自动加入底座</p>
          <div className="tip">
            <Info size={16} />
            <p>选择主体完整、背景干净的侧面图片，轮廓效果更好。</p>
          </div>
        </aside>
        <div className="main-column">
          <section className="preview-panel">
            <div className="panel-toolbar">
              <strong>
                <Box size={17} /> 设计预览 <span className="tiny-tag">3D</span>
              </strong>
              <span>
                {dirty ? '参考或参数已改变 · 待生成' : '模型与清单已同步'}
              </span>
            </div>
            <ModelViewer
              model={model}
              layer={layer}
              exploded={exploded}
              onExplode={() => setExploded((v) => !v)}
            />
            <div className="layer-control">
              <span>
                <Layers3 size={16} /> 显示层数
              </span>
              <Slider
                aria-label="显示层数"
                value={[layer]}
                min={1}
                max={model.height}
                step={1}
                onValueChange={(v) => setLayer(Array.isArray(v) ? v[0] : v)}
              />
              <b>
                {String(layer).padStart(2, '0')} <small>/ {model.height}</small>
              </b>
              <button
                onClick={() => {
                  setLayer(model.height);
                  setExploded(false);
                }}
              >
                完整模型
              </button>
            </div>
          </section>
          <section className="output-panel">
            <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
              <div className="output-header">
                <TabsList variant="line">
                  <TabsTrigger value="parts">
                    <Blocks /> 零件清单 <span>{parts.length}</span>
                  </TabsTrigger>
                  <TabsTrigger value="steps">
                    <FileText /> 拼装步骤
                  </TabsTrigger>
                </TabsList>
                <button className="text-button" onClick={() => save('csv')}>
                  <Download size={14} /> 导出 CSV
                </button>
              </div>
              <TabsContent value="parts">
                <div className="table-intro">
                  <span>包含主体、底座及白色支撑</span>
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
                              <Blocks
                                size={23}
                                style={{
                                  color:
                                    PALETTE[p.color].hex === '#F4F4F4'
                                      ? '#87958b'
                                      : PALETTE[p.color].hex,
                                }}
                              />
                              {PARTS[p.part]}
                            </span>
                          </TableCell>
                          <TableCell className="mono">{p.part}</TableCell>
                          <TableCell>
                            <span className="color-name">
                              <i style={{ background: PALETTE[p.color].hex }} />
                              {PALETTE[p.color].name}
                            </span>
                          </TableCell>
                          <TableCell className="quantity mono">
                            {p.quantity}
                          </TableCell>
                          <TableCell>
                            <a
                              href={`https://www.lego.com/en-us/pick-and-build/pick-a-brick?query=${p.part}`}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`在乐高官网核对 ${p.part} ${PALETTE[p.color].name}`}
                            >
                              <ArrowUpRight size={14} />
                            </a>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                  {!shownParts.length && (
                    <p className="empty-search">
                      没有匹配的零件，试试编号 3005 或「白色」。
                    </p>
                  )}
                </div>
                <div className="table-foot">
                  设计编号可核查 · 色号与在售组合需购买前核对{' '}
                  <span>
                    总计 <b>{model.bricks.length}</b> 块
                  </span>
                </div>
              </TabsContent>
              <TabsContent value="steps">
                <div className="step-navigation">
                  <div>
                    <b>第 {String(layer).padStart(2, '0')} 层</b>
                    <span>
                      {layer <= 2 ? '交错拼接底座' : '向上搭建主体与支撑'} ·
                      新增 {layerParts.length} 块
                    </span>
                  </div>
                  <div>
                    <button
                      aria-label="上一层"
                      disabled={layer <= 1}
                      onClick={() => setLayer((v) => v - 1)}
                    >
                      <ChevronLeft size={18} />
                    </button>
                    <button
                      aria-label="下一层"
                      disabled={layer >= model.height}
                      onClick={() => setLayer((v) => v + 1)}
                    >
                      <ChevronRight size={18} />
                    </button>
                  </div>
                </div>
                <div
                  className="step-plan"
                  dangerouslySetInnerHTML={{
                    __html: layerSVG(model, layer - 1),
                  }}
                />
                <p className="plan-caption">
                  俯视图 · 上方为 X 坐标，左侧为 Z 坐标 · 数字对应下方零件序号
                </p>
                <div className="step-table">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>序号</TableHead>
                        <TableHead>零件 / 颜色</TableHead>
                        <TableHead>左上角 X / Z</TableHead>
                        <TableHead>X × Z</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {layerParts.map((b) => (
                        <TableRow key={b.id}>
                          <TableCell>#{b.id}</TableCell>
                          <TableCell>
                            {b.part} · {PALETTE[b.color].name}
                            {b.support ? '（支撑）' : ''}
                          </TableCell>
                          <TableCell>
                            {b.x + 1} / {b.z + 1}
                          </TableCell>
                          <TableCell>
                            {b.w} × {b.d}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>
            </Tabs>
          </section>
        </div>
        <aside className="summary-column">
          <section className="summary-card">
            <div className="section-kicker">
              02 <span>你的积木设计</span>
            </div>
            <h2>{model.name}</h2>
            <p>
              {model.source === 'sample'
                ? '参数化示例 · 可调尺寸'
                : '轮廓拉伸 · 背面为推测'}
            </p>
            <div className="big-stat">
              <strong>{model.bricks.length.toLocaleString()}</strong>
              <span>块积木</span>
            </div>
            <div className="stat-grid">
              <div>
                <Palette size={16} />
                <b>{colors.length}</b>
                <span>种颜色</span>
              </div>
              <div>
                <Layers3 size={16} />
                <b>{model.height}</b>
                <span>层搭建</span>
              </div>
            </div>
            <div className="dimension">
              <Ruler size={16} />
              <span>
                {(model.width * 0.8).toFixed(1)} ×{' '}
                {(model.depth * 0.8).toFixed(1)} ×{' '}
                {(model.height * 0.96).toFixed(1)} cm
                <small>宽 × 深 × 高，含底座，不含凸点</small>
              </span>
            </div>
            <div className="divider" />
            <h3>
              <ShieldCheck size={17} /> 结构检查
            </h3>
            <ul className="check-list">
              <li>
                <Check />{' '}
                {validation.collisions === 0 ? '没有零件重叠' : '存在重叠'}
              </li>
              <li>
                <Check />{' '}
                {validation.unsupported === 0
                  ? '每块均有下方承托'
                  : '存在悬空零件'}
              </li>
              <li>
                <Check />{' '}
                {validation.connected ? '完整模型连为一体' : '模型尚未连通'}
              </li>
            </ul>
            <div className="support-note">
              已加入 <b>{model.supportCount}</b> 块白色支撑。
              <br />
              物理稳定性与实物拼装尚未验证。
            </div>
          </section>
          <section className="export-card">
            <span className="export-icon">
              <BookOpen size={23} />
            </span>
            <h3>准备好，开始拼搭。</h3>
            <p>
              按层定位每一块零件，
              <br />
              让屏幕里的创意来到手中。
            </p>
            <button className="primary" onClick={() => setExportOpen(true)}>
              <Download size={16} /> 导出拼装说明书
            </button>
            <button className="secondary" onClick={() => save('ldr')}>
              <Box size={15} /> 下载 LDraw 模型
            </button>
            <span className="export-formats">图文步骤 · 完整清单 · 可打印</span>
          </section>
          <div className="version-note">
            <span className="tiny-tag">V1</span>
            <p>
              当前支持基础砖块轮廓摆件。照片中的背面与真实结构仍需人工判断。
            </p>
          </div>
        </aside>
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
          <Blocks size={15} /> Small bricks. Endless possibilities.
        </span>
        <span>
          独立创作工具，与 LEGO Group 无关联或认证。
          <button onClick={() => setHelp(true)}>
            了解第一版能力 <ArrowUpRight size={12} />
          </button>
        </span>
      </footer>
      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="help-dialog">
          <DialogTitle>从参考图到积木摆件</DialogTitle>
          <DialogDescription>
            第一版生成的是图片轮廓的积木化摆件。推荐使用背景干净、主体完整的侧面图片。
          </DialogDescription>
          <ol className="help-steps">
            <li>
              <b>上传并调整</b>
              <p>
                选择精细度、厚度和去除背景的强度，点击生成。复杂背景可选择「保留完整图片」。
              </p>
            </li>
            <li>
              <b>检查 3D 与支撑</b>
              <p>
                旋转预览，拖动层数滑块查看结构。白色支撑会填补悬空区域，模型下方自动加入两层底座。
              </p>
            </li>
            <li>
              <b>导出并拼搭</b>
              <p>
                零件清单按设计编号和颜色汇总；说明书标出每个零件的坐标及方向。下载
                HTML 后可打印为 PDF。
              </p>
            </li>
          </ol>
          <div className="help-limits">
            <strong>这版的能力边界</strong>
            <p>
              没有使用 AI
              还原三维背面。图片模型采用等厚拉伸，示例小黄鸭为独立参数模型。算法只检查网格重叠、承托与连通，未验证抗倾倒、夹持力或实物拼装。
            </p>
            <p>
              内置 3005（1×1）、3004（1×2）、3010（1×4）和 6
              种基础色。尚未接入完整零件 / 颜色组合库及实时库存，购买前请到{' '}
              <a
                href="https://www.lego.com/en-us/pick-and-build/pick-a-brick"
                target="_blank"
                rel="noreferrer"
              >
                LEGO Pick a Brick 核对
              </a>
              。图片仅在浏览器内处理，刷新页面会清空本次设计。
            </p>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="export-dialog">
          <DialogTitle>带走你的拼装设计</DialogTitle>
          <DialogDescription>
            {model.name} · {model.bricks.length} 块零件 · {model.height}{' '}
            层。说明书包含编号、颜色、坐标与分层俯视图。
          </DialogDescription>
          <button className="export-option" onClick={printManual}>
            <FileText />
            <span>
              <b>打开说明书 · 打印为 PDF</b>
              <small>在新窗口中点击「打印 / 另存为 PDF」</small>
            </span>
            <ArrowUpRight />
          </button>
          <button className="export-option" onClick={() => save('html')}>
            <Download />
            <span>
              <b>下载离线说明书</b>
              <small>HTML 格式，无需联网即可浏览与打印</small>
            </span>
          </button>
          <button className="export-option" onClick={() => save('csv')}>
            <Blocks />
            <span>
              <b>下载完整零件清单</b>
              <small>CSV 格式，可在 Excel 中查看</small>
            </span>
          </button>
          <p className="export-disclaimer">
            包含白色支撑及底座。请核对零件与颜色组合，并先做小规模试拼。
          </p>
        </DialogContent>
      </Dialog>
    </main>
  );
}
