// Real Chrome + native FullscreenAPI regression. No API overrides, synthetic
// fullscreenElement, new inference, native task or replacement server.
import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import sharp from 'sharp';

const base = process.env.BRICKFORM_TEST_URL || 'http://127.0.0.1:3000';
const modelPath = 'outputs/model-quality-9d-manual-variant2-model.json';
const out = 'outputs/fullscreen-review';
const raw = await readFile(modelPath, 'utf8');
await mkdir(out, { recursive: true });
// Use a real headed Chrome window by default. The trusted Escape event tests
// the actual product shortcut; the browser API itself is never intercepted.
const headed = process.env.FULLSCREEN_HEADLESS !== '1';
const softwareRenderer = process.env.FULLSCREEN_SOFTWARE === '1';
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: !headed,
  args: softwareRenderer
    ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
    : [],
});
const evidence = {
  method: 'Actual shared AssemblyViewer and entry-point CSS, saved real catalog model; native Chrome FullscreenAPI entered only via trusted button click; no FullscreenAPI mocking.',
  url: base,
  modelPath,
  modelSha256: createHash('sha256').update(raw).digest('hex'),
  brickCount: JSON.parse(raw).bricks.length,
  browser: await browser.version(),
  headed,
  renderer: softwareRenderer ? 'Chrome SwiftShader' : 'Chrome platform GPU',
  nativeOrPaidSubmissions: 0,
  inferenceRequests: 0,
  cases: [],
};
const near = (a, b, label, tolerance = 2) => assert.ok(Math.abs(a - b) <= tolerance, `${label}: ${a} vs ${b}`);

