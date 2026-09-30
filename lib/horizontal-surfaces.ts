type Cell = { color: number; support: boolean };

/** Remove one-plate sampling noise on a broad, nearly level lower platform.
 * Larger rises, edges, holes and small pedestals retain their source shape.
 * Work from a snapshot so corrections cannot propagate across a staircase.
 */
export function regularizePlatform(
  cells: Map<string, Cell>,
  width: number,
  height: number,
  depth: number,
) {
  const tops = new Map<string, number>(),
    counts = new Map<number, number>();
  for (const key of cells.keys()) {
    const [x, y, z] = key.split(',').map(Number),
      column = `${x},${z}`;
    tops.set(column, Math.max(tops.get(column) ?? -1, y));
  }
  for (const y of tops.values())
    if (y >= 3 && y < height * 0.25 + 2)
      counts.set(y, (counts.get(y) || 0) + 1);
  const plane = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!plane || plane[1] < width * depth * 0.15) return 0;
  const [level] = plane;
  let adjusted = 0;
  for (const [column, y] of tops) {
    if (y === level || Math.abs(y - level) !== 1) continue;
    const [x, z] = column.split(',').map(Number);
    let near = 0,
      onPlane = 0;
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        if (!dx && !dz) continue;
        const other = tops.get(`${x + dx},${z + dz}`);
        if (other !== undefined && Math.abs(other - level) <= 1) near++;
        if (other === level) onPlane++;
      }
    if (near < 7 || onPlane < 5) continue;
    const old = cells.get(`${x},${y},${z}`)!;
    if (y > level) cells.delete(`${x},${y},${z}`);
    else cells.set(`${x},${level},${z}`, { ...old });
    adjusted++;
  }
  return adjusted;
}
