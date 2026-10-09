import { validateModel, type Model, type Raster } from './brick-engine.ts';
import {
  meshToDesign,
  meshToDesignAuto,
  type AutoComponentResult,
} from './mesh-design.ts';
import type { TriangleMesh } from './mesh-types.ts';
import type { ComponentRegion } from './semantic-components.ts';
import {
  detectRefinements,
  mergeRefinementRegions,
} from './semantic-refinement.ts';
import {
  VisionSceneDetector,
  type VisionSceneResponse,
} from './scene/detectors/vision-detector.ts';
import type { ReferenceCamera } from './reference-colors.ts';

export const WORKSPACE_DETECTION_TIMEOUT = 180000;
export const WORKSPACE_CONVERSION_TIMEOUT = 210000;

export type WorkspaceDesignQuality = {
  status: 'enhanced' | 'basic' | 'no-candidates' | 'preserved' | 'degraded';
  detected: number;
  applied: number;
  preserved: number;
  summary: string;
  warning?: string;
};
export type WorkspaceDesignResult = AutoComponentResult & {
  quality: WorkspaceDesignQuality;
};
export type WorkspaceDesignWorkerPayload = {
  action: 'workspace-design';
  mesh: TriangleMesh;
  raster: Raster;
  name: string;
  options: {
    resolution: number;
    colorMode?: 'coherent' | 'clean' | 'faithful';
  };
  regions: ComponentRegion[];
  camera?: ReferenceCamera;
  // Detection has already run. This flag prevents a second ML request; it does
  // not disable transactional placement of the supplied, evidence-backed regions.
  autoSemanticRefinement: false;
  detailEnhancement: boolean;
  detectedCount: number;
  semanticWarning?: string;
};
export type WorkspaceDesignInput = {
  mesh: TriangleMesh;
  raster: Raster;
  resolution: number;
  signal: AbortSignal;
  detailEnhancement?: boolean;
  colorMode?: 'coherent' | 'clean' | 'faithful';
  regions?: ComponentRegion[];
  camera?: ReferenceCamera;
  onPhase?: (message: string) => void;
};
export type WorkspaceDesignDependencies = {
  convert: (
    payload: WorkspaceDesignWorkerPayload,
    signal: AbortSignal,
    timeout: number,
  ) => Promise<WorkspaceDesignResult>;
  detect?: (input: WorkspaceDesignInput) => Promise<ComponentRegion[]>;
  fetch?: typeof fetch;
};

/** Settle cancellation even if an injected operation ignores its signal. Late
 * results cannot start conversion, release a newer task, or turn abort into basic. */
function abortable<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Stopped', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return run();
      })
      .then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
  });
}

async function detectWorkspaceRegions(
  input: WorkspaceDesignInput,
  fetcher: typeof fetch,
): Promise<ComponentRegion[]> {
  const readiness = await fetcher('/api/scene-analysis', {
    cache: 'no-store',
    signal: AbortSignal.any([input.signal, AbortSignal.timeout(10000)]),
  });
  if (!readiness.ok) throw Error('本机对象识别服务未就绪。');
  const status = (await readiness.json()) as {
    configured?: boolean;
    provider?: string;
  };
  input.signal.throwIfAborted();
  if (status.configured !== true || status.provider !== 'local')
    throw Error('本机对象识别尚未配置，不能验证特殊组件身份。');
  const detector = new VisionSceneDetector(async (image) => {
    input.signal.throwIfAborted();
    const response = await fetcher('/api/scene-analysis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        width: image.width,
        height: image.height,
        rgba: Array.from(image.data),
      }),
      signal: AbortSignal.any([
        input.signal,
        AbortSignal.timeout(WORKSPACE_DETECTION_TIMEOUT),
      ]),
    });
    if (!response.ok) throw Error('本机对象识别暂不可用。');
    return (await response.json()) as VisionSceneResponse;
  });
  return detectRefinements(
    input.mesh,
    input.raster,
    input.resolution,
    undefined,
    input.camera ?? input.mesh.coloring,
    detector,
  );
}

/** Runs only packing inside the worker. Identity, anchor, visibility, negative
 * space, and connector gates remain in meshToDesignAuto; failed trials preserve
 * the source volume. No image category or object template is assumed here. */
