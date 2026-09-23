'use client';
import type { PlacementReport } from '@/lib/placement-policy';
const labels = {
  'auto-applied': '已自动应用',
  preserved: '未替换，已保留原始几何',
  kept: '原位安装',
  adjusted: '小范围校正',
  conflict: '需要调整',
  unpositioned: '等待定位',
  budget: '需要复核',
  candidate: '待确认候选',
  confirmed: '已确认',
  rejected: '已忽略',
};
export default function PlacementReview({
  reports,
  onSelect,
}: {
  reports: PlacementReport[];
  onSelect?: (id: string) => void;
}) {
  if (!reports.length) return null;
  return (
    <section className="placement-review" aria-label="组件位置检查">
      <div>
        <h3>组件位置检查</h3>
        <p>
          最多平移 1 个凸点、升降 1
          层薄板。锁定的组件保持原位；检查不代表照片已精确对齐。
        </p>
      </div>
      <ul>
        {reports.map((r, i) => (
          <li key={r.id} data-status={r.status}>
            <div>
              <strong>
                {i + 1}. {r.name}
              </strong>
              <span>{labels[r.status]}</span>
            </div>
            <p>{r.message}</p>
            {onSelect && (
              <button onClick={() => onSelect(r.id)}>查看 / 调整位置</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
