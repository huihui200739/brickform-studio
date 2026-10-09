import type { Metadata } from 'next';

// 旧主题仅由 /advanced 加载；正式首页使用独立设计令牌和新版样式。
// 不在根 layout 引入旧 globals.css，避免上传卡片与按钮样式串色。
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
