import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_IMAGE_PIXELS,
  readWorkspaceImage,
  validateWorkspaceDimensions,
  validateWorkspaceFile,
  workspaceImageSize,
} from './workspace-source.ts';

void test('file validation accepts only PNG, JPEG and WebP without mutating metadata', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
    const file = Object.freeze({ type, size: 123 });
    assert.equal(validateWorkspaceFile(file), undefined);
    assert.deepEqual(file, { type, size: 123 });
  }
  for (const type of ['', 'image/gif', 'image/svg+xml', 'application/pdf'])
    assert.throws(
      () => validateWorkspaceFile({ type, size: 123 }),
      /PNG.*JPEG.*WebP/,
    );
});

void test('10 MiB boundary is inclusive and empty/invalid metadata is rejected', () => {
  assert.doesNotThrow(() =>
    validateWorkspaceFile({
      type: 'image/png',
      size: MAX_WORKSPACE_FILE_BYTES,
    }),
  );
  assert.throws(
    () =>
      validateWorkspaceFile({
        type: 'image/png',
        size: MAX_WORKSPACE_FILE_BYTES + 1,
      }),
    /10 MB/,
  );
  for (const size of [0, -1, 1.5, NaN, Infinity])
    assert.throws(
      () => validateWorkspaceFile({ type: 'image/png', size }),
      /为空或大小无效/,
    );
});

void test('40 million decoded pixels are accepted, larger images are rejected', () => {
  assert.doesNotThrow(() => validateWorkspaceDimensions(8000, 5000));
  assert.doesNotThrow(() =>
    validateWorkspaceDimensions(MAX_WORKSPACE_IMAGE_PIXELS, 1),
  );
  assert.throws(() => validateWorkspaceDimensions(8001, 5000), /4000 万像素/);
  assert.throws(
    () => validateWorkspaceDimensions(Number.MAX_SAFE_INTEGER, 2),
    /4000 万像素/,
  );
});

void test('decoded dimensions must be positive safe integers', () => {
  for (const [width, height] of [
    [0, 1],
    [1, 0],
    [-1, 1],
    [1.5, 2],
    [NaN, 1],
    [1, Infinity],
  ])
    assert.throws(() => validateWorkspaceDimensions(width, height), /尺寸无效/);
});

void test('raster and reconstruction sizes preserve ratio, never upscale, and keep one pixel', () => {
  assert.deepEqual(workspaceImageSize(4000, 3000, 128), {
    width: 128,
    height: 96,
  });
  assert.deepEqual(workspaceImageSize(3000, 4000, 1024), {
    width: 768,
    height: 1024,
  });
  assert.deepEqual(workspaceImageSize(80, 40, 128), { width: 80, height: 40 });
  assert.deepEqual(workspaceImageSize(40_000_000, 1, 128), {
    width: 128,
    height: 1,
  });
  assert.deepEqual(workspaceImageSize(1, 40_000_000, 1024), {
    width: 1,
    height: 1024,
  });
  assert.throws(() => workspaceImageSize(1, 1, 0), /目标图片尺寸无效/);
});

void test('readWorkspaceImage validates metadata before browser access', async () => {
  await assert.rejects(
    readWorkspaceImage(new File(['x'], 'not-image.gif', { type: 'image/gif' })),
    /PNG/,
  );
  await assert.rejects(
    readWorkspaceImage(new File(['x'], 'photo.png', { type: 'image/png' })),
    /浏览器/,
  );
});

type BrowserOptions = {
  width?: number;
  height?: number;
  decodeFailure?: boolean;
  readFailure?: boolean;
  canvasFailure?: boolean;
};

