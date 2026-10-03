import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TriangleMesh } from '../../lib/mesh-types.ts';
import {
  referenceAlignment,
  type ReferenceCamera,
} from '../../lib/reference-colors.ts';
import {
  evaluateContourCameras,
  type ContourCameraCandidate,
} from './calibration.ts';
import { extractImageContours } from './image-contours.ts';
import { extractMeshContours } from './mesh-contours.ts';

type Vec3 = [number, number, number];
type Box = { lo: Vec3; hi: Vec3 };
type Raster = {
  width: number;
  height: number;
  data: Uint8Array;
  independentProjection?: (point: Vec3) => [number, number];
};
const SIZE = 192;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalized = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return v.map((value) => value / length) as Vec3;
};

/** Six outward quads per exact cube, deliberately nonindexed. No contour
 * extraction, visibility rasterizer or projection helper renders the image. */
function cubes(boxes: Box[]): TriangleMesh {
  const positions: number[] = [];
  for (const {
    lo: [x0, y0, z0],
    hi: [x1, y1, z1],
  } of boxes) {
    const quads: Vec3[][] = [
      [
        [x0, y0, z0],
        [x0, y0, z1],
        [x0, y1, z1],
        [x0, y1, z0],
      ],
      [
        [x1, y0, z0],
        [x1, y1, z0],
        [x1, y1, z1],
        [x1, y0, z1],
      ],
      [
        [x0, y0, z0],
        [x1, y0, z0],
        [x1, y0, z1],
        [x0, y0, z1],
      ],
      [
        [x0, y1, z0],
        [x0, y1, z1],
        [x1, y1, z1],
        [x1, y1, z0],
      ],
      [
        [x0, y0, z0],
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
      ],
      [
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      ],
    ];
    for (const [a, b, c, d] of quads)
      positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  return {
    name: 'independent analytic cube control',
    positions: Float32Array.from(positions),
    colors: new Uint8Array(boxes.length * 12 * 3).fill(160),
  };
}

/** Analytic slab intersection also returns the outward entry normal. */
function intersect(origin: Vec3, direction: Vec3, box: Box) {
  let near = -Infinity,
    far = Infinity;
  let normal: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < box.lo[axis] || origin[axis] > box.hi[axis])
        return undefined;
      continue;
    }
    const a = (box.lo[axis] - origin[axis]) / direction[axis];
    const b = (box.hi[axis] - origin[axis]) / direction[axis];
    const entry = Math.min(a, b);
    if (entry > near) {
      near = entry;
      normal = [0, 0, 0];
      normal[axis] = a < b ? -1 : 1;
    }
    far = Math.min(far, Math.max(a, b));
    if (near > far) return undefined;
  }
  return far >= Math.max(near, 0)
    ? { distance: Math.max(near, 0), normal }
    : undefined;
}

/** Independent orthographic ray-box renderer. Illumination is Lambert shading
 * of analytic normals plus analytic hard shadows, never palette/mesh RGB.
 * Screen bounds come from box corners, not the triangle projection routine. */
