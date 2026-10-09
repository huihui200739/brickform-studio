// 快速集成指南
// 这个文件展示如何将新UI集成到现有项目

import { useState } from 'react';
import { Button, Card, Progress, Alert, Badge, Spinner } from '@/components/ds';

// 1. 上传功能集成示例
export function IntegratedUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (uploadedFile: File) => {
    setFile(uploadedFile);
    setUploading(true);

    try {
      // 连接到现有的上传API
      const formData = new FormData();
      formData.append('image', uploadedFile);

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      // response.json() 的返回类型是 unknown，必须显式断言，
      // 否则 tsc 报 TS18046: 'result' is of type 'unknown'
      const result = (await response.json()) as { id?: string };

      // 注意：项目里并不存在 /workspace 路由，实际可用的是 /new
      window.location.href = `/new?imageId=${result.id ?? ''}`;
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card title="上传图片">
      {uploading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <Spinner size="lg" />
          <p style={{ marginTop: '20px' }}>上传中...</p>
        </div>
      ) : (
        <input
          type="file"
          accept="image/*"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleUpload(file);
          }}
        />
      )}
    </Card>
  );
}

// 2. 生成进度集成示例
export function IntegratedProgress({ status }: { status: any }) {
  const getProgressValue = () => {
    switch (status.stage) {
      case 'reconstruction': return 25;
      case 'voxelization': return 50;
      case 'packing': return 75;
      case 'done': return 100;
      default: return 0;
    }
  };

  return (
    <Card title="生成进度">
      <Progress
        value={getProgressValue()}
        label={status.message}
      />

      {status.stage === 'done' && (
        <Alert type="success">
          生成完成！共 {status.brickCount} 块零件
        </Alert>
      )}

      {status.error && (
        <Alert type="error">
          {status.error}
        </Alert>
      )}
    </Card>
  );
}

// 3. 结果展示集成示例
export function IntegratedResult({ design }: { design: any }) {
  const downloadFile = (format: string) => {
    window.location.href = `/api/export/${design.id}?format=${format}`;
  };

  return (
    <div style={{ display: 'grid', gap: '24px' }}>
      <Card title="模型信息">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
          <div>
            <Badge variant="info">{design.bricks.length} 块</Badge>
            <p style={{ fontSize: '12px', marginTop: '8px' }}>零件总数</p>
          </div>
          <div>
            <Badge variant="success">{design.steps.length} 步</Badge>
            <p style={{ fontSize: '12px', marginTop: '8px' }}>拼装步骤</p>
          </div>
          <div>
            <Badge variant="warning">¥{design.estimatedCost}</Badge>
            <p style={{ fontSize: '12px', marginTop: '8px' }}>预估费用</p>
          </div>
        </div>
      </Card>

      <Card title="下载文件">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <Button
            variant="primary"
            onClick={() => downloadFile('html')}
          >
            📄 拼装说明书 (HTML)
          </Button>
          <Button
            variant="secondary"
            onClick={() => downloadFile('csv')}
          >
            📋 零件清单 (CSV)
          </Button>
          <Button
            variant="secondary"
            onClick={() => downloadFile('ldraw')}
          >
            🎨 3D 模型 (LDraw)
          </Button>
        </div>
      </Card>
    </div>
  );
}

// 4. 完整工作流程示例
export function FullWorkflowExample() {
  const [step, setStep] = useState<'upload' | 'processing' | 'result'>('upload');
  const [designData, setDesignData] = useState<any>(null);

  return (
    <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '40px 20px' }}>
      {/* 进度指示器 */}
      <div style={{ marginBottom: '40px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: '20px' }}>
          <Badge variant={step === 'upload' ? 'info' : 'success'}>
            1. 上传
          </Badge>
          <Badge variant={step === 'processing' ? 'info' : step === 'result' ? 'success' : 'info'}>
            2. 生成
          </Badge>
          <Badge variant={step === 'result' ? 'info' : 'info'}>
            3. 下载
          </Badge>
        </div>
      </div>

      {/* 当前步骤内容 */}
      {step === 'upload' && (
        <IntegratedUpload />
      )}

      {step === 'processing' && (
        <IntegratedProgress status={{ stage: 'voxelization', message: '正在转换...' }} />
      )}

      {step === 'result' && designData && (
        <IntegratedResult design={designData} />
      )}
    </div>
  );
}

// 5. 如何在现有页面中使用
/*
// 在 app/page.tsx 中:
import { IntegratedUpload } from './integration-guide';

export default function HomePage() {
  return (
    <div>
      <IntegratedUpload />
    </div>
  );
}
*/

// 6. 主题切换示例
export function ThemeToggle() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
    document.documentElement.classList.toggle('light', newTheme === 'light');
  };

  return (
    <Button onClick={toggleTheme}>
      {theme === 'dark' ? '☀️' : '🌙'} 切换主题
    </Button>
  );
}

export default FullWorkflowExample;
