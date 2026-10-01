import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { meshToDesign } from './mesh-design.ts';
import { colorFromReference, referenceAlignment } from './reference-colors.ts';

const boxes = [
  { lo: [-1.6, -1, -1], hi: [1.2, 0.1, 1] },
  { lo: [-1.6, 0.1, -0.9], hi: [-0.3, 1.7, 0.4] },
  { lo: [0.6, 0.1, -0.2], hi: [1.2, 0.7, 1] },
];
function mesh(divisions: number) {
  const p: number[] = [];
  for (const { lo, hi } of boxes) {
    const g = new BoxGeometry(
      ...(hi.map((v, i) => v - lo[i]) as [number, number, number]),
      divisions,
      divisions,
      divisions,
    ).toNonIndexed();
    const a = g.attributes.position.array;
    for (let i = 0; i < a.length; i++)
      p.push(a[i] + (lo[i % 3] + hi[i % 3]) / 2);
    g.dispose();
  }
  return {
    name: 'asymmetric blocks',
    positions: Float32Array.from(p),
    colors: new Uint8Array(p.length / 3).fill(150),
  };
}
// Independently render an orthographic reference by ray/box intersections,
// not by the triangle rasterizer or vertex samples under test.
function reference(yawDegrees: number, pitchDegrees: number) {
  const yaw = (yawDegrees * Math.PI) / 180,
    pitch = (pitchDegrees * Math.PI) / 180;
  const right = [Math.cos(yaw), 0, -Math.sin(yaw)],
    up = [
      -Math.sin(yaw) * Math.sin(pitch),
      Math.cos(pitch),
      -Math.cos(yaw) * Math.sin(pitch),
    ],
    direction = [
      Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      Math.cos(yaw) * Math.cos(pitch),
    ];
  const width = 256,
    height = 256,
    data = new Uint8Array(width * height * 4),
    scale = 44;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const origin = right.map(
        (r, k) =>
          (r * (x - width / 2)) / scale +
          (up[k] * (height / 2 - y)) / scale +
          direction[k] * 10,
      );
      const hit = boxes.some(({ lo, hi }) => {
        let near = 0,
          far = Infinity;
        for (let k = 0; k < 3; k++) {
          if (Math.abs(direction[k]) < 1e-9) {
            if (origin[k] < lo[k] || origin[k] > hi[k]) return false;
            continue;
          }
          const a = (origin[k] - lo[k]) / direction[k],
            b = (origin[k] - hi[k]) / direction[k];
          near = Math.max(near, Math.min(a, b));
          far = Math.min(far, Math.max(a, b));
        }
        return near <= far;
      });
      if (hit) data.set([215, 186, 140, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}

void test('true projected silhouette and fitted pose do not depend on face subdivisions', () => {
  const image = reference(35, 25),
    coarse = referenceAlignment(mesh(1), image),
    dense = referenceAlignment(mesh(7), image);
  assert.deepEqual(dense.camera, coarse.camera);
  assert.ok(Math.abs(dense.confidence - coarse.confidence) < 1e-7);
  assert.ok(
    coarse.evidence.silhouetteIoU > 0.96,
    JSON.stringify(coarse.evidence),
  );
  assert.ok(
    Math.abs(coarse.camera.yaw - 35) <= 10,
    JSON.stringify(coarse.camera),
  );
  assert.ok(
    Math.abs(coarse.camera.pitch - 25) <= 5,
    JSON.stringify(coarse.camera),
  );
});

void test('explicit camera fills coarse faces and records fit without calling it calibrated probability', () => {
  const a = referenceAlignment(mesh(1), reference(35, 25), {
    yaw: 35,
    pitch: 25,
    perspective: 0,
  });
  assert.ok(a.evidence.silhouetteIoU > 0.96, JSON.stringify(a.evidence));
  assert.equal(a.evidence.source, 'explicit-camera');
  assert.equal(a.evidence.ambiguous, false);
  assert.equal(a.evidence.alternative, undefined);
  assert.match(a.evidence.limitations, /interior pixel correspondence/);
});

void test('a symmetric outline records competing camera poses', () => {
  const g = new BoxGeometry(2, 2, 2).toNonIndexed(),
    p = Float32Array.from(g.attributes.position.array);
  g.dispose();
  const image = { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) };
  for (let y = 4; y < 36; y++)
    for (let x = 4; x < 36; x++)
      image.data.set([150, 150, 150, 255], (y * 40 + x) * 4);
  const a = referenceAlignment(
    {
      name: 'symmetric box',
      positions: p,
      colors: new Uint8Array(p.length / 3).fill(150),
    },
    image,
  );
  assert.equal(a.evidence.ambiguous, true);
  assert.ok(a.evidence.alternative);
  assert.ok(a.evidence.alternative!.scoreGap < 0.025);
});

void test('brick conversion reprojects reference colors when the mounting camera changes', () => {
  const g = new BoxGeometry(2, 2, 2, 4, 4, 4).toNonIndexed();
  const p = Float32Array.from(g.attributes.position.array);
  g.dispose();
  const source = {
    name: 'painted box',
    positions: p,
    colors: new Uint8Array(p.length / 3).fill(150),
  };
  const image = { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4) };
  for (let y = 4; y < 36; y++)
    for (let x = 4; x < 36; x++)
      image.data.set(
        (x < 20
          ? [0, 85, 191]
          : [215, 186, 140].map((v) =>
              Math.round(v * (0.65 + (0.35 * (y - 4)) / 31)),
            )
        ).concat(255),
        (y * 40 + x) * 4,
      );
  const camera = { yaw: 0, pitch: 0, perspective: 0 };
  const painted = colorFromReference(
    source,
    image,
    { ...camera, yaw: 90 },
    false,
  );
  const before = painted.colors.slice();
  const result = meshToDesign(painted, 20, [], { image, camera });
  assert.equal(result.materialDesign?.alignment?.source, 'explicit-camera');
  assert.equal(
    result.materialDesign?.normalizedPixels,
    0,
    'changing camera preserves disabled illumination correction',
  );
  assert.ok(
    colorFromReference(source, image, camera, true).materialDesign!
      .normalizedPixels > 0,
    'the gradient would change if correction were silently enabled',
  );
  assert.deepEqual(result.materialDesign?.alignment?.camera, camera);
  assert.deepEqual(painted.colors, before, 'source paint is not mutated');
  const consistent = meshToDesign(
    colorFromReference(source, image, camera, false),
    20,
  );
  assert.deepEqual(
    result.bricks.map((b) => [b.x, b.y, b.z, b.part, b.color]),
    consistent.bricks.map((b) => [b.x, b.y, b.z, b.part, b.color]),
  );
});
