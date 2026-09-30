import type { V3 } from './assembly-catalog.ts';
import { nearestColor, type Model, type Raster } from './brick-engine.ts';
import type { TriangleMesh } from './mesh-types.ts';
import type { BBox3d, SceneElementInstance } from './scene/scene-types.ts';
import type { ReferenceAlignment } from './image-to-mesh.ts';
import { projectImageRay } from './image-to-mesh.ts';
import { meshFrame } from './semantic-components.ts';

export type DesignPlane = {
  id: string;
  axis: 0 | 2;
  direction: -1 | 1;
  coordinate: number;
  bounds: BBox3d;
  material: {
    color: number;
    source: 'local-reference-region';
    supportFraction: number;
    inferredShadows: true;
  };
  evidence: {
    source: 'mesh-and-reference';
    samples: number;
    inlierFraction: number;
    rmseStuds: number;
    imageCoverage: number;
    observedCrossRange: [number, number];
  };
};
export type DesignGeometry = {
  version: 1;
  coordinates: 'brick-grid';
  planes: DesignPlane[];
  openings: Array<{
    id: string;
    bounds: BBox3d;
    rearPlaneId: string;
    source: 'reference-boundary';
  }>;
  warnings: string[];
  validation?: ReturnType<typeof auditDesignGeometry>;
};
type Sample = {
  depth: number;
  weight: number;
  point: V3;
  uv: [number, number];
};
const low = (values: number[]) =>
  values.reduce((a, b) => Math.min(a, b), Infinity);
const high = (values: number[]) =>
  values.reduce((a, b) => Math.max(a, b), -Infinity);
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** Fit an observed recess before packing. The surrounding wall and enclosing
 * image boundary authorize a planar region; a semantic object's centre alone
 * does not. Unknown/curved regions remain the original reconstruction. */
