import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import AssemblyViewer from '../components/assembly-viewer';
import type { Model } from '../lib/brick-engine';

// Browser regression fixture only. Keep the actual viewer, renderer, component
// state and entry-point CSS; replay a saved model without conversion/inference.
function FullscreenFixture({ model, advanced }: { model: Model; advanced: boolean }) {
  const [exploded, setExploded] = useState(false);
  return (
    <div className={advanced ? 'studio-v3' : 'workspace-page'}>
      <main className="workspace-main">
        <div className="container">
          <section className={advanced ? 'preview-panel' : 'card result-preview'}>
            <AssemblyViewer
              model={model}
              layer={model.levels.length}
              exploded={exploded}
              onExplode={() => setExploded((value) => !value)}
            />
          </section>
        </div>
      </main>
    </div>
  );
}

export async function renderFullscreenFixture(model: Model, advanced: boolean) {
  if (!advanced) {
    await import('../app/design-tokens.css');
    await import('../app/workspace.css');
    await import('../app/workspace-live.css');
  }
  for (const child of document.body.children) {
    if (child instanceof HTMLElement) child.style.display = 'none';
  }
  const mount = document.createElement('div');
  mount.dataset.fullscreenRegression = 'actual-product-viewer';
  document.body.appendChild(mount);
  createRoot(mount).render(
    <FullscreenFixture model={model} advanced={advanced} />,
  );
}
