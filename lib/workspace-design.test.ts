import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import {
  generateWorkspaceDesign,
  packWorkspaceDesign,
  WORKSPACE_CONVERSION_TIMEOUT,
  type WorkspaceDesignInput,
  type WorkspaceDesignWorkerPayload,
  type WorkspaceDesignResult,
} from './workspace-design.ts';
import type { ComponentRegion } from './semantic-components.ts';
import type { Raster } from './brick-engine.ts';

function input(signal = new AbortController().signal): WorkspaceDesignInput {
  const geometry = new BoxGeometry(8, 8, 8).toNonIndexed();
  const positions = new Float32Array(geometry.attributes.position.array);
  const colors = new Uint8Array(positions.length / 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([242, 205, 55], i);
  geometry.dispose();
  const data = new Uint8ClampedArray(16 * 16 * 4).fill(255);
  return {
    mesh: { positions, colors, name: 'generic-cube' },
    raster: { width: 16, height: 16, data },
    resolution: 20,
    signal,
  };
}
function weakRegion(): ComponentRegion {
  return {
    id: 'unverified-color-patch',
    kind: 'tree',
    source: 'color',
    autoRefinement: true,
    autoScoreWithInstallation: 1,
    anchor: [0.5, 0.5, 0.5],
    width: 6,
    height: 10,
    depth: 6,
    rotation: 0,
  };
}
const convert = async (payload: WorkspaceDesignWorkerPayload) =>
  packWorkspaceDesign(payload);

void test('explicit design colour mode reaches the packing worker without additional detection or geometry changes', async () => {
  const source = { ...input(), detailEnhancement: false };
  const original = await generateWorkspaceDesign(source, { convert });
  for (const colorMode of ['coherent', 'clean', 'faithful'] as const) {
    let conversions = 0;
    const result = await generateWorkspaceDesign(
      { ...source, colorMode },
      {
        detect: async () => {
          throw Error('colour changes must not start detection');
        },
        convert: async (payload) => {
          conversions++;
          assert.equal(payload.options.colorMode, colorMode);
          assert.equal(payload.autoSemanticRefinement, false);
          return packWorkspaceDesign(payload);
        },
      },
    );
    assert.equal(conversions, 1);
    assert.deepEqual(
      result.model.bricks,
      original.model.bricks,
      'no source ledger: retain every original brick',
    );
    assert.equal(result.model.resolution, 20);
    if (colorMode !== 'faithful') {
      assert.equal(result.model.colorDesign?.changedBricks, 0);
      assert.equal(result.model.colorDesign?.approximation, true);
      assert.equal(result.model.colorDesign?.mode, colorMode);
    } else assert.equal(result.model.colorDesign, undefined);
  }
});

void test('enhancement defaults on, detects once, then converts with evidence and complete worker metadata', async () => {
  const phases: string[] = [];
  const source = input();
  source.onPhase = (phase) => phases.push(phase);
  let detections = 0;
  let conversions = 0;
  const result = await generateWorkspaceDesign(source, {
    detect: async () => {
      detections++;
      return [weakRegion()];
    },
    convert: async (payload, signal, timeout) => {
      conversions++;
      assert.equal(signal, source.signal);
      assert.equal(timeout, WORKSPACE_CONVERSION_TIMEOUT);
      assert.equal(payload.action, 'workspace-design');
      assert.equal(
        payload.autoSemanticRefinement,
        false,
        'prevents duplicate detection, not placement',
      );
      assert.equal(payload.detailEnhancement, true);
      assert.equal(payload.regions.length, 1);
      return packWorkspaceDesign(payload);
    },
  });
  assert.equal(detections, 1);
  assert.equal(conversions, 1);
  assert.equal(phases.length, 2);
  assert.match(phases[0], /识别/);
  assert.match(phases[1], /连接/);
  assert.equal(result.quality.detected, 1);
  assert.equal(
    result.quality.applied,
    0,
    'color patches cannot authorize an invented tree',
  );
  assert.equal(result.quality.preserved, 1);
  assert.equal(result.quality.status, 'preserved');
  assert.equal(result.dropped[0].id, 'unverified-color-patch');
  assert.equal(result.reports.length, 1);
  assert.match(result.quality.warning!, /保留原几何/);
});

void test('independent detector AbortError stops conversion even before the outer signal is aborted', async () => {
  const source = input();
  let conversions = 0;
  await assert.rejects(
    generateWorkspaceDesign(source, {
      detect: async () => {
        throw new DOMException('Detection stopped', 'AbortError');
      },
      convert: async (payload) => {
        conversions++;
        return packWorkspaceDesign(payload);
      },
    }),
    (error: unknown) =>
      error instanceof DOMException && error.name === 'AbortError',
  );
  assert.equal(source.signal.aborted, false);
  assert.equal(
    conversions,
    0,
    'cancellation must not launch a disguised basic fallback',
  );
});

void test('explicit enhancement-off is basic and performs no detector or semantic request', async () => {
  const result = await generateWorkspaceDesign(
    { ...input(), detailEnhancement: false },
    {
      detect: async () => {
        throw Error('must not detect');
      },
      fetch: async () => {
        throw Error('must not request');
      },
      convert,
    },
  );
  assert.equal(result.quality.status, 'basic');
  assert.equal(result.quality.detected + result.quality.applied, 0);
  assert.match(result.quality.summary, /已关闭/);
  assert.match(result.model.assembly!.reference, /已关闭细节增强/);
});

void test('successful no-candidate detection is distinguished from unavailable service', async () => {
  const result = await generateWorkspaceDesign(input(), {
    detect: async () => [],
    convert,
  });
  assert.equal(result.quality.status, 'no-candidates');
  assert.equal(result.quality.warning, undefined);
  assert.match(result.quality.summary, /没有可验证/);
});

void test('detector failure visibly degrades once and discards stale automatic replacements', async () => {
  const source = input();
  source.regions = [weakRegion()];
  let calls = 0;
  const result = await generateWorkspaceDesign(source, {
    detect: async () => {
      throw Error('scene engine unavailable');
    },
    convert: async (payload) => {
      calls++;
      assert.equal(payload.regions.length, 0);
      return packWorkspaceDesign(payload);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.quality.status, 'degraded');
  assert.match(result.quality.warning!, /scene engine unavailable/);
  assert.match(result.quality.summary, /已保留原网格/);
  assert.equal(source.regions.length, 1, 'caller metadata is not mutated');
});

void test('unconfigured or nonlocal detector readiness never triggers a POST', async () => {
  for (const status of [
    { configured: false, provider: 'local' },
    { configured: true, provider: 'cloud' },
  ]) {
    let requests = 0;
    const result = await generateWorkspaceDesign(input(), {
      fetch: async (_url, init) => {
        requests++;
        assert.equal(init?.method, undefined);
        return Response.json(status);
      },
      convert,
    });
    assert.equal(requests, 1);
    assert.equal(result.quality.status, 'degraded');
    assert.ok(result.quality.warning);
  }
});

void test('local detector uses one abortable POST and validates the response against the same source raster', async () => {
  const source = input();
  const requests: RequestInit[] = [];
  const result = await generateWorkspaceDesign(source, {
    fetch: async (url, init) => {
      assert.equal(url, '/api/scene-analysis');
      requests.push(init!);
      assert.ok(init?.signal instanceof AbortSignal);
      if (init?.method !== 'POST')
        return Response.json({ configured: true, provider: 'local' });
      const body = JSON.parse(init.body as string) as {
        width: number;
        height: number;
        rgba: number[];
      };
      assert.deepEqual(body, {
        width: source.raster.width,
        height: source.raster.height,
        rgba: Array.from(source.raster.data),
      });
      return Response.json({
        version: 1,
        imageSize: [16, 16],
        engineFingerprint: 'a'.repeat(64),
        models: {
          detection: {
            repo: 'local-learned-identity',
            revision: 'b'.repeat(40),
          },
        },
        elements: [],
      });
    },
    convert,
  });
  assert.equal(requests.length, 2);
  assert.equal(result.quality.status, 'no-candidates');
});

void test('invalid scene evidence is a disclosed degradation, never authorization for a component', async () => {
  const result = await generateWorkspaceDesign(input(), {
    fetch: async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ version: 1, imageSize: [99, 99], elements: [] })
        : Response.json({ configured: true, provider: 'local' }),
    convert,
  });
  assert.equal(result.quality.status, 'degraded');
  assert.equal(result.quality.applied, 0);
  assert.match(result.quality.warning!, /参考图不匹配/);
});

void test('an already-cancelled run starts no detection, conversion, or phases', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    generateWorkspaceDesign(
      { ...input(controller.signal), onPhase: () => assert.fail('no phase') },
      {
        detect: async () => {
          assert.fail('no detect');
        },
        convert: async () => {
          assert.fail('no convert');
        },
      },
    ),
    { name: 'AbortError' },
  );
});

