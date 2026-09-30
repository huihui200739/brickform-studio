export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json(
    { configured: false, provider: 'unavailable' },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
export async function POST() {
  return Response.json(
    { error: '此环境尚未配置对象识别，保留原网格。' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
