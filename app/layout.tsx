import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Brickform 积木工坊 · 图片变成积木设计',
  description:
    '从小鸭侧面图测量比例，重建对称体积，查看真实零件 3D、零件清单和拼装步骤。V4 实验版，尚不支持通用物体识别。',
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
