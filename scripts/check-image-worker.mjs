// Check the emitted browser launcher as well as the worker body. Evaluating
// only the body misses file:// URLs introduced by the page compilation pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const root = path.resolve('dist/client');
const chunkDir = path.join(root, '_next/static/chunks');
const origin = 'https://brickform.example';
let checked = 0;
for (const filename of fs.readdirSync(chunkDir)) {
  if (!filename.endsWith('.js')) continue;
  const code = fs.readFileSync(path.join(chunkDir, filename), 'utf8');
  if (!code.includes('image-design.worker-')) continue;
  const ast = ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const constants = {};
  const launchers = [];
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) constants[node.name.text] = node.initializer.text;
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Worker') launchers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const launcher of launchers) {
    let workerUrl;
    vm.runInNewContext(launcher.getText(ast), {
      ...constants, URL, window: { location: { href: `${origin}/` } },
      Worker: class { constructor(url) { workerUrl = new URL(url, origin); } },
    });
    assert.equal(workerUrl.protocol, 'https:', 'Worker launcher must not reference a build-machine file:// URL');
    assert.equal(workerUrl.origin, origin, 'Worker must load from the Site origin');
    assert.match(workerUrl.pathname, /^\/_next\/static\/image-design\.worker-[\w-]+\.js$/);
    const file = path.join(root, workerUrl.pathname);
    assert.ok(fs.existsSync(file), 'The exact worker requested by the page must be packaged');
    let result;
    const self = { postMessage: value => { result = value; } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { self });
    const data = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data.set(x > 3 && x < 12 && y > 2 && y < 14 ? [0, 85, 191, 255] : [255, 255, 255, 255], (y * 16 + x) * 4);
    const options = { resolution: 20, depth: 4, threshold: 70, background: 'auto', mode: 'auto' };
    self.onmessage({ data: { raster: { width: 16, height: 16, data }, name: 'Worker launch check', options } });
    assert.ok(result.model?.bricks.length > 0, result.error);
    assert.ok(result.model.assembly.steps.length > 0);
    self.onmessage({ data: { raster: { width: 1, height: 1, data: [0, 0, 0, 0] }, name: 'empty', options } });
    assert.match(result.error, /透明/);
    checked++;
  }
}
assert.equal(checked, 1, 'Find and verify the image-generation worker launcher in the emitted page');
console.log('Image worker: HTTPS launcher, packaged asset, generated model and error response verified.');
