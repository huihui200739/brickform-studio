import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { referenceVisibility } from './reference-visibility.ts';

void test('perspective depth agrees with an analytic 3D ray, not affine screen depth', () => {
  // Projection denominator is 1-z/4. Actual triangle vertices are
  // (0,0,-.8), (8,0,.8), (0,8,.8), hence its plane z=-.8+.2(x+y).
  // The screen ray at (2.5,2.5) has x=y=2.5(1-z/4).
  // Solving these independent equations gives z=.16. Affine screen depth
  // would give zero, wrongly hiding this surface behind the z=.1 panel.
  const coords = Float64Array.from([
    0, 0, -0.8, 10, 0, 0.8, 0, 10, 0.8, 0, 0, 0.1, 10, 0, 0.1, 0, 10, 0.1,
  ]);
  const projection = referenceVisibility(coords, 2, 0.5, 12);
  const rayDepth = 0.2 / 1.25;
  assert.ok(Math.abs(projection.depthAt(0, 2.5, 2.5) - rayDepth) < 1e-12);
  assert.equal(projection.frontAt(2.5, 2.5).face, 0);
  assert.equal(projection.pixelFace[2 * 12 + 2], 0);
});

void test('a visible subpixel triangle and an occluded neighbor need exact sample rays', () => {
  const coords = Float64Array.from([
    0, 0, 0, 10, 0, 0, 0, 10, 0, 2.1, 2.1, 0.001, 2.2, 2.1, 0.001, 2.1, 2.2,
    0.001, 2.1, 2.1, -0.001, 2.2, 2.1, -0.001, 2.1, 2.2, -0.001,
  ]);
  const projection = referenceVisibility(coords, 10, 0, 12);
  assert.ok(
    !Array.from(projection.pixelFace).includes(1),
    'the tiny face owns no pixel',
  );
  const x = (2.1 + 2.2 + 2.1) / 3,
    y = x;
  assert.equal(projection.frontAt(x, y).face, 1);
  assert.ok(
    projection.depthAt(2, x, y) <
      projection.frontAt(x, y).depth - projection.tolerance,
  );
});
