import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { TriangleMesh } from './mesh-types.ts';
import {
  NATIVE_APPEARANCE_SOURCE,
  SOURCE_COLOR_KIND,
  snapshotNativeAppearance,
  colourPipelineAudit,
  type NativeMaterialAppearance,
} from './source-material-provenance.ts';

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
    colors: number[] = [],
    materialIds: number[] = [],
    faceSourceKinds: number[] = [],
    alpha: number[] = [];
  const nativeMaterials = new Map<number, NativeMaterialAppearance>();
  const json = gltf.parser.json as {
    materials?: Array<{
      name?: string;
      pbrMetallicRoughness?: {
        baseColorFactor?: [number, number, number, number];
      };
      alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
      alphaCutoff?: number;
      doubleSided?: boolean;
    }>;
  };
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
        const materialId =
          gltf.parser.associations.get(material)?.materials ?? -1;
        const definition =
          materialId >= 0 ? json.materials?.[materialId] : undefined;
        if (!nativeMaterials.has(materialId))
          nativeMaterials.set(materialId, {
            id: materialId,
            source:
              materialId >= 0
                ? 'explicit-gltf-material'
                : 'gltf-default-material',
            name: definition?.name ?? material.name,
            baseColorFactor: definition?.pbrMetallicRoughness
              ?.baseColorFactor ?? [1, 1, 1, 1],
            alphaMode: definition?.alphaMode ?? 'OPAQUE',
            alphaCutoff: definition?.alphaCutoff ?? 0.5,
            doubleSided: definition?.doubleSided ?? false,
          });
        let sourceKind =
          materialId >= 0
            ? NATIVE_APPEARANCE_SOURCE.materialFactor
            : NATIVE_APPEARANCE_SOURCE.defaultMaterial;
        let sampledAlpha =
          definition?.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1;
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
          sourceKind |= NATIVE_APPEARANCE_SOURCE.vertexColor;
          if (attrs.color.itemSize >= 4)
            sampledAlpha *= ids.reduce(
              (sum, id) => sum + attrs.color.getW(id) / 3,
              0,
            );
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
          sourceKind |= NATIVE_APPEARANCE_SOURCE.textureSample;
          sampledAlpha *= pixels.data[k + 3] / 255;
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
        materialIds.push(materialId);
        faceSourceKinds.push(sourceKind);
        alpha.push(sampledAlpha);
      }
    });
    if (!positions.length) throw Error('GLB 中没有可转换的三角网格。');
    const sampledColors = new Uint8Array(colors);
    const nativeAppearance = snapshotNativeAppearance({
      version: 1,
      method: 'glb-native-appearance',
      intrinsicMaterialVerified: false,
      originalRGB: sampledColors,
      materialIds: Int32Array.from(materialIds),
      faceSourceKinds: Uint8Array.from(faceSourceKinds),
      alpha: Float32Array.from(alpha),
      materials: [...nativeMaterials.values()],
    });
    return {
      positions: new Float32Array(positions),
      colors: sampledColors,
      nativeAppearance,
      colourPipelineAudit: colourPipelineAudit({
        nativeAppearance,
        perFaceSourceKind: new Uint8Array(materialIds.length).fill(
          SOURCE_COLOR_KIND.nativeAppearance,
        ),
      }),
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