void test('cancellation settles an ignoring detector and late results cannot start basic conversion', async () => {
  const controller = new AbortController();
  let release!: (regions: ComponentRegion[]) => void;
  let conversions = 0;
  const promise = generateWorkspaceDesign(input(controller.signal), {
    detect: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    convert: async (payload) => {
      conversions++;
      return packWorkspaceDesign(payload);
    },
  });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  release([weakRegion()]);
  await Promise.resolve();
  assert.equal(conversions, 0);
});

void test('the actual POST signal is cancelled, without starting downgrade conversion', async () => {
  const controller = new AbortController();
  let postSignal!: AbortSignal;
  let started!: () => void;
  const postStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const promise = generateWorkspaceDesign(input(controller.signal), {
    fetch: async (_url, init) => {
      if (init?.method !== 'POST')
        return Response.json({ configured: true, provider: 'local' });
      postSignal = init.signal!;
      started();
      return await new Promise<Response>(() => {});
    },
    convert: async () => {
      assert.fail('cancel must not downgrade');
    },
  });
  await postStarted;
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  assert.equal(postSignal.aborted, true);
});

void test('cancelled conversion cannot return a late successful model', async () => {
  const controller = new AbortController();
  let release!: (result: WorkspaceDesignResult) => void;
  let payload!: WorkspaceDesignWorkerPayload;
  let started!: () => void;
  const conversionStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const promise = generateWorkspaceDesign(
    { ...input(controller.signal), detailEnhancement: false },
    {
      convert: async (value) => {
        payload = value;
        started();
        return await new Promise((resolve) => {
          release = resolve;
        });
      },
    },
  );
  await conversionStarted;
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
  release(packWorkspaceDesign(payload));
});

