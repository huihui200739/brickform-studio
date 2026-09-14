'use client';
import { useState } from 'react';
import {
  COMPONENT_LABELS,
  COMPONENT_SIZES,
  suggestComponents,
  type ComponentKind,
  type ComponentRegion,
} from '@/lib/semantic-components';
import type { TriangleMesh } from '@/lib/mesh-types';
export default function ComponentEditor({
  mesh,
  resolution,
  regions,
  onChange,
  selected,
  onSelect,
  picking,
  onPicking,
  disabled = false,
  autoStatus = '',
  autoBusy = false,
  onAuto,
}: {
  disabled?: boolean;
  mesh: TriangleMesh;
  resolution: number;
  regions: ComponentRegion[];
  onChange: (v: ComponentRegion[]) => void;
  selected: string;
  onSelect: (id: string) => void;
  picking: boolean;
  onPicking: (p: boolean) => void;
  autoStatus?: string;
  autoBusy?: boolean;
  onAuto?: () => void;
}) {
  const [hint, setHint] = useState('颜色候选不等于物件识别；人物请手动定位。');
  const active = regions.find((r) => r.id === selected);
  // Manual components must be located before being included; they never
  // silently materialise at the scene origin.
  function add(kind: ComponentKind) {
    const id = crypto.randomUUID();
    onChange([
      ...regions,
      {
        id,
        kind,
        placed: false,
        positionLocked: true,
        anchor: [0.5, 0, 0.5],
        ...COMPONENT_SIZES[kind],
        rotation: kind === 'statue' ? 2 : 0,
      },
    ]);
    onSelect(id);
    onPicking(true);
  }
  function patch(update: Partial<ComponentRegion>) {
    onChange(
      regions.map((r) =>
        r.id === selected
          ? {
              ...r,
              ...update,
              placementStatus: undefined,
              ...(update.anchor
                ? { referenceAnchor: update.anchor, positionLocked: true }
                : {}),
            }
          : r,
      ),
    );
  }
  return (
    <section className="component-editor">
      <fieldset
        disabled={disabled}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}
      >
        <div className="component-title">
          <div>
            <h3>用合适的零件替换细节</h3>
            <p>
              先检查树、火盆和人物候选的位置；无法在原位附近安装的组件会保留原网格，等待你调整。
            </p>
          </div>
          <span>部件装配 · 试验版</span>
        </div>
        <div className="component-library">
          {(Object.keys(COMPONENT_LABELS) as ComponentKind[]).map((kind) => (
            <button
              disabled={regions.length >= 12}
              key={kind}
              onClick={() => add(kind)}
            >
              <img src={`/components/${kind}.png`} alt="" />
              <strong>＋ {COMPONENT_LABELS[kind]}</strong>
              <small>
                {kind === 'tree'
                  ? '树干与枝叶片'
                  : kind === 'brazier'
                    ? '底座、碟形件与火焰'
                    : '人物组件、头盔、盾与矛'}
              </small>
            </button>
          ))}
        </div>
        <div className="component-suggestions">
          <button
            onClick={() => {
              if (onAuto) {
                onAuto();
                return;
              }
              const hints = suggestComponents(mesh, resolution);
              if (hints.length) {
                onChange(
                  [
                    ...regions,
                    ...hints.map((r) => ({
                      ...r,
                      id: crypto.randomUUID(),
                      placed: true,
                    })),
                  ].slice(0, 12),
                );
                onSelect('');
              } else onPicking(false);
              setHint(
                hints.length
                  ? `找到 ${hints.length} 处颜色候选，请逐个检查底部位置与范围。`
                  : '没有可靠颜色候选。请用上面的组件按钮手动定位。',
              );
            }}
            disabled={regions.length >= 12 || autoBusy}
          >
            {autoBusy ? '正在自动识别…' : '重新自动识别树 / 火焰 / 人物'}
          </button>
          <output>{autoStatus || hint}</output>
        </div>
        {!!regions.length && (
          <>
            <div className="component-list">
              {regions.map((r, i) => (
                <button
                  className={r.id === selected ? 'active' : ''}
                  key={r.id}
                  onClick={() => {
                    onSelect(r.id);
                    onPicking(false);
                  }}
                >
                  {i + 1}. {COMPONENT_LABELS[r.kind]}
                  {r.placed === false
                    ? ' · 待定位'
                    : r.placementStatus &&
                        !['kept', 'adjusted'].includes(r.placementStatus)
                      ? ' · 待调整'
                      : ''}
                  {r.placed === false ? ' · 待定位' : ''}
                </button>
              ))}
            </div>
            {active ? (
              <div className="component-adjust">
                <div className="component-adjust-heading">
                  <strong>
                    {COMPONENT_LABELS[active.kind]} · 定位与清除范围
                  </strong>
                  <button
                    className={picking ? 'active' : ''}
                    onClick={() => onPicking(!picking)}
                  >
                    {picking
                      ? '正在定位：点击草稿中物件底部'
                      : '重新点选底部位置'}
                  </button>
                  <button
                    onClick={() => {
                      onChange(regions.filter((r) => r.id !== selected));
                      onSelect('');
                      onPicking(false);
                    }}
                  >
                    移除组件
                  </button>
                </div>
                <label className="placement-lock">
                  <input
                    type="checkbox"
                    checked={active.positionLocked === true}
                    onChange={(e) =>
                      patch({
                        positionLocked: e.target.checked,
                        referenceAnchor: active.anchor,
                      })
                    }
                  />
                  锁定当前位置，生成时不自动移动
                </label>
                <div className="component-fields">
                  {['左右位置', '底部高度', '前后位置'].map((label, a) => (
                    <label key={label}>
                      {label}
                      <input
                        aria-label={label}
                        type="range"
                        min="0"
                        max="100"
                        step="0.5"
                        value={active.anchor[a] * 100}
                        onChange={(e) => {
                          const anchor = [
                            ...active.anchor,
                          ] as ComponentRegion['anchor'];
                          anchor[a] = +e.target.value / 100;
                          patch({ anchor, placed: true });
                        }}
                      />
                      <span>{Math.round(active.anchor[a] * 100)}%</span>
                    </label>
                  ))}
                  {(['width', 'depth', 'height'] as const).map((key, i) => (
                    <label key={key}>
                      {
                        [
                          '清除宽度（凸点）',
                          '清除深度（凸点）',
                          '清除高度（薄板层）',
                        ][i]
                      }
                      <input
                        aria-label={['清除宽度', '清除深度', '清除高度'][i]}
                        type="number"
                        min="2"
                        max={key === 'height' ? 60 : 24}
                        value={active[key]}
                        onChange={(e) =>
                          patch({
                            [key]: Math.max(
                              2,
                              Math.min(
                                key === 'height' ? 60 : 24,
                                +e.target.value,
                              ),
                            ),
                          })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    朝向
                    <select
                      value={active.rotation}
                      onChange={(e) => patch({ rotation: +e.target.value })}
                    >
                      {['朝后', '朝左', '朝前', '朝右'].map((v, i) => (
                        <option key={v} value={i}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p>
                  彩色为真实尺寸的替换组件，灰色为原草稿。清除范围只影响旧模型，不会拉伸零件。避开相邻墙面与屋顶。
                </p>
              </div>
            ) : (
              <p className="field-hint">
                组件已自动放置，可以直接生成成品；这里用于核对位置和清除范围，或移除不需要的组件。
              </p>
            )}
          </>
        )}
      </fieldset>
    </section>
  );
}
