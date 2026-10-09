import type { ColorDesign } from './clean-design-colors.ts';

/** UI copy must not turn a completed colour pass into material certification. */
export function colorDesignSummary(design: ColorDesign) {
  const coherent = design.mode === 'coherent';
  const heading = coherent
    ? design.changedBricks > 0
      ? `统一建筑主体 · 已调整 ${design.changedBricks} 块配色`
      : '统一建筑主体 · 未发现有足够来源证据的配色调整'
    : design.changedBricks > 0
      ? `保守配色清理 · 已清理 ${design.changedBricks} 块异色`
      : '保守配色清理 · 未发现可安全合并的异色';
  let details = coherent
    ? '局部阴影整理依据源观测；暖色主体合并另属人工设计近似，可能与真实暖色饰带不同。拼色冲突、绿植、火焰与特殊组件保持保护。'
    : '保守方案保留有结构的拼色及特殊组件。';
  if (coherent && design.materialMetrics)
    details += ` 本次源标量阴影整理 ${design.materialMetrics.scalarDesignBricks} 块，人工局部材料近似 ${design.materialMetrics.localApproximationBricks} 块。`;
  if (design.catalogBlocked > 0)
    details += ` ${design.catalogBlocked} 块因目录颜色限制保留原色。`;
  const uncertainty = coherent && (design.uncertainBricks ?? 0) > 0
    ? `另有 ${design.uncertainBricks} 块缺少观测或合格材质锚点，保留原色待核对；并非所有阴影与杂色都已解决。`
    : undefined;
  return { heading, details, uncertainty };
}
