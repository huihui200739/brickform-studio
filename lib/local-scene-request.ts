/** Bound the native runtime's input before allocating or launching inference. */
export function decodeSceneRaster(value: unknown) {
  if (!value || typeof value !== 'object') throw Error('请提供参考图。');
  const { width, height, rgba } = value as {
    width: number;
    height: number;
    rgba: number[];
  };
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 2 ||
    height < 2 ||
    width > 512 ||
    height > 512 ||
    !Array.isArray(rgba) ||
    rgba.length !== width * height * 4 ||
    !rgba.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  )
    throw Error('参考图像素无效或超过本机识别尺寸。');
  return { width, height, data: Uint8Array.from(rgba) };
}
