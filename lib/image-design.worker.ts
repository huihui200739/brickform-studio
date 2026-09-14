import type { ComponentRegion } from './semantic-components.ts';
import { suggestComponents } from './semantic-components.ts';
import {
  generateImageDesign,
  type ImageDesignOptions,
} from './image-design.ts';
import { meshToDesign, meshToDesignAuto } from './mesh-design.ts';
import { carveMultiView, type MultiView } from './multiview.ts';
import { blueprintToModel, readFront } from './brick-reader.ts';
import { colorFromReference } from './reference-colors.ts';
import type { TriangleMesh } from './mesh-types.ts';
import type { Raster } from './brick-engine.ts';
self.onmessage = (
  event: MessageEvent<{
    mesh?: TriangleMesh;
    regions?: ComponentRegion[];
    views?: MultiView[];
    raster: Raster;
    options: ImageDesignOptions;
    name: string;
    action?: 'color' | 'components' | 'views' | 'blueprint';
    pitch?: number;
    depth?: number;
    softenShadows?: boolean;
    statue?: boolean;
    camera?: { yaw: number; pitch: number; perspective: number };
  }>,
) => {
  try {
    const { raster, options, name, mesh, regions = [] } = event.data;
    if (event.data.action === 'color' && mesh) {
      self.postMessage({
        mesh: colorFromReference(
          mesh,
          raster,
          event.data.camera,
          event.data.softenShadows,
        ),
      });
      return;
    }
    // Three-view mode: the volume is the intersection of the outlines, so no
    // mesh and no colour projection are involved at all.
    if (event.data.action === 'views') {
      self.postMessage({
        model: carveMultiView(event.data.views || [], options.resolution, name),
      });
      return;
    }
    // Face reading: the reference picture is itself a brick model, so the
    // layout is read off the facade instead of being guessed.
    if (event.data.action === 'blueprint') {
      const blueprint = readFront(raster, { pitch: event.data.pitch });
      self.postMessage({
        model: blueprintToModel(
          blueprint,
          event.data.depth ?? 8,
          options.resolution,
          name,
        ),
      });
      return;
    }
    if (!mesh) {
      self.postMessage({ model: generateImageDesign(raster, options, name) });
      return;
    }
    // Automatic pass: find catalogue components and hand back the ones that can
    // actually be seated. The caller only needs the resolved regions.
    if (event.data.action === 'components') {
      const hints = suggestComponents(mesh, options.resolution, {
        statue: event.data.statue,
      });
      if (!hints.length) {
        self.postMessage({ regions: [], dropped: [] });
        return;
      }
      const auto = meshToDesignAuto(mesh, options.resolution, hints);
      self.postMessage({
        regions: [
          ...auto.applied,
          ...auto.dropped.map((r) => ({
            ...r,
            placementStatus: auto.reports.find((p) => p.id === r.id)?.status,
          })),
        ],
        reports: auto.reports,
        dropped: auto.dropped.map((r) => r.id),
        attempts: auto.attempts,
      });
      return;
    }
    // Component placement never blocks the finished product: anything that
    // cannot be seated is reported instead of failing the whole conversion.
    const auto = regions.length
      ? meshToDesignAuto(mesh, options.resolution, regions)
      : {
          model: meshToDesign(mesh, options.resolution),
          applied: [] as ComponentRegion[],
          dropped: [] as ComponentRegion[],
        };
    self.postMessage({
      model: auto.model,
      applied: auto.applied.length,
      regions: [
        ...auto.applied,
        ...auto.dropped.map((r) => ({
          ...r,
          placementStatus: auto.model.componentPlacement?.find(
            (p) => p.id === r.id,
          )?.status,
        })),
      ],
      reports: auto.model.componentPlacement || [],
      dropped: auto.dropped.map((r) => r.id),
    });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : '生成失败，请换一张图片重试。',
    });
  }
};