void test('conversion errors remain errors and never retry as basic', async () => {
  const failure = Error('actual packing failed');
  let conversions = 0;
  await assert.rejects(
    generateWorkspaceDesign(input(), {
      detect: async () => [],
      convert: async () => {
        conversions++;
        throw failure;
      },
    }),
    (error) => error === failure,
  );
  assert.equal(conversions, 1);
});

void test('strict validation rejects an empty or mismatched-precision conversion result', async () => {
  for (const kind of ['empty', 'precision'])
    await assert.rejects(
      generateWorkspaceDesign(
        { ...input(), detailEnhancement: false },
        {
          convert: async (payload) => {
            const result = packWorkspaceDesign(payload);
            if (kind === 'empty')
              result.model = { ...result.model, bricks: [], levels: [] };
            else result.model = { ...result.model, resolution: 9 };
            return result;
          },
        },
      ),
      /有效零件|精度/,
    );
});

void test('component metadata alone cannot masquerade as visible, actually built enhancement', async () => {
  await assert.rejects(
    generateWorkspaceDesign(input(), {
      detect: async () => [],
      convert: async (payload) => ({
        ...packWorkspaceDesign(payload),
        applied: [weakRegion()],
      }),
    }),
    /实际零件与可见性/,
  );
});

void test('workspace worker returns the full design envelope and never redetects supplied regions', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  const messages: unknown[] = [];
  const worker = {
    onmessage: null as null | ((event: MessageEvent<unknown>) => Promise<void>),
    postMessage: (value: unknown) => messages.push(value),
  };
  Object.defineProperty(globalThis, 'self', {
    configurable: true,
    value: worker,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'self', previous);
    else Reflect.deleteProperty(globalThis, 'self');
  });
  await import('./image-design.worker.ts');
  const source = input();
  const payload = {
    action: 'workspace-design',
    mesh: source.mesh,
    raster: source.raster,
    name: source.mesh.name,
    options: { resolution: source.resolution },
    regions: [weakRegion()],
    autoSemanticRefinement: true,
    detailEnhancement: true,
    detectedCount: 1,
  };
  await worker.onmessage!(new MessageEvent('message', { data: payload }));
  const message = messages[0] as {
    design?: WorkspaceDesignResult;
    error?: string;
  };
  assert.equal(message.error, undefined);
  assert.ok(message.design?.model.bricks.length);
  assert.equal(message.design.quality.status, 'preserved');
  assert.equal(message.design.dropped.length, 1);
  assert.equal(message.design.reports.length, 1);
  await worker.onmessage!(
    new MessageEvent('message', { data: { ...payload, mesh: undefined } }),
  );
  assert.match((messages[1] as { error: string }).error, /缺少已确认/);
});

