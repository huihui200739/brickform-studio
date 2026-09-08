import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { viewerGeometry, viewerPose } from './assembly-render.ts';
import { roundedDuck } from './rounded-duck.ts';

void test('rendered triangles face outward after converting LDraw coordinates', () => {
  const parts = JSON.parse(
    readFileSync(
      new URL('../public/parts/geometry.json', import.meta.url),
      'utf8',
    ),
  );
  for (const [part, raw] of Object.entries(parts)) {
    const { positions: p, normals: n } = viewerGeometry(
      raw as { positions: number[]; normals: number[] },
    );
    let checked = 0;
    for (let i = 0; i < p.length; i += 9) {
      const a = new Vector3().fromArray(p, i),
        b = new Vector3().fromArray(p, i + 3).sub(a),
        c = new Vector3().fromArray(p, i + 6).sub(a);
      const dot = b.cross(c).dot(new Vector3().fromArray(n, i));
      assert.ok(dot >= -1e-7, `${part}: inside-out triangle`);
      if (dot > 1e-7) checked++;
    }
    assert.ok(checked > 0);
  }
});
void test('all ordinary and side-mounted instances preserve handedness and exact CAD placement', () => {
  for (const brick of roundedDuck().bricks) {
    const pose = brick.pose!,
      m = new Matrix4().set(...viewerPose(pose));
    assert.ok(Math.abs(m.determinant() - 1) < 1e-8);
    for (const v of [
      [0, 0, 0],
      [10, -8, 20],
      [-20, 24, -10],
    ]) {
      const converted = new Vector3(
        v[0] * 0.05,
        -v[1] * 0.05,
        v[2] * 0.05,
      ).applyMatrix4(m);
      const expected = v.map(
        (_, row) =>
          (pose.position[row] +
            v.reduce(
              (sum, value, col) => sum + pose.matrix[row * 3 + col] * value,
              0,
            )) *
          (row === 1 ? -0.05 : 0.05),
      );
      assert.ok(converted.distanceTo(new Vector3(...expected)) < 1e-7);
    }
  }
});
