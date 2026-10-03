import type { TriangleMesh } from './mesh-types.ts';
import type { SceneSurfaceGraph } from './scene-surface-graph.ts';
import { referenceVisibility } from './reference-visibility.ts';

export type SurfaceProjectionValidation = {
  method: 'fixed-source-camera';
  passed: boolean;
  silhouetteChangedPixels: number;
  materialChangedPixels: number;
  comparedPixels: number;
  maxVertexDisplacementPixels: number;
  failureReasons: string[];
};

/** Reproject both designs through the original recorded transform. Refitting
 * a camera or normalizing each candidate's bounds would hide displacement. */
export function validateSurfaceProjection(
  source: TriangleMesh,
  candidate: TriangleMesh,
  graph: SceneSurfaceGraph,
): SurfaceProjectionValidation {
  const { size, transform } = graph.projection;
  const { camera } = graph;
  const yaw = (camera.yaw * Math.PI) / 180,
    pitch = (camera.pitch * Math.PI) / 180;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const [minX, maxX, minY, maxY] = transform.viewBounds;
  const project = (p: Float32Array) => {
    const coords = new Float64Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const x = p[i] - transform.meshCenter[0],
        y = p[i + 1] - transform.meshCenter[1],
        z = p[i + 2] - transform.meshCenter[2];
      const depth = sy * cp * x + sp * y + cy * cp * z,
        perspective = 1 / (1 - (camera.perspective * depth) / transform.extent);
      coords[i] =
        (((cy * x - sy * z) * perspective - minX) * (size - 1)) / (maxX - minX);
      coords[i + 1] =
        ((maxY - (-sy * sp * x + cp * y - cy * sp * z) * perspective) *
          (size - 1)) /
        (maxY - minY);
      coords[i + 2] = depth;
    }
    return coords;
  };
  const failures: string[] = [];
  if (
    source.positions.length !== candidate.positions.length ||
    source.positions.length !== graph.sourcePositions.length ||
    source.colors.length !== candidate.colors.length
  )
    return {
      method: 'fixed-source-camera',
      passed: false,
      silhouetteChangedPixels: 0,
      materialChangedPixels: 0,
      comparedPixels: 0,
      maxVertexDisplacementPixels: Infinity,
      failureReasons: ['Source-face correspondence changed.'],
    };
  const before = project(source.positions),
    after = project(candidate.positions);
  let maxVertexDisplacementPixels = 0;
  for (let i = 0; i < before.length; i += 3)
    maxVertexDisplacementPixels = Math.max(
      maxVertexDisplacementPixels,
      Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1]),
    );
  const a = referenceVisibility(
    before,
    transform.extent,
    camera.perspective,
    size,
  ).pixelFace;
  const b = referenceVisibility(
    after,
    transform.extent,
    camera.perspective,
    size,
  ).pixelFace;
  let silhouetteChangedPixels = 0,
    materialChangedPixels = 0,
    comparedPixels = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] >= 0 || b[i] >= 0) comparedPixels++;
    if (a[i] >= 0 !== b[i] >= 0) {
      silhouetteChangedPixels++;
      continue;
    }
    if (a[i] < 0) continue;
    if (
      [0, 1, 2].some(
        (c) => source.colors[a[i] * 3 + c] !== candidate.colors[b[i] * 3 + c],
      )
    )
      materialChangedPixels++;
  }
  if (silhouetteChangedPixels > Math.max(2, comparedPixels * 0.001))
    failures.push('Source silhouette or projected opening changed.');
  if (materialChangedPixels > Math.max(4, comparedPixels * 0.01))
    failures.push('Projected source paint boundaries changed.');
  if (maxVertexDisplacementPixels > 1.5)
    failures.push('Surface displacement exceeds 1.5 source projection pixels.');
  return {
    method: 'fixed-source-camera',
    passed: failures.length === 0,
    silhouetteChangedPixels,
    materialChangedPixels,
    comparedPixels,
    maxVertexDisplacementPixels,
    failureReasons: failures,
  };
}
