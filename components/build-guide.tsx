'use client';
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Check, RotateCcw } from 'lucide-react';
import type { Model } from '@/lib/brick-engine';
import { inventory, PALETTE, PARTS } from '@/lib/brick-engine';
import {
  instructionModel,
  stageBricks,
  cleanStageName,
  partThumbnail,
  detailDiagram,
  topDiagram,
  installationText,
  isSideMounted,
  gridAddress,
} from '@/lib/build-instructions';

export default function BuildGuide({
  model,
  stage,
  onStageChange,
  onFocus,
}: {
  model: Model;
  stage: number;
  onStageChange: (stage: number) => void;
  onFocus: (id: number | undefined) => void;
}) {
  const guide = useMemo(() => instructionModel(model), [model]);
  const [progress, setProgress] = useState<{
    model: Model;
    stage: number;
    index: number;
    done: boolean;
    confirmed: number[];
  }>({ model, stage, index: 0, done: false, confirmed: [] });
  type View = 'detail' | 'placed' | 'top' | 'overview';
  const [viewState, setViewState] = useState<{
    model: Model;
    stage: number;
    value: View;
  }>({ model, stage, value: 'detail' });
  const view =
    viewState.model === model && viewState.stage === stage
      ? viewState.value
      : 'detail';
  const setView = (value: View) => setViewState({ model, stage, value });
  const confirmed =
    progress.model === model && progress.stage === stage
      ? progress.confirmed
      : [];
  const index =
    progress.model === model && progress.stage === stage ? progress.index : 0;
  const done =
    progress.model === model && progress.stage === stage && progress.done;
  const batch = useMemo(() => stageBricks(guide, stage), [guide, stage]),
    active = batch[index];
  const name = cleanStageName(guide.assembly!.steps[stage]?.name || '继续搭建');
  const parts = useMemo(() => inventory(batch), [batch]);
  const diagram = useMemo(
    () =>
      view === 'detail' || view === 'placed'
        ? detailDiagram(guide, stage, index, view === 'placed')
        : topDiagram(guide, stage, index, view === 'overview'),
    [guide, stage, index, view],
  );
  if (!active) return <p>这一组没有零件。</p>;
  const move = (n: number) => {
    setProgress({
      model,
      stage,
      index: Math.max(0, Math.min(batch.length - 1, n)),
      done: false,
      confirmed,
    });
    setView('detail');
    onFocus(batch[Math.max(0, Math.min(batch.length - 1, n))].id);
  };
  const changeStage = (s: number) => {
    onStageChange(s);
    setView('detail');
    onFocus(undefined);
  };
  const advance = () => {
    const nextConfirmed = [...new Set([...confirmed, index])];
    const complete = nextConfirmed.length === batch.length;
    const nextIndex = complete
      ? index
      : index < batch.length - 1
        ? index + 1
        : batch.findIndex((_, i) => !nextConfirmed.includes(i));
    setProgress({
      model,
      stage,
      index: nextIndex,
      done: complete,
      confirmed: nextConfirmed,
    });
    setView(complete ? 'overview' : 'detail');
    onFocus(complete ? undefined : batch[nextIndex].id);
  };
  return (
    <div className="build-guide">
      <div className="guide-heading">
        <div>
          <span className="guide-eyebrow">
            跟着拼 · 第 {stage + 1} / {guide.levels.length} 组
          </span>
          <h2>{name}</h2>
          <p>每次只装一块，完成后再继续。</p>
        </div>
        <div className="guide-group-nav">
          <button disabled={stage === 0} onClick={() => changeStage(stage - 1)}>
            <ChevronLeft size={16} />
            上一组
          </button>
          <button
            disabled={stage === guide.levels.length - 1}
            onClick={() => changeStage(stage + 1)}
          >
            下一组
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <details className="guide-parts">
        <summary>
          先备好这一组的零件{' '}
          <span>
            {batch.length} 块 · {parts.length} 种组合
          </span>
        </summary>
        <div className="guide-parts-grid">
          {parts.map((p) => {
            const b = batch.find(
              (b) => b.part === p.part && b.color === p.color,
            )!;
            return (
              <div className="guide-part-chip" key={`${p.part}-${p.color}`}>
                <div dangerouslySetInnerHTML={{ __html: partThumbnail(b) }} />
                <span>
                  <b>{PARTS[p.part]}</b>
                  <small>
                    {PALETTE[p.color].name} · {p.part}
                  </small>
                </span>
                <strong>×{p.quantity}</strong>
              </div>
            );
          })}
        </div>
      </details>
      {done ? (
        <div className="guide-complete" aria-live="polite">
          <Check size={22} />
          <div>
            <b>
              {stage === guide.levels.length - 1
                ? '全部步骤已完成'
                : '这一组拼好了'}
            </b>
            <p>对照下方总览，检查零件数量和朝向。</p>
          </div>
          <button onClick={() => move(0)}>
            <RotateCcw size={15} />
            重新查看
          </button>
          {stage < guide.levels.length - 1 && (
            <button
              className="guide-next"
              onClick={() => changeStage(stage + 1)}
            >
              开始下一组
              <ChevronRight size={16} />
            </button>
          )}
        </div>
      ) : (
        <div className="guide-workspace">
          <aside className="guide-action">
            <span className="guide-eyebrow">
              本组第 {index + 1} / {batch.length} 块
            </span>
            <h3>
              <i>1</i>拿这一块
            </h3>
            <div
              className="guide-pick"
              dangerouslySetInnerHTML={{ __html: partThumbnail(active) }}
            />
            <strong className="guide-part-title">
              {PARTS[active.part]} <span>× 1</span>
            </strong>
            <p className="guide-part-meta">
              {PALETTE[active.color].name} · 零件编号 {active.part}
            </p>
            <h3>
              <i>2</i>
              {isSideMounted(active) ? '对准侧面凸点' : '放到标记位置'}
            </h3>
            <p className="guide-action-text">
              {installationText(guide, active)}
            </p>
            <div className="guide-address">
              {isSideMounted(active)
                ? '侧向按入 →'
                : `定位格 ${gridAddress(guide, active)}`}
              <small>
                {isSideMounted(active)
                  ? '观察侧面，不要向下压'
                  : '俯视图：字母横向，数字从后向前'}
              </small>
            </div>
          </aside>
          <div className="guide-drawing">
            <fieldset className="guide-view-tabs" aria-label="拼装图视角">
              {[
                ['detail', '怎么装'],
                ['placed', '装好后'],
                ['top', '俯视定位'],
                ['overview', '整组总览'],
              ].map(([v, t]) => (
                <button
                  key={v}
                  aria-pressed={view === v}
                  onClick={() => {
                    setView(v as typeof view);
                    onFocus(v === 'overview' ? undefined : active.id);
                  }}
                >
                  {t}
                </button>
              ))}
            </fieldset>
            <div
              className={
                view === 'detail' || view === 'placed'
                  ? 'guide-diagram-pair'
                  : ''
              }
            >
              <div className="guide-main-diagram">
                {(view === 'detail' || view === 'placed') && (
                  <h4>
                    {view === 'placed'
                      ? '装好后，应当是这样'
                      : isSideMounted(active)
                        ? '沿箭头向内按入'
                        : active.y === 0
                          ? '先平放到虚线位置'
                          : '对准虚线位置，向下按紧'}
                  </h4>
                )}
                <div
                  className="guide-svg"
                  dangerouslySetInnerHTML={{ __html: diagram }}
                />
              </div>
              {(view === 'detail' || view === 'placed') && (
                <aside className="guide-inline-map">
                  <h4>
                    {isSideMounted(active)
                      ? '连接位置 · 从上方看'
                      : `定位 ${gridAddress(guide, active)} · 从上方看`}
                  </h4>
                  <div
                    dangerouslySetInnerHTML={{
                      __html: topDiagram(guide, stage, index, false, true),
                    }}
                  />
                  <p>
                    鸭嘴朝上；橙框是这一块的位置。
                    <br />
                    {isSideMounted(active)
                      ? '按左图从侧面连接。'
                      : '左后角对准橙色小圆点。'}
                  </p>
                </aside>
              )}
            </div>
            <p className="guide-legend">
              <span>
                <i className="legend-current" />
                {view === 'overview'
                  ? '橙框数字：本组安装顺序'
                  : view === 'placed'
                    ? '彩色：刚装好的这一块'
                    : '彩色：这一块 · 橙色虚线：放置位置'}
              </span>
              <span>
                <i />
                灰色：此前已安装
              </span>
            </p>
            <p className="guide-view-note">
              {view === 'detail'
                ? '彩色零件悬空展示；沿箭头装入橙色虚线位置，灰色部分保持不动。'
                : view === 'placed'
                  ? '对照安装后的外观与右侧定位图，检查方向和位置。'
                  : view === 'top'
                    ? '从正上方看：鸭嘴朝上。将零件左后角对齐橙色小圆点。'
                    : '这是整组完成后的外观，数字对应本组第几块。'}
            </p>
          </div>
        </div>
      )}
      {done && (
        <div
          className="guide-summary-svg"
          dangerouslySetInnerHTML={{
            __html: topDiagram(guide, stage, index, true),
          }}
        />
      )}
      <div className="guide-controls">
        <button
          disabled={index === 0 && !done}
          onClick={() => move(Math.max(0, index - 1))}
        >
          <ChevronLeft size={17} />
          上一块
        </button>
        <span aria-live="polite">
          {confirmed.length} / {batch.length} 块已确认
        </span>
        {!done && (
          <button className="guide-next" onClick={advance}>
            <Check size={17} />
            {index === batch.length - 1
              ? '这块装好了，检查整组'
              : '已装好，下一块'}
            <ChevronRight size={17} />
          </button>
        )}
      </div>
      <details className="guide-jump">
        <summary>跳到本组的某一块</summary>
        <div>
          {batch.map((b, i) => (
            <button
              key={b.id}
              aria-current={!done && i === index ? 'step' : undefined}
              onClick={() => move(i)}
            >
              {i + 1}
              {confirmed.includes(i) ? <Check size={11} /> : null}
            </button>
          ))}
        </div>
        <p>
          可返回检查或直接跳转；点“已装好”才会记录确认；切换组别或刷新会重置本组进度。
        </p>
      </details>
    </div>
  );
}