export function fitRecessGeometry(
  mesh: TriangleMesh,
  image: Raster,
  element: SceneElementInstance,
  alignment: ReferenceAlignment,
  resolution: number,
  mountingPoint: V3,
  axis: 0 | 2,
  direction: -1 | 1,
  onReject: (reason: string) => void = () => {},
): DesignGeometry | undefined {
  const reject = (reason: string) => {
    onReject(reason);
    return undefined;
  };
  const box = element.nicheBox;
  if (!box || alignment.confidence < 0.6 || box.width <= 0 || box.height <= 0)
    return reject('recess boundary or camera alignment is insufficient');
  const frame = meshFrame(mesh, resolution),
    cross = axis === 0 ? 2 : 0;
  const gridPoint = (p: V3) =>
    p.map(
      (v, i) =>
        ((v - frame.min[i]) * frame.scale) / (i === 1 ? 0.4 : 1) +
        (i === 1 ? 2 : 1),
    ) as V3;
  const p = mesh.positions,
    samples: Sample[] = [],
    facadeSamples: Sample[] = [];
  const inObject = (u: number, v: number) => {
    if (element.imageMask && element.imageMaskSize) {
      const [w, h] = element.imageMaskSize;
      // Native vision masks cover the reference raster. Legacy recess masks
      // are cropped to imageBox; interpreting them as full-frame masks hides
      // the entire surrounding wall.
      const b = element.imageBox;
      const full = w === image.width && h === image.height;
      if (
        !full &&
        (!b || u < b.x || u > b.x + b.width || v < b.y || v > b.y + b.height)
      )
        return false;
      const x = Math.round((full ? u : (u - b!.x) / b!.width) * (w - 1)),
        y = Math.round((full ? v : (v - b!.y) / b!.height) * (h - 1));
      // Leave a pixel border around the object as well as its actual mask.
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (
            x + dx >= 0 &&
            x + dx < w &&
            y + dy >= 0 &&
            y + dy < h &&
            element.imageMask[(y + dy) * w + x + dx]
          )
            return true;
      return false;
    }
    const b = element.imageBox;
    return (
      !!b && u >= b.x && u <= b.x + b.width && v >= b.y && v <= b.y + b.height
    );
  };
  for (let i = 0; i < p.length; i += 9) {
    const ab = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]],
      ac = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]],
      n = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
      ],
      area = Math.hypot(...n);
    if (!area || (n[axis] * direction) / area < 0.8) continue;
    const c = [0, 1, 2].map(
      (a) => (p[i + a] + p[i + 3 + a] + p[i + 6 + a]) / 3,
    ) as V3;
    const v = alignment.view.point(...c);
    const uv: [number, number] = [
      (alignment.left +
        ((v[0] - alignment.view.minX) /
          (alignment.view.maxX - alignment.view.minX)) *
          (alignment.right - alignment.left)) /
        (image.width - 1),
      (alignment.top +
        ((alignment.view.maxY - v[1]) /
          (alignment.view.maxY - alignment.view.minY)) *
          (alignment.bottom - alignment.top)) /
        (image.height - 1),
    ];
    const point = gridPoint(c);
    const border =
      (uv[0] >= box.x - box.width * 0.12 &&
        uv[0] <= box.x + box.width * 0.08) ||
      (uv[0] >= box.x + box.width * 0.92 && uv[0] <= box.x + box.width * 1.12);
    if (
      border &&
      uv[1] >= box.y &&
      uv[1] <= box.y + box.height * 0.75 &&
      (point[axis] - mountingPoint[axis]) * direction >= -1
    )
      facadeSamples.push({ depth: point[axis], weight: area, point, uv });
    if (
      uv[0] < box.x + box.width * 0.08 ||
      uv[0] > box.x + box.width * 0.92 ||
      uv[1] < box.y + box.height * 0.08 ||
      uv[1] > box.y + box.height * 0.92 ||
      inObject(...uv)
    )
      continue;
    // A rear wall must be behind the proposed object, never in front of it.
    if ((point[axis] - mountingPoint[axis]) * direction > -2) continue;
    samples.push({ depth: point[axis], weight: area, point, uv });
  }
  if (samples.length < 24)
    return reject(`too few rear-wall mesh samples: ${samples.length}`);
  const tolerance = Math.max(0.35, resolution / 64);
  // Area-weighted consensus is insensitive to the tessellation density of a
  // noisy detail. Search depth bins, then refine with the inlier mean.
  const bins = new Map<number, number>();
  for (const s of samples) {
    const b = Math.round(s.depth / tolerance);
    bins.set(b, (bins.get(b) || 0) + s.weight);
  }
  const peak =
    [...bins].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0] * tolerance;
  const inliers = samples.filter((s) => Math.abs(s.depth - peak) <= tolerance);
  const weight = inliers.reduce((n, s) => n + s.weight, 0);
  const total = samples.reduce((n, s) => n + s.weight, 0);
  const coordinate =
    inliers.reduce((n, s) => n + s.depth * s.weight, 0) / weight;
  const rmse = Math.sqrt(
    inliers.reduce((n, s) => n + (s.depth - coordinate) ** 2 * s.weight, 0) /
      weight,
  );
  const tiles = new Set(
    inliers.map(
      (s) =>
        `${Math.floor(((s.uv[0] - box.x) / box.width) * 6)},${Math.floor(((s.uv[1] - box.y) / box.height) * 8)}`,
    ),
  );
  const coverage = tiles.size / 48;
  const xs = inliers.map((s) => s.uv[0]),
    ys = inliers.map((s) => s.uv[1]);
  if (
    weight / total < 0.5 ||
    rmse > tolerance * 0.8 ||
    coverage < 0.2 ||
    high(xs) - low(xs) < box.width * 0.5 ||
    high(ys) - low(ys) < box.height * 0.5
  )
    return reject(
      `rear-wall consensus insufficient: fraction ${(weight / total).toFixed(2)}, residual ${rmse.toFixed(2)}, coverage ${coverage.toFixed(2)}, width ${((Math.max(...xs) - Math.min(...xs)) / box.width).toFixed(2)}, height ${((Math.max(...ys) - Math.min(...ys)) / box.height).toFixed(2)}`,
    );

  // Project the enclosing boundary onto the mounting-depth plane. This is the
  // façade aperture, not the bounding box of the small catalog figure.
  const mountingPlane =
    frame.min[axis] + (mountingPoint[axis] - 1) / frame.scale;
  const corners = [box.x, box.x + box.width].flatMap((u) =>
    [box.y, box.y + box.height].map((v) => {
      const ray = projectImageRay(
        alignment,
        [image.width, image.height],
        [u, v],
      );
      const t = (mountingPlane - ray.origin[axis]) / ray.direction[axis];
      return gridPoint(
        ray.origin.map((v, i) => v + t * ray.direction[i]) as V3,
      );
    }),
  );
  if (!corners.every((c) => c.every(Number.isFinite)))
    return reject('recess projection is non-finite');
  const left = Math.ceil(Math.min(...corners.map((c) => c[cross]))),
    right = Math.floor(Math.max(...corners.map((c) => c[cross]))),
    floor = Math.round(mountingPoint[1]),
    ceiling = Math.floor(Math.min(corners[0][1], corners[2][1])) - 1;
  const plane = Math.round(coordinate);
  if (
    left < 2 ||
    right > frame.grid[cross] ||
    right - left < 6 ||
    ceiling <= floor + 12 ||
    plane < 3 ||
    plane > frame.grid[axis] - 2
  )
    return reject(
      `recess boundary does not fit the grid: width ${right - left}, floor ${floor}, ceiling ${ceiling}, plane ${plane}`,
    );
  const min: V3 = [1, floor, 1],
    max: V3 = [frame.grid[0] + 1, ceiling, frame.grid[2] + 1];
  min[cross] = left;
  max[cross] = right;
  if (facadeSamples.length < 24)
    return reject('recess has no observed facade boundary');
  const facadeBins = new Map<number, number>();
  for (const s of facadeSamples) {
    const b = Math.round(s.depth);
    facadeBins.set(b, (facadeBins.get(b) || 0) + s.weight);
  }
  const facade = [...facadeBins].sort(
    (a, b) => b[1] - a[1] || a[0] - b[0],
  )[0][0];
  if ((facade - plane) * direction < 3)
    return reject('recess lacks sufficient observed depth');
  // Reserve the cavity behind the façade, rather than extending the void
  // through the entire foreground and destroying the separate torch mounts.
  if (direction > 0) {
    min[axis] = plane;
    max[axis] = facade + 1;
  } else {
    min[axis] = facade - 1;
    max[axis] = plane;
  }
  const bounds = { min: [...min] as V3, max: [...max] as V3 };
  if (direction > 0) {
    bounds.min[axis] = plane - 2;
    bounds.max[axis] = plane;
  } else {
    bounds.min[axis] = plane;
    bounds.max[axis] = plane + 2;
  }

  // Estimate a local material from the brighter part of the same reference
  // region. RGB chromaticity separates illumination changes from grey/red
  // accents. Conflicting materials do not authorize a uniform repaint.
  const pixels: number[][] = [];
  for (
    let y = Math.ceil(box.y * (image.height - 1));
    y <= Math.floor((box.y + box.height) * (image.height - 1));
    y++
  )
    for (
      let x = Math.ceil(box.x * (image.width - 1));
      x <= Math.floor((box.x + box.width) * (image.width - 1));
      x++
    ) {
      if (
        !tiles.has(
          `${Math.floor(((x / (image.width - 1) - box.x) / box.width) * 6)},${Math.floor(((y / (image.height - 1) - box.y) / box.height) * 8)}`,
        )
      )
        continue;
      if (
        x < 0 ||
        y < 0 ||
        x >= image.width ||
        y >= image.height ||
        inObject(x / (image.width - 1), y / (image.height - 1))
      )
        continue;
      const j = (y * image.width + x) * 4;
      const c = [image.data[j], image.data[j + 1], image.data[j + 2]];
      if (image.data[j + 3] > 100 && Math.max(...c) > 45) pixels.push(c);
    }
  if (pixels.length < 24) return reject('too few rear-wall material pixels');
  pixels.sort((a, b) => Math.max(...a) - Math.max(...b));
  // Deep shadow chromaticity is unstable in sRGB. Establish the material from
  // well-lit samples on the fitted patch, then record that shaded areas are
  // inferred from that region rather than claiming a measured paint colour.
  const lit = pixels.slice(Math.floor(pixels.length * 0.5));
  const chroma = lit.map((c) => c.map((v) => v / Math.max(...c)));
  const center = [0, 1, 2].map((i) => median(chroma.map((c) => c[i])));
  const coherent = lit.filter(
    (_, i) => Math.hypot(...chroma[i].map((v, a) => v - center[a])) < 0.18,
  );
  if (coherent.length / lit.length < 0.75)
    return reject(
      `rear-wall material is mixed: coherent fraction ${(coherent.length / lit.length).toFixed(2)}`,
    );
  coherent.sort((a, b) => Math.max(...a) - Math.max(...b));
  const bright = coherent.slice(Math.floor(coherent.length * 0.7));
  let color = nearestColor(
    ...([0, 1, 2].map((i) => median(bright.map((c) => c[i]))) as V3),
    true,
  );
  // The recess is shaded. Use the adjacent masonry's well-lit material when
  // a single colour dominates that local boundary; do not recolour decorations
  // elsewhere in the model. This is explicitly a design material inference.
  const surround: number[][] = [];
  for (
    let y = Math.ceil(box.y * (image.height - 1));
    y <= Math.floor((box.y + box.height * 0.7) * (image.height - 1));
    y++
  )
    for (
      let x = Math.ceil((box.x - box.width * 0.3) * (image.width - 1));
      x <= Math.floor((box.x + box.width * 1.3) * (image.width - 1));
      x++
    ) {
      const u = x / (image.width - 1);
      if (
        (u > box.x && u < box.x + box.width) ||
        x < 0 ||
        y < 0 ||
        x >= image.width ||
        y >= image.height
      )
        continue;
      const i = (y * image.width + x) * 4;
      if (image.data[i + 3] > 100)
        surround.push([image.data[i], image.data[i + 1], image.data[i + 2]]);
    }
  surround.sort((a, b) => Math.max(...a) - Math.max(...b));
  const votes = new Map<number, number>();
  const wellLit = surround.slice(Math.floor(surround.length * 0.5));
  for (const c of wellLit) {
    const v = nearestColor(c[0], c[1], c[2], true);
    votes.set(v, (votes.get(v) || 0) + 1);
  }
  const dominant = [...votes].sort((a, b) => b[1] - a[1])[0];
  if (dominant && dominant[1] / wellLit.length >= 0.75) color = dominant[0];
  const id = `${element.id}-rear-wall`;
  return {
    version: 1,
    coordinates: 'brick-grid',
    planes: [
      {
        id,
        axis,
        direction,
        coordinate: plane,
        bounds,
        material: {
          color,
          source: 'local-reference-region',
          supportFraction: coherent.length / lit.length,
          inferredShadows: true,
        },
        evidence: {
          source: 'mesh-and-reference',
          samples: inliers.length,
          inlierFraction: weight / total,
          rmseStuds: rmse,
          imageCoverage: coverage,
          observedCrossRange: [
            low(inliers.map((s) => s.point[cross])),
            high(inliers.map((s) => s.point[cross])),
          ],
        },
      },
    ],
    openings: [
      {
        id: `${element.id}-opening`,
        bounds: { min, max },
        rearPlaneId: id,
        source: 'reference-boundary',
      },
    ],
    warnings: [
      'Rear wall and material are a fitted design approximation; hidden structure and lintel strength require separate validation.',
    ],
  };
}

