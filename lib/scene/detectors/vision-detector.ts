import type { Raster } from '../../brick-engine.ts';
import { instanceId } from '../../scene-elements.ts';
import type { ElementCategory, SceneElementInstance } from '../scene-types.ts';
import type { SceneDetector } from './detector.ts';
import { LegacySceneDetector } from './legacy-detector.ts';

export type VisionSceneResponse = {
  version: number;
  imageSize: [number, number];
  engineFingerprint: string;
  models: {
    detection: { repo: string; revision: string };
    segmentation: { repo: string; revision: string };
  };
  elements: Array<{
    category: ElementCategory;
    label: string;
    identityScore: number;
    identityThreshold: number;
    identitySupported: boolean;
    maskScore: number;
    imageBox: { x: number; y: number; width: number; height: number };
    anchorUV: [number, number];
    maskSize: [number, number];
    maskRuns: number[];
  }>;
};

export function hasVerifiedIdentity(element?: SceneElementInstance) {
  const identity = element?.identity;
  return (
    element?.detectionSource === 'vision' &&
    identity?.status === 'verified' &&
    Number.isFinite(identity.score) &&
    identity.score >= identity.threshold &&
    identity.threshold >= 0.3 &&
    identity.threshold <= 1 &&
    identity.score <= 1 &&
    !!identity.model &&
    /^[a-f0-9]{40}$/.test(identity.revision) &&
    !!element.imageMask?.some(Boolean)
  );
}

/** Validate runtime data before it can authorize replacement of source geometry. */
export function decodeVisionScene(
  response: VisionSceneResponse,
  image: Raster,
): SceneElementInstance[] {
  if (
    response.version !== 1 ||
    response.imageSize?.[0] !== image.width ||
    response.imageSize?.[1] !== image.height ||
    !/^[a-f0-9]{64}$/.test(response.engineFingerprint) ||
    !response.models?.detection?.repo ||
    !/^[a-f0-9]{40}$/.test(response.models.detection.revision) ||
    !Array.isArray(response.elements) ||
    response.elements.length > 24
  )
    throw Error('对象识别结果与参考图不匹配。');
  const categories = new Set([
    'tree',
    'plant',
    'statue',
    'person',
    'building',
    'vehicle',
    'animal',
    'decor',
    'furniture',
    'brazier',
    'lamp',
  ]);
  return response.elements.map((object) => {
    const box = object.imageBox;
    if (
      !categories.has(object.category) ||
      !box ||
      ![box.x, box.y, box.width, box.height, ...object.anchorUV].every(
        Number.isFinite,
      ) ||
      box.x < 0 ||
      box.y < 0 ||
      box.width <= 0 ||
      box.height <= 0 ||
      box.x + box.width > 1.001 ||
      box.y + box.height > 1.001 ||
      object.anchorUV.some((v) => v < 0 || v > 1) ||
      object.maskSize[0] !== image.width ||
      object.maskSize[1] !== image.height ||
      !Array.isArray(object.maskRuns) ||
      object.maskRuns.length % 2 ||
      object.maskRuns.length > image.width * image.height * 2 ||
      !Number.isFinite(object.identityScore) ||
      object.identityScore < 0 ||
      object.identityScore > 1 ||
      !Number.isFinite(object.identityThreshold) ||
      object.identityThreshold < 0.3 ||
      object.identityThreshold > 1
    )
      throw Error('对象识别证据无效。');
    const mask = new Uint8Array(image.width * image.height);
    let end = 0;
    for (let i = 0; i < object.maskRuns.length; i += 2) {
      const start = object.maskRuns[i],
        length = object.maskRuns[i + 1];
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(length) ||
        start < end ||
        length <= 0 ||
        start + length > mask.length
      )
        throw Error('对象轮廓无效。');
      mask.fill(1, start, start + length);
      end = start + length;
    }
    const element: SceneElementInstance = {
      id: instanceId(object.category, box),
      category: object.category,
      confidence: object.identityScore,
      detectionSource: 'vision',
      imageBox: box,
      imageMask: mask,
      imageMaskSize: object.maskSize,
      anchorUV: object.anchorUV,
      // A flame's bottom is not proof of a bowl/pedestal. The surface solver
      // must still establish an actual mount and the assembler its sockets.
      anchorConfidence: object.category === 'brazier' ? 0.8 : 0.9,
      anchorKind: 'surface',
      identity: {
        status:
          object.identitySupported === true &&
          object.identityScore >= object.identityThreshold &&
          mask.some(Boolean)
            ? 'verified'
            : 'unverified',
        score: object.identityScore,
        threshold: object.identityThreshold,
        label: object.label,
        model: response.models.detection.repo,
        revision: response.models.detection.revision,
        maskScore: object.maskScore,
      },
      evidence: [
        `对象身份：${object.label}，Grounding DINO 原始评分 ${object.identityScore.toFixed(3)}`,
        '实例轮廓由 SlimSAM 分割；安装面仍需独立校准',
      ],
    };
    return element;
  });
}

function intersectionCoverage(
  a: NonNullable<SceneElementInstance['imageBox']>,
  b: NonNullable<SceneElementInstance['imageBox']>,
) {
  const area =
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return (
    area / Math.max(1e-9, Math.min(a.width * a.height, b.width * b.height))
  );
}

/** Only learned instances authorize identity. Color/recess evidence refines
 * placement within an existing learned instance and cannot create another one. */
export class VisionSceneDetector implements SceneDetector {
  private readonly observe: (image: Raster) => Promise<VisionSceneResponse>;
  constructor(
    observe: (image: Raster) => Promise<VisionSceneResponse> = async (
      image,
    ) => {
      const response = await fetch('/api/scene-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          width: image.width,
          height: image.height,
          rgba: Array.from(image.data),
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (!response.ok) throw Error('本机对象识别暂不可用，已保留原网格。');
      return (await response.json()) as VisionSceneResponse;
    },
  ) {
    this.observe = observe;
  }

  async detect(image: Raster): Promise<SceneElementInstance[]> {
    const elements = decodeVisionScene(await this.observe(image), image);
    if (!elements.length) return [];
    const hints = await new LegacySceneDetector().detect(image).catch(() => []);
    return elements.map((element) => {
      const matches = hints.filter(
        (h) =>
          h.category === element.category &&
          h.imageBox &&
          element.imageBox &&
          intersectionCoverage(h.imageBox, element.imageBox) >= 0.5,
      );
      if (matches.length !== 1) return element;
      const hint = matches[0];
      // Preserve accurate existing flame/cavity anchors, after identity has
      // been established independently. Never copy color confidence upward.
      return {
        ...element,
        imageBox: hint.imageBox,
        nicheBox: hint.nicheBox,
        anchorUV: hint.anchorUV,
        anchorConfidence: hint.anchorConfidence,
        anchorKind: hint.anchorKind,
        ...(element.category === 'statue' && hint.imageMask
          ? { imageMask: hint.imageMask, imageMaskSize: hint.imageMaskSize }
          : {}),
        evidence: [...(element.evidence || []), ...(hint.evidence || [])],
      };
    });
  }
}
