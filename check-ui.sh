#!/bin/bash
# Read-only application checks; never starts services or submits AI tasks.
# Usage: ./check-ui.sh [port] (default: 3000)
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
PORT="${1:-3000}"
if [[ $# -gt 1 || ! "$PORT" =~ ^[0-9]+$ || ${#PORT} -gt 5 ]]; then
  printf '用法: %s [1..65535 的端口]\n' "$0" >&2
  exit 2
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '需要 Node.js 22.13+ 与 npm。\n' >&2
  exit 2
fi
status=0
if node --input-type=module - "$PORT" <<'NODE'
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('端口必须是 1..65535 的整数。');
  process.exit(2);
}
let failures = 0;
function check(condition, message) {
  if (condition) console.log(`   ✅ ${message}`);
  else {
    failures++;
    console.error(`   ❌ ${message}`);
  }
}
const files = [
  'package.json', 'vite.config.ts', '启动本地重建.command',
  'app/page.tsx', 'app/new/page.tsx', 'app/advanced/page.tsx',
  'app/studio-app.tsx', 'app/layout.tsx', 'app/home-new.tsx',
  'app/workspace-new.tsx', 'app/design-tokens.css', 'app/home.css',
  'app/workspace.css', 'app/workspace-live.css',
  'lib/workspace-source.ts', 'lib/workspace-reconstruction.ts',
  'lib/workspace-worker.ts', 'components/reconstruction-panel.tsx',
];
const sources = new Map();
console.log(`🔍 Brickform Studio 自检（已有服务端口 ${port}）`);
console.log('\n1) 本项目文件（不读取 .env 或密钥）');
for (const file of files) {
  try {
    const metadata = await stat(file);
    if (!metadata.isFile()) throw Error('not-a-file');
    sources.set(file, await readFile(file, 'utf8'));
    check(true, file);
  } catch {
    check(false, `${file} 缺失或不可读`);
  }
}
const source = (file) => sources.get(file) ?? '';
console.log('\n2) 正式入口、真实流程与安全启动配置');
check(/^\s*import\s+StudioApp\s+from\s+['"]\.\/studio-app['"]/m.test(source('app/page.tsx')) &&
  /<StudioApp\s*\/>/.test(source('app/page.tsx')),
  '/ 正式首页使用 StudioApp');
check(/^\s*import\s+StudioApp\s+from\s+['"]\.\.\/studio-app['"]/m.test(source('app/new/page.tsx')) &&
  /<StudioApp\s*\/>/.test(source('app/new/page.tsx')),
  '/new 历史入口复用同一个 StudioApp（不依赖旧演示切换器）');
check(/^\s*import\s+HomePage\s+from\s+['"]\.\/home-new['"]/m.test(source('app/studio-app.tsx')) &&
  (/^\s*import\s+WorkspacePage\s+from\s+['"]\.\/workspace-new['"]/m.test(source('app/studio-app.tsx')) ||
   /\bconst\s+WorkspacePage\s*=\s*lazy\(\s*\(\)\s*=>\s*import\(['"]\.\/workspace-new['"]\)/.test(source('app/studio-app.tsx'))) &&
  /<HomePage\b[^>]*\bonUpload=/.test(source('app/studio-app.tsx')) &&
  /<WorkspacePage\b[^>]*\bsource=/.test(source('app/studio-app.tsx')),
  '应用入口接入共享首页、工作台及上传数据');
const globalsImport = /^\s*import\s+['"][^'"]*globals\.css['"]/m;
check(!['app/layout.tsx', 'app/page.tsx', 'app/new/page.tsx', 'app/studio-app.tsx']
  .some((file) => globalsImport.test(source(file))) &&
  globalsImport.test(source('app/advanced/page.tsx')),
  '旧 globals.css 仅由高级工作台加载，不污染根布局与正式入口');
check(source('app/advanced/page.tsx').includes('ReconstructionPanel'),
  '/advanced 保留多视图、GLB 与语义组件的原重建面板');
check(source('app/home-new.tsx').includes('readWorkspaceImage') &&
  source('app/workspace-new.tsx').includes('submitReconstruction') &&
  source('app/workspace-new.tsx').includes('followReconstruction') &&
  source('app/workspace-new.tsx').includes('workspaceWorker'),
  '上传、真实重建轮询与浏览器计算链已接入');
check(['manualHTML(', 'purchaseInventoryCSV(', 'csv(model)', 'toLDraw(model)']
  .every((call) => source('app/workspace-new.tsx').includes(call)),
  '结果页接入 HTML、采购 CSV、几何 CSV、LDraw 真实导出');
try {
  const pkg = JSON.parse(source('package.json'));
  const dev = pkg.scripts?.dev;
  check(pkg.name === 'brickform-studio', '类型检查将在本项目执行');
  check(typeof dev === 'string' && dev === pkg.scripts?.local &&
    /BRICKFORM_LOCAL_3D=1\b/.test(dev) &&
    /--hostname\s+127\.0\.0\.1\b/.test(dev) && /--port\s+3000\b/.test(dev) &&
    !/--host(?:\s|=)|0\.0\.0\.0/.test(dev),
    'npm dev/local 统一启用本机插件，使用 vinext 正确的 IPv4 hostname 参数');
} catch {
  check(false, 'package.json 无法解析');
}
check(/host:\s*['"]127\.0\.0\.1['"]/.test(source('vite.config.ts')) &&
  /port:\s*3000\b/.test(source('vite.config.ts')) &&
  /strictPort:\s*true\b/.test(source('vite.config.ts')) &&
  source('vite.config.ts').includes('localReconstruction()'),
  'Vite 配置使用严格的 127.0.0.1:3000，本机重建插件已接入');

// Keep responses in memory; do not reuse predictable /tmp paths or invoke curl.
function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, {
      signal: AbortSignal.timeout(45000),
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      headers: { Accept: url.includes('/api/') ? 'application/json' : 'text/html' },
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) {
          response.destroy(Error('response-too-large'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('aborted', () => reject(Error('response-aborted')));
      response.once('end', () => resolve({
        status: response.statusCode,
        type: response.headers['content-type'] ?? '',
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.setTimeout(30000, () => request.destroy(Error('request-timeout')));
    request.once('error', reject);
  });
}
function classCount(html, token) {
  // Count rendered opening tags, not duplicate class strings in React/RSC data.
  const tags = html.matchAll(/<[a-z][\w:-]*\b[^>]*\bclass\s*=\s*["']([^"']*)["'][^>]*>/gi);
  let count = 0;
  for (const tag of tags) if (tag[1].split(/\s+/).includes(token)) count++;
  return count;
}
console.log('\n3) 双地址真实 HTTP 页面与重建能力（仅 GET，无推理提交）');
for (const hostname of ['127.0.0.1', 'localhost']) {
  const base = `http://${hostname}:${port}`;
  for (const route of ['/', '/new', '/advanced']) {
    const url = base + route;
    try {
      const response = await get(url);
      check(response.status === 200, `${url} 返回 HTTP 200（实际 ${response.status}）`);
      check(response.type.includes('text/html') && /<html\b/i.test(response.text),
        `${url} 返回真实 HTML 页面`);
      if (route !== '/advanced') {
        check(classCount(response.text, 'home-page') === 1,
          `${url} 渲染正式首页`);
        const cards = classCount(response.text, 'feature-card');
        check(cards === 4, `${url} 渲染 4 张功能卡片（实际 ${cards}）`);
      }
    } catch (error) {
      check(false, `${url} 请求失败（${error.code ?? error.name ?? '网络错误'}）；请先确认已有服务`);
    }
  }
  try {
    const url = base + '/api/reconstruction';
    const response = await get(url);
    check(response.status === 200 && response.type.includes('application/json'),
      `${url} 返回 HTTP 200 JSON 能力信息`);
    let capability;
    try { capability = JSON.parse(response.text); } catch { capability = null; }
    const valid = capability && capability.provider === 'local' &&
      typeof capability.configured === 'boolean' &&
      capability.multiView && typeof capability.multiView.configured === 'boolean';
    check(valid, `${hostname} 重建服务为本机 provider，单图/三图能力格式正确`);
    if (valid) console.log(`   ℹ️ ${hostname}: 单图 AI ${capability.configured ? '就绪' : '未就绪，轮廓模式仍可用'}；三图 AI ${capability.multiView.configured ? '就绪' : '未就绪'}`);
  } catch (error) {
    check(false, `${hostname} 重建能力查询失败（${error.code ?? error.name ?? '网络错误'}）`);
  }
}
console.log(`\n文件/结构/HTTP 检查：${failures === 0 ? '全部通过' : `${failures} 项未通过`}。`);
process.exitCode = failures === 0 ? 0 : 1;
NODE
then
  :
else
  status=1
fi
printf '\n4) 本项目 TypeScript（npm run typecheck）\n'
if npm run typecheck; then
  printf '   ✅ TypeScript 通过\n'
else
  printf '   ❌ TypeScript 未通过\n' >&2
  status=1
fi
if [[ "$status" -eq 0 ]]; then
  printf '\n🎉 自检全部通过。正式入口：http://127.0.0.1:%s/（localhost 同样可用）。\n' "$PORT"
  printf '说明：本脚本不代替浏览器上传/下载、WebGL 或真实 AI 模型质量验收。\n'
else
  printf '\n⚠️ 自检未通过，请查看上方失败项；本脚本不会启动或重启服务。\n' >&2
fi
exit "$status"
