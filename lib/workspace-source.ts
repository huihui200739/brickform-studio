import type { Raster } from './brick-engine.ts';

export type WorkspaceSource = {
  /** Fast outline packing; never reuse this reduced raster for tiny AI objects. */
  raster: Raster;
  /** Match the preserved workbench's evidence resolution for color and identity. */
  analysisRaster: Raster;
  imageData: string;
  preview: string;
  name: string;
};

export const MAX_WORKSPACE_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WORKSPACE_IMAGE_PIXELS = 40_000_000;
export const WORKSPACE_RASTER_EDGE = 128;
export const WORKSPACE_ANALYSIS_EDGE = 320;
export const WORKSPACE_IMAGE_EDGE = 1024;

const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const decodeError =
  '无法解码这张图片。文件可能已损坏，或不是有效的 PNG、JPEG 或 WebP；请重新导出后重试。';

/** Metadata-only validation: no browser globals, file reads, or side effects. */
export function validateWorkspaceFile(file: Pick<File, 'type' | 'size'>): void {
  if (!supportedTypes.has(file.type))
    throw Error('请选择 PNG、JPEG（JPG）或 WebP 图片，不支持其他文件类型。');
  if (!Number.isSafeInteger(file.size) || file.size <= 0)
    throw Error('图片文件为空或大小无效，请重新选择图片。');
  if (file.size > MAX_WORKSPACE_FILE_BYTES)
    throw Error('图片超过 10 MB，请压缩后重试。');
}

/** Validate decoded dimensions before allocating any canvas pixel buffers. */
export function validateWorkspaceDimensions(
  width: number,
  height: number,
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  )
    throw Error('图片尺寸无效，请重新导出为 PNG、JPEG 或 WebP 后重试。');
  if (width > MAX_WORKSPACE_IMAGE_PIXELS / height)
    throw Error('图片尺寸过大，请缩小到 4000 万像素以内。');
}

/** Preserve aspect ratio, never upscale, and retain at least one pixel per side. */
export function workspaceImageSize(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  validateWorkspaceDimensions(width, height);
  if (!Number.isSafeInteger(maxEdge) || maxEdge < 1)
    throw Error('目标图片尺寸无效。');
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

function readDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (
        typeof reader.result !== 'string' ||
        !reader.result.startsWith('data:')
      )
        reject(Error('无法读取图片文件，请重新选择后重试。'));
      else resolve(reader.result);
    };
    reader.onerror = () =>
      reject(Error('无法读取图片文件，请重新选择后重试。'));
    reader.onabort = () => reject(Error('图片读取已取消，请重试。'));
    reader.readAsDataURL(file);
  });
}

/**
 * All three scales use the same decoded orientation, with no upscaling:
 * 128px for outline packing, 320px for AI identity/color, <=1024px for reconstruction.
 * Preview reuses the bounded PNG data URL. Every temporary canvas is released,
 * including failures; no object URL is created or retained.
 */
export async function readWorkspaceImage(file: File): Promise<WorkspaceSource> {
  validateWorkspaceFile(file);
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof FileReader === 'undefined'
  )
    throw Error('当前环境无法读取图片，请在支持 Canvas 的浏览器中重试。');

  const inputData = await readDataURL(file);
  const image = new window.Image();
  const canvases: HTMLCanvasElement[] = [];
  try {
    try {
      image.src = inputData;
      await image.decode();
    } catch {
      throw Error(decodeError);
    }
    validateWorkspaceDimensions(image.naturalWidth, image.naturalHeight);

    const rasterSize = workspaceImageSize(
      image.naturalWidth,
      image.naturalHeight,
      WORKSPACE_RASTER_EDGE,
    );
    const rasterCanvas = document.createElement('canvas');
    canvases.push(rasterCanvas);
    rasterCanvas.width = rasterSize.width;
    rasterCanvas.height = rasterSize.height;
    const rasterContext = rasterCanvas.getContext('2d', {
      willReadFrequently: true,
    });
    if (!rasterContext)
      throw Error('浏览器无法读取图片像素，请使用支持 Canvas 的浏览器重试。');

    const imageSize = workspaceImageSize(
      image.naturalWidth,
      image.naturalHeight,
      WORKSPACE_IMAGE_EDGE,
    );
    const photoCanvas = document.createElement('canvas');
    canvases.push(photoCanvas);
    photoCanvas.width = imageSize.width;
    photoCanvas.height = imageSize.height;
    const photoContext = photoCanvas.getContext('2d');
    if (!photoContext)
      throw Error('浏览器无法准备重建参考图，请使用支持 Canvas 的浏览器重试。');

    const analysisSize = workspaceImageSize(
      image.naturalWidth,
      image.naturalHeight,
      WORKSPACE_ANALYSIS_EDGE,
    );
    const analysisCanvas = document.createElement('canvas');
    canvases.push(analysisCanvas);
    analysisCanvas.width = analysisSize.width;
    analysisCanvas.height = analysisSize.height;
    const analysisContext = analysisCanvas.getContext('2d', {
      willReadFrequently: true,
    });
    if (!analysisContext)
      throw Error(
        '浏览器无法准备细节分析图片，请使用支持 Canvas 的浏览器重试。',
      );

    try {
      rasterContext.drawImage(image, 0, 0, rasterSize.width, rasterSize.height);
      const pixels = rasterContext.getImageData(
        0,
        0,
        rasterSize.width,
        rasterSize.height,
      );
      analysisContext.drawImage(
        image,
        0,
        0,
        analysisSize.width,
        analysisSize.height,
      );
      const detailPixels = analysisContext.getImageData(
        0,
        0,
        analysisSize.width,
        analysisSize.height,
      );
      photoContext.drawImage(image, 0, 0, imageSize.width, imageSize.height);
      const imageData = photoCanvas.toDataURL('image/png');
      if (!imageData.startsWith('data:image/png;'))
        throw Error('Invalid canvas image data');
      return {
        raster: {
          width: pixels.width,
          height: pixels.height,
          data: pixels.data,
        },
        analysisRaster: {
          width: detailPixels.width,
          height: detailPixels.height,
          data: detailPixels.data,
        },
        imageData,
        preview: imageData,
        name:
          file.name
            .replace(/\.[^.]+$/, '')
            .trim()
            .slice(0, 80) || '参考图片',
      };
    } catch {
      throw Error('无法处理这张图片，请重新导出为 PNG、JPEG 或 WebP 后重试。');
    }
  } finally {
    image.removeAttribute('src');
    // Returned ImageData arrays are independent of all temporary canvas buffers.
    for (const canvas of canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