/** Apply a declared solid wall before brick selection; no global colour map or
 * deletion box is used. Outside the fitted patch, volume and colours are exact. */
export function applyDesignPlanes(
  cells: Map<string, { color: number; support: boolean }>,
  geometry: DesignGeometry,
) {
  let adjusted = 0;
  for (const plane of geometry.planes) {
    const { min, max } = plane.bounds;
    for (let x = min[0]; x < max[0]; x++)
      for (let y = min[1]; y < max[1]; y++)
        for (let z = min[2]; z < max[2]; z++) {
          const key = `${x},${y},${z}`,
            previous = cells.get(key);
          if (!previous || previous.color !== plane.material.color) adjusted++;
          cells.set(key, { color: plane.material.color, support: false });
        }
  }
  return adjusted;
}

/** Verify constraints against the final, optimized parts, not the fitted plan.
 * Catalog components are separate objects and do not vote on masonry colour. */
export function auditDesignGeometry(model: Model, geometry: DesignGeometry) {
  const planes = geometry.planes.map((plane) => {
    const cross = plane.axis === 0 ? 2 : 0;
    const face = plane.coordinate - (plane.direction > 0 ? 1 : 0);
    const occupied = new Map<string, number>();
    for (const b of model.bricks) {
      if (b.section?.startsWith('component-')) continue;
      const lo = [b.x, b.y, b.z],
        hi = [b.x + b.w, b.y + b.h, b.z + b.d];
      if (face < lo[plane.axis] || face >= hi[plane.axis]) continue;
      for (
        let u = Math.max(lo[cross], plane.bounds.min[cross]);
        u < Math.min(hi[cross], plane.bounds.max[cross]);
        u++
      )
        for (
          let y = Math.max(b.y, plane.bounds.min[1]);
          y < Math.min(b.y + b.h, plane.bounds.max[1]);
          y++
        )
          occupied.set(`${u},${y}`, b.color);
    }
    let checkedCells = 0,
      missingCells = 0,
      materialMismatches = 0;
    for (let u = plane.bounds.min[cross]; u < plane.bounds.max[cross]; u++)
      for (let y = plane.bounds.min[1]; y < plane.bounds.max[1]; y++) {
        checkedCells++;
        const color = occupied.get(`${u},${y}`);
        if (color === undefined) missingCells++;
        else if (color !== plane.material.color) materialMismatches++;
      }
    return {
      id: plane.id,
      coordinate: plane.coordinate,
      checkedCells,
      missingCells,
      materialMismatches,
    };
  });
  const occupiedOpenings = model.bricks.filter(
    (b) =>
      !b.section?.startsWith('component-') &&
      geometry.openings.some((o) =>
        [0, 1, 2].every(
          (a) =>
            [b.x, b.y, b.z][a] < o.bounds.max[a] &&
            [b.x + b.w, b.y + b.h, b.z + b.d][a] > o.bounds.min[a],
        ),
      ),
  ).length;
  return {
    passed:
      occupiedOpenings === 0 &&
      planes.every((p) => p.missingCells + p.materialMismatches === 0),
    planes,
    occupiedOpenings,
  };
}
