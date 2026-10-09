'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import {
  Box,
  Palette,
  FileText,
  Layers,
  Landmark,
  Bird,
  Coffee,
} from 'lucide-react';
import {
  readWorkspaceImage,
  type WorkspaceSource,
} from '../lib/workspace-source';
import './design-tokens.css';
import './home.css';

export type HomePageProps = {
  onUpload: (source: WorkspaceSource) => void;
};

type Example = 'temple' | 'duck' | 'cup';
type UploadRequest =
  | { kind: 'file'; file: File }
  | { kind: 'example'; example: Example };

export default function HomePage({ onUpload }: HomePageProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const uploadToken = useRef(0);
  const mounted = useRef(true);
  const dragDepth = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const lastRequest = useRef<UploadRequest | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      uploadToken.current = uploadToken.current + 1;
      activeRequest.current?.abort();
    };
  }, []);

  function chooseFile() {
    if (!input.current) return;
    input.current.value = '';
    input.current.click();
  }

  async function upload(request: UploadRequest) {
    if (!mounted.current) return;
    const token = ++uploadToken.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    lastRequest.current = request;
    setBusy(true);
    setError('');
    setDragging(false);
    dragDepth.current = 0;
    try {
      const file =
        request.kind === 'file'
          ? request.file
          : await exampleFile(request.example, controller.signal);
      // Newer selections invalidate old downloads, decodes, errors and callbacks.
      if (!mounted.current || token !== uploadToken.current) return;
      const source = await readWorkspaceImage(file);
      if (!mounted.current || token !== uploadToken.current) return;
      onUpload(source);
    } catch (cause) {
      if (!mounted.current || token !== uploadToken.current) return;
      setError(
        cause instanceof Error ? cause.message : '无法读取图片，请重试。',
      );
    } finally {
      if (mounted.current && token === uploadToken.current) {
        setBusy(false);
        activeRequest.current = null;
      }
    }
  }

  function rejectDrop(message: string) {
    uploadToken.current++;
    activeRequest.current?.abort();
    activeRequest.current = null;
    lastRequest.current = null;
    setBusy(false);
    setError(message);
  }

  return (
    <div className="home-page">
      <header className="hero-nav">
        <div className="container">
          <div className="nav-content">
            <div className="brand">
              <div className="brand-icon" aria-hidden="true">
                <svg viewBox="0 0 32 32" fill="none">
                  <path d="m4 11 12-7 12 7-12 7-12-7Z" fill="currentColor" />
                  <path
                    d="m4 14 12 7 12-7v8l-12 7-12-7v-8Z"
                    fill="currentColor"
                    opacity=".6"
                  />
                  <ellipse cx="12" cy="10" rx="2.6" ry="1.5" fill="white" />
                  <ellipse cx="20" cy="10" rx="2.6" ry="1.5" fill="white" />
                </svg>
              </div>
              <span className="brand-name">
                Brickform<span className="brand-caption">DESIGN STUDIO</span>
              </span>
            </div>
            <nav className="nav-links" aria-label="主导航">
              <a href="#examples">示例</a>
              <a href="#guide">使用指南</a>
              <Link
                href="/advanced"
                prefetch={false}
                onClick={(event) => {
                  event.preventDefault();
                  // The legacy workbench owns global CSS; don't retain it in SPA navigation.
                  window.location.assign('/advanced');
                }}
              >
                高级工作台
              </Link>
              <a
                href="https://github.com/huihui200739/brickform-studio"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub
              </a>
            </nav>
          </div>
        </div>
      </header>

      <main className="hero-section">
        <div className="container">
          <div className="hero-content">
            <div className="hero-intro">
              <p className="hero-eyebrow">
                <span /> 从参考，到可以亲手搭建的设计
              </p>
              <h1 className="hero-title">
                把参考图片变成
                <span className="gradient-text">积木模型</span>
              </h1>
              <p className="hero-subtitle">
                上传图片，先生成并检查三维草稿，再转换为积木模型，
                <br />
                导出零件清单和分步拼装说明
              </p>

              <div className="hero-method" aria-label="设计流程">
                <span>
                  <b>01</b> 观察轮廓
                </span>
                <span>
                  <b>02</b> 检查结构
                </span>
                <span>
                  <b>03</b> 开始拼装
                </span>
              </div>
              <figure className="hero-study">
                <Image
                  src="/brickform-study.svg"
                  width={580}
                  height={340}
                  unoptimized
                  alt="纸白、陶橙和橄榄色的等距积木几何插图"
                />
                <figcaption>
                  <span>FORM & STRUCTURE</span>
                  <span>结构示意 · 非生成结果</span>
                </figcaption>
              </figure>
            </div>
            <div className="hero-station">
              <div className="station-heading">
                <span className="station-index">01 / START</span>
                <h2>从一张参考图开始</h2>
                <p>先看三维草稿，再决定如何搭建。</p>
              </div>
              <div className="upload-card">
                <button
                  type="button"
                  className={`upload-zone${dragging ? ' is-dragging' : ''}${busy ? ' is-loading' : ''}`}
                  aria-label="上传 PNG、JPEG 或 WebP 图片"
                  aria-describedby="upload-hint upload-status"
                  aria-busy={busy}
                  onClick={chooseFile}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      chooseFile();
                    }
                  }}
                  onDragEnter={(event) => {
                    event.preventDefault();
                    if (!event.dataTransfer.types.includes('Files')) return;
                    dragDepth.current++;
                    setDragging(true);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragLeave={(event) => {
                    event.preventDefault();
                    dragDepth.current = Math.max(0, dragDepth.current - 1);
                    if (!dragDepth.current) setDragging(false);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dragDepth.current = 0;
                    setDragging(false);
                    if (event.dataTransfer.files.length !== 1) {
                      rejectDrop('请一次上传一张 PNG、JPEG 或 WebP 图片。');
                      return;
                    }
                    void upload({
                      kind: 'file',
                      file: event.dataTransfer.files[0],
                    });
                  }}
                >
                  <span className="upload-icon-circle" aria-hidden="true">
                    <svg
                      width="40"
                      height="40"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                      />
                    </svg>
                  </span>
                  <span className="upload-text">
                    <strong>
                      {dragging
                        ? '松开以读取图片'
                        : busy
                          ? '正在读取参考图片…'
                          : '拖拽图片到这里'}
                    </strong>
                    <span>
                      {busy
                        ? '也可以选择另一张图片替换当前上传'
                        : '或点击选择文件（支持 Enter / 空格键）'}
                    </span>
                  </span>
                  <span className="upload-hint" id="upload-hint">
                    PNG、JPEG / JPG、WebP · 最大 10 MB · 不超过 4000 万像素
                  </span>
                </button>
                <input
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  aria-label="选择参考图片"
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    // Reset before processing, so the same file always fires change.
                    event.currentTarget.value = '';
                    if (file) void upload({ kind: 'file', file });
                  }}
                />
                <div id="upload-status" className="upload-status">
                  {busy && (
                    <p className="upload-loading" role="alert">
                      正在校验、解码并准备图片，请稍候…
                    </p>
                  )}
                  {error && (
                    <div className="upload-error" role="alert">
                      <p>{error}</p>
                      <button
                        type="button"
                        className="upload-retry"
                        disabled={busy}
                        onClick={() => {
                          if (lastRequest.current)
                            void upload(lastRequest.current);
                          else chooseFile();
                        }}
                      >
                        重试
                      </button>
                    </div>
                  )}
                </div>
                <p className="upload-note">
                  单张图片无法保证还原真实三维结构；结果取决于图片与重建服务，请先检查草稿。
                </p>
              </div>

              <section
                className="examples-row"
                id="examples"
                aria-label="参考图示例"
              >
                <span className="examples-label">
                  或试试这些真实可加载的示例：
                </span>
                <div className="example-chips">
                  <button
                    type="button"
                    className="chip"
                    data-example="temple"
                    disabled={busy}
                    onClick={() =>
                      void upload({ kind: 'example', example: 'temple' })
                    }
                  >
                    <Landmark size={16} aria-hidden="true" /> 神庙（合成示例）
                  </button>
                  <button
                    type="button"
                    className="chip"
                    data-example="duck"
                    disabled={busy}
                    onClick={() =>
                      void upload({ kind: 'example', example: 'duck' })
                    }
                  >
                    <Bird size={16} aria-hidden="true" /> 橡皮小鸭
                  </button>
                  <button
                    type="button"
                    className="chip"
                    data-example="cup"
                    disabled={busy}
                    onClick={() =>
                      void upload({ kind: 'example', example: 'cup' })
                    }
                  >
                    <Coffee size={16} aria-hidden="true" /> 咖啡杯（合成示例）
                  </button>
                </div>
                <p className="examples-note">
                  小鸭使用内置参考图片；神庙与咖啡杯为 Canvas
                  绘制的合成参考图，均走同一图片处理流程。
                </p>
              </section>
              <figure className="reference-mini">
                <Image
                  src="/reference-duck.png"
                  width={112}
                  height={84}
                  unoptimized
                  alt="橡皮小鸭参考照片"
                />
                <figcaption>
                  <span>REFERENCE / 01</span>
                  <strong>橡皮小鸭</strong>
                  <p>内置参考示例，非生成效果展示。</p>
                </figcaption>
              </figure>
            </div>
          </div>

          <div className="features-heading">
            <span>为完整的设计流程而做</span>
            <span>REFERENCE → BUILD</span>
          </div>
          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon" aria-hidden="true">
                <Box size={23} strokeWidth={1.5} />
              </div>
              <h3>先看草稿</h3>
              <p>
                以你的参考图生成三维草稿，检查轮廓后再转换；服务不可用或重建失败会明确提示
              </p>
            </div>
            <div className="feature-card">
              <div className="feature-icon" aria-hidden="true">
                <Palette size={23} strokeWidth={1.5} />
              </div>
              <h3>参考图配色</h3>
              <p>采样图片颜色并映射到积木色系，颜色与细节可能存在近似</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon" aria-hidden="true">
                <Layers size={23} strokeWidth={1.5} />
              </div>
              <h3>分步说明</h3>
              <p>根据实际生成的零件与位置整理拼装步骤，不使用固定的示例清单</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon" aria-hidden="true">
                <FileText size={23} strokeWidth={1.5} />
              </div>
              <h3>下载文件</h3>
              <p>
                生成后导出零件清单、拼装说明和 LDraw 文件；不提供实时价格报价
              </p>
            </div>
          </div>
        </div>
      </main>

      <section
        className="workflow-section"
        id="guide"
        aria-labelledby="guide-title"
      >
        <div className="container">
          <h2 className="section-title" id="guide-title">
            三步开始
          </h2>
          <div className="workflow-steps">
            <div className="workflow-step">
              <div className="step-number">1</div>
              <div className="step-content">
                <h3>上传参考图</h3>
                <p>拖拽或点击选择 PNG、JPEG、WebP 图片</p>
                <div className="step-tip">
                  图片建议 / 主体清晰、背景简洁，避免遮挡和复杂场景
                </div>
              </div>
            </div>
            <div className="workflow-arrow" aria-hidden="true">
              →
            </div>
            <div className="workflow-step">
              <div className="step-number">2</div>
              <div className="step-content">
                <h3>检查并生成</h3>
                <p>生成三维草稿并旋转查看，确认后转换为积木</p>
                <div className="step-tip">
                  生成设置 / 调整尺寸与厚度；生成耗时依图片与服务而定
                </div>
              </div>
            </div>
            <div className="workflow-arrow" aria-hidden="true">
              →
            </div>
            <div className="workflow-step">
              <div className="step-number">3</div>
              <div className="step-content">
                <h3>下载结果</h3>
                <p>检查生成结果，下载零件清单、说明书和模型文件</p>
                <div className="step-tip">交付格式 / LDraw · CSV · HTML</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <footer className="site-footer">
        <div className="container">
          <div className="footer-content">
            <span className="mono">Brickform Studio</span>
            <span>
              A reference-to-build workspace · by{' '}
              <a
                href="https://github.com/huihui200739"
                target="_blank"
                rel="noopener noreferrer"
              >
                huihui200739
              </a>
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