export function packWorkspaceDesign(
  payload: WorkspaceDesignWorkerPayload,
): WorkspaceDesignResult {
  const regions = structuredClone(payload.regions);
  const visibility = {
    image: payload.raster,
    camera: payload.camera ?? payload.mesh.coloring,
  };
  const auto: AutoComponentResult = regions.length
    ? meshToDesignAuto(
        payload.mesh,
        payload.options.resolution,
        regions,
        48,
        visibility,
        { colorMode: payload.options.colorMode },
      )
    : {
        model: meshToDesign(
          payload.mesh,
          payload.options.resolution,
          [],
          visibility,
          { colorMode: payload.options.colorMode },
        ),
        applied: [],
        dropped: [],
        reports: [],
        attempts: 0,
      };
  const applied = auto.applied.length;
  const preserved = auto.dropped.length;
  const summary = !payload.detailEnhancement
    ? '已关闭细节增强：仅按原网格生成积木。'
    : payload.semanticWarning
      ? `细节增强未完成：${payload.semanticWarning} 已保留原网格生成积木。`
      : applied
        ? `细节增强：${applied} 处对象通过身份与安装检查${preserved ? `，${preserved} 处未通过，保留原几何` : ''}。未确认部分仍保留原网格。`
        : regions.length
          ? `检测到 ${regions.length} 处候选，但未通过完整安装检查；已保留原几何。`
          : '细节识别完成：没有可验证的特殊组件，保留原网格。';
  const warning = payload.semanticWarning
    ? summary
    : preserved
      ? `${preserved} 处对象未通过安全替换，已保留原几何。`
      : undefined;
  const quality: WorkspaceDesignQuality = {
    status: !payload.detailEnhancement
      ? 'basic'
      : payload.semanticWarning
        ? 'degraded'
        : applied
          ? 'enhanced'
          : regions.length
            ? 'preserved'
            : 'no-candidates',
    detected: payload.detectedCount,
    applied,
    preserved,
    summary,
    ...(warning ? { warning } : {}),
  };
  if (auto.model.assembly) auto.model.assembly.reference += ` ${summary}`;
  return { ...auto, quality };
}

function assertWorkspaceDesign(
  result: WorkspaceDesignResult,
  resolution: number,
) {
  const model: Model = result.model;
  if (!model?.bricks.length || !model.levels.length)
    throw Error('模型中没有有效零件，请调整参考图后重试。');
  const check = validateModel(model);
  if (
    check.collisions ||
    check.unsupported ||
    check.invalidParts ||
    !check.connected
  )
    throw Error('模型未通过重叠与连接检查，不能作为有效积木成品。');
  if (model.resolution !== resolution)
    throw Error('转换结果的精度与当前设置不一致，请重新转换。');
  for (const region of result.applied) {
    const representation = region.representationResult;
    if (
      !representation?.committed ||
      !representation.visibleFromReference ||
      !representation.bbox3d ||
      representation.depthCheck?.passed === false ||
      !representation.brickIds?.length ||
      representation.brickCount !== representation.brickIds.length ||
      !representation.brickIds.every((id) =>
        model.bricks.some((b) => b.id === id),
      )
    )
      throw Error('组件未通过实际零件与可见性检查，不能报告细节增强成功。');
  }
}

/** Detect once, then place in a separate cancellable worker. Detector failure
 * is an explicitly disclosed downgrade; cancellation and packing failure never
 * silently retry as a basic conversion or start another reconstruction job. */
export async function generateWorkspaceDesign(
  input: WorkspaceDesignInput,
  dependencies: WorkspaceDesignDependencies,
): Promise<WorkspaceDesignResult> {
  input.signal.throwIfAborted();
  const enabled = input.detailEnhancement !== false;
  let regions = (input.regions ?? []).filter((r) => !r.autoRefinement);
  let semanticWarning: string | undefined;
  let detectedCount = 0;
  if (enabled) {
    input.onPhase?.('正在识别参考图中的对象，并独立检查身份与安装位置');
    try {
      const found = await abortable(
        () =>
          dependencies.detect
            ? dependencies.detect(input)
            : detectWorkspaceRegions(input, dependencies.fetch ?? fetch),
        input.signal,
      );
      input.signal.throwIfAborted();
      detectedCount = found.length;
      regions = mergeRefinementRegions(input.regions ?? [], found);
    } catch (error) {
      input.signal.throwIfAborted();
      if (
        error &&
        typeof error === 'object' &&
        'name' in error &&
        error.name === 'AbortError'
      )
        throw error;
      semanticWarning =
        error instanceof Error ? error.message : '对象识别未完成。';
    }
  }
  input.signal.throwIfAborted();
  input.onPhase?.(
    semanticWarning
      ? '对象识别未完成，正在保留原网格转换积木并检查连接'
      : '正在安全放置组件、优化积木装配并检查零件连接',
  );
  const result = await abortable(
    () =>
      dependencies.convert(
        {
          action: 'workspace-design',
          mesh: input.mesh,
          raster: input.raster,
          name: input.mesh.name,
          options: {
            resolution: input.resolution,
            ...(input.colorMode ? { colorMode: input.colorMode } : {}),
          },
          regions,
          camera: input.camera ?? input.mesh.coloring,
          autoSemanticRefinement: false,
          detailEnhancement: enabled,
          detectedCount,
          semanticWarning,
        },
        input.signal,
        WORKSPACE_CONVERSION_TIMEOUT,
      ),
    input.signal,
  );
  input.signal.throwIfAborted();
  assertWorkspaceDesign(result, input.resolution);
  return result;
}
