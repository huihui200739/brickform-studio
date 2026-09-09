import {
  generateImageDesign,
  type ImageDesignOptions,
} from './image-design.ts';
import type { Raster } from './brick-engine.ts';
self.onmessage = (
  event: MessageEvent<{
    raster: Raster;
    options: ImageDesignOptions;
    name: string;
  }>,
) => {
  try {
    const { raster, options, name } = event.data;
    self.postMessage({ model: generateImageDesign(raster, options, name) });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : '生成失败，请换一张图片重试。',
    });
  }
};
