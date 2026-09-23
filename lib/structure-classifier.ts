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
  const occupied = new Set<string>();
  for (let i = 0; i < p.length; i += 3) {
    const x = Math.min(7, Math.max(0, Math.floor(((p[i] - minX) / width) * 8)));
    const y = Math.min(7, Math.max(0, Math.floor(((p[i + 1] - minY) / height) * 8)));
    const z = Math.min(7, Math.max(0, Math.floor(((p[i + 2] - minZ) / depth) * 8)));
    occupied.add(`${x},${y},${z}`);
  }
  const occupancy = occupied.size / 512;
  const evidence: string[] = [];
  if (aspectRatio >= 2.2) evidence.push('高宽比显示为高耸主体');
  if (occupancy < 0.24) evidence.push('体积采样稀疏，存在镂空或桁架特征');
  if (aspectRatio >= 2.2 && occupancy < 0.24)
    return { category: 'lattice-tower', confidence: Math.min(0.96, 0.55 + (2.2 / aspectRatio) * 0.15 + (0.24 - occupancy)), aspectRatio, occupancy, evidence };
  if (aspectRatio >= 2.2)
    return { category: 'tower', confidence: Math.min(0.9, 0.55 + Math.min(0.3, (aspectRatio - 2.2) * 0.12)), aspectRatio, occupancy, evidence };
  if (height / Math.max(1e-6, Math.min(width, depth)) > 1.25)
    return { category: 'stepped-monument', confidence: 0.55, aspectRatio, occupancy, evidence: [...evidence, '主体高度高于底面'] };
  return { category: 'mass-building', confidence: 0.5, aspectRatio, occupancy, evidence };
}

