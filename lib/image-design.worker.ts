import {
  generateImageDesign,
  type ImageDesignOptions,
} from './image-design.ts';
import { meshToDesign } from './mesh-design.ts';
import type { TriangleMesh } from './mesh-types.ts';
import type { Raster } from './brick-engine.ts';
self.onmessage = (
  event: MessageEvent<{
    mesh?: TriangleMesh;
    raster: Raster;
    options: ImageDesignOptions;
    name: string;
  }>,
) => {
  try {
    const { raster, options, name, mesh } = event.data;
    self.postMessage({
      model: mesh
        ? meshToDesign(mesh, options.resolution)
        : generateImageDesign(raster, options, name),
    });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : '生成失败，请换一张图片重试。',
    });
  }
};
