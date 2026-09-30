// Development-only native reconstruction. This module never enters the hosted Worker.
import { existsSync, createReadStream, statSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Plugin } from 'vite';
import { decodeLocalViews } from '../lib/local-view-request.ts';

export function localReconstruction(): Plugin {
  const root = path.resolve('work/local-3d');
  const binary = path.join(root, 'hy3d');
  const weights = path.join(root, 'weights');
  const multiRoot = path.resolve('work/multiview-engine');
  const multiPython = path.join(multiRoot, '.venv/bin/python');
  const multiRunner = path.resolve('scripts/local-multiview.py');
  type Job = {
    id: string;
    ticket: string;
    status: string;
    progress: number;
    error?: string;
    output: string;
    multiView: boolean;
  };
  const jobs = new Map<string, Job>();
  let active = false;
  return {
    name: 'brickform-local-reconstruction',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use('/api/reconstruction', (req, res) => {
        const send = (status: number, body: unknown) => {
          res.writeHead(status, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(body));
        };
        let reserved = false;
        const run = async () => {
          const host = req.headers.host || '';
          if (!/^(localhost|127\.0\.0\.1):\d+$/.test(host))
            return send(403, { error: '本机服务仅允许在这台电脑上使用。' });
          if (req.method !== 'GET' && req.headers.origin !== `http://${host}`)
            return send(403, { error: '请从本机工作台提交图片。' });
          const url = new URL(req.url || '/', `http://${host}`);
          const ready =
            existsSync(binary) &&
            existsSync(path.join(root, 'mlx.metallib')) &&
            existsSync(path.join(weights, 'model.fp16.safetensors'));
          const multiWeights = path.join(
            multiRoot,
            'weights/map-anything/model.safetensors',
          );
          const multiReady =
            existsSync(multiPython) &&
            existsSync(path.join(multiRoot, 'ready.json')) &&
            existsSync(multiWeights) &&
            statSync(multiWeights).size === 4914062480;
          const queryId = url.searchParams.get('id');
          if (req.method === 'GET' && !queryId)
            return send(200, {
              configured: ready,
              provider: 'local',
              model: 'Hunyuan3D mini · Apple Silicon',
              multiView: {
                configured: multiReady,
                model: 'MapAnything MLX · 联合三视图',
              },
            });
          if (req.method === 'GET') {
            const job = jobs.get(queryId || ''),
              ticket = url.searchParams.get('ticket') || '';
            if (
              !job ||
              ticket.length !== job.ticket.length ||
              !timingSafeEqual(Buffer.from(ticket), Buffer.from(job.ticket))
            )
              return send(403, {
                error: '任务不存在或凭证不匹配。请保留生成时的页面。',
              });
            if (url.searchParams.get('reference') === '1') {
              if (job.status !== 'SUCCEEDED')
                return send(409, { error: '参考图尚未就绪。' });
              const dir = path.dirname(job.output);
              const cutout = path.join(dir, 'cutout.png');
              const file = existsSync(cutout)
                ? cutout
                : path.join(
                    dir,
                    job.multiView ? 'views/0-front.png' : 'input.png',
                  );
              res.writeHead(200, {
                'Content-Type': 'image/png',
                'Cache-Control': 'no-store',
              });
              createReadStream(file).pipe(res);
              return;
            }
            if (url.searchParams.get('download') === '1') {
              if (job.status !== 'SUCCEEDED')
                return send(409, { error: '模型尚未生成。' });
              res.writeHead(200, {
                'Content-Type': 'model/gltf-binary',
                'Cache-Control': 'no-store',
              });
              createReadStream(job.output).pipe(res);
              return;
            }
            const diagnostics =
              job.multiView && job.status === 'SUCCEEDED'
                ? JSON.parse(
                    await readFile(
                      job.output.replace(/\.glb$/, '.json'),
                      'utf8',
                    ),
                  )
                : undefined;
            return send(200, {
              multiDiagnostics: diagnostics,
              status: job.status,
              progress: job.progress,
              ready: job.status === 'SUCCEEDED',
              error: job.error,
            });
          }
          if (req.method !== 'POST')
            return send(405, { error: '不支持此操作。' });

          if (active)
            return send(409, {
              error: '电脑正在处理另一张图片，请等完成后再试。',
            });
          let body = '';
          for await (const chunk of req) {
            body += chunk.toString();
            if (body.length > 21 * 1024 * 1024)
              return send(413, { error: '图片太大，请缩小后上传。' });
          }
          const payload = JSON.parse(body) as {
            image?: unknown;
            views?: unknown;
          };
          const multiView = payload.views !== undefined;
          const images = multiView ? decodeLocalViews(payload.views) : [];
          if (!(multiView ? multiReady : ready))
            return send(503, {
              error: multiView
                ? '本机三视图引擎尚未安装完成。'
                : '本机模型尚未安装完成。',
            });
          const image = payload.image;
          if (
            !multiView &&
            (typeof image !== 'string' ||
              !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image))
          )
            return send(400, { error: '请上传 PNG 或 JPG 图片。' });
          // Recheck after the asynchronous body read; one inference fits the memory budget.
          if (active) return send(409, { error: '已有一个任务运行中。' });
          active = true;
          reserved = true;
          const id = randomBytes(12).toString('hex'),
            ticket = randomBytes(24).toString('hex');
          const dir = path.join(root, 'jobs', id);
          await mkdir(dir, { recursive: true });
          if (multiView) {
            const inputs = path.join(dir, 'views');
            await mkdir(inputs);
            for (const [index, view] of images.entries())
              await writeFile(
                path.join(inputs, `${index}-${view.axis}.png`),
                view.bytes,
              );
          } else {
            await writeFile(
              path.join(dir, 'input.png'),
              Buffer.from((image as string).split(',')[1], 'base64'),
            );
          }
          const job: Job = {
            id,
            ticket,
            status: 'RUNNING',
            progress: 1,
            output: path.join(dir, 'model.glb'),
            multiView,
          };
          jobs.set(id, job);
          const execute = (file: string, args: string[]) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(file, args, {
                cwd: root,
                stdio: ['ignore', 'pipe', 'pipe'],
              });
              let detail = '';
              const timer = setTimeout(
                () => child.kill('SIGTERM'),
                12 * 60 * 1000,
              );
              child.stdout.on('data', (data: Buffer) => {
                for (const match of data.toString().matchAll(/\[\s*(\d+)%\]/g))
                  job.progress = Math.max(
                    job.progress,
                    Math.min(99, Number(match[1])),
                  );
              });
              child.stderr.on('data', (data: Buffer) => {
                detail = (detail + data.toString()).slice(-2000);
              });
              child.on('error', (error) => {
                clearTimeout(timer);
                reject(error);
              });
              child.on('close', (code) => {
                clearTimeout(timer);
                if (code === 0) resolve();
                else
                  reject(
                    Error(detail || '本机重建中断，请确认内存可用后再试。'),
                  );
              });
            });
          void (async () => {
            try {
              if (multiView) {
                await execute(multiPython, [
                  multiRunner,
                  path.join(dir, 'views'),
                  job.output,
                ]);
              } else {
                let input = path.join(dir, 'input.png');
                if (existsSync(path.join(root, 'prepare-image'))) {
                  try {
                    await execute(path.join(root, 'prepare-image'), [
                      input,
                      path.join(dir, 'cutout.png'),
                    ]);
                    input = path.join(dir, 'cutout.png');
                  } catch {
                    /* The original image remains usable if the OS mask finds no foreground. */
                  }
                }
                await execute(binary, [
                  'shape',
                  input,
                  '-o',
                  job.output,
                  '--weights',
                  weights,
                  '--steps',
                  '30',
                  '--octree',
                  '128',
                  '--seed',
                  // A reference has one repeatable draft. Resolution changes
                  // affect brick packing, never resample the hidden geometry.
                  String(createHash('sha256').update(await readFile(path.join(dir, 'input.png'))).digest().readUInt32BE(0)),
                ]);
              }
              job.status = 'SUCCEEDED';
              job.progress = 100;
            } catch (e) {
              await writeFile(path.join(dir, 'error.log'), String(e)).catch(
                () => {},
              );
              job.status = 'FAILED';
              job.error = multiView
                ? '三图联合重建未完成。请确认三张图来自同一模型且有重叠区域；本机日志已保留。'
                : '本机重建未完成。请关闭占用内存较大的应用后重试；也可换一张主体更清晰的图片。';
            } finally {
              active = false;
            }
          })();
          send(202, { id, ticket });
        };
        void run().catch(() => {
          if (reserved) active = false;
          send(400, {
            error: '无法读取图片或创建本机任务，请检查三张图片的格式和视角。',
          });
        });
      });
    },
  };
}
