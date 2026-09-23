// Check the emitted browser launcher as well as the worker body. Evaluating
// only the body misses file:// URLs introduced by the page compilation pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { BoxGeometry } from 'three';

const root = path.resolve('dist/client');
const chunkDir = path.join(root, '_next/static/chunks');
const origin = 'https://brickform.example';
let checked = 0;
for (const filename of fs.readdirSync(chunkDir)) {
  if (!filename.endsWith('.js')) continue;
  const code = fs.readFileSync(path.join(chunkDir, filename), 'utf8');
  if (!code.includes('image-design.worker-')) continue;
  const ast = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const constants = {};
  const launchers = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer)
    )
      constants[node.name.text] = node.initializer.text;
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Worker')
      launchers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const launcher of launchers) {
    let workerUrl;
    vm.runInNewContext(launcher.getText(ast), {
      ...constants,
      URL,
      window: { location: { href: `${origin}/` } },
      Worker: class {
        constructor(url) {
          workerUrl = new URL(url, origin);
        }
      },
    });
    assert.equal(
      workerUrl.protocol,
      'https:',
      'Worker launcher must not reference a build-machine file:// URL',
    );
    assert.equal(
      workerUrl.origin,
      origin,
      'Worker must load from the Site origin',
    );
    assert.match(
      workerUrl.pathname,
      /^\/_next\/static\/image-design\.worker-[\w-]+\.js$/,
    );
    const file = path.join(root, workerUrl.pathname);
    assert.ok(
      fs.existsSync(file),
      'The exact worker requested by the page must be packaged',
    );
    let result;
    const self = {
      postMessage: (value) => {
        result = value;
      },
    };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { self });
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++)
        data.set(
          x > 3 && x < 12 && y > 2 && y < 14
            ? [0, 85, 191, 255]
            : [255, 255, 255, 255],
          (y * 16 + x) * 4,
        );
    const options = {
      resolution: 20,
      depth: 4,
      threshold: 70,
      background: 'auto',
      mode: 'auto',
    };
    await self.onmessage({
      data: {
        raster: { width: 16, height: 16, data },
        name: 'Worker launch check',
        options,
      },
    });
    assert.ok(result.model?.bricks.length > 0, result.error);
    assert.ok(result.model.assembly.steps.length > 0);
    await self.onmessage({
      data: {
        raster: { width: 1, height: 1, data: [0, 0, 0, 0] },
        name: 'empty',
        options,
      },
    });
    assert.match(result.error, /透明/);
    const cube = new BoxGeometry(4, 5, 6).toNonIndexed();
    const colors = new Uint8Array(cube.attributes.position.count);
    for (let i = 0; i < colors.length; i += 3) colors.set([215, 186, 140], i);
    await self.onmessage({
      data: {
        mesh: {
          positions: new Float32Array(cube.attributes.position.array),
          colors,
          name: 'Mesh worker check',
        },
        options: { resolution: 20 },
      },
    });
    assert.ok(result.model?.meshDesign, result.error);
    assert.ok(result.model.bricks.some((b) => b.color === 7));
    await self.onmessage({
      data: {
        action: 'color',
        mesh: {
          positions: new Float32Array(cube.attributes.position.array),
          colors,
          name: 'Reference color worker check',
        },
        raster: { width: 16, height: 16, data },
        camera: { yaw: 0, pitch: 0, perspective: 0 },
      },
    });
    assert.equal(
      result.mesh?.coloring.method,
      'reference-projection',
      result.error,
    );
    assert.ok(
      result.mesh.colors.some((c, i) => i % 3 === 2 && c === 191),
      'reference blue reaches the mesh',
    );
    // Actual bundled async semantic pipeline: no reference confirmation step.
    await self.onmessage({
      data: {
        mesh: {
          positions: new Float32Array(cube.attributes.position.array),
          colors,
          name: 'Automatic fallback',
        },
        raster: { width: 16, height: 16, data },
        options: { resolution: 28 },
        autoSemanticRefinement: true,
      },
    });
    assert.ok(result.model?.bricks.length > 0, result.error);
    assert.equal(result.applied, 0);
    assert.ok(!result.model.semanticDesign);
    cube.dispose();
    checked++;
  }
}
assert.equal(
  checked,
  2,
  'Verify both image and mesh conversion worker launchers in the emitted page',
);
console.log(
  'Image worker: HTTPS launcher, packaged asset, generated model and error response verified.',
);
