import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { TriangleMesh } from './mesh-types.ts';

export async function readGLB(
  buffer: ArrayBuffer,
  name: string,
): Promise<TriangleMesh> {
  if (
    buffer.byteLength < 20 ||
    buffer.byteLength > 24 * 1024 * 1024 ||
    new DataView(buffer).getUint32(0, true) !== 0x46546c67
  )
    throw Error('请选择不超过 24 MB 的 GLB 三维模型。');
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (!url.startsWith('blob:') && !url.startsWith('data:'))
      throw Error('请使用内嵌纹理的 GLB，不能加载外部资源。');
    return url;
  });
  const loader = new GLTFLoader(manager);
  const gltf = await loader.parseAsync(buffer, '');
  gltf.scene.updateMatrixWorld(true);
  const positions: number[] = [],
    colors: number[] = [];
  const textures = new Map<
    THREE.Texture,
    { width: number; height: number; data: Uint8ClampedArray }
  >();
  const v = new THREE.Vector3(),
    uv = new THREE.Vector2();
  try {
    gltf.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh) || !object.visible) return;
      const geometry = object.geometry as THREE.BufferGeometry,
        attrs = geometry.attributes,
        index = geometry.index;
      if (!attrs.position) return;
      const count = index ? index.count : attrs.position.count;
      if (positions.length / 9 + count / 3 > 250000)
        throw Error('网格超过 25 万个三角面，请先简化后导入。');
      for (let i = 0; i + 2 < count; i += 3) {
        const group = geometry.groups.find(
          (g) => i >= g.start && i < g.start + g.count,
        );
        const material = (
          Array.isArray(object.material)
            ? object.material[group?.materialIndex || 0]
            : object.material
        ) as THREE.MeshStandardMaterial;
        const c = (material.color || new THREE.Color(1, 1, 1)).clone();
        const ids = [0, 1, 2].map((j) => (index ? index.getX(i + j) : i + j));
        for (const id of ids) {
          v.fromBufferAttribute(attrs.position, id).applyMatrix4(
            object.matrixWorld,
          );
          positions.push(v.x, v.y, v.z);
        }
        if (attrs.color) {
          const vertex = new THREE.Color(0, 0, 0);
          for (const id of ids) {
            vertex.r += attrs.color.getX(id) / 3;
            vertex.g += attrs.color.getY(id) / 3;
            vertex.b += attrs.color.getZ(id) / 3;
          }
          c.multiply(vertex);
        }
        const map = material.map;
        if (map && attrs.uv && map.image) {
          const image = map.image as CanvasImageSource & {
            width: number;
            height: number;
          };
          let pixels = textures.get(map);
          if (!pixels) {
            const canvas = document.createElement('canvas');
            canvas.width = Math.min(512, image.width);
            canvas.height = Math.min(512, image.height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (!ctx) throw Error('无法读取模型纹理。');
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
            textures.set(map, pixels);
          }
          uv.set(
            ids.reduce((n, id) => n + attrs.uv.getX(id), 0) / 3,
            ids.reduce((n, id) => n + attrs.uv.getY(id), 0) / 3,
          );
          map.transformUv(uv);
          const x = Math.min(
              pixels.width - 1,
              Math.max(0, Math.floor(uv.x * pixels.width)),
            ),
            y = Math.min(
              pixels.height - 1,
              Math.max(0, Math.floor(uv.y * pixels.height)),
            ),
            k = (y * pixels.width + x) * 4;
          c.multiply(
            new THREE.Color().setRGB(
              pixels.data[k] / 255,
              pixels.data[k + 1] / 255,
              pixels.data[k + 2] / 255,
              THREE.SRGBColorSpace,
            ),
          );
        }
        c.convertLinearToSRGB();
        colors.push(
          Math.round(c.r * 255),
          Math.round(c.g * 255),
          Math.round(c.b * 255),
        );
      }
    });
    if (!positions.length) throw Error('GLB 中没有可转换的三角网格。');
    return {
      positions: new Float32Array(positions),
      colors: new Uint8Array(colors),
      name,
    };
  } finally {
    gltf.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
        for (const m of Array.isArray(object.material)
          ? object.material
          : [object.material])
          m.dispose();
      }
    });
    for (const texture of textures.keys()) {
      texture.dispose();
      (texture.image as { close?: () => void } | undefined)?.close?.();
    }
  }
}
