import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = process.env.BRICKFORM_TEST_URL || 'http://127.0.0.1:3000';
const out = 'outputs/ui-verification';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const log = (message) => console.log(message);
async function noOverflow(label) {
  const sizes = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  assert.ok(
    sizes.document <= sizes.viewport + 1,
    `${label} overflows ${JSON.stringify(sizes)}`,
  );
}
async function uploadDuck() {
  await page
    .locator('input[type=file]')
    .setInputFiles('public/reference-duck.png');
  await page.locator('.workspace-page').waitFor();
  await page
    .locator('.service-status')
    .filter({ hasText: '引擎已就绪' })
    .waitFor();
}
try {
  await page.goto(base, { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.home-page').count(), 1);
  assert.equal(await page.locator('.feature-card').count(), 4);
  await noOverflow('desktop home');
  await page.screenshot({ path: `${out}/home-desktop.png`, fullPage: true });
  log('PASS formal homepage and four feature cards');
  // Real rejected file and corrupt image decode (not API mocks).
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('bad'),
  });
  await page
    .getByRole('alert')
    .filter({ hasText: '不支持其他文件类型' })
    .waitFor();
  await page.locator('input[type=file]').setInputFiles({
    name: 'bad.png',
    mimeType: 'image/png',
    buffer: Buffer.from('not a png'),
  });
  await page.getByRole('alert').filter({ hasText: '无法解码' }).waitFor();
  log('PASS invalid type and corrupt image handling');
  await uploadDuck();
  await page.getByLabel('生成方式', { exact: true }).selectOption('image');
  await page.locator('.size-option').filter({ hasText: '小' }).click();
  await page.getByRole('button', { name: '生成轮廓草稿', exact: true }).click();
  const confirm = page.getByRole('button', { name: '确认生成积木模型' });
  await confirm.waitFor();
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll('button')].find((b) =>
        b.textContent.includes('确认生成积木模型'),
      );
      return button && !button.disabled;
    },
    null,
    { timeout: 120000 },
  );
  await page.locator('.viewer canvas').waitFor();
  await page.screenshot({ path: `${out}/draft-desktop.png`, fullPage: true });
  await confirm.click();
  await page.locator('.success-badge').waitFor();
  await page.locator('.result-preview canvas').waitFor();
  const count = Number(
    (await page.locator('.metric-value').first().innerText()).replaceAll(
      ',',
      '',
    ),
  );
  assert.ok(
    count > 0 && count !== 462,
    'count must come from actual model, not old static result',
  );
  log(`PASS real image worker -> preview -> result (${count} pieces)`);
  for (const [name, file] of [
    ['拼装说明书 (HTML)', 'guide.html'],
    ['零件清单 (CSV)', 'purchase.csv'],
    ['3D 模型 (LDraw)', 'model.ldr'],
    ['三维子件清单 (CSV)', 'geometry.csv'],
  ]) {
    const event = page.waitForEvent('download');
    await page.getByRole('button', { name, exact: true }).click();
    const download = await event;
    assert.equal(await download.failure(), null);
    await download.saveAs(`${out}/${file}`);
    const content = await readFile(`${out}/${file}`, 'utf8');
    assert.ok(content.length > 100, `${file} is empty`);
  }
  const ldraw = await readFile(`${out}/model.ldr`, 'utf8');
  assert.equal(
    ldraw.split('\n').filter((line) => /^1 /.test(line)).length,
    count,
  );
  assert.match(await readFile(`${out}/guide.html`, 'utf8'), /<!doctype html>/i);
  assert.match(await readFile(`${out}/purchase.csv`, 'utf8'), /BrickLink/);
  await page.screenshot({ path: `${out}/result-desktop.png`, fullPage: true });
  log('PASS four genuine downloads; LDraw quantity matches displayed model');
  await page.getByRole('button', { name: '拼装步骤', exact: true }).click();
  await page.locator('.build-guide').waitFor();
  await page.getByRole('button', { name: '下一组', exact: true }).click();
  await page.locator('.guide-eyebrow').filter({ hasText: '第 2 /' }).waitFor();
  log('PASS actual build guide navigation');
  await page.getByRole('button', { name: '调整参数与草稿' }).click();
  await page.locator('.size-option').filter({ hasText: '中' }).click();
  assert.equal(
    await confirm.isDisabled(),
    true,
    'changing image precision must invalidate draft',
  );
  await page.getByRole('button', { name: '重新上传', exact: true }).click();
  await uploadDuck();
  log('PASS parameter invalidation and repeated same-file upload');
  // AI mode is deliberately enabled only for the opt-in native inference run.
  if (process.env.BRICKFORM_TEST_NATIVE === '1') {
    assert.equal(
      await page.getByLabel('生成方式', { exact: true }).inputValue(),
      'mesh',
    );
    await page.locator('.size-option').filter({ hasText: '小' }).click();
    const submitted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/reconstruction' &&
        response.request().method() === 'POST',
    );
    await page
      .getByRole('button', { name: '生成 3D 草稿', exact: true })
      .click();
    const { id, ticket } = await (await submitted).json();
    assert.match(id, /^[0-9a-f]{24}$/);
    log(`Native task created: ${id}`);
    log(
      'RUNNING real native AI image reconstruction (no response interception)',
    );
    await page.waitForFunction(
      () =>
        document.querySelector('.live-mesh canvas') ||
        document.querySelector('.workspace-message.error'),
      null,
      { timeout: 900000 },
    );
    const nativeError = await page.locator('.workspace-message.error').count();
    if (nativeError)
      throw Error(
        'Native reconstruction: ' +
          (await page.locator('.workspace-message.error').innerText()),
      );
    await page.locator('.live-mesh canvas').waitFor();
    const rawDownload = await page.request.get(
      `${base}/api/reconstruction?id=${encodeURIComponent(id)}&ticket=${encodeURIComponent(ticket)}&download=1`,
    );
    assert.equal(rawDownload.status(), 200);
    await writeFile(`${out}/native-model.glb`, await rawDownload.body());
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${out}/native-draft.png`, fullPage: true });
    await confirm.click();
    await page.waitForFunction(
      () =>
        document.querySelector('.success-badge') ||
        document.querySelector('.workspace-message.error'),
      null,
      { timeout: 180000 },
    );
    if (await page.locator('.workspace-message.error').count())
      throw Error(await page.locator('.workspace-message.error').innerText());
    await page.locator('.success-badge').waitFor();
    await page.screenshot({ path: `${out}/native-result.png`, fullPage: true });
    log(
      'PASS native POST -> status -> GLB -> colors -> confirmed mesh packing',
    );
  }
  await page.goto(base + '/new', { waitUntil: 'networkidle' });
  assert.equal(await page.locator('.home-page').count(), 1);
  log('PASS historical /new address shares formal application');
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow('mobile home');
  await page.screenshot({ path: `${out}/home-mobile.png`, fullPage: true });
  await page.getByRole('button', { name: /咖啡杯/ }).click();
  await page.locator('.workspace-page').waitFor();
  await page.getByLabel('生成方式', { exact: true }).selectOption('image');
  await noOverflow('mobile workspace');
  await page.screenshot({
    path: `${out}/workspace-mobile.png`,
    fullPage: true,
  });
  log(
    'PASS synthetic sample, mobile home/workspace without horizontal overflow',
  );
  await page.goto(base + '/advanced', { waitUntil: 'networkidle' });
  await page.locator('.studio').waitFor();
  await page.locator('.brand').click();
  await page.locator('.home-page').waitFor();
  const height = await page
    .locator('.upload-zone')
    .evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(height > 200, `legacy styles leaked: upload card height ${height}`);
  await noOverflow('return from advanced');
  log('PASS preserved advanced workbench and new-theme navigation');
  assert.deepEqual(errors, [], 'browser runtime errors');
  await writeFile(
    `${out}/browser-result.json`,
    JSON.stringify(
      {
        passed: true,
        native: process.env.BRICKFORM_TEST_NATIVE === '1',
        imagePieces: count,
        browserErrors: errors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
