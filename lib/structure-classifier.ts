import type { TriangleMesh } from './mesh-types.ts';

export type StructureCategory =
  | 'mass-building'
  | 'stepped-monument'
  | 'tower'
  | 'lattice-tower'
  | 'arch-structure'
  | 'unknown';

export type StructureClassification = {
  category: StructureCategory;
  confidence: number;
  aspectRatio: number;
  occupancy: number;
  evidence: string[];
};

function occupancyAt(
  positions: ArrayLike<number>,
  min: [number, number, number],
  span: [number, number, number],
  size: number,
) {
  const occupied = new Set<string>();
  for (let i = 0; i < positions.length; i += 3) {
    const cell = [0, 1, 2].map((axis) =>
      Math.min(size - 1, Math.max(0, Math.floor(((positions[i + axis] - min[axis]) / span[axis]) * size))),
    );
    occupied.add(cell.join(','));
  }
  return occupied.size / size ** 3;
}

/** Geometry-only classifier. It never depends on a filename or scene preset. */
export function classifyStructure(mesh: TriangleMesh): StructureClassification {
  const p = mesh.positions;
  if (!p.length) return { category: 'unknown', confidence: 0, aspectRatio: 0, occupancy: 0, evidence: [] };
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
    minZ = Math.min(minZ, p[i + 2]); maxZ = Math.max(maxZ, p[i + 2]);
  }
  const width = Math.max(1e-6, maxX - minX), depth = Math.max(1e-6, maxZ - minZ), height = Math.max(1e-6, maxY - minY);
  const aspectRatio = height / Math.max(width, depth);
  const min: [number, number, number] = [minX, minY, minZ];
  const span: [number, number, number] = [width, height, depth];
  const occupancy = occupancyAt(p, min, span, 8);
  const fineOccupancy = occupancyAt(p, min, span, 12);
  const evidence: string[] = [];
  if (aspectRatio >= 2.2) evidence.push('高宽比显示为高耸主体');
  if (occupancy < 0.34 || fineOccupancy < 0.28) evidence.push('多尺度体积采样稀疏，存在镂空或桁架特征');
  // A landmark can be foreshortened or sit on a wide base, so height alone is
  // not enough. Sparse occupancy at two resolutions is the stable signal for
  // an open tower and avoids routing solid buildings to the lattice template.
  if (aspectRatio >= 1.2 && (occupancy < 0.34 || fineOccupancy < 0.28))
    return { category: 'lattice-tower', confidence: Math.min(0.96, 0.62 + Math.min(0.2, (0.34 - occupancy) * 0.8) + Math.min(0.12, (0.28 - fineOccupancy) * 0.5)), aspectRatio, occupancy, evidence };
  if (aspectRatio >= 1.2)
    return { category: 'tower', confidence: Math.min(0.9, 0.55 + Math.min(0.3, (aspectRatio - 1.2) * 0.12)), aspectRatio, occupancy, evidence };
  if (height / Math.max(1e-6, Math.min(width, depth)) > 1.25)
    return { category: 'stepped-monument', confidence: 0.55, aspectRatio, occupancy, evidence: [...evidence, '主体高度高于底面'] };
  return { category: 'mass-building', confidence: 0.5, aspectRatio, occupancy, evidence };
}
