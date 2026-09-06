import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Brickform 积木工坊 · 图片变成积木设计',
  description:
    '上传参考图片，生成积木轮廓摆件，查看 3D 模型、零件清单与分层拼装说明。',
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
