import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { designDuck, referenceDuck, envelope } from './duck-designer.ts';
import { validateAssembly, connectors } from './assembly-validation.ts';
import { validateModel, inventory, toLDraw } from './brick-engine.ts';
import { manualHTML, csv } from './manual.ts';
import { orientationLabel } from './assembly-diagram.ts';
import { ASSEMBLY_PARTS, worldPoint } from './assembly-catalog.ts';

test('all four duck proportions form a connected assembly with ordered real stud connections', () => {
  for (const headWidth of [4, 6])
    for (const bodyLength of [8, 10]) {
      const model = designDuck({ headWidth, bodyLength });
      assert.deepEqual(validateModel(model), {
        collisions: 0,
        unsupported: 0,
        invalidParts: 0,
        connected: true,
        brickCount: model.bricks.length,
      });
      assert.ok(model.bricks.length < 200);
      assert.equal(
        inventory(model.bricks).reduce((n, p) => n + p.quantity, 0),
        model.bricks.length,
      );
      assert.equal(model.assembly!.sections.length, 6);
      assert.ok(
        model.assembly!.steps.every((_, i) =>
          model.bricks.some((b) => b.step === i),
        ),
      );
      const centerX = model.width / 2,
        centerZ = model.depth / 2;
      for (const b of model.bricks) {
        const bounds = envelope(b.part, b.pose!);
        assert.ok(Math.abs(bounds.x + centerX - b.x) < 1e-6);
        assert.ok(Math.abs(bounds.z + centerZ - b.z) < 1e-6);
        assert.ok(
          b.x >= -1e-6 &&
            b.x + b.w <= model.width + 1e-6 &&
            b.z >= -1e-6 &&
            b.z + b.d <= model.depth + 1e-6,
        );
      }
    }
});
test('side-mounted eyes and wings connect at exact opposing-side stud positions, and mutations are rejected', () => {
  const model = designDuck();
  const sideParts = model.bricks.filter(
    (b) =>
      b.part === '98138' || (b.section === 'wings' && b.pose!.matrix[4] === 0),
  );
  assert.equal(sideParts.length, 4);
  for (const part of sideParts) {
    const sockets = connectors(part).sockets;
    const hosts = model.bricks
      .filter((b) => b.id !== part.id)
      .flatMap((b) => connectors(b).studs);
    assert.ok(
      sockets.some((s) =>
        hosts.some((h) => JSON.stringify(h) === JSON.stringify(s)),
      ),
    );
    assert.match(orientationLabel(part), /侧装/);
  }
  const changed = structuredClone(model),
    eye = changed.bricks.find((b) => b.part === '98138')!;
  eye.pose!.position[0] += 2;
  assert.ok(validateAssembly(changed).unsupported > 0);
  assert.equal(validateAssembly(changed).connected, false);
  const badOrder = structuredClone(model);
  badOrder.bricks.find((b) => b.part === '98138')!.step = 0;
  assert.ok(validateAssembly(badOrder).unsupported > 0);
  const collision = structuredClone(model);
  collision.bricks[1] = { ...collision.bricks[0], id: 2 };
  assert.ok(validateAssembly(collision).collisions > 0);
});
test('the provided duck raster changes palette and proportions, and invalid images are rejected', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('./fixtures/duck-raster.json', import.meta.url),
      'utf8',
    ),
  );
  const raster = {
    width: fixture.width,
    height: fixture.height,
    data: Buffer.from(fixture.rgba, 'base64'),
  };
  const profile = referenceDuck(raster, { background: 'white', threshold: 70 });
  assert.equal(profile.bodyColor, 3);
  assert.equal(profile.beakColor, 2);
  const blue = Buffer.from(raster.data);
  for (let i = 0; i < blue.length; i += 4)
    if (blue[i] > 150 && blue[i + 1] > 100 && blue[i + 2] < 90) {
      blue[i] = 0;
      blue[i + 1] = 85;
      blue[i + 2] = 191;
    }
  assert.equal(
    referenceDuck(
      { ...raster, data: blue },
      { background: 'white', threshold: 70 },
    ).bodyColor,
    4,
  );
  assert.throws(
    () =>
      referenceDuck(
        { width: 2, height: 2, data: Array(16).fill(255) },
        { background: 'white', threshold: 70 },
      ),
    /没有找到/,
  );
  assert.throws(
    () =>
      referenceDuck(
        { width: 2, height: 2, data: [] },
        { background: 'auto', threshold: 70 },
      ),
    /不完整/,
  );
});
test('LDraw exports exact full rotations and translations, including curved part origins and side mounting', () => {
  const model = designDuck(),
    lines = toLDraw(model).split('\n'),
    placements = lines.filter((l) => l.startsWith('1 '));
  assert.equal(placements.length, model.bricks.length);
  assert.equal(
    lines.filter((l) => l === '0 STEP').length,
    model.assembly!.steps.length,
  );
  const ordered = model.levels.flatMap((step) =>
    model.bricks.filter((b) => b.step === step),
  );
  placements.forEach((line, i) => {
    const t = line.split(' '),
      b = ordered[i];
    assert.deepEqual(t.slice(2, 5).map(Number), b.pose!.position);
    assert.deepEqual(t.slice(5, 14).map(Number), b.pose!.matrix);
    assert.equal(t[14], `${b.part}.dat`);
    const p = ASSEMBLY_PARTS[b.part];
    if (b.pose!.matrix[4] === 1)
      assert.equal(
        worldPoint(b.pose!, [0, p.bottom, p.centerZ || 0])[1],
        -b.y * 8,
      );
  });
});
test('offline instructions contain every placement exactly once, preserve assembly order, and escape names', () => {
  const model = designDuck();
  model.name = '<img src=x onerror=alert(1)>';
  const html = manualHTML(model);
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
  for (const b of model.bricks)
    assert.equal(html.split(`<td>#${b.id} · `).length - 1, 1);
  assert.ok(html.includes('侧装 · 向左') && html.includes('侧装 · 向右'));
  assert.ok(html.indexOf('11 · 眼睛连接砖') < html.indexOf('12 · 扁平的鸭嘴'));
  assert.equal(
    csv(model)
      .trim()
      .split('\r\n')
      .slice(1)
      .reduce((s, l) => s + Number(l.split(',').at(-1)), 0),
    model.bricks.length,
  );
});
test('every assembly part has finite complete baked LDraw geometry and attribution', () => {
  const meshes = JSON.parse(
    readFileSync(
      new URL('../public/parts/geometry.json', import.meta.url),
      'utf8',
    ),
  );
  const attribution = readFileSync(
    new URL('../public/parts/ATTRIBUTION.txt', import.meta.url),
    'utf8',
  );
  for (const part of Object.keys(ASSEMBLY_PARTS)) {
    const mesh = meshes[part];
    assert.ok(mesh);
    assert.ok(mesh.positions.length > 0 && mesh.positions.length % 9 === 0);
    assert.equal(mesh.normals.length, mesh.positions.length);
    assert.ok(
      mesh.positions.every(Number.isFinite) &&
        mesh.normals.every(Number.isFinite),
    );
    assert.ok(attribution.includes(`${part}.dat`));
  }
});