async function exampleFile(
  example: Example,
  signal: AbortSignal,
): Promise<File> {
  if (example === 'duck') {
    const response = await fetch('/reference-duck.png', { signal });
    if (!response.ok)
      throw Error('小鸭参考图加载失败，请重试或上传自己的图片。');
    const blob = await response.blob();
    // Same-origin static PNG; the loader still validates and decodes the bytes.
    return new File([blob], '橡皮小鸭.png', { type: 'image/png' });
  }

  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  try {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw Error('浏览器无法绘制合成示例，请上传自己的图片。');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (example === 'temple') {
      ctx.fillStyle = '#c4a875';
      ctx.fillRect(105, 350, 430, 28);
      ctx.fillRect(125, 325, 390, 25);
      ctx.fillStyle = '#e2c692';
      for (let x = 155; x <= 455; x += 100) {
        ctx.fillRect(x, 205, 30, 120);
        ctx.fillRect(x - 10, 195, 50, 16);
        ctx.fillRect(x - 10, 313, 50, 16);
      }
      ctx.fillStyle = '#ac8052';
      ctx.fillRect(120, 180, 400, 20);
      ctx.beginPath();
      ctx.moveTo(100, 180);
      ctx.lineTo(320, 85);
      ctx.lineTo(540, 180);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#e2c692';
      ctx.beginPath();
      ctx.moveTo(175, 164);
      ctx.lineTo(320, 104);
      ctx.lineTo(465, 164);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.strokeStyle = '#3d8cb5';
      ctx.lineWidth = 28;
      ctx.beginPath();
      ctx.ellipse(427, 247, 60, 65, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#65b4d7';
      ctx.beginPath();
      ctx.moveTo(160, 155);
      ctx.lineTo(410, 155);
      ctx.lineTo(389, 330);
      ctx.quadraticCurveTo(285, 372, 181, 330);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#287ca5';
      ctx.beginPath();
      ctx.ellipse(285, 155, 125, 28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5b3826';
      ctx.beginPath();
      ctx.ellipse(285, 155, 110, 18, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(Error('无法读取合成示例，请重试或上传自己的图片。'));
      }, 'image/png');
    });
    return new File(
      [blob],
      `${example === 'temple' ? '神庙' : '咖啡杯'}-合成示例.png`,
      { type: 'image/png' },
    );
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
