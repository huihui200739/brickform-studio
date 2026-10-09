// Same-source colour integration regression against the existing :3000 app.
// Only reconstruction/scene HTTP transports replay caches. Workers, Canvas,
// readGLB, packing, CAD, UI, procurement and actual downloads are NOT stubbed.
// Run: node --experimental-strip-types scripts/test-studio-colour-browser.mjs
import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  PALETTE,
  CATALOG,
  inventory,
  toLDraw,
  validateModel,
} from '../lib/brick-engine.ts';
import { csv } from '../lib/manual.ts';
import {
  procurementReport,
  purchaseInventoryCSV,
} from '../lib/purchase-inventory.ts';
import { choosePartColor } from '../lib/part-color-policy.ts';
import { ASSEMBLY_PARTS } from '../lib/assembly-catalog.ts';
import { materializeStatueBody } from '../lib/component-materials.ts';
import { colorDesignSummary } from '../lib/color-design-summary.ts';

const base = process.env.BRICKFORM_TEST_URL || 'http://127.0.0.1:3000';
const job = 'work/local-3d/jobs/9d33b59549c88e0734675966';
const out =
  process.env.BRICKFORM_COLOR_REVIEW_OUT || 'outputs/color-coherent-browser';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function waitGate(gate, label, timeout = 45000) {
  let timer;
  try {
    await Promise.race([
      gate.promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Error(`Timed out waiting for ${label}`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const [glb, photo, sceneText, metricsText] = await Promise.all([
  readFile(`${job}/model.glb`),
  readFile(`${job}/input.png`),
  readFile('outputs/model-quality-9d-scene-320.json', 'utf8'),
  readFile('outputs/model-quality-9d-metrics-320.json', 'utf8'),
]);
const scene = JSON.parse(sceneText),
  metrics = JSON.parse(metricsText);
assert.equal(sha(glb), metrics.glbSha256, 'genuine cached GLB SHA');
assert.deepEqual(metrics.rasterSize, [320, 320]);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1050 },
  acceptDownloads: true,
  serviceWorkers: 'block',
});
const page = await context.newPage();
page.setDefaultTimeout(45000);
const pageErrors = [],
  routeErrors = [],
  artifacts = [],
  observations = [];
const transport = {
  nativeMockPosts: 0,
  nativeStatusGets: 0,
  nativeDownloadGets: 0,
  sceneFixturePosts: 0,
  sceneReadinessGets: 0,
  sceneRasterHashes: [],
  canceledSceneRequestFailures: [],
  canceledLateFixtureFulfilledByTransport: false,
  actualNativeSubmissions: 0,
  actualNativeInference: 0,
  actualSceneInference: 0,
};
const nativeArrived = deferred(),
  nativeRelease = deferred();
const cancelSceneArrived = deferred(),
  cancelSceneRelease = deferred();
const cancelSceneRouteSettled = deferred();
let holdNextScene = false,
  heldSceneRequest;
page.on('pageerror', (error) => pageErrors.push(error.message));
context.on('requestfailed', (request) => {
  if (request === heldSceneRequest)
    transport.canceledSceneRequestFailures.push(request.failure()?.errorText);
});

// Construct genuine native Workers and pass all native messages/results through
// unchanged. This observer attaches before the app's onmessage and only copies
// evidence; it never dispatches a fake message or substitutes a worker result.
await context.addInitScript(() => {
  const NativeWorker = window.Worker;
  // Native methods are deliberately stored and later called with Reflect.apply
  // and the original Worker receiver, never as unbound function calls.
  const nativePostMessage = Object.getOwnPropertyDescriptor(
    NativeWorker.prototype,
    'postMessage',
  ).value;
  const nativeTerminate = Object.getOwnPropertyDescriptor(
    NativeWorker.prototype,
    'terminate',
  ).value;
  const records = [],
    byWorker = new WeakMap();
  const digest = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  const encoded = (value) =>
    new TextEncoder().encode(
      JSON.stringify(value, (_key, item) =>
        ArrayBuffer.isView(item)
          ? { type: item.constructor.name, values: Array.from(item) }
          : item,
      ),
    );
  const meshSummary = async (mesh) =>
    mesh
      ? {
          meshSha256: await digest(encoded(mesh)),
          positionsSha256: await digest(mesh.positions),
          colorsSha256: await digest(mesh.colors),
          sourceObservationsSha256: mesh.sourceObservations
            ? await digest(encoded(mesh.sourceObservations))
            : null,
          materialEvidenceSha256: mesh.materialEvidence
            ? await digest(encoded(mesh.materialEvidence))
            : null,
          positionValues: mesh.positions.length,
          colorValues: mesh.colors.length,
        }
      : null;
  NativeWorker.prototype.postMessage = function (payload, ...rest) {
    const record = byWorker.get(this);
    if (record) {
      record.action = payload.action;
      record.input = {
        options: structuredClone(payload.options),
        detailEnhancement: payload.detailEnhancement,
        autoSemanticRefinement: payload.autoSemanticRefinement,
        regionIds: (payload.regions || []).map((region) => region.id),
      };
      record.inputEvidence = Promise.all([
        meshSummary(payload.mesh),
        payload.raster ? digest(payload.raster.data) : null,
      ]).then(([mesh, rasterSha256]) => ({
        mesh,
        rasterSha256,
        rasterSize: payload.raster
          ? [payload.raster.width, payload.raster.height]
          : null,
      }));
    }
    return Reflect.apply(nativePostMessage, this, [payload, ...rest]);
  };
  NativeWorker.prototype.terminate = function (...args) {
    const record = byWorker.get(this);
    if (record) record.terminated = true;
    return Reflect.apply(nativeTerminate, this, args);
  };
  window.Worker = new Proxy(NativeWorker, {
    construct(target, args) {
      const worker = Reflect.construct(target, args);
      const record = {
        id: records.length,
        url: String(args[0]),
        terminated: false,
        messages: 0,
      };
      records.push(record);
      byWorker.set(worker, record);
      worker.addEventListener('message', (event) => {
        record.messages++;
        record.response = structuredClone(event.data);
        record.outputMesh = meshSummary(event.data.mesh);
      });
      worker.addEventListener('error', (event) => {
        record.error = event.message;
      });
      return worker;
    },
  });
  window.__studioColourObservation = async () =>
    Promise.all(
      records.map(async (record) => ({
        id: record.id,
        action: record.action,
        url: record.url,
        terminated: record.terminated,
        messages: record.messages,
        input: record.input,
        evidence: await record.inputEvidence,
        outputMesh: await record.outputMesh,
        error: record.error,
        response: record.response
          ? JSON.parse(
              JSON.stringify(
                record.action === 'color'
                  ? {
                      meshObserved: Boolean(record.response.mesh),
                      error: record.response.error,
                    }
                  : record.response,
              ),
            )
          : null,
      })),
    );
});

async function routeFailure(route, error) {
  routeErrors.push(error.stack || String(error));
  await route.fulfill({
    status: 500,
    json: { error: `Regression transport failed: ${error.message}` },
  });
}
await context.route('**/api/reconstruction**', async (route) => {
  try {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === 'POST') {
      transport.nativeMockPosts++;
      nativeArrived.resolve();
      await nativeRelease.promise;
      return await route.fulfill({
        json: {
          id: 'colour-cached-genuine-9d',
          ticket: 'replay-only-local-ticket',
        },
      });
    }
    assert.equal(request.method(), 'GET');
    if (url.searchParams.has('download')) {
      transport.nativeDownloadGets++;
      return await route.fulfill({
        contentType: 'model/gltf-binary',
        body: glb,
      });
    }
    transport.nativeStatusGets++;
    return await route.fulfill({
      json: url.searchParams.has('id')
        ? { status: 'SUCCEEDED', ready: true, progress: 100 }
        : {
            configured: true,
            provider: 'local',
            model: '同源已生成 GLB 缓存回放 · 不执行新推理',
          },
    });
  } catch (error) {
    await routeFailure(route, error);
  }
});
await context.route('**/api/scene-analysis**', async (route) => {
  try {
    const request = route.request();
    if (request.method() === 'GET') {
      transport.sceneReadinessGets++;
      return await route.fulfill({
        json: { configured: true, provider: 'local' },
      });
    }
    assert.equal(request.method(), 'POST');
    transport.sceneFixturePosts++;
    const data = request.postDataJSON(),
      rasterSha256 = sha(Buffer.from(data.rgba));
    assert.deepEqual([data.width, data.height], [320, 320]);
    assert.equal(
      rasterSha256,
      metrics.rasterSha256,
      'scene cache must match actual Canvas320 input',
    );
    transport.sceneRasterHashes.push(rasterSha256);
    if (holdNextScene) {
      holdNextScene = false;
      heldSceneRequest = request;
      cancelSceneArrived.resolve();
      await cancelSceneRelease.promise;
      try {
        await route.fulfill({ json: scene });
        transport.canceledLateFixtureFulfilledByTransport = true;
      } catch (error) {
        // Aborted fetches can reject a late fulfill. Only this specifically
        // canceled request may do so; all other route exceptions fail the test.
        const failure = request.failure()?.errorText;
        if (!failure?.includes('ERR_ABORTED')) throw error;
        transport.canceledLateFixtureDeliveryError = error.message;
      } finally {
        cancelSceneRouteSettled.resolve();
      }
      return;
    }
    await route.fulfill({ json: scene });
  } catch (error) {
    cancelSceneRouteSettled.resolve();
    await routeFailure(route, error);
  }
});

async function observedWorkers() {
  return await page.evaluate(() => window.__studioColourObservation());
}
async function flushRender() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function noOverflow(label) {
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    label,
  );
}
async function screenshot(name, locator) {
  const path = `${out}/${name}.png`;
  if (locator) await locator.screenshot({ path });
  else {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path, fullPage: true });
  }
  artifacts.push(path);
}
function parseCSV(text) {
  const rows = [],
    row = [];
  let field = '',
    quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (char === ',' || char === '\n')) {
      row.push(field.replace(/\r$/, ''));
      field = '';
      if (char === '\n') {
        rows.push([...row]);
        row.length = 0;
      }
    } else field += char;
  }
  assert.equal(quoted, false, 'CSV quotes must close');
  if (field || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  const headers = rows.shift();
  return rows.map((values) => {
    assert.equal(values.length, headers.length, 'CSV row width');
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index]]),
    );
  });
}
async function downloadFile(buttonName, path) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: buttonName, exact: true }).click(),
  ]);
  assert.equal(await download.failure(), null);
  await download.saveAs(path);
  artifacts.push(path);
  return await readFile(path, 'utf8');
}
async function verifyExports(model, label) {
  const report = procurementReport(model);
  assert.equal(report.sourceBrickCount, model.bricks.length);
  const purchaseText = await downloadFile(
    '零件清单 (CSV)',
    `${out}/${label}-purchase.csv`,
  );
  const geometryText = await downloadFile(
    '三维子件清单 (CSV)',
    `${out}/${label}-geometry.csv`,
  );
  const ldrawText = await downloadFile(
    '3D 模型 (LDraw)',
    `${out}/${label}.ldr`,
  );
  assert.equal(
    purchaseText,
    purchaseInventoryCSV(model.bricks),
    'actual purchase download == live module output',
  );
  assert.equal(
    geometryText,
    csv(model),
    'actual geometry download == live module output',
  );
  assert.equal(
    ldrawText,
    toLDraw(model),
    'actual LDraw download == live module output',
  );
  const purchase = parseCSV(purchaseText),
    geometry = parseCSV(geometryText);
  assert.equal(
    purchase.reduce((n, row) => n + Number(row['采购数量']), 0),
    report.purchaseQuantity,
  );
  assert.equal(
    geometry.reduce((n, row) => n + Number(row['数量']), 0),
    model.bricks.length,
  );
  const expectedInventory = inventory(model.bricks).map((line) => [
    line.part,
    PALETTE[line.color].lego,
    line.quantity,
  ]);
  assert.deepEqual(
    geometry.map((row) => [
      row['LDraw编号'],
      Number(row['乐高颜色编号']),
      Number(row['数量']),
    ]),
    expectedInventory,
  );
  const sourceIds = purchase.flatMap((row) =>
    row['来源零件序号'].split(' / ').map(Number),
  );
  assert.equal(
    new Set(sourceIds).size,
    sourceIds.length,
    'purchase traces each geometric subpart exactly once',
  );
  assert.deepEqual(
    sourceIds.sort((a, b) => a - b),
    model.bricks.map((brick) => brick.id).sort((a, b) => a - b),
  );
  purchase.forEach((row, index) => {
    const line = report.lines[index];
    assert.equal(Number(row['采购数量']), line.quantity);
    assert.equal(Number(row['LEGO颜色编号']), PALETTE[line.color].lego);
    assert.equal(row['核对状态'], line.status);
    assert.equal(row['LDraw编号'], line.ldrawParts.join(' / '));
  });
  const actualLines = ldrawText
    .split(/\r?\n/)
    .filter((line) => line.startsWith('1 '));
  const orderedBricks = model.levels.flatMap((level) =>
    model.bricks.filter((brick) =>
      model.assembly ? brick.step === level : brick.y === level,
    ),
  );
  assert.equal(actualLines.length, model.bricks.length);
  assert.equal(orderedBricks.length, model.bricks.length);
  actualLines.forEach((line, index) => {
    const fields = line.trim().split(/\s+/),
      brick = orderedBricks[index];
    assert.equal(fields.length, 15, 'LDraw type1 field count');
    assert.equal(
      Number(fields[1]),
      PALETTE[brick.color].ldraw,
      `#${brick.id} exported colour`,
    );
    assert.equal(fields[14], `${brick.part}.dat`, `#${brick.id} exported part`);
    let position = brick.pose?.position,
      matrix = brick.pose?.matrix;
    if (!brick.pose) {
      const part = CATALOG.find((entry) => entry.id === brick.part);
      assert.ok(part);
      position = [
        (brick.x + brick.w / 2 - model.width / 2) * 20,
        -(brick.y + brick.h) * 8,
        (brick.z + brick.d / 2 - model.depth / 2) * 20,
      ];
      matrix =
        part.w !== part.d && brick.w !== part.w
          ? [0, 0, -1, 0, 1, 0, 1, 0, 0]
          : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    assert.deepEqual(
      fields.slice(2, 5).map(Number),
      position,
      `#${brick.id} exported position`,
    );
    assert.deepEqual(
      fields.slice(5, 14).map(Number),
      matrix,
      `#${brick.id} exported matrix`,
    );
  });
  const purchaseInfo = page
    .locator('.info-item')
    .filter({ hasText: '采购数量' });
  assert.equal(
    (await purchaseInfo.locator('span').last().innerText()).replace(/\s/g, ''),
    `${report.purchaseQuantity}件`,
  );
  const tableRows = page
    .getByRole('region', { name: '零件采购表' })
    .locator('tbody tr');
  assert.equal(await tableRows.count(), report.lines.length);
  for (let index = 0; index < report.lines.length; index++) {
    const cells = await tableRows.nth(index).locator('td').allTextContents(),
      line = report.lines[index];
    assert.equal(cells[0], line.name);
    assert.equal(cells[2], PALETTE[line.color].name);
    assert.equal(Number(cells[3]), line.quantity);
  }
  return {
    geometryQuantity: model.bricks.length,
    purchaseQuantity: report.purchaseQuantity,
    assembledQuantity: report.assembledQuantity,
    purchaseLines: purchase.length,
    geometryLines: geometry.length,
    ldrawLines: actualLines.length,
    catalogConfirmed: report.catalogConfirmed,
    unverified: report.unverified,
    unsupportedColors: report.unsupportedColors,
    sha256: {
      purchase: sha(purchaseText),
      geometry: sha(geometryText),
      ldraw: sha(ldrawText),
    },
  };
}
async function result(label, mode, detailEnhancement) {
  await page.locator('.result-preview canvas').waitFor({ timeout: 210000 });
  await page.waitForFunction(
    () => !document.querySelector('.result-preview .viewer-loading'),
    null,
    { timeout: 210000 },
  );
  assert.equal(
    await page.getByRole('alert').count(),
    0,
    'no application/renderer errors',
  );
  const workers = await observedWorkers();
  const designWorkers = workers.filter(
    (worker) => worker.action === 'workspace-design',
  );
  const record = designWorkers.at(-1);
  assert.ok(
    record?.response?.design?.model,
    'capture a real completed design-worker Model',
  );
  assert.equal(record.messages, 1);
  assert.equal(record.input.options.colorMode, mode);
  assert.equal(record.input.options.resolution, 28);
  assert.equal(record.input.detailEnhancement, detailEnhancement);
  assert.equal(
    record.input.autoSemanticRefinement,
    false,
    'worker must not start a second scene inference',
  );
  assert.equal(record.evidence.rasterSha256, metrics.rasterSha256);
  assert.deepEqual(record.evidence.rasterSize, [320, 320]);
  assert.ok(
    record.evidence.mesh.sourceObservationsSha256,
    'real source correspondence ledger survived colour worker',
  );
  const design = record.response.design,
    model = design.model;
  assert.equal(model.resolution, 28);
  assert.ok(model.bricks.length > 0);
  const validation = validateModel(model);
  assert.equal(validation.collisions, 0);
  assert.equal(validation.unsupported, 0);
  assert.equal(validation.invalidParts, 0);
  assert.equal(validation.connected, true);
  const displayedCount = Number(
    (await page.locator('.metric-value').first().innerText()).replace(
      /[,\s]/g,
      '',
    ),
  );
  assert.equal(
    displayedCount,
    model.bricks.length,
    'UI count comes from actual Model',
  );
  const colorQuality = page.getByRole('region', {
    name: '积木配色质量',
    exact: true,
  });
  if (mode === 'coherent' || mode === 'clean') {
    assert.ok(model.colorDesign);
    const metadata = model.colorDesign;
    assert.equal(metadata.mode, mode);
    assert.equal(metadata.approximation, true);
    assert.ok(
      Number.isSafeInteger(metadata.changedBricks) &&
        metadata.changedBricks >= 0,
    );
    assert.ok(
      Number.isSafeInteger(metadata.catalogBlocked) &&
        metadata.catalogBlocked >= 0,
    );
    const text = await colorQuality.innerText();
    const summary = colorDesignSummary(metadata);
    const headline = summary.heading;
    assert.equal(
      await colorQuality.locator('.quality-heading strong').innerText(),
      headline,
      'actual-mode headline and actual-model count',
    );
    assert.match(text, /设计配色近似/);
    assert.match(text, /不是材质复原/);
    if (mode === 'coherent') {
      assert.match(text, /可能与真实暖色饰带不同/);
      if (metadata.materialMetrics) {
        assert.ok(text.includes(`源标量阴影整理 ${metadata.materialMetrics.scalarDesignBricks} 块`));
        assert.ok(text.includes(`人工局部材料近似 ${metadata.materialMetrics.localApproximationBricks} 块`));
      }
      const uncertainty = colorQuality.locator('[data-colour-uncertainty]');
      if ((metadata.uncertainBricks ?? 0) > 0) {
        assert.equal(await uncertainty.count(), 1);
        assert.ok((await uncertainty.innerText()).includes(`${metadata.uncertainBricks} 块`));
        assert.match(await uncertainty.innerText(), /并非所有阴影与杂色都已解决/);
      } else assert.equal(await uncertainty.count(), 0);
    }
    if (metadata.catalogBlocked > 0)
      assert.ok(
        text.includes(`${metadata.catalogBlocked} 块因目录颜色限制保留原色`),
      );
    else assert.ok(!text.includes('块因目录颜色限制保留原色'));
  } else {
    assert.equal(
      model.colorDesign,
      undefined,
      'faithful preserves the original mapping without design-colour metadata',
    );
    assert.equal(await colorQuality.count(), 0);
  }
  const qualityText = await page
    .getByRole('region', { name: '模型细节质量', exact: true })
    .innerText();
  assert.equal(design.quality.status, detailEnhancement ? 'enhanced' : 'basic');
  assert.ok(
    qualityText.includes(
      detailEnhancement ? `已增强 ${design.applied.length} 处细节` : '基础转换',
    ),
  );
  if (detailEnhancement)
    assert.ok(
      design.applied.length > 0,
      'cached genuine scene yields actual committed components',
    );
  await noOverflow(`${label}: desktop horizontal overflow`);
  await screenshot(`${label}-result`);
  const exports = await verifyExports(model, label);
  observations.push({
    label,
    mode,
    detailEnhancement,
    record,
    design,
    exports,
  });
  console.log(
    `PASS ${label}: ${model.bricks.length} actual bricks; ${model.colorDesign?.changedBricks ?? 0} reported ${mode} changes; real CSV/CSV/LDraw downloads`,
  );
  return observations.at(-1);
}
async function revise(mode, detailEnhancement) {
  const posts = transport.nativeMockPosts;
  await page
    .getByRole('button', { name: '调整参数与草稿', exact: true })
    .click();
  await page.locator('.live-mesh canvas').waitFor({ timeout: 210000 });
  assert.equal(
    await page
      .getByRole('button', { name: '重新生成草稿', exact: true })
      .count(),
    1,
    'return to parameters keeps native mesh draft',
  );
  await page.getByLabel('积木配色', { exact: true }).selectOption(mode);
  await page
    .getByLabel('增强小型细节', { exact: true })
    .setChecked(detailEnhancement);
  assert.equal(
    transport.nativeMockPosts,
    posts,
    'changing colour/quality does not reconstruct',
  );
  assert.ok(
    await page
      .getByRole('button', { name: '确认生成积木模型', exact: true })
      .isEnabled(),
  );
}
function compareModes(designed, faithful) {
  const a = designed.design.model,
    b = faithful.design.model,
    metadata = a.colorDesign;
  assert.equal(a.bricks.length, b.bricks.length, 'colour modes preserve part count');

  // Instance material binding precedes the planar/scalar colour pass. Rebuild
  // that declared baseline from the faithful Model; never mistake a changed
  // component colour for a raw source observation or a colourDesign ledger item.
  const bodyParts = new Set([
    '3816c', '3815b', '3817c', '973', '3818', '3819', '3820', '3626c',
    '3003', '3004', '3005', '3023', '3024', '3710',
  ]);
  const candidateInstances = new Set();
  const baseline = b.bricks.map((source) => {
    if (designed.mode !== 'coherent' || !source.section?.startsWith('component-'))
      return source;
    const component = a.semanticDesign?.components.find((c) => c.id === source.section);
    const instance = a.sceneElements?.find((element) => element.id === component?.instanceId);
    const material = instance?.materialDesign;
    if (instance?.category !== 'statue' || material?.status !== 'candidate')
      return source;
    assert.equal(material.source, 'reference-mask');
    assert.equal(material.approximation, true);
    assert.ok(material.pixels >= 16 && material.brightPixels >= 5);
    assert.ok(material.agreement >= 0.7 && material.agreement <= 1);
    assert.ok(Number.isInteger(material.targetColor) && PALETTE[material.targetColor]);
    assert.ok((PALETTE[material.targetColor].opacity ?? 1) >= 1);
    assert.deepEqual(instance.imageMaskSize, metrics.rasterSize);
    assert.equal(Object.keys(instance.imageMask).length, metrics.rasterSize[0] * metrics.rasterSize[1]);
    candidateInstances.add(instance.id);
    const expected = materializeStatueBody([source], instance)[0];
    const eligible = source.color === 11 && !source.colorChoice && bodyParts.has(source.part);
    if (!eligible || choosePartColor(source.part, material.targetColor).color !== material.targetColor)
      assert.deepEqual(expected, source, `#${source.id}: accessory/base/unknown/catalog-blocked component retained`);
    else
      assert.equal(expected.color, material.targetColor, `#${source.id}: candidate body material target`);

    const { color: _expectedColor, installation: expectedText, ...expectedGeometry } = expected;
    const { color: _sourceColor, installation: sourceText, ...sourceGeometry } = source;
    assert.deepEqual(expectedGeometry, sourceGeometry, `#${source.id}: reference binding is colour-only geometry`);
    if (expected.color !== source.color && source.part === '3626c')
      assert.equal(expectedText, sourceText?.replace('无印刷灰色头部', `无印刷${PALETTE[expected.color].name}头部`));
    else
      assert.equal(expectedText, sourceText, `#${source.id}: only a rebound head's exact colour wording may change`);
    return expected;
  });
  assert.deepEqual(
    a.bricks.map(({ color: _color, ...brick }) => brick),
    baseline.map(({ color: _color, ...brick }) => brick),
    'every id/part/pose/section/support/step remains identical; only exact bound-head material wording may change',
  );
  assert.deepEqual(a.levels, b.levels);
  assert.deepEqual(
    [a.width, a.depth, a.height, a.supportCount],
    [b.width, b.depth, b.height, b.supportCount],
  );
  assert.deepEqual(
    designed.record.evidence.mesh,
    faithful.record.evidence.mesh,
    'same source geometry, radiance, raw observation and evidence ledger',
  );
  const diffColors = (after, before) => after.flatMap((brick, index) =>
    brick.color !== before[index].color
      ? [{ brickId: brick.id, from: before[index].color, to: brick.color }]
      : [],
  );
  const changed = diffColors(a.bricks, b.bricks),
    componentChanges = diffColors(baseline, b.bricks),
    designChanges = diffColors(a.bricks, baseline);
  const componentIds = new Set(componentChanges.map((change) => change.brickId));
  assert.ok(designChanges.every((change) => !componentIds.has(change.brickId)));
  assert.equal(changed.length, componentChanges.length + designChanges.length);
  assert.equal(metadata.changedBricks, designChanges.length, 'colourDesign counts only its actual post-binding changes');
  assert.deepEqual(
    metadata.changes.map(({ brickId, from, to }) => ({ brickId, from, to })),
    designChanges,
    'every planar/scalar change appears in the actual ledger exactly once',
  );
  const countColors = (bricks) => PALETTE.map(
    (_color, index) => bricks.filter((brick) => brick.color === index).length,
  );
  assert.deepEqual(metadata.beforeColorCounts, countColors(baseline));
  assert.deepEqual(metadata.afterColorCounts, countColors(a.bricks));
  const reserved = (b.semanticReservedCells ?? []).map((cell) => cell.split(',').map(Number));
  let protectedCount = 0,
    unchangedNonWarmCount = 0,
    scalarNonWarmChanges = 0;
  const immutableReasons = new Map();
  a.bricks.forEach((brick, index) => {
    const source = baseline[index],
      grid = [source.x, source.y, source.z, source.w, source.h, source.d].every(Number.isInteger),
      reasons = [];
    if (source.support) reasons.push('support');
    if (source.section === 'base') reasons.push('base');
    if (source.section?.startsWith('component-')) reasons.push('component');
    if (source.colorChoice) reasons.push('reviewed-catalog-substitution');
    if (!['brick', 'plate', 'tile'].includes(ASSEMBLY_PARTS[source.part]?.kind)) reasons.push('special-part');
    if (!grid) reasons.push('non-grid-pose');
    if (reserved.some(([x, y, z]) => x >= source.x && x < source.x + source.w && y >= source.y && y < source.y + source.h && z >= source.z && z < source.z + source.d))
      reasons.push('reserved-cell');
    if (reasons.length) {
      protectedCount++;
      assert.equal(brick.color, source.color, `#${brick.id}: source-protected part remains at the post-binding baseline`);
      for (const reason of reasons) immutableReasons.set(reason, (immutableReasons.get(reason) ?? 0) + 1);
    }
    const change = metadata.changes.find((c) => c.brickId === brick.id);
    if (designed.mode === 'coherent' && ![7, 8, 9, 10].includes(source.color)) {
      if (change) {
        scalarNonWarmChanges++;
        assert.equal(change.reason, 'source-scalar-shadow-design', `#${brick.id}: palette ID is not evidence; non-warm repair needs the scalar source ledger`);
      } else unchangedNonWarmCount++;
    }
    if (change) assert.ok(change.areaSupport >= 0.65 && change.areaSupport <= 1.000001);
    if (brick.color !== b.bricks[index].color)
      assert.equal(choosePartColor(brick.part, brick.color).color, brick.color, `#${brick.id}: design cannot introduce a catalog-blocked colour`);
  });
  if (designed.mode === 'coherent') {
    assert.equal(metadata.policyVersion, 'provenance-material-v2');
    for (const [reason, count] of immutableReasons)
      assert.equal(metadata.protectionReasons[reason], count, `actual ${reason} protection reason count`);
    assert.ok(metadata.changes.every((change) => ['source-scalar-shadow-design', 'source-local-material-design'].includes(change.reason)));
    assert.equal(metadata.materialMetrics.protectedObservedMaterialChangedArea, 0);
    assert.equal(metadata.materialMetrics.scalarDesignBricks, metadata.changes.filter((change) => change.reason === 'source-scalar-shadow-design').length);
    assert.equal(metadata.materialMetrics.localApproximationBricks, metadata.changes.filter((change) => change.reason === 'source-local-material-design').length);
    assert.ok(metadata.materialMetrics.domainInconsistentAreaAfter <= metadata.materialMetrics.domainInconsistentAreaBefore + 1e-6);
    assert.ok(metadata.materialMetrics.scalarShadowMismatchAreaAfter <= metadata.materialMetrics.scalarShadowMismatchAreaBefore + 1e-6);
    assert.ok(Number.isInteger(metadata.uncertainBricks) && metadata.uncertainBricks >= 0);
  }
  assert.deepEqual(a.semanticReservedCells, b.semanticReservedCells);
  assert.deepEqual(a.reservedVolumes, b.reservedVolumes);
  assert.deepEqual(a.componentPlacement, b.componentPlacement);
  assert.ok(designed.exports.unsupportedColors <= faithful.exports.unsupportedColors, 'design colour mode must not add catalog-unsupported combinations');
  return {
    mode: designed.mode,
    bricks: a.bricks.length,
    changedBricks: changed.length,
    designChangedBricks: designChanges.length,
    componentMaterialChangedBricks: componentChanges.length,
    candidateStatueInstances: [...candidateInstances],
    changes: changed,
    designChanges,
    componentMaterialChanges: componentChanges,
    catalogBlocked: metadata.catalogBlocked,
    protectedBricksVerified: protectedCount,
    coherentUnchangedNonWarmBricksVerified: unchangedNonWarmCount,
    coherentSourceScalarNonWarmChangesVerified: scalarNonWarmChanges,
    protectionReasons: metadata.protectionReasons,
    uncertainReasons: metadata.uncertainReasons,
    materialMetrics: metadata.materialMetrics,
    source: designed.record.evidence.mesh,
    geometryEqual: true,
    colourCountsBefore: countColors(b.bricks),
    colourCountsBeforePlanarScalarPass: countColors(baseline),
    colourCountsAfter: countColors(a.bricks),
    designExports: designed.exports,
    faithfulExports: faithful.exports,
  };
}

try {
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').setInputFiles({
    name: '神庙·统一配色同源回归.png',
    mimeType: 'image/png',
    buffer: photo,
  });
  await page
    .locator('.service-status')
    .filter({ hasText: '引擎已就绪' })
    .waitFor();
  const colorSelect = page.getByLabel('积木配色', { exact: true });
  assert.equal(
    await colorSelect.inputValue(),
    'coherent',
    'workspace default is explicitly coherent',
  );
  assert.deepEqual(await colorSelect.locator('option').allTextContents(), [
    '统一建筑主体 · 推荐',
    '保守清理阴影与杂色',
    '保留参考图映射',
  ]);
  assert.deepEqual(
    await colorSelect.locator('option').evaluateAll((options) =>
      options.map((option) => option.value),
    ),
    ['coherent', 'clean', 'faithful'],
  );
  assert.ok(await page.getByLabel('增强小型细节', { exact: true }).isChecked());
  assert.equal(
    await page
      .locator('.size-option[aria-pressed=true] .size-value')
      .innerText(),
    '28 凸点',
  );
  await noOverflow('initial workspace');
  await screenshot('coherent-default-settings');
  await page.getByRole('button', { name: '生成 3D 草稿', exact: true }).click();
  await waitGate(nativeArrived, 'cached native POST');
  assert.ok(
    await colorSelect.isDisabled(),
    'colour selection locked while POST is gate-held',
  );
  assert.ok(
    await page
      .getByRole('button', { name: '提交中，请稍候', exact: true })
      .isDisabled(),
  );
  await screenshot('native-submit-busy');
  nativeRelease.resolve();
  await page.locator('.live-mesh canvas').waitFor({ timeout: 210000 });
  await page.waitForFunction(
    () => !document.querySelector('select[aria-label="积木配色"]').disabled,
  );
  const colorWorker = (await observedWorkers()).filter(
    (worker) => worker.action === 'color',
  );
  assert.equal(colorWorker.length, 1, 'one genuine reference-colour worker');
  assert.equal(colorWorker[0].messages, 1);
  assert.equal(colorWorker[0].evidence.rasterSha256, metrics.rasterSha256);
  assert.equal(
    colorWorker[0].evidence.mesh.positionsSha256,
    colorWorker[0].outputMesh.positionsSha256,
    'readGLB geometry survives reference-colour worker',
  );
  await screenshot('native-draft');
  await colorSelect.click();
  // Do not scroll the document after opening the genuine native select popup.
  await page.screenshot({ path: `${out}/colour-menu.png`, fullPage: true });
  artifacts.push(`${out}/colour-menu.png`);
  await page.keyboard.press('Escape');
  await page.getByLabel('增强小型细节', { exact: true }).uncheck();
  await page
    .getByRole('button', { name: '确认生成积木模型', exact: true })
    .click();
  const coherentBasic = await result('coherent-basic-28', 'coherent', false);
  assert.equal(
    transport.sceneFixturePosts,
    0,
    'basic mode never asks for scene inference',
  );
  await revise('faithful', false);
  await page
    .getByRole('button', { name: '确认生成积木模型', exact: true })
    .click();
  const faithfulBasic = await result('faithful-basic-28', 'faithful', false);
  assert.equal(transport.sceneFixturePosts, 0);
  const basicComparison = compareModes(coherentBasic, faithfulBasic);

  // Cover the third, conservative mode with real worker/UI/three exports.
  await revise('clean', false);
  await page
    .getByRole('button', { name: '确认生成积木模型', exact: true })
    .click();
  const cleanBasic = await result('clean-conservative-basic-28', 'clean', false);
  assert.equal(transport.sceneFixturePosts, 0);
  const conservativeComparison = compareModes(cleanBasic, faithfulBasic);

  // One real cancel button during a held coherent enhancement POST. Deliver the
  // late fixture only after cancellation and verify it cannot launch packing.
  await revise('coherent', true);
  holdNextScene = true;
  const workersBeforeCancel = (await observedWorkers()).filter(
    (worker) => worker.action === 'workspace-design',
  ).length;
  await page
    .getByRole('button', { name: '确认生成积木模型', exact: true })
    .click();
  await waitGate(cancelSceneArrived, 'held coherent scene POST');
  assert.ok(
    await colorSelect.isDisabled(),
    'colour select locked during scene/conversion busy',
  );
  await page.getByRole('button', { name: '取消转换', exact: true }).click();
  await page
    .getByText('已取消转换，可以调整参数后重试。', { exact: true })
    .waitFor();
  assert.equal(
    await page.locator('.result-preview').count(),
    0,
    'cancellation does not reveal a stale result',
  );
  assert.ok(await colorSelect.isEnabled());
  cancelSceneRelease.resolve();
  await waitGate(
    cancelSceneRouteSettled,
    'late canceled scene transport settlement',
  );
  await flushRender();
  assert.equal(
    (await observedWorkers()).filter(
      (worker) => worker.action === 'workspace-design',
    ).length,
    workersBeforeCancel,
    'late canceled detection must not start packing',
  );
  assert.equal(
    await page.locator('.result-preview').count(),
    0,
    'late canceled fixture must not display a result',
  );
  assert.equal(
    transport.nativeMockPosts,
    1,
    'cancel does not submit a new native task',
  );
  await screenshot('coherent-cancelled-late-fixture');
  await page
    .getByRole('button', { name: '确认生成积木模型', exact: true })
    .click();
  const coherentEnhanced = await result(
    'coherent-enhanced-28',
    'coherent',
    true,
  );
  await screenshot(
    'coherent-enhanced-canvas',
    page.locator('.result-preview canvas'),
  );
  await screenshot(
    'coherent-enhanced-quality',
    page.getByRole('region', { name: '积木配色质量', exact: true }),
  );
  await revise('faithful', true);
  await page
    .getByRole('button', { name: '确认生成积木模型', exact: true })
    .click();
  const faithfulEnhanced = await result(
    'faithful-enhanced-28',
    'faithful',
    true,
  );
  const enhancedComparison = compareModes(coherentEnhanced, faithfulEnhanced);
  await screenshot(
    'faithful-enhanced-canvas',
    page.locator('.result-preview canvas'),
  );
  for (const observation of observations)
    assert.deepEqual(
      observation.record.evidence.mesh,
      colorWorker[0].outputMesh,
      'all conversions reuse the exact coloured draft/source ledger',
    );
  await page.setViewportSize({ width: 390, height: 844 });
  await flushRender();
  await noOverflow('mobile faithful result');
  await screenshot('faithful-enhanced-mobile');
  await revise('coherent', true);
  await noOverflow('mobile colour settings');
  assert.equal(await colorSelect.inputValue(), 'coherent');
  await screenshot('coherent-mobile-settings');
  assert.equal(
    transport.nativeMockPosts,
    1,
    'all colour/detail revisions reuse one native draft',
  );
  assert.equal(transport.nativeDownloadGets, 1);
  assert.equal(
    transport.sceneFixturePosts,
    3,
    'one canceled scene POST plus two successful enhanced conversions',
  );
  const allWorkers = await observedWorkers();
  assert.equal(
    allWorkers.filter((worker) => worker.action === 'workspace-design').length,
    5,
  );
  assert.equal(observations.length, 5, 'five real completed results');
  assert.equal(
    artifacts.filter((path) => /\.(csv|ldr)$/.test(path)).length,
    15,
    'three actual downloads for every completed result',
  );
  assert.equal(transport.actualNativeSubmissions, 0);
  assert.equal(transport.actualNativeInference, 0);
  assert.equal(transport.actualSceneInference, 0);
  assert.deepEqual(
    allWorkers.flatMap((worker) => (worker.error ? [worker.error] : [])),
    [],
  );
  assert.deepEqual(pageErrors, [], 'all pageErrors are fatal, never filtered');
  assert.deepEqual(
    routeErrors,
    [],
    'all unexpected transport exceptions are fatal',
  );
  const verification = {
    status: 'PASS',
    method:
      'Existing actual app; cached genuine native GLB and learned scene HTTP transports; observed unchanged native Worker messages; real Canvas320/readGLB/colour/packing/CAD/UI/BOM/downloads',
    base,
    sourceJob: metrics.sourceJob,
    resolution: 28,
    glbSha256: metrics.glbSha256,
    uploadSha256: sha(photo),
    rasterSha256: metrics.rasterSha256,
    defaultColorMode: 'coherent',
    colorModeOptions: ['coherent', 'clean', 'faithful'],
    completedResults: observations.length,
    actualDownloads: artifacts.filter((path) => /\.(csv|ldr)$/.test(path)).length,
    busyDisabledVerified: true,
    cancellation: {
      realCancelButton: true,
      lateResultHidden: true,
      latePackingPrevented: true,
      retryUsesSameDraft: true,
    },
    basic: basicComparison,
    enhanced: enhancedComparison,
    conservativeBasic: conservativeComparison,
    transport,
    workerActions: allWorkers.map(({ action, messages, terminated }) => ({
      action,
      messages,
      terminated,
    })),
    pageErrors,
    routeErrors,
    horizontalOverflow: false,
    artifacts,
    limitations: [
      'Cached transport responses are simulated: nativeMockPosts and sceneFixturePosts are nonzero; actual submissions and native/scene inference are zero because no matching request is forwarded.',
      'Single genuine source fixture at resolution28, not the user 8843-brick/48-resolution model. Different resolutions and source Models have different colour-change counts; resolution48 results are not expected values for this resolution28 run. Counts are measured, never forced to historical values.',
      'Design colour approximation, not recovered intrinsic material, real inventory/stock lookup, physical stability or real-world assembly validation.',
      'Catalog assertions cover every actual changed colour. Provenance-v2 protection checks support, components, special parts, reviewed substitutions and reserved cells; an explicitly reference-mask-bound statue body is audited separately before the planar/scalar ledger. Non-warm palette IDs are not paint identity: any changed non-warm ordinary brick must carry source-scalar-shadow-design evidence. Positive foliage/fire/source-conflict and blocked-candidate coverage require separate core fixtures when absent from this source.',
      'Service workers are blocked so the cache interception is deterministic; the application pipeline uses its actual native colour/design Workers and CAD loader.',
      'Fullscreen was already covered separately and is not retested or replaced here.',
      'Chrome Page screenshots capture the genuine focused native colour selector, not its operating-system popup; both actual option labels and values are asserted in the DOM.',
      'This genuine temple fixture has no assembled/minifigure procurement units; purchase aggregation is checked against procurementReport, but positive assembly-unit merging is not exercised.',
    ],
  };
  await writeFile(
    `${out}/verification.json`,
    `${JSON.stringify(verification, null, 2)}\n`,
  );
  console.log(
    `PASS colour-browser: coherent basic ${basicComparison.bricks} bricks/${basicComparison.changedBricks} actual colour changes; coherent enhanced ${enhancedComparison.bricks}/${enhancedComparison.changedBricks}; clean conservative basic ${conservativeComparison.bricks}/${conservativeComparison.changedBricks}; ${observations.length} results/15 actual downloads; native mock POST=${transport.nativeMockPosts}, scene fixture POST=${String(transport.sceneFixturePosts)}, actual submissions/native/scene inference=0/0/0; pageErrors=0`,
  );
} catch (error) {
  const failure = {
    status: 'FAIL',
    error: error.stack || String(error),
    transport,
    pageErrors,
    routeErrors,
    completedResults: observations.length,
    actualDownloads: artifacts.filter((path) => /\.(csv|ldr)$/.test(path)).length,
    completed: observations.map(({ label, mode, design, exports }) => ({
      label,
      mode,
      bricks: design.model.bricks.length,
      changedBricks: design.model.colorDesign?.changedBricks ?? 0,
      exports,
    })),
    artifacts,
  };
  await writeFile(
    `${out}/failure.json`,
    `${JSON.stringify(failure, null, 2)}\n`,
  );
  try {
    await screenshot('failure');
  } catch (screenshotError) {
    console.error('Failure screenshot error:', screenshotError);
  }
  console.error('FAIL colour-browser:', error);
  throw error;
} finally {
  nativeRelease.resolve();
  cancelSceneRelease.resolve();
  await browser.close();
}
