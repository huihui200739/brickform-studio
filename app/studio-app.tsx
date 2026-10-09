'use client';
import { lazy, Suspense, useState } from 'react';
import HomePage from './home-new';
import type { WorkspaceSource } from '@/lib/workspace-source';

// Only load Three.js, reconstruction and manual generation after upload; keep
// homepage hydration independent of the large design-engine/viewer bundle.
const WorkspacePage = lazy(() => import('./workspace-new'));

export default function StudioApp() {
  const [source, setSource] = useState<WorkspaceSource | null>(null);
  function changeSource(next: WorkspaceSource | null) {
    setSource(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  return source ? (
    <Suspense
      fallback={
        <main className="container" aria-live="polite">
          <p className="card">图片已读取，正在加载设计工作台…</p>
        </main>
      }
    >
      <WorkspacePage source={source} onBack={() => changeSource(null)} />
    </Suspense>
  ) : (
    <HomePage onUpload={changeSource} />
  );
}
