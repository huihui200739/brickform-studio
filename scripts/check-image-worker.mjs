// Check the emitted browser launcher as well as the worker body. Evaluating
// only the body misses file:// URLs introduced by the page compilation pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { BoxGeometry } from 'three';

const root = path.resolve('dist/client');
const chunkDir = path.join(root, '_next/static/chunks');
const origin = 'https://brickform.example';
// The URL can be hoisted into a shared chunk after route splitting. Resolve
// imported string constants instead of silently skipping all real launchers.
const modules = new Map();
for (const filename of fs.readdirSync(chunkDir)) {
  if (!filename.endsWith('.js')) continue;
  const code = fs.readFileSync(path.join(chunkDir, filename), 'utf8');
  const ast = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const info = {
    ast,
    constants: {},
    imports: new Map(),
    exports: new Map(),
    launchers: [],
  };
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer)
    )
      info.constants[node.name.text] = node.initializer.text;
    if (
      ts.isImportDeclaration(node) &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const imported of node.importClause.namedBindings.elements)
        info.imports.set(imported.name.text, {
          file: path.basename(node.moduleSpecifier.text),
          exported: (imported.propertyName ?? imported.name).text,
        });
    }
    if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const exported of node.exportClause.elements)
        info.exports.set(
          exported.name.text,
          (exported.propertyName ?? exported.name).text,
        );
    }
    if (ts.isNewExpression(node) && node.expression.getText(ast) === 'Worker')
      info.launchers.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  modules.set(filename, info);
}
function resolveConstant(filename, name, seen = new Set()) {
  const key = `${filename}:${name}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const info = modules.get(filename);
  if (!info) return undefined;
  if (name in info.constants) return info.constants[name];
  const imported = info.imports.get(name);
  if (!imported) return undefined;
  const source = modules.get(imported.file);
  const localName = source?.exports.get(imported.exported);
  return localName
    ? resolveConstant(imported.file, localName, seen)
    : undefined;
}
let checked = 0;
for (const [filename, info] of modules) {
  const { ast, launchers } = info;
  const constants = { ...info.constants };
  for (const name of info.imports.keys()) {
    const value = resolveConstant(filename, name);
    if (value !== undefined) constants[name] = value;
  }
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
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      self,
      structuredClone,
      crypto,
    });
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
    const reference = result.mesh,
      header = Buffer.alloc(8);
    header.writeUInt32LE(16, 0);
    header.writeUInt32LE(16, 4);
    await self.onmessage({
      data: {
        action: 'color-material',
        mesh: structuredClone(reference),
        materialCandidate: {
          raster: { width: 16, height: 16, data },
          provenance: {
            method: 'marigold-iid-lighting',
            modelRevision: '08c3930bb641abf786ba44ce92547507ebefbc16',
            sourceSha256: createHash('sha256')
              .update(header)
              .update(data)
              .digest('hex'),
            engineFingerprint: 'a'.repeat(64),
            runtimeDtype: 'float32',
            steps: 4,
            processingResolution: 512,
            seed: 735,
          },
        },
      },
    });
    assert.equal(
      result.mesh?.materialHypothesis.method,
      'learned-albedo-candidate',
      result.error,
    );
    assert.equal(
      result.mesh.materialHypothesis.materialIdentityVerified,
      false,
    );
    assert.deepEqual(result.mesh.positions, reference.positions);
    assert.deepEqual(
      Array.from(result.mesh.sourceObservations.raster.rgba),
      Array.from(data),
    );
    await self.onmessage({
      data: { action: 'color-material', mesh: reference },
    });
    assert.match(result.error, /缺少/);
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
    // Exercise the packaged three-view preview and conversion, including the
    // structured-cloned occupied volume returned to the browser between steps.
    const viewData = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 2; y < 14; y++)
      for (let x = 2; x < 14; x++)
        viewData.set([215, 186, 140, 255], (y * 16 + x) * 4);
    await self.onmessage({
      data: {
        action: 'views-draft',
        views: ['front', 'side', 'top'].map((axis) => ({
          axis,
          image: { width: 16, height: 16, data: viewData },
        })),
        options: { resolution: 20 },
        name: 'Three-view worker check',
      },
    });
    assert.ok(result.reconstruction?.mesh.positions.length > 0, result.error);
    assert.equal(
      result.reconstruction.mesh.positions.length / 3,
      result.reconstruction.mesh.colors.length,
    );
    const volume = structuredClone(result.reconstruction.volume);
    await self.onmessage({
      data: {
        action: 'views',
        volume,
        options: { resolution: 20 },
        name: 'Three-view worker check',
      },
    });
    assert.equal(
      result.model?.viewsDesign.method,
      'silhouette-carving',
      result.error,
    );
    assert.ok(result.model.bricks.length > 0);
    assert.ok(result.model.assembly.steps.length > 0);
    checked++;
  }
}
// The formal workflow adds one shared launcher; the advanced workbench retains
// its image and mesh launchers. Every source launcher must survive packaging.
let expected = 0;
for (const file of [
  'lib/workspace-worker.ts',
  'app/advanced/page.tsx',
  'components/reconstruction-panel.tsx',
]) {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const count = (node) => {
    if (
      ts.isNewExpression(node) &&
      node.expression.getText(source) === 'Worker'
    )
      expected++;
    ts.forEachChild(node, count);
  };
  count(source);
}
assert.ok(
  expected >= 3,
  'Formal and advanced workflows must retain conversion workers',
);
assert.equal(
  checked,
  expected,
  'Verify every emitted image/mesh worker launcher across route chunks',
);
console.log(
  'Image worker: HTTPS launcher, packaged asset, generated model and error response verified.',
);
