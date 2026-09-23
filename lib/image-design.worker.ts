import type { ComponentRegion } from './semantic-components.ts';
import {
  detectRefinements,
  mergeRefinementRegions,
} from './semantic-refinement.ts';
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
self.onmessage = async (
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
    autoSemanticRefinement?: boolean;
    camera?: { yaw: number; pitch: number; perspective: number };
  }>,
) => {
  try {
    let { raster, options, name, mesh, regions = [] } = event.data;
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
    // Do not manufacture a central subject from image coordinates.  A
    // fallback relief is only consumed when an upstream detector has produced
    // an explicit, anchored region (or when a caller supplies legacy
    // `mesh.statueFallback` data).  This keeps unrelated references such as
    // towers from acquiring a fake statue.
    let refined = regions.filter((r) => !r.autoRefinement);
    if (event.data.autoSemanticRefinement !== false && raster) {
      try {
        const found = await detectRefinements(
          mesh,
          raster,
          options.resolution,
          undefined,
          event.data.camera || mesh.coloring,
        );
        refined = mergeRefinementRegions(regions, found);
      } catch {
        // Semantic alignment is optional. A detector failure must never remove
        // geometry or prevent ordinary mesh-to-brick conversion.
        refined = regions.filter((r) => !r.autoRefinement);
      }
    }
    if (event.data.action === 'components') {
      self.postMessage({ regions: refined, reports: [], dropped: [] });
      return;
    }
    // Component placement never blocks the finished product: anything that
    // cannot be seated is reported instead of failing the whole conversion.
    const auto = refined.length
      ? meshToDesignAuto(mesh, options.resolution, refined, 48, {
          image: raster,
          camera: event.data.camera || mesh.coloring,
        })
      : {
          model: meshToDesign(mesh, options.resolution, [], {
            image: raster,
            camera: event.data.camera || mesh.coloring,
          }),
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
