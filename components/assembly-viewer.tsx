'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
  Plus,
  Minus,
  RotateCcw,
  Layers3,
  Maximize,
  LoaderCircle,
} from 'lucide-react';
import { PALETTE, type Model, type Brick } from '@/lib/brick-engine';

import { viewerGeometry, viewerPose } from '@/lib/assembly-render';
import {
  explodedLayers,
  visibleInPreview,
  previewFrame,
} from '@/lib/preview-state';

type MeshData = Record<string, { positions: number[]; normals: number[] }>;
let library: Promise<MeshData> | undefined;
function loadParts() {
  return (library ??= fetch('/parts/geometry.json')
    .then((r) => {
      if (!r.ok) throw Error('零件模型加载失败，请刷新重试。');
      return r.json() as Promise<MeshData>;
    })
    .catch((e) => {
      library = undefined;
      throw e;
    }));
}
export default function AssemblyViewer({
  model,
  layer,
  exploded,
  onExplode,
  section = 'all',
  focusId,
}: {
  model: Model;
  layer: number;
  exploded: boolean;
  onExplode: () => void;
  section?: string;
  focusId?: number;
}) {
  const [firstLayer, setFirstLayer] = useState(0),
    [allLayers, setAllLayers] = useState(false),
    [layerGap, setLayerGap] = useState(0.9);
  const availableSteps = [
    ...new Set(
      model.bricks
        .filter((b) => visibleInPreview(b, { layer, section, focusId }))
        .map((b) => b.step ?? 0),
    ),
  ].sort((a, b) => a - b);
  const first = allLayers
      ? 0
      : Math.min(firstLayer, Math.max(0, availableSteps.length - 1)),
    count = allLayers ? model.levels.length : 6;
  const mount = useRef<HTMLDivElement>(null),
    live = useRef({
      layer,
      exploded,
      section,
      focusId,
      first,
      count,
      layerGap,
    });
  const control = useRef<{
    zoom: (factor: number) => void;
    view: (name: string) => void;
    update: () => void;
  } | null>(null);
  const [failure, setFailure] = useState<{
      model: Model;
      message: string;
    } | null>(null),
    [readyModel, setReadyModel] = useState<Model | null>(null),
    [view, setView] = useState('perspective');
  const ready = readyModel === model,
    error = failure?.model === model ? failure.message : '';
  useEffect(() => {
    let cancelled = false,
      dispose: () => void = () => {};
    loadParts()
      .then((data) => {
        if (cancelled || !mount.current) return;
        const el = mount.current,
          renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor('#eef1f5');
        renderer.shadowMap.enabled = true;
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.05;
        renderer.domElement.setAttribute('role', 'img');
        renderer.domElement.setAttribute(
          'aria-label',
          '小鸭积木模型，拖动旋转，滚轮缩放。',
        );
        el.appendChild(renderer.domElement);
        const scene = new THREE.Scene(),
          camera = new THREE.PerspectiveCamera(34, 1, 0.1, 1000);
        const orbit = new OrbitControls(camera, renderer.domElement);
        orbit.enableDamping = true;
        orbit.enablePan = false;
        orbit.maxPolarAngle = Math.PI * 0.88;
        const size = Math.max(model.width, model.depth, model.height * 0.4);
        orbit.minDistance = size * 0.7;
        orbit.maxDistance = size * 8;
        scene.add(new THREE.HemisphereLight('#ffffff', '#83909f', 2));
        const light = new THREE.DirectionalLight('#fff9ed', 3);
        light.position.set(-size, size * 2, size * 1.5);
        light.castShadow = true;
        light.shadow.mapSize.set(2048, 2048);
        Object.assign(light.shadow.camera, {
          left: -size * 1.7,
          right: size * 1.7,
          top: size * 1.7,
          bottom: -size * 1.7,
          near: 0.1,
          far: size * 8,
        });
        light.shadow.normalBias = 0.025;
        scene.add(light);
        const fill = new THREE.DirectionalLight('#e4efff', 1.5);
        fill.position.set(size, size, -size);
        scene.add(fill);
        const floor = new THREE.Mesh(
          new THREE.PlaneGeometry(size * 15, size * 15),
          new THREE.ShadowMaterial({ opacity: 0.18, color: '#34465b' }),
        );
        floor.rotation.x = -Math.PI / 2;
        floor.position.y = -0.025;
        floor.receiveShadow = true;
        scene.add(floor);
        const geometries = new Map<string, THREE.BufferGeometry>(),
          edgeGeometries = new Map<string, THREE.EdgesGeometry>();
        const materials: THREE.Material[] = [];
        const groups: {
          mesh: THREE.InstancedMesh;
          parts: Brick[];
          edges: THREE.LineSegments[];
        }[] = [];
        const entries = new Map<string, Brick[]>();
        for (const b of model.bricks) {
          const key = `${b.part}-${b.color}`;
          entries.set(key, [...(entries.get(key) || []), b]);
        }
        const lineMaterial = new THREE.LineBasicMaterial({
          color: '#383523',
          transparent: true,
          opacity: 0.16,
        });
        materials.push(lineMaterial);
        for (const parts of entries.values()) {
          const b = parts[0],
            raw = data[b.part];
          if (!raw) throw Error(`缺少 ${b.part} 零件模型。`);
          let geometry = geometries.get(b.part);
          if (!geometry) {
            const converted = viewerGeometry(raw);
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              'position',
              new THREE.Float32BufferAttribute(converted.positions, 3),
            );
            geometry.setAttribute(
              'normal',
              new THREE.Float32BufferAttribute(converted.normals, 3),
            );
            geometries.set(b.part, geometry);
            edgeGeometries.set(b.part, new THREE.EdgesGeometry(geometry, 35));
          }
          const material = new THREE.MeshStandardMaterial({
            color: PALETTE[b.color].hex,
            roughness: 0.27,
            metalness: 0,
          });
          materials.push(material);
          const mesh = new THREE.InstancedMesh(
            geometry,
            material,
            parts.length,
          );
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          mesh.frustumCulled = false;
          scene.add(mesh);
          const edges = parts.map(() => {
            const edge = new THREE.LineSegments(
              edgeGeometries.get(b.part),
              lineMaterial,
            );
            edge.matrixAutoUpdate = false;
            scene.add(edge);
            return edge;
          });
          groups.push({ mesh, parts, edges });
        }
        const m = new THREE.Matrix4(),
          zero = new THREE.Matrix4().makeScale(0, 0, 0);
        const labels = model.levels.map((step) => {
          const canvas = document.createElement('canvas');
          canvas.width = 192;
          canvas.height = 64;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = '#17664b';
          ctx.fillRect(0, 0, 192, 64);
          ctx.font = '500 32px sans-serif';
          ctx.textAlign = 'center';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(`第 ${step + 1} 层`, 96, 44);
          const texture = new THREE.CanvasTexture(canvas);
          const material = new THREE.SpriteMaterial({
            map: texture,
            depthTest: false,
          });
          const sprite = new THREE.Sprite(material);
          sprite.scale.set(4, 1.3, 1);
          scene.add(sprite);
          return { step, sprite, texture, material };
        });
        const visibleBounds = new THREE.Box3();
        const partBounds = new THREE.Box3();
        const update = () => {
          visibleBounds.makeEmpty();
          const eligible = model.bricks.filter((b) =>
            visibleInPreview(b, live.current),
          );
          const layout = explodedLayers(
            eligible,
            live.current.first,
            live.current.count,
            live.current.layerGap,
          );
          for (const label of labels) {
            const level = layout.layers.find((l) => l.step === label.step);
            label.sprite.visible =
              live.current.exploded &&
              !!level &&
              (layout.layers.length <= 8 ||
                label.step % 5 === 0 ||
                label.step === layout.layers.at(-1)?.step);
            if (level)
              label.sprite.position.set(model.width / 2 + 1.7, level.center, 0);
          }
          for (const g of groups) {
            g.parts.forEach((b, i) => {
              const visible =
                visibleInPreview(b, live.current) &&
                (!live.current.exploded || layout.offsets.has(b.step ?? 0));
              if (!visible) {
                g.mesh.setMatrixAt(i, zero);
                g.edges[i].visible = false;
                return;
              }
              m.set(...viewerPose(b.pose!));
              if (live.current.exploded)
                m.elements[13] += layout.offsets.get(b.step ?? 0)!;
              if (!g.mesh.geometry.boundingBox)
                g.mesh.geometry.computeBoundingBox();
              partBounds.copy(g.mesh.geometry.boundingBox!).applyMatrix4(m);
              visibleBounds.union(partBounds);
              g.mesh.setMatrixAt(i, m);
              g.edges[i].matrix.copy(m);
              g.edges[i].visible = true;
            });
            g.mesh.instanceMatrix.needsUpdate = true;
          }
        };
        const alignLabels = (direction: number[]) => {
          const right = new THREE.Vector3(
            direction[2],
            0,
            -direction[0],
          ).normalize();
          const distance =
            (Math.abs(right.x) * model.width) / 2 +
            (Math.abs(right.z) * model.depth) / 2 +
            2;
          for (const label of labels) {
            label.sprite.position.x = right.x * distance;
            label.sprite.position.z = right.z * distance;
          }
        };
        let angle = 'perspective';
        const fit = (name = angle) => {
          angle = name;
          const dirs: Record<string, number[]> = {
            perspective: [-1.3, 0.85, 1.6],
            front: [0, live.current.exploded ? 0.025 : 0.13, 1],
            side: [-1, 0.13, 0],
            back: [0, 0.13, -1],
            top: [0, 1, 0.001],
          };
          const bounds = visibleBounds.isEmpty()
            ? new THREE.Box3(
                new THREE.Vector3(-1, 0, -1),
                new THREE.Vector3(1, 1, 1),
              )
            : visibleBounds.clone();
          alignLabels(dirs[name] || dirs.perspective);
          for (const label of labels)
            if (label.sprite.visible) {
              const p = label.sprite.position;
              bounds.expandByPoint(
                p.clone().add(new THREE.Vector3(2, 0.65, 2)),
              );
              bounds.expandByPoint(
                p.clone().sub(new THREE.Vector3(2, 0.65, 2)),
              );
            }
          const framing = previewFrame(
            bounds.min.toArray(),
            bounds.max.toArray(),
            camera.aspect,
            camera.fov,
          );
          orbit.minDistance = framing.minDistance;
          orbit.maxDistance = Math.max(size * 8, framing.distance * 3);
          orbit.target.fromArray(framing.target);
          camera.position
            .fromArray(dirs[name] || dirs.perspective)
            .normalize()
            .multiplyScalar(framing.distance)
            .add(orbit.target);
          orbit.update();
        };
        control.current = {
          update: () => {
            update();
            fit();
          },
          view: fit,
          zoom: (factor) => {
            camera.position
              .sub(orbit.target)
              .multiplyScalar(factor)
              .clampLength(orbit.minDistance, orbit.maxDistance)
              .add(orbit.target);
            orbit.update();
          },
        };
        const resize = () => {
          const { width, height } = el.getBoundingClientRect();
          if (!width || !height) return;
          renderer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          fit();
        };
        const observer = new ResizeObserver(resize);
        observer.observe(el);
        update();
        resize();
        let frame = 0;
        const draw = () => {
          frame = requestAnimationFrame(draw);
          orbit.update();
          alignLabels(camera.position.clone().sub(orbit.target).toArray());
          renderer.render(scene, camera);
        };
        draw();
        setReadyModel(model);
        const lost = (e: Event) => {
          e.preventDefault();
          setFailure({
            model,
            message: '3D 显示中断，请刷新页面。零件清单与说明书仍可导出。',
          });
        };
        renderer.domElement.addEventListener('webglcontextlost', lost);
        dispose = () => {
          control.current = null;
          cancelAnimationFrame(frame);
          observer.disconnect();
          orbit.dispose();
          geometries.forEach((g) => g.dispose());
          edgeGeometries.forEach((g) => g.dispose());
          materials.forEach((m) => m.dispose());
          labels.forEach((l) => {
            l.texture.dispose();
            l.material.dispose();
          });
          groups.forEach((g) => g.mesh.dispose());
          floor.geometry.dispose();
          (floor.material as THREE.Material).dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      })
      .catch((e) => {
        if (!cancelled)
          setFailure({
            model,
            message:
              e instanceof Error ? e.message : '3D 模型加载失败，请刷新重试。',
          });
      });
    return () => {
      cancelled = true;
      dispose();
    };
  }, [model]);
  useEffect(() => {
    live.current = {
      layer,
      exploded,
      section,
      focusId,
      first,
      count,
      layerGap,
    };
    control.current?.update();
  }, [layer, exploded, section, focusId, first, count, layerGap]);
  useEffect(() => {
    control.current?.view(view);
  }, [exploded, view, readyModel]);
  return (
    <div className="assembly-preview">
      <div className="viewer assembly-viewer">
        <div className="canvas-mount" ref={mount} />
        {!ready && !error && (
          <div className="viewer-message">
            <LoaderCircle className="spin" />
            正在加载真实零件
          </div>
        )}
        {error && (
          <div className="viewer-message" role="alert">
            {error}
          </div>
        )}
        <div className="model-label">
          <span className="live-dot" />
          <span>
            {model.reconstruction ? '体积重建 · 对称背面推测' : '部件模板'}
          </span>
          <span className="label-line" />
          <span>{model.name}</span>
        </div>
        {exploded && (
          <div className="exploded-note">
            按搭建组逐层展开 · 侧装零件在后续层展示 · 收起后恢复安装位置
          </div>
        )}
        <div className="assembly-view-bottom">
          <fieldset className="view-presets" aria-label="观察方向">
            {[
              ['perspective', '立体'],
              ['front', '正面'],
              ['side', '侧面'],
              ['back', '背面'],
              ['top', '俯视'],
            ].map(([v, t]) => (
              <button
                key={v}
                aria-pressed={view === v}
                onClick={() => {
                  setView(v);
                  control.current?.view(v);
                }}
              >
                {t}
              </button>
            ))}
          </fieldset>
          <div className="assembly-tools" role="toolbar" aria-label="模型工具">
            <button
              aria-label="放大模型"
              title="放大"
              onClick={() => control.current?.zoom(0.85)}
            >
              <Plus size={17} />
            </button>
            <button
              aria-label="缩小模型"
              title="缩小"
              onClick={() => control.current?.zoom(1.18)}
            >
              <Minus size={17} />
            </button>
            <button
              aria-label="重置视角"
              title="复位"
              onClick={() => {
                setView('perspective');
                control.current?.view('perspective');
              }}
            >
              <RotateCcw size={17} />
            </button>
            <button
              aria-label={exploded ? '收起分层' : '分层展开'}
              title={exploded ? '收起分层' : '分层展开'}
              aria-pressed={exploded}
              onClick={() => {
                if (!exploded) {
                  setFirstLayer(0);
                  setView('front');
                }
                onExplode();
              }}
            >
              <Layers3 size={17} />
            </button>
            <button
              aria-label="全屏预览"
              title="全屏"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                else
                  void mount.current
                    ?.closest('.assembly-preview')
                    ?.requestFullscreen()
                    .catch(() =>
                      setFailure({ model, message: '当前浏览器不支持全屏。' }),
                    );
              }}
            >
              <Maximize size={17} />
            </button>
          </div>
        </div>
      </div>
      {exploded && (
        <div className="layer-explorer" aria-label="分层展开控制">
          <div className="layer-explorer-heading">
            <strong>分层查看</strong>
            <span>
              {availableSteps.length
                ? `第 ${availableSteps[first] + 1}–${availableSteps[Math.min(first + count, availableSteps.length) - 1] + 1} 层`
                : '当前范围没有零件'}{' '}
              / 共 {model.levels.length} 个搭建组
            </span>
            <fieldset aria-label="展开范围">
              <button
                aria-pressed={!allLayers}
                onClick={() => setAllLayers(false)}
              >
                每次 6 层
              </button>
              <button
                aria-pressed={allLayers}
                onClick={() => setAllLayers(true)}
              >
                全部展开
              </button>
            </fieldset>
            <button className="collapse-layers" onClick={onExplode}>
              收起分层
            </button>
          </div>
          <div className="layer-explorer-controls">
            {!allLayers && (
              <div className="layer-window">
                <button
                  disabled={first === 0}
                  onClick={() => setFirstLayer(Math.max(0, first - 6))}
                >
                  上一组层
                </button>
                <label>
                  起始层{' '}
                  <input
                    type="range"
                    min={1}
                    max={Math.max(1, availableSteps.length)}
                    value={first + 1}
                    aria-valuetext={`第 ${(availableSteps[first] ?? 0) + 1} 层`}
                    onChange={(e) => setFirstLayer(Number(e.target.value) - 1)}
                  />
                </label>
                <button
                  disabled={first + 6 >= availableSteps.length}
                  onClick={() =>
                    setFirstLayer(
                      Math.min(availableSteps.length - 1, first + 6),
                    )
                  }
                >
                  下一组层
                </button>
              </div>
            )}
            <label className="layer-gap">
              层间距{' '}
              <input
                type="range"
                min={0.4}
                max={2}
                step={0.1}
                value={layerGap}
                onChange={(e) => setLayerGap(Number(e.target.value))}
              />
            </label>
          </div>
          <p>
            同一搭建组保持原有相对位置；绿色编号对应下方拼装步骤。展开间距仅用于观察，不代表实物间距。
          </p>
        </div>
      )}
    </div>
  );
}
