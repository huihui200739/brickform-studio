import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Brickform 积木工坊 · 图片变成积木设计',
  description:
    '从单图、三视图、正面图纸或 GLB 生成可检查的积木设计、真实零件清单和逐块拼装说明。',
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