void test('enhanced status requires a real connected visible component, not just its name', async () => {
  const source = input();
  source.regions = [
    {
      id: 'manual-tree',
      kind: 'tree',
      source: 'manual',
      confirmed: true,
      anchor: [0.5, 1, 0.5],
      width: 2,
      depth: 2,
      height: 8,
      rotation: 0,
      templateId: 'tree-small-round',
    },
  ];
  const result = await generateWorkspaceDesign(source, {
    detect: async () => [],
    convert,
  });
  assert.equal(result.quality.status, 'enhanced');
  assert.equal(result.quality.applied, 1);
  const region = result.applied[0];
  assert.equal(
    region.source,
    'manual',
    'explicit user choice is not manufactured learned identity',
  );
  assert.equal(region.representationResult!.committed, true);
  assert.equal(region.representationResult!.visibleFromReference, true);
  assert.ok(region.representationResult!.bbox3d);
  assert.ok(region.representationResult!.brickCount > 0);
  assert.ok(
    region.representationResult!.brickIds.every((id) =>
      result.model.bricks.some((b) => b.id === id),
    ),
  );
  assert.match(result.quality.summary, /未确认部分仍保留原网格/);
});

void test('an uncommitted representation is rejected even when metadata points to actual model IDs', async () => {
  await assert.rejects(
    generateWorkspaceDesign(input(), {
      detect: async () => [],
      convert: async (payload) => {
        const result = packWorkspaceDesign(payload);
        result.applied = [
          {
            ...weakRegion(),
            representationResult: {
              elementId: 'invented-component',
              requestedKind: 'component',
              actualKind: 'component',
              committed: false,
              visibleFromReference: true,
              brickIds: [result.model.bricks[0].id],
              brickCount: 1,
              bbox3d: { min: [0, 0, 0], max: [1, 1, 1] },
              fallbackLevel: 0,
              failureReasons: [],
            },
          },
        ];
        return result;
      },
    }),
    /实际零件与可见性/,
  );
});

void test('quality conversion never mutates the original mesh or source pixel buffer', async () => {
  const source = input();
  const before = structuredClone({
    mesh: source.mesh,
    raster: source.raster,
  } satisfies { raster: Raster; mesh: WorkspaceDesignInput['mesh'] });
  await generateWorkspaceDesign(source, {
    detect: async () => [weakRegion()],
    convert,
  });
  assert.deepEqual(source.mesh, before.mesh);
  assert.deepEqual(source.raster, before.raster);
});
