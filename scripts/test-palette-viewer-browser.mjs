// Actual existing-server display/export regression; no inference or packing.
// Run: node scripts/test-palette-viewer-browser.mjs
// Use a FRESH BRICKFORM_DISPLAY_REVIEW_OUT for repeats; every artifact uses wx.
// Optional BRICKFORM_DISPLAY_MODEL renders/exports an existing Model, unchanged.
import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const base = process.env.BRICKFORM_TEST_URL || 'http://127.0.0.1:3000';
const out = process.env.BRICKFORM_DISPLAY_REVIEW_OUT || 'outputs/continue-colour-verification';
const modelPath = process.env.BRICKFORM_DISPLAY_MODEL;
const modelBytes = modelPath ? await readFile(modelPath) : null;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const save = (name, bytes) => writeFile(`${out}/${name}`, bytes, { flag: 'wx' });
await mkdir(out, { recursive: true });
const productFiles = ['components/assembly-viewer.tsx', 'components/mesh-draft-viewer.tsx', 'components/model-viewer.tsx', 'lib/palette-rendering.ts', 'lib/brick-engine.ts', 'lib/manual.ts', 'lib/purchase-inventory.ts', 'lib/assembly-render.ts'];
const productHashes = {};
for (const path of productFiles) productHashes[path] = sha(await readFile(path));
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const report = {
  scope: 'Synthetic 17-palette swatches and synthetic raw mesh through actual product viewers and export functions. NOT exact Temple8843/Tower4715. Optional saved Model, if specified, is identified separately.',
  method: 'Actual product modules/CSS and parts geometry; observational Object3D.add wrapper forwards original arguments/results unchanged. No fake worker, shader, material, camera or export results.',
  url: base, browser: await browser.version(), renderer: 'Chrome SwiftShader',
  nativeSubmissions: 0, sceneInference: 0, packing: 0,
  productHashesBefore: productHashes, forbiddenRequests: [], pageErrors: [], artifacts: [],
};
async function pageContext() {
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    if (route.request().method() !== 'GET') {
      report.forbiddenRequests.push(`${route.request().method()} ${route.request().url()}`);
      await route.abort();
    } else await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.pageErrors.push(error.message));
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const text = await (await fetch('/components/assembly-viewer.tsx')).text();
    const match = text.match(/import \* as THREE from ["']([^"']+)["']/);
    if (!match) throw Error('Requires existing Vite/vinext dev server source-module imports');
    const T = await import(match[1]);
    window.__displayAuditThree = T;
    const originalAdd = T.Object3D.prototype.add;
    T.Object3D.prototype.add = function (...objects) {
      if (this.isScene) window.__displayAuditScene = this;
      return Reflect.apply(originalAdd, this, objects);
    };
  });
  return { context, page };
}
async function snapshot(page) {
  return page.evaluate(() => {
    const scene = window.__displayAuditScene;
    if (!scene) throw Error('No actual product scene observed');
    const materials = [];
    scene.traverse(object => {
      if (object.isMesh && object.material?.type === 'MeshStandardMaterial') materials.push({
        hex: object.material.color.getHexString(), opacity: object.material.opacity,
        transparent: object.material.transparent, depthWrite: object.material.depthWrite,
        side: object.material.side, vertexColors: object.material.vertexColors,
        map: Boolean(object.material.map), instances: object.count ?? 1,
        instanced: Boolean(object.isInstancedMesh),
        rawVertexColor: object.material.vertexColors ? Array.from(object.geometry.attributes.color.array.slice(0, 3)) : null,
      });
    });
    const canvas = document.querySelector('[data-fullscreen-regression] canvas') || document.querySelector('[data-display-audit] canvas');
    return { materials, lights: scene.children.filter(object => object.isLight).map(light => ({ type: light.type, hex: light.color.getHexString(), groundHex: light.groundColor?.getHexString(), intensity: light.intensity })), canvasCSS: { filter: getComputedStyle(canvas).filter, blend: getComputedStyle(canvas).mixBlendMode }, drawingBuffer: [canvas.width, canvas.height] };
  });
}
async function screenshot(page, name) {
  const buffer = await page.screenshot({ animations: 'disabled' });
  await save(name, buffer);
  report.artifacts.push({ path: `${out}/${name}`, sha256: sha(buffer) });
}
async function assemblyCase(label, savedJSON) {
  const { context, page } = await pageContext();
  try {
    const prepared = await page.evaluate(async ({ label, savedJSON }) => {
      const { PALETTE, toLDraw } = await import('/lib/brick-engine.ts');
      const { csv } = await import('/lib/manual.ts');
      const { purchaseInventoryCSV } = await import('/lib/purchase-inventory.ts');
      const revive = (_key, value) => value?.typedArray && Array.isArray(value.values) ? new globalThis[value.typedArray](value.values) : value;
      const width = 35;
      const model = savedJSON ? JSON.parse(savedJSON, revive) : {
        name: 'Synthetic palette swatches, NOT screenshot model', source: 'sample', resolution: 28,
        width, depth: 3, height: 3, levels: [0], supportCount: 0,
        bricks: PALETTE.map((_color, color) => ({ id: color + 1, part: '3005', x: color * 2, y: 0, z: 1, w: 1, h: 3, d: 1, color, step: 0, pose: { position: [(color * 2 + 0.5 - width / 2) * 20, -24, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] } })),
      };
      const before = JSON.stringify(model);
      const ldraw = toLDraw(model), geometry = csv(model), purchase = purchaseInventoryCSV(model.bricks);
      const ordered = model.levels.flatMap(level => model.bricks.filter(brick => model.assembly ? brick.step === level : brick.y === level));
      const exported = ldraw.split(/\r?\n/).filter(line => line.startsWith('1 '));
      if (exported.length !== model.bricks.length || ordered.length !== model.bricks.length) throw Error('Export order/count mismatch');
      const expectedCounts = {};
      for (let index = 0; index < ordered.length; index++) {
        const brick = ordered[index], color = PALETTE[brick.color];
        if (!color || Number(exported[index].split(' ')[1]) !== color.ldraw) throw Error(`LDraw palette mismatch for #${brick.id}`);
        const hex = color.hex.slice(1).toLowerCase();
        expectedCounts[hex] = (expectedCounts[hex] || 0) + 1;
      }
      const { renderFullscreenFixture } = await import('/scripts/fullscreen-viewer-fixture.tsx');
      await renderFullscreenFixture(model, false);
      window.__displayAuditModel = model;
      window.__displayAuditModelBefore = before;
      return { label, modelSerialized: before, bricks: model.bricks.length, resolution: model.resolution, expectedCounts, palette: PALETTE.map(color => ({ ...color, hex: color.hex.slice(1).toLowerCase(), opacity: color.opacity ?? 1 })), exportedLDrawColors: exported.map(line => Number(line.split(' ')[1])), geometry, purchase, ldraw };
    }, { label, savedJSON });
    await page.locator('[data-fullscreen-regression] canvas').waitFor({ timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector('[data-fullscreen-regression] .viewer-loading'), null, { timeout: 120000 });
    const actual = await snapshot(page), actualCounts = {};
    for (const material of actual.materials) {
      const color = prepared.palette.find(color => color.hex === material.hex);
      assert.ok(color, `No invented actual viewer color ${material.hex}`);
      assert.equal(material.opacity, color.opacity); assert.equal(material.transparent, color.opacity < 1);
      assert.equal(material.depthWrite, color.opacity === 1); assert.equal(material.side, 0);
      assert.equal(material.vertexColors, false); assert.equal(material.map, false);
      actualCounts[material.hex] = (actualCounts[material.hex] || 0) + material.instances;
    }
    assert.deepEqual(actualCounts, prepared.expectedCounts);
    assert.equal(await page.evaluate(() => JSON.stringify(window.__displayAuditModel) === window.__displayAuditModelBefore), true);
    const result = { label, scope: savedJSON ? 'Saved Model renderer/export replay, no packing' : 'Synthetic 17-colour display controls, NOT screenshot target', modelPath: savedJSON ? modelPath : null, inputFileSha256: savedJSON ? sha(modelBytes) : null, modelValueSha256: sha(prepared.modelSerialized), bricks: prepared.bricks, resolution: prepared.resolution, expectedCounts: prepared.expectedCounts, exportedLDrawColors: prepared.exportedLDrawColors, exportSha256: { ldraw: sha(prepared.ldraw), geometryCSV: sha(prepared.geometry), purchaseCSV: sha(prepared.purchase) }, actual };
    await screenshot(page, `display-audit-${label}-hero.png`);
    await page.getByRole('button', { name: '背面', exact: true }).click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await screenshot(page, `display-audit-${label}-back.png`);
    return result;
  } finally { await context.close(); }
}
try {
  report.palette = await assemblyCase('palette', null);
  if (modelBytes) report.savedModel = await assemblyCase('saved-model', modelBytes.toString('utf8'));
  const { context, page } = await pageContext();
  try {
    await page.evaluate(async () => {
      const source = await (await fetch('/components/assembly-viewer.tsx')).text();
      const fixture = await (await fetch('/scripts/fullscreen-viewer-fixture.tsx')).text();
      const dependency = (text, needle) => [...text.matchAll(/from ["']([^"']+)["']/g)].map(match => match[1]).find(url => url.includes(needle));
      const react = await import(dependency(source, '/react.js?')), reactDom = await import(dependency(fixture, '/react-dom_client.js?'));
      window.__displayAuditReact = react.default ?? react;
      for (const child of document.body.children) if (child instanceof HTMLElement) child.style.display = 'none';
      const mount = document.body.appendChild(document.createElement('div'));
      mount.dataset.displayAudit = 'actual-draft-viewer'; mount.style.width = '1080px'; mount.style.height = '600px';
      window.__displayAuditRoot = (reactDom.createRoot ?? reactDom.default.createRoot)(mount);
      window.__displayAuditDraft = (await import('/components/mesh-draft-viewer.tsx')).default;
      window.__displayAuditMesh = { name: 'Synthetic white source, NOT user mesh', positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 10, 10, 0, 0, 10, 10, 10, 0, 10, 10]), colors: new Uint8Array([255, 255, 255, 255, 255, 255]) };
    });
    report.draft = [];
    for (const test of [{ label: 'confirmed', confirmed: true, source: 'vision', expected: 128 / 255 }, { label: 'manual', confirmed: false, source: 'manual', expected: 128 / 255 }, { label: 'candidate', confirmed: false, source: 'vision', expected: (128 / 255) * 0.35 }]) {
      const inputs = await page.evaluate(test => {
        const region = { id: 'opacity-regression', kind: 'brazier', anchor: [0.5, 0, 0.5], placed: true, width: 4, depth: 4, height: 18, rotation: 0, placementStatus: 'candidate', confirmed: test.confirmed, source: test.source };
        window.__displayAuditRoot.render(window.__displayAuditReact.createElement(window.__displayAuditDraft, { mesh: window.__displayAuditMesh, regions: [region], resolution: 28 }));
        return { mesh: JSON.stringify(window.__displayAuditMesh, (_key, value) => ArrayBuffer.isView(value) ? { typedArray: value.constructor.name, values: Array.from(value) } : value), region };
      }, test);
      await page.waitForFunction(expected => {
        const flames = []; window.__displayAuditScene?.traverse(object => { if (object.isMesh && object.material?.color?.getHexString() === 'f08f1c') flames.push(object.material); });
        return flames.length > 0 && flames.every(material => Math.abs(material.opacity - expected) < 1e-12);
      }, test.expected, { timeout: 60000 });
      // Fixture sizing only; the actual viewer's ResizeObserver resizes WebGL.
      await page.evaluate(() => {
        const host = document.querySelector('[data-display-audit] .mesh-draft-canvas');
        host.style.width = '1080px';
        host.style.height = '600px';
      });
      await page.waitForFunction(() => document.querySelector('[data-display-audit] canvas')?.height >= 599);
      const actual = await snapshot(page), flames = actual.materials.filter(material => material.hex === 'f08f1c');
      assert.ok(flames.length > 0);
      for (const material of flames) { assert.equal(material.opacity, test.expected); assert.equal(material.transparent, true); assert.equal(material.depthWrite, false); }
      assert.equal(actual.materials.find(material => material.vertexColors).side, 2);
      report.draft.push({ ...test, inputMeshSha256: sha(inputs.mesh), regionSha256: sha(JSON.stringify(inputs.region)), actual });
      await screenshot(page, `display-audit-draft-${test.label}.png`);
    }
  } finally { await context.close(); }
  assert.deepEqual(report.forbiddenRequests, []); assert.deepEqual(report.pageErrors, []);
  report.productHashesAfter = {};
  for (const path of productFiles) report.productHashesAfter[path] = sha(await readFile(path));
  assert.deepEqual(report.productHashesAfter, report.productHashesBefore, 'Product changed during display audit; rerun only after a freeze');
  report.scriptSha256 = sha(await readFile(new URL(import.meta.url)));
  report.allAssertionsPassed = true;
  await save('display-audit.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ report: `${out}/display-audit.json`, paletteBricks: report.palette.bricks, savedModel: report.savedModel ? { path: modelPath, bricks: report.savedModel.bricks } : null, draftCases: report.draft.length, artifacts: report.artifacts, forbiddenRequests: report.forbiddenRequests, pageErrors: report.pageErrors, allAssertionsPassed: true }, null, 2));
} finally { await browser.close(); }
