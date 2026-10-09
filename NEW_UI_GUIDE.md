> ⚠️ **本文档已过时，仅作历史记录。**
> 里面的目录结构、文件清单和"启用新界面"的操作步骤已被后续修复取代，
> **其中 `cp app/home-new.tsx app/page.tsx` 之类的命令千万不要执行** ——
> 那会把能正常工作的正式应用替换成静态演示样板。
> 当前准确的状态和改法请看 **`START_HERE.md`**。

---

# 🎨 新UI界面 - 快速预览指南

## 🚀 立即预览

```bash
# 1. 确保开发服务器正在运行
npm run dev

# 2. 在浏览器中打开新界面
http://localhost:3000/new
```

## 📁 新文件说明

### 设计系统
- `app/design-tokens.css` - 颜色、字体、间距等设计令牌
- `components/ds/index.tsx` - 可复用的UI组件库
- `components/ds/components.css` - 组件样式

### 页面
- `app/home-new.tsx` - 新首页组件
- `app/home.css` - 首页样式
- `app/workspace-new.tsx` - 新工作台组件
- `app/workspace.css` - 工作台样式
- ~~app/demo.tsx~~ （**已删除**：与 `/new` 完全重复，且根本不是路由）
- `app/new/page.tsx` - 路由入口

### 文档
- `UI_REFACTOR_SUMMARY.md` - 完整重构总结
- `REFACTOR_PLAN.md` - 重构计划
- `app/integration-guide.tsx` - 集成指南和代码示例

## 🎯 核心改进

### 视觉设计
✅ 深色主题（5层表面系统）
✅ 乐高配色（蓝色/绿色/黄色）
✅ 流动字体（响应式缩放）
✅ 圆角一致（pills按钮、卡片）
✅ 微交互动画

### 用户体验
✅ 简化流程：8步 → 3步
✅ 智能推荐（自动识别、参数预设）
✅ 清晰进度指示
✅ 实时反馈
✅ 移动端友好

### 代码质量
✅ 组件化（易维护）
✅ 设计系统（统一风格）
✅ TypeScript（类型安全）
✅ 响应式（适配所有设备）

## 🎨 设计系统使用

### 按钮
```tsx
import { Button } from '@/components/ds';

<Button variant="primary" size="lg">
  生成模型
</Button>

<Button variant="secondary" loading={true}>
  处理中...
</Button>
```

### 卡片
```tsx
import { Card } from '@/components/ds';

<Card title="模型信息" description="查看详细参数">
  {/* 内容 */}
</Card>
```

### 进度条
```tsx
import { Progress } from '@/components/ds';

<Progress value={75} label="正在生成..." showPercentage />
```

### 提示框
```tsx
import { Alert } from '@/components/ds';

<Alert type="success" title="完成">
  模型已生成！
</Alert>
```

## 🔄 集成到现有项目

### ~~方案1：渐进式替换~~ —— 已作废，请勿执行

新界面目前是静态演示：直接 `cp app/home-new.tsx app/page.tsx` 会废掉正式应用。
`app/layout.tsx` 也**故意不引入** `globals.css`（新旧界面样式已隔离），
不要再往 layout 里追加设计令牌样式。

要接入正式应用请先规划，见 `START_HERE.md`。


### 方案2：AB测试

```tsx
// app/page.tsx
import OldUI from './page-old';
import NewUI from './home-new';

export default function Page() {
  const useNewUI = Math.random() > 0.5; // 或读取用户设置
  return useNewUI ? <NewUI /> : <OldUI />;
}
```

### 方案3：URL切换

```
/       → 旧界面（保持稳定）
/new    → 新界面（测试和预览）
```

## 🔌 连接真实数据

### 1. 上传功能
```tsx
// app/home-new.tsx 中修改 UploadZone
const handleUpload = async (file: File) => {
  const formData = new FormData();
  formData.append('image', file);

  const res = await fetch('/api/upload', {
    method: 'POST',
    body: formData
  });

  const { id } = await res.json();
  window.location.href = `/new?id=${id}`;
};
```

### 2. 生成流程
```tsx
// app/workspace-new.tsx 中
const [status, setStatus] = useState({ stage: 'idle' });

useEffect(() => {
  const eventSource = new EventSource(`/api/generate/${imageId}`);

  eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);
    setStatus(data);
  };

  return () => eventSource.close();
}, [imageId]);
```

### 3. 下载结果
```tsx
const downloadFile = (format: string) => {
  window.location.href = `/api/export/${designId}?format=${format}`;
};
```

## 🎬 示例场景

### 场景1：用户上传照片
1. 打开首页，看到大的上传区域
2. 拖拽图片 → 自动识别类型
3. 显示智能推荐："检测到建筑物，推荐尺寸：中"
4. 点击"生成" → 进入工作台

### 场景2：查看生成进度
1. 工作台顶部：进度条（当前：体素化 50%）
2. 左侧：参考图 + 智能提示
3. 右侧：3D草稿实时更新
4. 完成后：自动跳转到结果页

### 场景3：下载成品
1. 结果页展示：3D模型 + 关键指标
2. 下载按钮组：说明书/清单/3D文件
3. 购买链接：BrickLink/LEGO.com
4. 详细信息：尺寸/零件数/步骤

## 📱 响应式测试

### 桌面端（1920x1080）
```
✅ 侧边栏 + 主内容区
✅ 3D预览大画布
✅ 完整功能展示
```

### 平板端（768x1024）
```
✅ 侧边栏变窄
✅ 功能卡片堆叠
✅ 字体自动缩放
```

### 移动端（375x812）
```
✅ 单列布局
✅ 隐藏次要信息
✅ 大触控目标
```

## 🐛 已知问题

1. **3D Canvas 未集成**
   - 当前只有占位符
   - 需要连接 Three.js 组件

2. **上传逻辑未连接**
   - 需要调用 `/api/upload`
   - 处理文件大小限制

3. **示例图片未加载**
   - 需要放入 `public/` 目录
   - 或连接到真实示例API

## 🎯 下一步TODO

### 紧急（本周）
- [ ] 集成3D预览组件
- [ ] 连接上传API
- [ ] 测试生成流程
- [ ] 修复响应式问题

### 重要（下周）
- [ ] 添加错误处理
- [ ] 性能优化
- [ ] 无障碍测试
- [ ] 多语言支持

### 未来
- [ ] 深色/浅色主题切换
- [ ] 自定义品牌色
- [ ] 键盘快捷键
- [ ] 离线支持

## 💬 反馈

如果你发现问题或有建议：
1. 在 GitHub 提 Issue
2. 或直接修改代码并提 PR
3. 或联系开发者

## 📞 需要帮助？

问题示例：
- "如何修改主题色？" → 编辑 `design-tokens.css` 中的 `--accent-primary`
- "如何添加新组件？" → 参考 `components/ds/index.tsx` 的模式
- "如何部署？" → `npm run build` 后部署 `dist/` 目录

---

**享受新界面吧！** 🎉
