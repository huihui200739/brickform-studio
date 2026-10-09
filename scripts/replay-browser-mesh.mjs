// Replay an already-generated local GLB with exact browser Canvas/Worker inputs.
// This does not submit a second native/paid reconstruction task.
import { chromium } from '../work/ui-test-tools/node_modules/playwright/index.mjs';
import { readFile, writeFile } from 'node:fs/promises';
const file = process.argv[2];
if (!file) throw Error('Pass an existing GLB fixture');
const bytes = await readFile(file);
const browser = await chromium.launch({
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
  const data = await page.evaluate(async (base64) => {
    const { readGLB } = await import('/lib/read-glb.ts');
    const { readWorkspaceImage } = await import('/lib/workspace-source.ts');
    const { workspaceWorker } = await import('/lib/workspace-worker.ts');
    const rasterSource = await readWorkspaceImage(
      new File(
        [await (await fetch('/reference-duck.png')).blob()],
        'reference-duck.png',
        { type: 'image/png' },
      ),
    );
    const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const raw = await readGLB(binary.buffer, rasterSource.name);
    const c = new AbortController();
    const mesh = await workspaceWorker(
      {
        action: 'color',
        mesh: raw,
        raster: rasterSource.raster,
        softenShadows: true,
      },
      'mesh',
      c.signal,
    );
    const results = [];
    for (const resolution of [20, 28, 36]) {
      try {
        const model = await workspaceWorker(
          {
            mesh,
            raster: rasterSource.raster,
            options: { resolution },
            autoSemanticRefinement: false,
          },
          'model',
          c.signal,
        );
        results.push({
          resolution,
          pieces: model.bricks.length,
          success: true,
        });
      } catch (error) {
        results.push({ resolution, success: false, error: error.message });
      }
    }
    const fixture = JSON.stringify(
      { mesh, raster: rasterSource.raster },
      (_key, value) =>
        ArrayBuffer.isView(value)
          ? { typedArray: value.constructor.name, values: Array.from(value) }
          : value,
    );
    return { results, fixture, coloring: mesh.coloring };
  }, bytes.toString('base64'));
  await writeFile(
    'outputs/ui-verification/browser-mesh-failure.json',
    data.fixture,
  );
  console.log(
    JSON.stringify(
      { source: file, results: data.results, coloring: data.coloring },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
