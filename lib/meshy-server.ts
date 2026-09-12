const API = 'https://api.meshy.ai/openapi/v1/image-to-3d';
export class ReconstructionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function requireReconstructionUser(request: Request) {
  const user = request.headers.get('oai-authenticated-user-id');
  if (!user) throw new ReconstructionError('请登录工作台后重试。', 401);
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin)
      throw new ReconstructionError('请求来源不匹配，请刷新工作台。', 403);
  }
  return user;
}
export async function meshyRequest(
  key: string,
  id?: string,
  image?: string,
  fetcher: typeof fetch = fetch,
) {
  if (!key)
    throw new ReconstructionError(
      '尚未配置 Meshy API 密钥。请先配置服务，或导入已有的 GLB 三维模型。',
      503,
    );
  if (id && (id.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(id)))
    throw new ReconstructionError('任务编号无效。');
  if (
    image &&
    (image.length > 6 * 1024 * 1024 ||
      !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image))
  )
    throw new ReconstructionError('图片数据无效或过大，请重新上传。');
  let response: Response;
  try {
    response = await fetcher(id ? `${API}/${encodeURIComponent(id)}` : API, {
      method: image ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: image
        ? JSON.stringify({
            image_url: image,
            ai_model: 'meshy-6',
            model_type: 'standard',
            should_remesh: true,
            target_polycount: 30000,
            topology: 'triangle',
            should_texture: true,
            enable_pbr: false,
            texture_resolution: '2k',
            image_enhancement: false,
            target_formats: ['glb'],
          })
        : undefined,
      signal: AbortSignal.timeout(45000),
    });
  } catch {
    throw new ReconstructionError(
      image
        ? '请求中断，任务可能已提交。请到 Meshy 控制台核对，避免重复扣费。'
        : '暂时无法查询三维任务，请稍后继续。',
      502,
    );
  }
  if (!response.ok)
    throw new ReconstructionError(
      response.status === 401
        ? 'Meshy 密钥无效，请检查配置。'
        : response.status === 402
          ? 'Meshy API 额度不足，请在服务商控制台补充。'
          : response.status === 429
            ? 'Meshy 请求过于频繁，请稍后继续。'
            : '三维服务未完成请求，请稍后重试。',
      response.status === 429 ? 429 : 502,
    );
  return response.json() as Promise<{
    result?: string;
    status?: string;
    progress?: number;
    model_urls?: { glb?: string };
    task_error?: { message?: string };
  }>;
}
async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}
export async function taskTicket(id: string, user: string, secret: string) {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await signingKey(secret),
    new TextEncoder().encode(`${user}\n${id}`),
  );
  return Array.from(new Uint8Array(signature), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export async function verifyTicket(
  id: string,
  ticket: string,
  user: string,
  secret: string,
) {
  if (!/^[a-f0-9]{64}$/.test(ticket))
    throw new ReconstructionError('任务凭证无效，请重新打开本次任务。', 403);
  const bytes = new Uint8Array(
    ticket.match(/../g)!.map((h) => parseInt(h, 16)),
  );
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await signingKey(secret),
      bytes,
      new TextEncoder().encode(`${user}\n${id}`),
    ))
  )
    throw new ReconstructionError('无权读取此任务。', 403);
}
export async function modelDownload(
  url: string,
  fetcher: typeof fetch = fetch,
) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'assets.meshy.ai')
    throw new ReconstructionError('服务商返回了不受支持的模型地址。', 502);
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok)
    throw new ReconstructionError('三维模型下载失败，请稍后继续。', 502);
  if (Number(response.headers.get('content-length')) > 24 * 1024 * 1024)
    throw new ReconstructionError(
      '三维文件超过 24 MB，请在 Meshy 中简化后导入。',
      413,
    );
  if (!response.body) throw new ReconstructionError('三维文件为空。', 502);
  // Bound reads even when Content-Length is absent or misleading.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 24 * 1024 * 1024)
        throw new ReconstructionError(
          '三维文件超过 24 MB，请简化后导入。',
          413,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.length;
  }
  return bytes;
}
