// Shared validation for the development-only joint multi-view endpoint.
export const VIEW_AXES = ['front', 'side', 'top'] as const;
export function decodeLocalViews(
  input: unknown,
): Array<{ axis: string; bytes: Uint8Array }> {
  if (!Array.isArray(input) || input.length !== 3)
    throw Error('请提供同一模型的正面、侧面和俯视三张图片。');
  return VIEW_AXES.map((axis) => {
    const matches = input.filter(
      (v) => v && typeof v === 'object' && v.axis === axis,
    );
    if (matches.length !== 1) throw Error('每个视角必须有且只有一张图片。');
    const image = matches[0].image;
    if (
      typeof image !== 'string' ||
      !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(image)
    )
      throw Error('请上传 PNG 或 JPG 图片。');
    const bytes = Buffer.from(image.split(',')[1], 'base64');
    if (bytes.length > 5 * 1024 * 1024)
      throw Error('每张图片太大，请缩小后上传。');
    const png =
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg =
      bytes.length >= 3 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255;
    if (!png && !jpeg) throw Error('图片内容与 PNG / JPG 格式不匹配。');
    return { axis, bytes };
  });
}