async function settle(page, frames = 35) {
  // OrbitControls damping needs extra frames after drag/zoom before a strict
  // round-trip pixel comparison; do not compare two still-moving cameras.
  await page.evaluate((maxFrames) => new Promise((resolve) => {
    let frames = 0;
    const draw = () => ++frames >= maxFrames ? resolve() : requestAnimationFrame(draw);
    requestAnimationFrame(draw);
  }), frames);
}
async function geometry(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-fullscreen-regression] .assembly-preview');
    const rect = (element) => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
    };
    const viewer = root.querySelector('.assembly-viewer');
    const canvas = viewer.querySelector('canvas');
    const bottom = viewer.querySelector('.assembly-view-bottom');
    return {
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      fullscreen: document.fullscreenElement === root,
      fullscreenTag: document.fullscreenElement?.className ?? null,
      root: rect(root), viewer: rect(viewer), canvas: rect(canvas), controls: rect(bottom),
      drawingBuffer: { width: canvas.width, height: canvas.height },
      background: getComputedStyle(viewer).backgroundColor,
      buttons: [...bottom.querySelectorAll('button')].map((button) => ({ label: button.getAttribute('aria-label') || button.textContent, rect: rect(button) })),
      layerExplorer: root.querySelector('.layer-explorer') ? rect(root.querySelector('.layer-explorer')) : null,
      exitButtonPressed: root.querySelector('[aria-label="退出全屏"]')?.getAttribute('aria-pressed'),
      customView: [...root.querySelectorAll('.view-presets button')].every((button) => button.getAttribute('aria-pressed') === 'false'),
    };
  });
}
function assertFullscreen(g, label) {
  assert.equal(g.fullscreen, true, `${label}: actual document.fullscreenElement`);
  near(g.root.x, 0, `${label}: root x`);
  near(g.root.y, 0, `${label}: root y`);
  near(g.root.width, g.viewport.width, `${label}: fullscreen width`);
  near(g.root.height, g.viewport.height, `${label}: fullscreen height`);
  near(g.viewer.width, g.viewport.width, `${label}: viewer width`);
  near(g.viewer.height + (g.layerExplorer?.height || 0), g.viewport.height, `${label}: no dead area below viewer`);
  near(g.canvas.width, g.viewer.width, `${label}: canvas width`);
  near(g.canvas.height, g.viewer.height, `${label}: canvas height`);
  near(g.drawingBuffer.width, g.canvas.width * g.viewport.dpr, `${label}: drawing buffer width`);
  near(g.drawingBuffer.height, g.canvas.height * g.viewport.dpr, `${label}: drawing buffer height`);
  assert.equal(g.exitButtonPressed, 'true');
  for (const button of g.buttons) {
    assert.ok(button.rect.x >= -1 && button.rect.right <= g.viewport.width + 1, `${label}: ${button.label} horizontal visibility`);
    assert.ok(button.rect.y >= -1 && button.rect.bottom <= g.viewer.bottom + 1, `${label}: ${button.label} vertical visibility`);
  }
  if (g.layerExplorer) {
    near(g.layerExplorer.bottom, g.viewport.height, `${label}: explorer at bottom`);
    assert.ok(g.viewer.height >= g.viewport.height * 0.61, `${label}: exploded viewer must still fill remaining space`);
  }
}
async function pixels(buffer) {
  return sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
}
async function blackLowerHalf(buffer) {
  const { data, info } = await pixels(buffer);
  let black = 0, count = 0;
  for (let y = Math.floor(info.height / 2); y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      if (Math.max(data[i], data[i + 1], data[i + 2]) < 20) black++;
      count++;
    }
  }
  const fraction = black / count;
  assert.ok(fraction < 0.01, `No black half-screen: black lower-half pixels ${fraction}`);
  return fraction;
}
async function diff(a, b) {
  const pa = await pixels(a), pb = await pixels(b);
  assert.deepEqual(pa.info, pb.info);
  let changed = 0, absolute = 0;
  for (let i = 0; i < pa.data.length; i += pa.info.channels) {
    const d = Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
    if (d > 18) changed++;
    absolute += d;
  }
  return { changedPixelFraction: changed / (pa.info.width * pa.info.height), meanChannelDifference: absolute / (pa.info.width * pa.info.height * 3) };
}
async function capture(page, name) {
  const screenshot = await page.screenshot({ path: `${out}/${name}.png` });
  return { screenshot, blackLowerHalf: await blackLowerHalf(screenshot), geometry: await geometry(page) };
}
async function enter(page) {
  await page.getByRole('button', { name: '全屏预览', exact: true }).click();
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('assembly-preview'));
  await page.getByRole('button', { name: '退出全屏', exact: true }).waitFor();
  await settle(page);
}
async function escape(page) {
  // Send a trusted key to the actual component; never call exitFullscreen from
  // the test or substitute a synthetic fullscreenElement.
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.fullscreenElement === null);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.fullscreenEscapeTrusted), 'true', 'Escape must be a trusted browser input event');
  await page.getByRole('button', { name: '全屏预览', exact: true }).waitFor();
  await settle(page);
}
let activePage;
try {
  for (const [name, path] of [['formal', '/'], ['new-bookmark', '/new'], ['advanced', '/advanced']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const errors = [], forbidden = [];
    await context.route('**/api/**', async (route) => {
      if (route.request().method() !== 'GET') {
        forbidden.push(`${route.request().method()} ${route.request().url()}`);
        await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(45000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape')
          document.documentElement.dataset.fullscreenEscapeTrusted = String(event.isTrusted);
      }, { capture: true });
    });
    await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
    await page.evaluate(async ({ raw, advanced }) => {
      const model = JSON.parse(raw, (_key, value) => {
        if (!value || typeof value !== 'object') return value;
        const type = value.typedArray ?? value.__typedArray ?? value.type;
        const items = value.values ?? value.data;
        const Ctor = typeof type === 'string' ? globalThis[type] : null;
        return Ctor?.BYTES_PER_ELEMENT && Array.isArray(items) ? new Ctor(items) : value;
      });
      const { renderFullscreenFixture } = await import('/scripts/fullscreen-viewer-fixture.tsx');
      await renderFullscreenFixture(model, advanced);
    }, { raw, advanced: name === 'advanced' });
    await page.locator('[data-fullscreen-regression] canvas').waitFor({ timeout: 120000 });
    await page.waitForFunction(() => !document.querySelector('[data-fullscreen-regression] .viewer-message'));
    await settle(page);
    const nativeAPIs = await page.evaluate(() => ({
      request: Element.prototype.requestFullscreen.toString(),
      exit: Document.prototype.exitFullscreen.toString(),
      elementGetter: Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement').get.toString(),
    }));
    for (const api of Object.values(nativeAPIs))
      assert.ok(api.includes('[native code]'), `${name}: FullscreenAPI must remain native`);
    const before = await geometry(page);
    await page.screenshot({ path: `${out}/${name}-normal-1440x1000.png` });
    assert.equal(before.fullscreen, false);
    await enter(page);
    const full = await capture(page, `${name}-fullscreen-1440x1000`);
    assertFullscreen(full.geometry, `${name}: desktop`);
    const item = { entry: name, path, nativeAPIs, before, desktop: full.geometry, blackLowerHalf: full.blackLowerHalf };
    evidence.cases.push(item);

    if (name === 'formal') {
      const canvas = page.locator('[data-fullscreen-regression] canvas');
      const bounds = await canvas.boundingBox();
      const initial = await canvas.screenshot();
      await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * 0.63, bounds.y + bounds.height * 0.57, { steps: 14 });
      await page.mouse.up();
      await settle(page, 100);
      const rotated = await canvas.screenshot();
      item.rotationDiff = await diff(initial, rotated);
      assert.ok(item.rotationDiff.changedPixelFraction > 0.02, 'Dragging must actually rotate the rendered model');
      assert.equal((await geometry(page)).customView, true);
      await page.getByRole('button', { name: '放大模型', exact: true }).click();
      await settle(page, 100);
      const zoomed = await canvas.screenshot();
      item.zoomDiff = await diff(rotated, zoomed);
      assert.ok(item.zoomDiff.changedPixelFraction > 0.01, 'Zoom must actually change the rendered model');
      await page.screenshot({ path: `${out}/formal-rotation-zoom-fullscreen.png` });
      await escape(page);
      const restored = await geometry(page);
      near(restored.viewer.width, before.viewer.width, 'Esc restores original width');
      near(restored.viewer.height, before.viewer.height, 'Esc restores original height');
      assert.equal(restored.customView, true, 'Esc must preserve the custom orbit');
      assert.equal(restored.fullscreen, false);
      item.escRestored = restored;
      await page.screenshot({ path: `${out}/formal-esc-restored.png` });
      await enter(page);
      const reentered = await canvas.screenshot();
      item.reentryDiff = await diff(zoomed, reentered);
      assert.ok(item.reentryDiff.changedPixelFraction < 0.015, 'Fullscreen round-trip must preserve custom orientation and relative zoom');
      await page.setViewportSize({ width: 1180, height: 620 });
      await settle(page);
      const resized = await capture(page, 'formal-fullscreen-resize-1180x620');
      assertFullscreen(resized.geometry, 'formal: live resize');
      assert.equal(resized.geometry.customView, true, 'Resize must not reset custom orbit');
      item.liveResize = resized.geometry;
      await page.getByRole('button', { name: '分层展开', exact: true }).click();
      await settle(page);
      const exploded = await capture(page, 'formal-exploded-fullscreen-1180x620');
      assertFullscreen(exploded.geometry, 'formal: exploded');
      item.exploded = exploded.geometry;
      await page.getByRole('button', { name: '下一组层', exact: true }).click();
      await page.getByRole('button', { name: '全部展开', exact: true }).click();
      await settle(page);
      const allLayers = await capture(page, 'formal-all-layers-fullscreen-1180x620');
      assertFullscreen(allLayers.geometry, 'formal: all layers');
      item.allLayers = allLayers.geometry;
      await page.getByRole('button', { name: '收起分层', exact: true }).last().click();
      await settle(page);
      assertFullscreen(await geometry(page), 'formal: collapsed');
      await escape(page);
      await page.setViewportSize({ width: 1440, height: 600 });
      await settle(page);
      const shortBefore = await geometry(page);
      await enter(page);
      const short = await capture(page, 'formal-fullscreen-short-1440x600');
      assertFullscreen(short.geometry, 'formal: short window');
      item.shortWindow = short.geometry;
      await page.getByRole('button', { name: '退出全屏', exact: true }).click();
      await page.waitForFunction(() => !document.fullscreenElement);
      await settle(page);
      const buttonExit = await geometry(page);
      near(buttonExit.viewer.height, shortBefore.viewer.height, 'Exit button restores short normal height');
      assert.equal(buttonExit.fullscreen, false);
      item.buttonExit = buttonExit;
    } else {
      await page.getByRole('button', { name: '分层展开', exact: true }).click();
      await settle(page);
      const expanded = await capture(page, `${name}-exploded-fullscreen`);
      assertFullscreen(expanded.geometry, `${name}: expanded`);
      item.exploded = expanded.geometry;
      await escape(page);
      assert.equal((await geometry(page)).fullscreen, false);
    }
    assert.deepEqual(errors, [], `${name}: page errors`);
    assert.deepEqual(forbidden, [], `${name}: no POST/inference/submission`);
    item.pageErrors = errors;
    item.forbiddenRequests = forbidden;
    await context.close();
  }
  evidence.status = 'PASS';
  console.log('PASS real Chrome native FullscreenAPI: formal/new/advanced, 1440x1000, rotation+zoom, native Esc, exit button, live resize, 1440x600, expanded/all layers, no black half-screen, zero new submissions.');
} catch (error) {
  evidence.status = 'FAIL';
  evidence.failure = error.stack || String(error);
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: `${out}/failure-state.png` }).catch(() => {});
    evidence.failureDOM = await activePage.evaluate(() => ({
      url: location.href,
      visibility: document.visibilityState,
      fullscreen: document.fullscreenElement?.className ?? null,
      fixture: !!document.querySelector('[data-fullscreen-regression]'),
      buttonLabels: [...document.querySelectorAll('[data-fullscreen-regression] button')].map((b) => ({ label: b.getAttribute('aria-label') || b.textContent, pressed: b.getAttribute('aria-pressed') })),
      bodyText: document.body.innerText.slice(0, 600),
    })).catch(() => null);
  }
  throw error;
} finally {
  await writeFile(`${out}/verification.json`, JSON.stringify(evidence, null, 2));
  await browser.close();
}
