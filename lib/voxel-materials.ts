type Point = [number, number, number];
export type VoxelMaterialDesign = {
  method: 'clipped-source-surface-area';
  testedCells: number;
  areaCells: number;
  paintedCells: number;
  defaultedEdgeCells: number;
  sourceAreaStudsSquared: number;
  capturedAreaStudsSquared: number;
  materialAreaStudsSquared: number[];
  warnings: string[];
};

export function triangleStudArea(a: Point, b: Point, c: Point) {
  const ab = b.map((v, k) => (v - a[k]) * (k === 1 ? 0.4 : 1));
  const ac = c.map((v, k) => (v - a[k]) * (k === 1 ? 0.4 : 1));
  return (
    Math.hypot(
      ab[1] * ac[2] - ab[2] * ac[1],
      ab[2] * ac[0] - ab[0] * ac[2],
      ab[0] * ac[1] - ab[1] * ac[0],
    ) / 2
  );
}

// Clip one source triangle to a plate-grid cell, then measure its actual stud
// area (one plate is 0.4 studs high). Point/edge contacts carry no paint vote.
export function triangleCellArea(triangle: Point[], cell: Point) {
  let polygon = triangle;
  for (let axis = 0; axis < 3; axis++)
    for (const side of [0, 1]) {
      if (polygon.length < 3) return 0;
      const boundary = cell[axis] + side;
      const output: Point[] = [];
      const inside = (p: Point) =>
        side ? p[axis] <= boundary : p[axis] >= boundary;
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i],
          b = polygon[(i + 1) % polygon.length];
        const aInside = inside(a),
          bInside = inside(b);
        if (aInside) output.push(a);
        if (aInside !== bInside) {
          const t = (boundary - a[axis]) / (b[axis] - a[axis]);
          output.push(a.map((v, k) => v + (b[k] - v) * t) as Point);
        }
      }
      polygon = output;
    }
  if (polygon.length < 3) return 0;
  const origin = polygon[0];
  let area = 0;
  for (let i = 1; i + 1 < polygon.length; i++) {
    const a = polygon[i].map((v, k) => (v - origin[k]) * (k === 1 ? 0.4 : 1));
    const b = polygon[i + 1].map(
      (v, k) => (v - origin[k]) * (k === 1 ? 0.4 : 1),
    );
    area +=
      Math.hypot(
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ) / 2;
  }
  return area;
}

/** Per-cell paint weight from source triangle/cell intersections, independent
 * of tessellation density. Extent limits must be supplied by the volume grid. */
export function triangleMaterialAreas(
  triangle: Point[],
  size: Point,
  visit: (x: number, y: number, z: number, area: number) => void,
) {
  const lo = size.map((n, a) =>
    Math.max(
      0,
      Math.min(n - 1, Math.floor(Math.min(...triangle.map((p) => p[a])))),
    ),
  );
  const hi = size.map((n, a) =>
    Math.max(
      0,
      Math.min(n - 1, Math.floor(Math.max(...triangle.map((p) => p[a])))),
    ),
  );
  let tested = 0;
  for (let x = lo[0]; x <= hi[0]; x++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let z = lo[2]; z <= hi[2]; z++) {
        tested++;
        const area = triangleCellArea(triangle, [x, y, z]);
        if (area > 1e-12) visit(x, y, z, area);
      }
  return tested;
}
