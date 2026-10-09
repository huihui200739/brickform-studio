// Replay one genuine, already-generated native GLB and its learned scene cache.
// Only transports are intercepted: image decoding, color, identity validation,
// packing, CAD rendering and exports run through the actual app and workers.
import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const base = process.env.BRICKFORM_TEST_URL || 'http://127.0.0.1:3000';
const job = 'work/local-3d/jobs/9d33b59549c88e0734675966';
const out = 'outputs/model-quality-ui';
await mkdir(out, { recursive: true });
const [glb, photo, sceneText, metricsText] = await Promise.all([
  readFile(`${job}/model.glb`),
  readFile(`${job}/input.png`),
  readFile('outputs/model-quality-9d-scene-320.json', 'utf8'),
  readFile('outputs/model-quality-9d-metrics-320.json', 'utf8'),
]);
const scene = JSON.parse(sceneText),
  metrics = JSON.parse(metricsText);
assert.equal(createHash('sha256').update(glb).digest('hex'), metrics.glbSha256);
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
});
let submissions = 0,
  sceneRequests = 0,
  releaseScene;
let observedScene;
const sceneArrived = new Promise((resolve) => {
  observedScene = resolve;
});
const errors = [];
await context.route('**/api/reconstruction**', async (route) => {
  const request = route.request(),
    url = new URL(request.url());
  if (request.method() === 'POST') {
    submissions++;
    await route.fulfill({
      json: { id: 'cached-genuine-temple', ticket: 'replay-only-local-ticket' },
    });
  } else if (url.searchParams.has('download')) {
    await route.fulfill({ contentType: 'model/gltf-binary', body: glb });
  } else if (url.searchParams.has('id')) {
    await route.fulfill({
      json: { status: 'SUCCEEDED', ready: true, progress: 100 },
    });
  } else {
    await route.fulfill({
      json: {
        configured: true,
        provider: 'local',
        model: '已生成原始 GLB（同源回放，无新推理）',
      },
    });
  }
});
await context.route('**/api/scene-analysis', async (route) => {
  if (route.request().method() === 'GET') {
    await route.fulfill({ json: { configured: true, provider: 'local' } });
    return;
  }
  sceneRequests++;
  const data = route.request().postDataJSON();
  assert.deepEqual([data.width, data.height], [320, 320]);
  assert.equal(
    createHash('sha256').update(Buffer.from(data.rgba)).digest('hex'),
    metrics.rasterSha256,
    'cached identity masks must match the actual UI evidence pixels',
  );
  const gate = new Promise((resolve) => {
    releaseScene = resolve;
  });
  observedScene();
  await gate;
  await route.fulfill({ json: scene });
});
const page = await context.newPage();
page.setDefaultTimeout(45000);
page.on('pageerror', (e) => errors.push(e.message));
async function modelCount() {
  return Number(
    (await page.locator('.metric-value').first().innerText()).replace(
      /[,\s]/g,
      '',
    ),
  );
}
async function stableResult(path) {
  await page.locator('.result-preview canvas').waitFor({ timeout: 210000 });
  await page.waitForFunction(
    () => !document.querySelector('.result-preview .viewer-loading'),
  );
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path, fullPage: true });
}
async function noOverflow(label) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    label,
  );
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page
    .locator('input[type=file]')
    .setInputFiles({
      name: '神庙·同源质量验证.png',
      mimeType: 'image/png',
      buffer: photo,
    });
  await page
    .locator('.service-status')
    .filter({ hasText: '引擎已就绪' })
    .waitFor();
  assert.equal(
    await page.getByLabel('增强小型细节', { exact: true }).isChecked(),
    true,
  );
  await page.getByRole('button', { name: '生成 3D 草稿', exact: true }).click();
  await page.locator('.live-mesh canvas').waitFor({ timeout: 180000 });
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll('button')].find((b) =>
        b.textContent.includes('确认生成积木模型'),
      ).disabled,
  );
  await page.screenshot({ path: `${out}/draft-light.png`, fullPage: true });
  await page.getByLabel('增强小型细节', { exact: true }).uncheck();
  await page.getByRole('button', { name: '确认生成积木模型' }).click();
  await page
    .getByRole('region', { name: '模型细节质量' })
    .filter({ hasText: '基础转换' })
    .waitFor({ timeout: 210000 });
  assert.equal(await modelCount(), metrics.baseline.bricks);
  assert.equal(
    sceneRequests,
    0,
    'explicit basic mode must not run identity inference',
  );
  await stableResult(`${out}/baseline-28.png`);
  await noOverflow('desktop basic result');
  await page
    .getByRole('button', { name: '调整参数与草稿', exact: true })
    .click();
  await page.getByLabel('增强小型细节', { exact: true }).check();
  await page.getByRole('button', { name: '确认生成积木模型' }).click();
  await sceneArrived;
  assert.ok(
    await page.getByLabel('增强小型细节', { exact: true }).isDisabled(),
  );
  for (const button of await page.locator('.size-option').all())
    assert.ok(await button.isDisabled());
  assert.equal(
    submissions,
    1,
    'changing quality must reuse the same native draft, not create another task',
  );
  releaseScene();
  await page
    .getByRole('region', { name: '模型细节质量' })
    .filter({ hasText: '已增强 3 处细节' })
    .waitFor({ timeout: 210000 });
  const count = await modelCount();
  assert.equal(count, metrics.enhanced.bricks);
  assert.equal(
    sceneRequests,
    1,
    'identity detection must run once and must not be redone in the packing worker',
  );
  await stableResult(`${out}/enhanced-28.png`);
  await noOverflow('desktop enhanced result');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: '3D 模型 (LDraw)', exact: true }).click(),
  ]);
  await download.saveAs(`${out}/enhanced-temple-28.ldr`);
  const ldraw = await readFile(`${out}/enhanced-temple-28.ldr`, 'utf8');
  assert.equal((ldraw.match(/^1 /gm) || []).length, count);
  const expectedModel = JSON.parse(
    await readFile('outputs/model-quality-9d-enhanced-model-320.json', 'utf8'),
  );
  const componentIds = new Set(
    metrics.enhanced.applied.flatMap(
      (region) => region.representation.brickIds,
    ),
  );
  const componentParts = [
    ...new Set(
      expectedModel.bricks
        .filter((brick) => componentIds.has(brick.id))
        .map((brick) => brick.part),
    ),
  ];
  assert.ok(
    componentParts.length >= 3,
    'the committed components must have actual catalog geometry',
  );
  for (const id of componentParts)
    assert.ok(
      ldraw.includes(`${id}.dat`),
      `${id}: every actual committed component part must be exported`,
    );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await noOverflow('mobile enhanced result');
  assert.equal(
    await page.getByRole('button', { name: '重新上传', exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole('button', { name: '使用说明', exact: true }).count(),
    1,
  );
  await page.screenshot({ path: `${out}/enhanced-mobile.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    `${out}/verification.json`,
    JSON.stringify(
      {
        method:
          'genuine native GLB and actual local learned scene cache; no new inference; real application color/design workers',
        sourceJob: metrics.sourceJob,
        glbSha256: metrics.glbSha256,
        rasterSha256: metrics.rasterSha256,
        resolution: 28,
        baseline: metrics.baseline.bricks,
        enhanced: count,
        applied: metrics.enhanced.applied,
        nativeSubmissionsIntercepted: submissions,
        sceneRequestsIntercepted: sceneRequests,
        ldrawCount: count,
        pageErrors: errors,
        limitation:
          'Unverified central statue remains original mesh; no unreliable toy/person probe is used in production.',
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS genuine same-source app/worker quality comparison at resolution28: ${metrics.baseline.bricks} -> ${count}, 3 verified components, LDraw count equality, no duplicate native task, mobile accessibility`,
  );
} finally {
  await browser.close();
}
