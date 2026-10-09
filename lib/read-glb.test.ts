import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { deflateSync } from 'node:zlib';
import { readGLB } from './read-glb.ts';
import {
  NATIVE_APPEARANCE_SOURCE,
  SOURCE_COLOR_KIND,
} from './source-material-provenance.ts';

type Material = {
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: { index: number };
  };
  alphaMode?: string;
  alphaCutoff?: number;
};
function glb(
  materials: Material[],
  faces: { material?: number; vertex?: number[]; uv?: boolean }[],
  image?: Uint8Array,
) {
  const chunks: Uint8Array[] = [],
    views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: {
    bufferView: number;
    componentType: number;
    count: number;
    type: string;
    min?: number[];
    max?: number[];
  }[] = [];
  let length = 0;
  const addView = (bytes: Uint8Array) => {
    const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
    padded.set(bytes);
    const id = views.length;
    views.push({ buffer: 0, byteOffset: length, byteLength: bytes.length });
    chunks.push(padded);
    length += padded.length;
    return id;
  };
  const attribute = (
    values: number[],
    type: string,
    count: number,
    bounds = false,
  ) => {
    const array = Float32Array.from(values),
      id = accessors.length;
    accessors.push({
      bufferView: addView(new Uint8Array(array.buffer)),
      componentType: 5126,
      count,
      type,
      ...(bounds ? { min: [0, 0, 0], max: [1, 1, 0] } : {}),
    });
    return id;
  };
  const primitives = faces.map((face) => ({
    attributes: {
      POSITION: attribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3', 3, true),
      ...(face.vertex
        ? {
            COLOR_0: attribute(
              [...face.vertex, ...face.vertex, ...face.vertex],
              'VEC4',
              3,
            ),
          }
        : {}),
      ...(face.uv
        ? { TEXCOORD_0: attribute([0, 0, 1, 0, 0, 1], 'VEC2', 3) }
        : {}),
    },
    ...(face.material === undefined ? {} : { material: face.material }),
  }));
  const imageView = image ? addView(image) : undefined;
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    materials,
    buffers: [{ byteLength: length }],
    bufferViews: views,
    accessors,
    ...(image
      ? {
          images: [{ bufferView: imageView, mimeType: 'image/png' }],
          textures: [{ source: 0 }],
        }
      : {}),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(json)),
    jsonLength = Math.ceil(encoded.length / 4) * 4;
  const result = new Uint8Array(12 + 8 + jsonLength + 8 + length),
    header = new DataView(result.buffer);
  header.setUint32(0, 0x46546c67, true);
  header.setUint32(4, 2, true);
  header.setUint32(8, result.length, true);
  header.setUint32(12, jsonLength, true);
  header.setUint32(16, 0x4e4f534a, true);
  result.fill(32, 20, 20 + jsonLength);
  result.set(encoded, 20);
  header.setUint32(20 + jsonLength, length, true);
  header.setUint32(24 + jsonLength, 0x004e4942, true);
  let offset = 28 + jsonLength;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result.buffer;
}

void test('native missing white is distinct from explicit white and magenta; source RGB is detached from design colours', async () => {
  const source = await readGLB(
    glb(
      [
        { pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } },
        { pbrMetallicRoughness: { baseColorFactor: [1, 0, 1, 1] } },
      ],
      [{}, { material: 0 }, { material: 1 }],
    ),
    'authored appearance fixture',
  );
  const native = source.nativeAppearance!;
  assert.deepEqual(
    Array.from(source.colors),
    [255, 255, 255, 255, 255, 255, 255, 0, 255],
  );
  assert.deepEqual(Array.from(native.originalRGB), Array.from(source.colors));
  assert.deepEqual(Array.from(native.materialIds), [-1, 0, 1]);
  assert.deepEqual(Array.from(native.faceSourceKinds), [
    NATIVE_APPEARANCE_SOURCE.defaultMaterial,
    1,
    1,
  ]);
  assert.equal(native.materials[0].source, 'gltf-default-material');
  assert.equal(native.materials[1].source, 'explicit-gltf-material');
  assert.equal(native.intrinsicMaterialVerified, false);
  assert.ok(Object.isFrozen(native));
  assert.ok(Object.isFrozen(native.materials));
  assert.ok(Object.isFrozen(native.materials[1].baseColorFactor));
  assert.deepEqual(
    Array.from(source.colourPipelineAudit!.perFaceSourceKind),
    [1, 1, 1],
  );
  assert.equal(
    source.colourPipelineAudit!.perFaceSourceKind[0],
    SOURCE_COLOR_KIND.nativeAppearance,
  );
  source.colors[0] = 0;
  assert.equal(native.originalRGB[0], 255);
  assert.equal(source.colourPipelineAudit!.nativeRGB![0], 255);
});