function render(
  boxes: Box[],
  camera: ReferenceCamera,
  paintLines = false,
): Raster {
  assert.equal(camera.perspective, 0);
  const yaw = (camera.yaw * Math.PI) / 180,
    pitch = (camera.pitch * Math.PI) / 180;
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw),
    cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const right: Vec3 = [cy, 0, -sy],
    up: Vec3 = [-sy * sp, cp, -cy * sp];
  const front: Vec3 = [sy * cp, sp, cy * cp];
  const lo: Vec3 = [Infinity, Infinity, Infinity],
    hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes)
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], box.lo[axis]);
      hi[axis] = Math.max(hi[axis], box.hi[axis]);
    }
  const center = lo.map((value, axis) => (value + hi[axis]) / 2) as Vec3;
  let minU = Infinity,
    maxU = -Infinity,
    minV = Infinity,
    maxV = -Infinity;
  for (const box of boxes)
    for (const x of [box.lo[0], box.hi[0]])
      for (const y of [box.lo[1], box.hi[1]])
        for (const z of [box.lo[2], box.hi[2]]) {
          const point = [x - center[0], y - center[1], z - center[2]] as Vec3;
          const u = dot(point, right),
            v = dot(point, up);
          minU = Math.min(minU, u);
          maxU = Math.max(maxU, u);
          minV = Math.min(minV, v);
          maxV = Math.max(maxV, v);
        }
  const data = new Uint8Array(SIZE * SIZE * 4),
    margin = 12;
  const towardLight = normalized([-0.4, 0.55, 0.8]);
  const direction = front.map((value) => -value) as Vec3;
  for (let y = 0; y < SIZE; y++)
    for (let x = 0; x < SIZE; x++) {
      const u =
        minU + ((x + 0.5 - margin) / (SIZE - 2 * margin)) * (maxU - minU);
      const v =
        maxV - ((y + 0.5 - margin) / (SIZE - 2 * margin)) * (maxV - minV);
      const origin = center.map(
        (value, axis) =>
          value + right[axis] * u + up[axis] * v + front[axis] * 20,
      ) as Vec3;
      let hit: ReturnType<typeof intersect>;
      for (const box of boxes) {
        const candidate = intersect(origin, direction, box);
        if (candidate && (!hit || candidate.distance < hit.distance))
          hit = candidate;
      }
      if (!hit) continue;
      const point = origin.map(
        (value, axis) => value + direction[axis] * hit!.distance,
      ) as Vec3;
      const shadowOrigin = point.map(
        (value, axis) =>
          value + hit!.normal[axis] * 1e-5 + towardLight[axis] * 1e-5,
      ) as Vec3;
      const shadowed = boxes.some((box) => {
        const obstruction = intersect(shadowOrigin, towardLight, box);
        return obstruction && obstruction.distance > 1e-6;
      });
      let value =
        50 +
        170 * Math.max(0, dot(hit.normal, towardLight)) * (shadowed ? 0.18 : 1);
      if (paintLines) {
        // Three spatially separate painted frames on one flat plane; these have
        // the same type of persistent edges as openings but no geometric depth.
        const frames = [
          [-1.5, 1.4, 0.75, 0.6],
          [1.35, 0.5, 0.55, 0.9],
          [-0.6, -1.6, 0.9, 0.55],
        ];
        if (
          frames.some(
            ([cx, py, w, h]) =>
              Math.abs(point[0] - cx) < w &&
              Math.abs(point[1] - py) < h &&
              (Math.abs(point[0] - cx) > w - 0.16 ||
                Math.abs(point[1] - py) > h - 0.16),
          )
        )
          value = 35;
      }
      const gray = Math.round(value);
      data.set([gray, gray, gray, 255], (y * SIZE + x) * 4);
    }
  return {
    width: SIZE,
    height: SIZE,
    data,
    independentProjection: (point) => {
      const relative = point.map((value, axis) => value - center[axis]) as Vec3;
      return [
        margin +
          ((dot(relative, right) - minU) / (maxU - minU)) *
            (SIZE - 2 * margin) -
          0.5,
        margin +
          ((maxV - dot(relative, up)) / (maxV - minV)) * (SIZE - 2 * margin) -
          0.5,
      ];
    },
  };
}

const shell: Box = { lo: [-3, -3, -0.5], hi: [3, 3, 0.5] };
const asymmetric: Box[] = [
  shell,
  { lo: [-2.1, 0.6, 0.4], hi: [-0.7, 2.15, 1.55] },
  { lo: [0.9, -0.1, 0.4], hi: [2.15, 1.1, 1.35] },
  { lo: [-1.7, -2.25, 0.4], hi: [-0.25, -0.8, 1.75] },
];
const frontCamera: ReferenceCamera = { yaw: 15, pitch: 10, perspective: 0 };
const backCamera: ReferenceCamera = { yaw: 180, pitch: 10, perspective: 0 };

function evaluate(
  mesh: TriangleMesh,
  image: Raster,
  cameras = [frontCamera, backCamera],
) {
  const imageContours = extractImageContours(image);
  const geometry = cameras.map((camera) => {
    const alignment = referenceAlignment(mesh, image, camera);
    return {
      camera,
      alignment,
      contours: extractMeshContours(mesh, alignment, [SIZE, SIZE]),
    };
  });
  const candidates: ContourCameraCandidate[] = geometry.map(
    ({ camera, alignment, contours }, i) => ({
      id: i === 0 ? 'known' : 'opposite',
      camera,
      silhouetteIoU: alignment.evidence.silhouetteIoU,
      samples: contours.samples,
    }),
  );
  const result = evaluateContourCameras(
    candidates,
    imageContours.samples,
    'opposite',
    [SIZE, SIZE],
  );
  return { imageContours, geometry, result };
}

