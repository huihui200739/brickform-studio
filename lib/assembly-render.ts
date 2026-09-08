import type { Pose } from './assembly-catalog.ts';

// Instance transforms must preserve handedness: WebGL chooses front-face
// winding for the mesh, not separately for every reflected instance.
// Bake the LDraw Y reflection into vertices and reverse each triangle once.
export function viewerGeometry(raw: {
  positions: number[];
  normals: number[];
}) {
  const positions: number[] = [],
    normals: number[] = [];
  for (let t = 0; t < raw.positions.length; t += 9)
    for (const vertex of [0, 2, 1])
      for (let axis = 0; axis < 3; axis++) {
        const sign = axis === 1 ? -1 : 1,
          i = t + vertex * 3 + axis;
        positions.push(raw.positions[i] * sign * 0.05);
        normals.push(raw.normals[i] * sign);
      }
  return { positions, normals };
}

export function viewerPose({
  matrix: r,
  position: p,
}: Pose): [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
] {
  return [
    r[0],
    -r[1],
    r[2],
    p[0] * 0.05,
    -r[3],
    r[4],
    -r[5],
    -p[1] * 0.05,
    r[6],
    -r[7],
    r[8],
    p[2] * 0.05,
    0,
    0,
    0,
    1,
  ];
}
