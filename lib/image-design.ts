import {
  imageToModel,
  validateModel,
  type Model,
  type Options,
  type Raster,
} from './brick-engine.ts';
import { instructionModel } from './build-instructions.ts';

export type ImageDesignOptions = Options & {
  mode: 'auto' | 'sculpture' | 'relief';
};

// Border consistency is a background heuristic, not semantic object recognition.
export function imageTreatment(raster: Raster, options: ImageDesignOptions) {
  const { width, height, data } = raster;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 1024 * 1024 ||
    data.length !== width * height * 4
  )
    throw Error('图片像素数据不完整或过大，请重新上传图片。');
  let opaque = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 100) opaque++;
  if (!opaque)
    throw Error('这张图片完全透明，没有可生成的内容，请换一张图片。');
  const corners = [0, width - 1, (height - 1) * width, width * height - 1];
  const alpha = corners.some((i) => data[i * 4 + 3] <= 100);
  const bg = [0, 1, 2].map(
    (c) => corners.reduce((n, i) => n + data[i * 4 + c], 0) / 4,
  );
  let border = 0,
    similar = 0,
    foreground = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const matches =
        data[i + 3] <= 100 ||
        (!alpha &&
          Math.hypot(
            data[i] - bg[0],
            data[i + 1] - bg[1],
            data[i + 2] - bg[2],
          ) <= options.threshold);
      if (!matches) foreground++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        border++;
        if (matches) similar++;
      }
    }
  const clean = similar / border >= 0.85 && foreground > 0;
  const background: Options['background'] =
    options.background === 'auto' && !clean ? 'keep' : options.background;
  const shape =
    options.mode === 'auto'
      ? background === 'keep'
        ? 'relief'
        : 'sculpture'
      : options.mode;
  const reason =
    options.background === 'auto' && !clean
      ? '背景与主体不易分开，已保留完整画面。可调整背景选项后重新生成。'
      : background === 'keep'
        ? '已保留完整画面与配色。'
        : '已按透明区域或边缘颜色去除背景；如主体被裁掉，请改选保留完整图片。';
  return { background, shape, reason };
}

export function generateImageDesign(
  raster: Raster,
  options: ImageDesignOptions,
  name: string,
): Model {
  if (
    ![20, 28, 36].includes(options.resolution) ||
    !Number.isInteger(options.depth) ||
    options.depth < 4 ||
    options.depth > 20 ||
    !Number.isFinite(options.threshold) ||
    options.threshold < 10 ||
    options.threshold > 180
  )
    throw Error('生成参数超出范围，请重新选择尺寸和厚度。');
  const treatment = imageTreatment(raster, options);
  let raw: Model;
  try {
    raw = imageToModel(raster, { ...options, ...treatment }, name);
  } catch (error) {
    // A white-background setting can remove an all-white picture. Keep the
    // explicit choice actionable; only automatic background may fall back.
    if (options.background !== 'auto') throw error;
    raw = imageToModel(
      raster,
      { ...options, background: 'keep', shape: 'relief' },
      name,
    );
    treatment.background = 'keep';
    treatment.shape = 'relief';
    treatment.reason = '未分离出有效主体，已保留完整画面生成浮雕。';
  }
  const model = instructionModel(raw);
  const steps: NonNullable<Model['assembly']>['steps'] = [];
  // Keep height dependencies, and split long layers into small pick-and-place
  // groups. Every placement has the same id and pose in preview and exports.
  for (const y of raw.levels) {
    const row = model.bricks.filter((b) => b.y === y);
    for (let offset = 0; offset < row.length; offset += 12) {
      const step = steps.length;
      const batch = row.slice(offset, offset + 12);
      for (const b of batch) {
        b.step = step;
        b.section = b.y < 2 ? 'base' : b.support ? 'supports' : 'subject';
      }
      steps.push({
        name: `${y < 2 ? '底座' : '主体'} · 第 ${raw.levels.indexOf(y) + 1} 层${row.length > 12 ? `（${offset / 12 + 1}/${Math.ceil(row.length / 12)}）` : ''}`,
        description:
          y === 0
            ? '先在平面摆好底座零件，第二层会把底部连接起来。'
            : '对照定位图安装，每次完成一块，再继续下一块。标注为支撑的零件也要保留。',
        section: y < 2 ? 'base' : 'subject',
      });
    }
  }
  model.levels = steps.map((_, i) => i);
  model.assembly!.steps = steps;
  model.assembly!.sections = [
    { id: 'subject', name: '图片主体' },
    { id: 'base', name: '底座' },
    ...(model.supportCount ? [{ id: 'supports', name: '辅助支撑' }] : []),
  ];
  model.assembly!.reference = `${treatment.reason} ${treatment.shape === 'sculpture' ? '厚度随轮廓变化，背面按对称轮廓推测；未还原物品真实三维结构。' : '这是带厚度的图片浮雕，保留画面轮廓；未还原物品真实三维结构。'} 同色辅助支撑 ${model.supportCount} 块，已计入清单。`;
  model.imageDesign = {
    shape: treatment.shape,
    background: treatment.background,
    note: treatment.reason,
  };
  const v = validateModel(model);
  if (v.collisions || v.unsupported || v.invalidParts || !v.connected)
    throw Error('这张图片的模型未通过连接检查，请降低尺寸或厚度后重试。');
  return model;
}