function assertNoTruthClaims(
  result: ReturnType<typeof evaluateContourCameras>,
) {
  assert.equal(result.productionCameraChanged, false);
  assert.equal(result.interiorCorrespondenceVerified, false);
  assert.equal(result.materialIdentityVerified, false);
}

function diagnostic(control: ReturnType<typeof evaluate>) {
  return {
    image: {
      ...control.imageContours.summary,
      retainedSourceComponents: new Set(
        control.imageContours.samples.map(
          (sample) => sample.component ?? sample.group,
        ),
      ).size,
    },
    candidates: control.result.candidates.map((candidate, i) => ({
      id: candidate.id,
      residual: candidate.match.residual,
      coverage: candidate.match.coverage,
      silhouette: candidate.silhouetteIoU,
      samples: candidate.geometrySamples,
      supportedForRanking: candidate.supportedForRanking,
      supportReasons: candidate.supportReasons,
      totalWeight: candidate.match.groups.reduce(
        (sum, group) => sum + group.totalWeight,
        0,
      ),
      visibleGroups: candidate.match.groups.length,
      matchedImageComponents: new Set(
        candidate.match.groups.flatMap((group) => group.matchedImageComponents),
      ).size,
      geometry: control.geometry[i].contours.summary,
    })),
    proposed: control.result.proposedId,
    status: control.result.status,
    directionDeterminant: control.result.directionDeterminant,
    reasons: control.result.reasons,
  };
}

function assertProjectionAgreement(
  mesh: TriangleMesh,
  image: Raster,
  camera: ReferenceCamera,
) {
  assert.ok(image.independentProjection);
  const { view, left, right, top, bottom } = referenceAlignment(
    mesh,
    image,
    camera,
  );
  let maxError = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const point = [
      mesh.positions[i],
      mesh.positions[i + 1],
      mesh.positions[i + 2],
    ] as Vec3;
    const analytic = image.independentProjection(point),
      projected = view.point(...point);
    const aligned = [
      left +
        ((projected[0] - view.minX) / (view.maxX - view.minX)) * (right - left),
      top +
        ((view.maxY - projected[1]) / (view.maxY - view.minY)) * (bottom - top),
    ];
    maxError = Math.max(
      maxError,
      Math.hypot(analytic[0] - aligned[0], analytic[1] - aligned[1]),
    );
  }
  // Integer foreground bounds represent pixel centres, whereas the independent
  // ray frame uses pixel cells. This permits only the resulting subpixel error.
  assert.ok(
    maxError < 0.8,
    `independent/alignment projection differ by ${maxError}px`,
  );
  return maxError;
}

function assertQualifiedKnownNomination(control: ReturnType<typeof evaluate>) {
  const [known, opposite] = control.result.candidates;
  assert.ok(
    control.imageContours.samples.length > 50,
    JSON.stringify(control.imageContours.summary),
  );
  assert.ok(
    known.geometrySamples > 50,
    JSON.stringify(control.geometry[0].contours.summary),
  );
  assert.ok(
    opposite.silhouetteIoU > 0.9,
    'opposite camera must retain a similar outer silhouette',
  );
  // Preserve the independently rendered counterexample: the raw directed
  // residual prefers the sparse back contour. Support qualification, rather
  // than a changed fixture or a weaker residual claim, must prevent selection.
  assert.ok(
    opposite.match.residual + 0.025 < known.match.residual,
    JSON.stringify({
      known: {
        residual: known.match.residual,
        coverage: known.match.coverage,
        samples: known.geometrySamples,
        groups: known.match.groups.length,
        silhouette: known.silhouetteIoU,
      },
      opposite: {
        residual: opposite.match.residual,
        coverage: opposite.match.coverage,
        samples: opposite.geometrySamples,
        groups: opposite.match.groups.length,
        silhouette: opposite.silhouetteIoU,
      },
      image: control.imageContours.samples.length,
      gate: control.result.status,
      reasons: control.result.reasons,
    }),
  );
  assert.equal(
    opposite.match.groups.length,
    1,
    'competing back camera has one sparse geometric group',
  );
  assert.equal(opposite.supportedForRanking, false);
  assert.ok(
    opposite.supportReasons.length > 0,
    'sparse camera must explain its exclusion before ranking',
  );
  assert.equal(
    known.supportedForRanking,
    true,
    JSON.stringify(known.supportReasons),
  );
  assert.equal(
    control.result.proposedId,
    'known',
    'prequalified supported camera must be nominated',
  );
  assertNoTruthClaims(control.result);
}

