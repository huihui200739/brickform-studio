import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Brickform 积木工坊 · 图片变成积木设计',
  description:
    '用参考图片设计小鸭积木摆件，查看真实零件 3D、分部件结构、零件清单与拼装步骤。保留图片轮廓生成模式。',
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