/** Browser doubles test data flow and cleanup, not actual codec rendering. */
async function withImageBrowser(
  options: BrowserOptions,
  check: (
    canvases: { width: number; height: number; encodedSize?: number[] }[],
  ) => Promise<void>,
) {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const canvases: { width: number; height: number; encodedSize?: number[] }[] =
    [];
  class FakeReader {
    result = 'data:image/png;base64,aW5wdXQ=';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      queueMicrotask(() =>
        options.readFailure ? this.onerror?.() : this.onload?.(),
      );
    }
  }
  class FakeImage {
    src = '';
    naturalWidth = options.width ?? 4000;
    naturalHeight = options.height ?? 3000;
    async decode() {
      if (options.decodeFailure) throw Error('Native codec failure');
    }
    removeAttribute() {
      this.src = '';
    }
  }
  const fakeDocument = {
    createElement() {
      const canvas = {
        width: 0,
        height: 0,
        encodedSize: undefined as number[] | undefined,
        getContext() {
          if (options.canvasFailure) return null;
          return {
            drawImage() {},
            getImageData(
              _x: number,
              _y: number,
              width: number,
              height: number,
            ) {
              return {
                width,
                height,
                data: new Uint8ClampedArray(width * height * 4).fill(125),
              };
            },
          };
        },
        toDataURL() {
          this.encodedSize = [this.width, this.height];
          return 'data:image/png;base64,cHJldmlldw==';
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  const globals = {
    window: { Image: FakeImage },
    document: fakeDocument,
    FileReader: FakeReader,
  };
  for (const [key, value] of Object.entries(globals)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  try {
    await check(canvases);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

void test('reader produces a 128px RGBA raster and <=1024px data URL used as preview', async () => {
  await withImageBrowser({}, async (canvases) => {
    const source = await readWorkspaceImage(
      new File(['image'], '旅行照片.png', { type: 'image/png' }),
    );
    assert.equal(source.name, '旅行照片');
    assert.equal(source.raster.width, 128);
    assert.equal(source.raster.height, 96);
    assert.equal(source.raster.data.length, 128 * 96 * 4);
    assert.equal(source.raster.data[0], 125);
    assert.equal(source.analysisRaster.width, 320);
    assert.equal(source.analysisRaster.height, 240);
    assert.equal(source.analysisRaster.data.length, 320 * 240 * 4);
    assert.equal(source.analysisRaster.data[0], 125);
    assert.notEqual(
      source.analysisRaster.data,
      source.raster.data,
      'AI evidence must not reuse the reduced silhouette pixels',
    );
    assert.equal(canvases.length, 3);
    assert.equal(source.preview, source.imageData);
    assert.match(source.preview, /^data:image\/png;/);
    assert.deepEqual(canvases[1].encodedSize, [1024, 768]);
    assert.ok(
      canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
    );
  });
});

void test('reader reports a clear decode failure instead of native codec text', async () => {
  await withImageBrowser({ decodeFailure: true }, async (canvases) => {
    await assert.rejects(
      readWorkspaceImage(
        new File(['broken'], 'broken.png', { type: 'image/png' }),
      ),
      /无法解码.*损坏.*重新导出/,
    );
    assert.equal(canvases.length, 0);
  });
});

void test('reader rejects oversized dimensions before canvas allocation', async () => {
  await withImageBrowser({ width: 8001, height: 5000 }, async (canvases) => {
    await assert.rejects(
      readWorkspaceImage(
        new File(['large'], 'large.webp', { type: 'image/webp' }),
      ),
      /4000 万像素/,
    );
    assert.equal(canvases.length, 0);
  });
});

void test('read and Canvas failures provide actionable errors and release buffers', async () => {
  await withImageBrowser({ readFailure: true }, async () => {
    await assert.rejects(
      readWorkspaceImage(new File(['x'], 'photo.jpg', { type: 'image/jpeg' })),
      /无法读取图片文件/,
    );
  });
  await withImageBrowser({ canvasFailure: true }, async (canvases) => {
    await assert.rejects(
      readWorkspaceImage(new File(['x'], 'photo.jpg', { type: 'image/jpeg' })),
      /Canvas/,
    );
    assert.ok(
      canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
    );
  });
});

void test('small portrait images retain their natural dimensions and repeated reads are independent', async () => {
  await withImageBrowser({ width: 25, height: 100 }, async (canvases) => {
    const file = new File(['x'], '.png', { type: 'image/png' });
    const first = await readWorkspaceImage(file);
    const second = await readWorkspaceImage(file);
    assert.equal(first.name, '参考图片');
    assert.deepEqual([first.raster.width, first.raster.height], [25, 100]);
    assert.deepEqual(canvases[1].encodedSize, [25, 100]);
    assert.notEqual(first.raster.data, second.raster.data);
  });
});

void test('image loading never creates object URLs on success or decode failure', async (context) => {
  context.mock.method(URL, 'createObjectURL', () => {
    throw Error('Unexpected object URL creation');
  });
  await withImageBrowser({}, async () => {
    await readWorkspaceImage(
      new File(['x'], 'photo.png', { type: 'image/png' }),
    );
  });
  await withImageBrowser({ decodeFailure: true }, async () => {
    await assert.rejects(
      readWorkspaceImage(new File(['x'], 'photo.png', { type: 'image/png' })),
      /无法解码/,
    );
  });
});
