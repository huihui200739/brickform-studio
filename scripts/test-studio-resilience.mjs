// Fault-injection UI tests. Only the transport is controlled; image decoding,
// color workers and state transitions run in the actual browser application.
import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
const glb = await readFile(
  process.argv[2] || 'work/local-3d/jobs/c2f96a0caa7021080d0ce506/model.glb',
);
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  let mode = 'status-failed';
  let posts = 0;
  let releasePost;
  let polled = 0;
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/reconstruction*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      posts++;
      if (mode === 'lost-post') return route.abort('failed');
      await new Promise((resolve) => {
        releasePost = resolve;
      });
      return route.fulfill({
        status: 202,
        json: { id: 'ui-resume-check', ticket: 'opaque-test-token' },
      });
    }
    if (!url.searchParams.has('id')) {
      if (mode === 'status-failed')
        return route.fulfill({ status: 503, json: { error: '模拟临时故障' } });
      return route.fulfill({
        json: { configured: true, provider: 'local', model: '故障注入测试' },
      });
    }
    if (url.searchParams.get('download') === '1')
      return route.fulfill({ contentType: 'model/gltf-binary', body: glb });
    polled++;
    if (mode === 'terminal')
      return route.fulfill({
        json: { status: 'FAILED', error: '模拟任务失败' },
      });
    return route.fulfill({
      json: {
        status: mode === 'ready' ? 'SUCCEEDED' : 'RUNNING',
        ready: mode === 'ready',
        progress: mode === 'ready' ? 100 : 30,
      },
    });
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page
    .locator('input[type=file]')
    .setInputFiles('public/reference-duck.png');
  await page
    .locator('.service-status')
    .filter({ hasText: '模拟临时故障' })
    .waitFor();
  mode = 'pending';
  await page.getByRole('button', { name: '重新检查服务' }).click();
  await page
    .locator('.service-status')
    .filter({ hasText: '引擎已就绪' })
    .waitFor();
  await page.getByLabel('生成方式', { exact: true }).selectOption('mesh');
  const create = page.getByRole('button', {
    name: '生成 3D 草稿',
    exact: true,
  });
  await create.click();
  await page.getByRole('button', { name: '提交中，请稍候' }).waitFor();
  assert.ok(
    await page.getByRole('button', { name: '提交中，请稍候' }).isDisabled(),
  );
  assert.ok(
    await page
      .getByRole('button', { name: '重新上传', exact: true })
      .isDisabled(),
  );
  assert.equal(posts, 1);
  releasePost();
  await page.getByRole('progressbar', { name: '重建进度' }).waitFor();
  await page.getByRole('button', { name: '暂停查看', exact: true }).click();
  await page.getByText('已暂停查看。', { exact: false }).waitFor();
  const before = polled;
  mode = 'ready';
  await page.getByRole('button', { name: '继续查看任务', exact: true }).click();
  await page.locator('.live-mesh canvas').waitFor({ timeout: 180000 });
  assert.equal(posts, 1, 'resume must not submit another reconstruction');
  assert.ok(polled > before);
  console.log(
    'PASS service retry, guarded pending POST, pause/resume preserves one task',
  );
  await page.getByRole('button', { name: '重新上传', exact: true }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles('public/reference-duck.png');
  await page
    .locator('.service-status')
    .filter({ hasText: '引擎已就绪' })
    .waitFor();
  mode = 'lost-post';
  await create.click();
  await page.getByRole('alert').filter({ hasText: '提交结果未知' }).waitFor();
  assert.ok(
    await create.isDisabled(),
    'uncertain submission must not be silently retried',
  );
  assert.equal(posts, 2);
  await page.getByLabel('生成方式', { exact: true }).selectOption('image');
  assert.equal(
    await page
      .getByRole('button', { name: '生成轮廓草稿', exact: true })
      .isDisabled(),
    false,
  );
  console.log(
    'PASS uncertain submission blocks repetition and allows non-submitting local fallback',
  );
  // The preserved workbench must lock parent parameters during its own task,
  // then unlock after a terminal failure; no native inference is submitted.
  mode = 'pending';
  await page.goto(base + '/advanced', { waitUntil: 'networkidle' });
  const legacyUpload = page.getByLabel('上传参考图片', { exact: true });
  await legacyUpload.setInputFiles('public/reference-duck.png');
  const legacyCreate = page.getByRole('button', {
    name: '在本机生成积木模型',
    exact: true,
  });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find(
      (b) => b.textContent.trim() === '在本机生成积木模型',
    );
    return button && !button.disabled;
  });
  await legacyCreate.click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="上传参考图片"]').disabled,
  );
  assert.ok(await legacyUpload.isDisabled());
  assert.equal(await page.locator('.detail-options [role="radio"]').count(), 3);
  for (const radio of await page
    .locator('.detail-options [role="radio"]')
    .all())
    assert.ok(
      await radio.isDisabled(),
      'legacy precision must be locked by child busy state',
    );
  mode = 'terminal';
  releasePost();
  await page.getByRole('alert').filter({ hasText: '模拟任务失败' }).waitFor();
  await page.waitForFunction(
    () => !document.querySelector('input[aria-label="上传参考图片"]').disabled,
  );
  assert.equal(await legacyCreate.isDisabled(), false);
  assert.equal(posts, 3);
  console.log(
    'PASS advanced child task locks parent precision/upload and releases locks after failure',
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
