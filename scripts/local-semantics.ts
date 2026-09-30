// Local-only model execution; never bundled into the hosted application.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Plugin } from 'vite';
import { decodeSceneRaster } from '../lib/local-scene-request.ts';

const execute = promisify(execFile);
export function localSemantics(): Plugin {
  const root = resolve('work/semantic-engine');
  const python = join(root, '.venv/bin/python');
  const runner = resolve('scripts/local-scene-analysis.py');
  const ready = join(root, 'ready.json');
  const pending = new Map<string, Promise<string>>();
  let active = false;
  return {
    name: 'brickform-local-object-identity',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use('/api/scene-analysis', (req, res) => {
        const send = (status: number, data: unknown) => {
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(data));
        };
        void (async () => {
          const host = req.headers.host || '';
          if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host))
            return send(403, { error: '本机识别仅允许在这台电脑上使用。' });
          const configured = existsSync(python) && existsSync(ready);
          if (req.method === 'GET')
            return send(200, {
              configured,
              provider: 'local',
              model: 'Grounding DINO + SlimSAM',
            });
          if (req.method !== 'POST')
            return send(405, { error: '不支持此操作。' });
          if (req.headers.origin !== `http://${host}`)
            return send(403, { error: '请从本机工作台提交参考图。' });
          if (!configured)
            return send(503, { error: '本机对象识别尚未安装，已保留网格。' });
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 5 * 1024 * 1024)
              return send(413, { error: '参考图过大。' });
          }
          let raster: ReturnType<typeof decodeSceneRaster>;
          try {
            raster = decodeSceneRaster(JSON.parse(body));
          } catch {
            return send(400, { error: '参考图像素无效或超过本机识别尺寸。' });
          }
          const header = Buffer.alloc(8);
          header.writeUInt32LE(raster.width, 0);
          header.writeUInt32LE(raster.height, 4);
          const bytes = Buffer.concat([header, raster.data]);
          const fingerprint = createHash('sha256')
            .update(await readFile(ready))
            .update(await readFile(runner))
            .digest('hex');
          const id = createHash('sha256')
            .update(fingerprint)
            .update(bytes)
            .digest('hex');
          const dir = join(root, 'jobs', id),
            file = join(dir, 'reference.rgba'),
            output = join(dir, 'reference.scene.json');
          if (existsSync(output)) {
            const cached = JSON.parse(await readFile(output, 'utf8'));
            if (cached.engineFingerprint === fingerprint)
              return send(200, cached);
          }
          const existing = pending.get(id);
          if (existing) return send(200, JSON.parse(await existing));
          if (active)
            return send(409, { error: '本机正在识别另一张图片，请稍后重试。' });
          active = true;
          const task = (async () => {
            try {
              await mkdir(dir, { recursive: true });
              await writeFile(file, bytes);
              await execute(python, [runner, file, '--output', dir], {
                timeout: 170000,
                maxBuffer: 1024 * 1024,
              });
              return await readFile(output, 'utf8');
            } finally {
              active = false;
              pending.delete(id);
            }
          })();
          pending.set(id, task);
          send(200, JSON.parse(await task));
        })().catch((error: unknown) =>
          send(500, {
            error:
              error instanceof Error
                ? error.message
                : '本机识别失败，保留原网格。',
          }),
        );
      });
    },
  };
}
