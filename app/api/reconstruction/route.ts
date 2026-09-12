import { env } from 'cloudflare:workers';
import {
  meshyRequest,
  requireReconstructionUser,
  ReconstructionError,
  taskTicket,
  verifyTicket,
  modelDownload,
} from '@/lib/meshy-server';
export const dynamic = 'force-dynamic';
const key = () =>
  (env as unknown as { MESHY_API_KEY?: string }).MESHY_API_KEY || '';
function errorResponse(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof ReconstructionError
          ? error.message
          : '重建服务暂不可用，请稍后重试。',
    },
    {
      status: error instanceof ReconstructionError ? error.status : 500,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
export async function GET(request: Request) {
  try {
    const user = requireReconstructionUser(request),
      url = new URL(request.url),
      id = url.searchParams.get('id');
    if (!id)
      return Response.json(
        { configured: !!key(), provider: 'Meshy', model: 'meshy-6' },
        { headers: { 'Cache-Control': 'no-store' } },
      );
    if (!key()) throw new ReconstructionError('三维服务尚未配置。', 503);
    await verifyTicket(id, url.searchParams.get('ticket') || '', user, key());
    const task = await meshyRequest(key(), id);
    if (url.searchParams.get('download') === '1') {
      if (task.status !== 'SUCCEEDED' || !task.model_urls?.glb)
        throw new ReconstructionError('三维任务尚未完成。', 409);
      return new Response(await modelDownload(task.model_urls.glb), {
        headers: {
          'Content-Type': 'model/gltf-binary',
          'Cache-Control': 'no-store',
        },
      });
    }
    return Response.json(
      {
        status: task.status,
        progress: Math.max(0, Math.min(100, task.progress || 0)),
        ready: task.status === 'SUCCEEDED' && !!task.model_urls?.glb,
        error:
          task.status === 'FAILED'
            ? '三维重建失败，请检查图片或在 Meshy 控制台查看原因。'
            : undefined,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const user = requireReconstructionUser(request);
    if (!key())
      throw new ReconstructionError(
        '尚未配置 Meshy API 密钥。可先导入已有 GLB 模型。',
        503,
      );
    if (Number(request.headers.get('content-length')) > 6.1 * 1024 * 1024)
      throw new ReconstructionError('图片过大，请缩小后重试。', 413);
    const body = await request.text();
    if (body.length > 6.1 * 1024 * 1024)
      throw new ReconstructionError('图片过大。', 413);
    const payload = JSON.parse(body) as { image?: string };
    if (!payload.image) throw new ReconstructionError('请先上传图片。');
    const task = await meshyRequest(key(), undefined, payload.image);
    if (!task.result)
      throw new ReconstructionError(
        '服务商没有返回任务编号，请先检查 Meshy 控制台，避免重复提交。',
        502,
      );
    return Response.json(
      { id: task.result, ticket: await taskTicket(task.result, user, key()) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