void test('support qualification nominates known front camera despite the sparse flat back winning raw residual', (t) => {
  const mesh = cubes(asymmetric),
    image = render(asymmetric, frontCamera);
  const beforePositions = mesh.positions.slice(),
    beforeImage = image.data.slice();
  assert.deepEqual(intersect([0, 0, 20], [0, 0, -1], shell), {
    distance: 19.5,
    normal: [0, 0, 1],
  });
  assert.deepEqual(intersect([0, 0, -20], [0, 0, 1], shell), {
    distance: 19.5,
    normal: [0, 0, -1],
  });
  const maxProjectionError = assertProjectionAgreement(
    mesh,
    image,
    frontCamera,
  );
  const control = evaluate(mesh, image);
  t.diagnostic(JSON.stringify({ maxProjectionError, ...diagnostic(control) }));
  assert.deepEqual(mesh.positions, beforePositions);
  assert.deepEqual(image.data, beforeImage);
  assertQualifiedKnownNomination(control);
  // Nomination may remain unresolved without a valid independent competitor.
});

void test('global illumination scaling and offset preserve safe nomination and the raw-residual counterexample', (t) => {
  const mesh = cubes(asymmetric),
    image = render(asymmetric, frontCamera);
  const changed: Raster = { ...image, data: image.data.slice() };
  for (let i = 0; i < changed.data.length; i += 4)
    if (changed.data[i + 3]) {
      const value = Math.round(image.data[i] * 0.65 + 27);
      changed.data.set([value, value, value], i);
    }
  const original = evaluate(mesh, image),
    illuminated = evaluate(mesh, changed);
  t.diagnostic(
    JSON.stringify({
      original: diagnostic(original),
      illuminated: diagnostic(illuminated),
    }),
  );
  assertQualifiedKnownNomination(original);
  assertQualifiedKnownNomination(illuminated);
});

void test('rotationally repetitive geometry and paint-only frames remain unresolved', () => {
  const repeated: Box[] = [shell];
  for (const x of [-1.45, 1.45])
    for (const y of [-1.45, 1.45]) {
      repeated.push({
        lo: [x - 0.6, y - 0.6, 0.4],
        hi: [x + 0.6, y + 0.6, 1.4],
      });
      repeated.push({
        lo: [x - 0.6, y - 0.6, -1.4],
        hi: [x + 0.6, y + 0.6, -0.4],
      });
    }
  const equivalent = { ...frontCamera, yaw: 195 };
  const symmetric = evaluate(cubes(repeated), render(repeated, frontCamera), [
    frontCamera,
    equivalent,
  ]);
  assert.equal(symmetric.result.status, 'unresolved');
  assert.ok(
    symmetric.result.reasons.includes('competing-camera-ambiguity'),
    JSON.stringify(symmetric.result.reasons),
  );
  assertNoTruthClaims(symmetric.result);
  const faceOn = { yaw: 0, pitch: 0, perspective: 0 };
  const painted = evaluate(cubes([shell]), render([shell], faceOn, true), [
    faceOn,
    { ...faceOn, yaw: 180 },
  ]);
  assert.ok(
    painted.imageContours.samples.length > 50,
    'paint supplies persistent image contours',
  );
  assert.equal(
    painted.geometry[0].contours.samples.length,
    0,
    'flat source plane has no internal geometric edges',
  );
  assert.equal(painted.result.status, 'unresolved');
  assertNoTruthClaims(painted.result);
});

void test('an image opening absent from source geometry cannot verify or correct correspondence', () => {
  const recessed: Box[] = [
    { lo: [-3, -3, -0.5], hi: [-1, 3, 0.5] },
    { lo: [1, -3, -0.5], hi: [3, 3, 0.5] },
    { lo: [-1, -3, -0.5], hi: [1, -1.5, 0.5] },
    { lo: [-1, 1.5, -0.5], hi: [1, 3, 0.5] },
    { lo: [-1, -1.5, -1.5], hi: [1, 1.5, -1.35] },
  ];
  const source = cubes([shell]),
    image = render(recessed, frontCamera);
  const before = source.positions.slice();
  const control = evaluate(source, image);
  assert.ok(
    control.imageContours.samples.length > 20,
    'opening must be visible in the independent image',
  );
  assert.equal(
    control.result.status,
    'unresolved',
    JSON.stringify(control.result),
  );
  assertNoTruthClaims(control.result);
  assert.deepEqual(source.positions, before);
});