void test('native vertex RGBA, material ID and explicit alpha modes remain appearance evidence, not albedo', async () => {
  const source = await readGLB(
    glb(
      [
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.8] },
          alphaMode: 'BLEND',
        },
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.2] },
          alphaMode: 'MASK',
          alphaCutoff: 0.3,
        },
        {
          pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 0.2] },
          alphaMode: 'OPAQUE',
        },
      ],
      [
        { material: 0, vertex: [1, 0, 1, 0.5] },
        { material: 1 },
        { material: 2 },
      ],
    ),
    'alpha fixture',
  );
  const native = source.nativeAppearance!;
  assert.deepEqual(Array.from(source.colors.slice(0, 3)), [255, 0, 255]);
  assert.deepEqual(
    Array.from(native.materialIds),
    [0, 1, 2],
    'loader material clones keep glTF IDs',
  );
  assert.equal(
    native.faceSourceKinds[0],
    NATIVE_APPEARANCE_SOURCE.materialFactor |
      NATIVE_APPEARANCE_SOURCE.vertexColor,
  );
  assert.ok(Math.abs(native.alpha[0] - 0.4) < 1e-6);
  assert.deepEqual(
    native.materials.map((m) => m.alphaMode),
    ['BLEND', 'MASK', 'OPAQUE'],
  );
  assert.equal(native.materials[1].alphaCutoff, 0.3);
  assert.ok(
    Math.abs(native.alpha[2] - 0.2) < 1e-6,
    'sampled alpha is retained even though OPAQUE ignores it',
  );
});

function png(pixel: number[]) {
  const chunk = (name: string, bytes: Uint8Array) => {
    const result = new Uint8Array(bytes.length + 12),
      view = new DataView(result.buffer);
    view.setUint32(0, bytes.length);
    result.set(new TextEncoder().encode(name), 4);
    result.set(bytes, 8);
    let crc = 0xffffffff;
    for (const value of result.subarray(4, 8 + bytes.length)) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    view.setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
    return result;
  };
  const ihdr = new Uint8Array(13),
    header = new DataView(ihdr.buffer);
  header.setUint32(0, 1);
  header.setUint32(4, 1);
  ihdr.set([8, 6], 8);
  const pieces = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Uint8Array.from([0, ...pixel]))),
    chunk('IEND', new Uint8Array()),
  ];
  const bytes = new Uint8Array(pieces.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const p of pieces) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return bytes;
}

void test('embedded texture RGB and alpha survive as a sampled native sidecar without changing legacy RGB output', async () => {
  const pixel = [128, 64, 32, 128],
    image = png(pixel);
  const keys = ['self', 'document', 'createImageBitmap'] as const;
  const descriptors = keys.map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  let closed = 0;
  // Deterministic one-pixel browser image/canvas shim; no network or inference.
  const shim = {
    self: globalThis,
    createImageBitmap: async (blob: Blob) => {
      assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), image);
      return {
        width: 1,
        height: 1,
        close: () => {
          closed++;
        },
      };
    },
    document: {
      createElement: () => ({
        width: 1,
        height: 1,
        getContext: () => ({
          drawImage: () => {},
          getImageData: () => ({
            width: 1,
            height: 1,
            data: Uint8ClampedArray.from(pixel),
          }),
        }),
      }),
    },
  };
  keys.forEach((key) =>
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: shim[key],
    }),
  );
  try {
    const source = await readGLB(
      glb(
        [
          {
            pbrMetallicRoughness: {
              baseColorFactor: [1, 1, 1, 0.5],
              baseColorTexture: { index: 0 },
            },
            alphaMode: 'BLEND',
          },
        ],
        [{ material: 0, uv: true }],
        image,
      ),
      'texture fixture',
    );
    const native = source.nativeAppearance!;
    assert.deepEqual(Array.from(source.colors), pixel.slice(0, 3));
    assert.deepEqual(Array.from(native.originalRGB), pixel.slice(0, 3));
    assert.equal(
      native.faceSourceKinds[0],
      NATIVE_APPEARANCE_SOURCE.materialFactor |
        NATIVE_APPEARANCE_SOURCE.textureSample,
    );
    assert.ok(Math.abs(native.alpha[0] - (0.5 * 128) / 255) < 1e-6);
    assert.equal(native.materials[0].alphaMode, 'BLEND');
    assert.equal(closed, 1);
  } finally {
    keys.forEach((key, i) => {
      const descriptor = descriptors[i];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
});
