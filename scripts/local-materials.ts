// The optional local estimator is never included in the hosted application.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import type { Plugin } from 'vite';
import {
  decodeMaterialRaster,
  encodeMaterialRaster,
  decodeMaterialCandidate,
  LOCAL_MATERIAL_MODEL,
  type LocalMaterialAnalysisResponse,
} from '../lib/local-material-request.ts';

const execute = promisify(execFile),
  MAX_BODY_BYTES = 2 * 1024 * 1024;

function loopback(req: IncomingMessage) {
  const address = req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((accept, reject) => {
    let bytes = 0, rejected = false;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        reject(Error('body-too-large'));
      } else chunks.push(chunk);
    });
    req.once('end', () => {
      if (!rejected) accept(Buffer.concat(chunks).toString('utf8'));
    });
    req.once('error', reject);
    req.once('aborted', () => reject(Error('request-aborted')));
  });
}

export function localMaterials(): Plugin {
  const root = resolve('work/intrinsic-engine'),
    python = join(root, '.venv/bin/python'),
    runner = resolve('scripts/local-material-analysis.py'),
    ready = join(root, 'ready.json');
  const pending = new Map<string, Promise<LocalMaterialAnalysisResponse>>();
  let active = false;
  return {
    name: 'brickform-local-material-estimate',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use('/api/material-analysis', (req, res) => {
        const send = (status: number, data: unknown) => {
          if (res.writableEnded) return;
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            ...(status === 405 ? { Allow: 'GET, POST' } : {}),
          });
          res.end(JSON.stringify(data));
        };
        void (async () => {
          const host = req.headers.host || '',
            port = Number(host.slice(host.lastIndexOf(':') + 1));
          if (
            !loopback(req) ||
            !/^(localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/.test(host) ||
            port < 1 || port > 65535
          )
            return send(403, { error: '本机材质估计仅允许在这台电脑上使用。' });
          const pathname = (req.url || '/').split('?')[0];
          if (pathname !== '/' && pathname !== '')
            return send(404, { error: '此接口不存在。' });
          const configured = existsSync(python) && existsSync(ready) && existsSync(runner);
          if (req.method === 'GET')
            return send(200, { configured, model: 'Marigold IID lighting v1.1', busy: active });
          if (req.method !== 'POST') return send(405, { error: '不支持此操作。' });
          if (req.headers.origin !== 'http://' + host)
            return send(403, { error: '请从本机工作台提交材质估计。' });
          if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
            return send(415, { error: '请提交规范的参考图像素。' });
          if (!configured)
            return send(503, { error: '本机材质估计运行时不可用，原图已保留。' });
          if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
            req.resume();
            return send(413, { error: '参考图过大。' });
          }
          let body: string;
          try { body = await readBody(req); }
          catch (error) {
            if (error instanceof Error && error.message === 'body-too-large')
              return send(413, { error: '参考图过大。' });
            throw error;
          }
          let raster: ReturnType<typeof decodeMaterialRaster>;
          try { raster = decodeMaterialRaster(JSON.parse(body)); }
          catch { return send(400, { error: '参考图像素无效或超过 320 × 320。' }); }
          const bytes = encodeMaterialRaster(raster),
            sourceSha256 = createHash('sha256').update(bytes).digest('hex');
          const [readyBytes, runnerBytes] = await Promise.all([readFile(ready), readFile(runner)]);
          const readyMetadata = JSON.parse(readyBytes.toString('utf8'));
          if (
            readyMetadata.model?.repo !== LOCAL_MATERIAL_MODEL.repo ||
            readyMetadata.model?.revision !== LOCAL_MATERIAL_MODEL.revision ||
            readyMetadata.config?.runtimeDtype !== 'float32' ||
            readyMetadata.verifiedFiles !== 14
          )
            return send(503, { error: '本机材质模型尚未验证，原图已保留。' });
          const fingerprint = createHash('sha256').update(readyBytes).update(runnerBytes).digest('hex'),
            id = createHash('sha256').update(fingerprint).update(bytes).digest('hex'),
            dir = join(root, 'jobs', id),
            file = join(dir, 'reference.rgba'),
            output = join(dir, 'material-analysis.json');
          const validate = (raw: unknown): LocalMaterialAnalysisResponse => {
            if (!raw || typeof raw !== 'object' || !('candidate' in raw))
              throw Error('本机材质输出无效。');
            return {
              candidate: decodeMaterialCandidate(raw.candidate, raster, {
                sourceSha256, engineFingerprint: fingerprint,
              }),
            };
          };
          if (existsSync(output)) {
            try { return send(200, validate(JSON.parse(await readFile(output, 'utf8')))); }
            catch { /* A stale or malformed cached estimate is recomputed. */ }
          }
          const existing = pending.get(id);
          if (existing) return send(200, await existing);
          if (active)
            return send(409, { error: '本机正在估计另一张图片的材质，请稍后重试。' });
          active = true;
          const task = (async () => {
            try {
              await mkdir(dir, { recursive: true });
              await writeFile(file, bytes);
              await execute(python, [runner, file, '--output', dir], {
                timeout: 180000,
                maxBuffer: 1024 * 1024,
                env: {
                  ...process.env,
                  HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
                  HF_HUB_DISABLE_TELEMETRY: '1', TOKENIZERS_PARALLELISM: 'false',
                },
              });
              return validate(JSON.parse(await readFile(output, 'utf8')));
            } finally {
              active = false;
              pending.delete(id);
            }
          })();
          pending.set(id, task);
          send(200, await task);
        })().catch(() => send(503, {
          error: '本机材质估计未产生有效结果，原图已保留。',
        }));
      });
    },
  };
}
