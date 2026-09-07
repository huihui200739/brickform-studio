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
  const mount = useRef<HTMLDivElement>(null),
    live = useRef({ layer, exploded, section, focusId });
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
            geometry = new THREE.BufferGeometry();
            geometry.setAttribute(
              'position',
              new THREE.Float32BufferAttribute(raw.positions, 3),
            );
            geometry.setAttribute(
              'normal',
              new THREE.Float32BufferAttribute(raw.normals, 3),
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
          convert = new THREE.Matrix4().makeScale(0.05, -0.05, 0.05),
          zero = new THREE.Matrix4().makeScale(0, 0, 0);
        const update = () => {
          for (const g of groups) {
            g.parts.forEach((b, i) => {
              const visible =
                (b.step || 0) < live.current.layer &&
                (live.current.focusId === undefined ||
                  b.step !== live.current.layer - 1 ||
                  b.id <= live.current.focusId) &&
                (live.current.section === 'all' ||
                  b.section === live.current.section);
              if (!visible) {
                g.mesh.setMatrixAt(i, zero);
                g.edges[i].visible = false;
                return;
              }
              const { matrix: r, position: p } = b.pose!;
              m.set(
                r[0],
                r[1],
                r[2],
                p[0],
                r[3],
                r[4],
                r[5],
                p[1],
                r[6],
                r[7],
                r[8],
                p[2],
                0,
                0,
                0,
                1,
              );
              m.premultiply(convert);
              if (live.current.exploded) {
                if (
                  b.section === 'head' ||
                  b.section === 'beak' ||
                  b.section === 'eyes'
                )
                  m.elements[13] += 5;
                if (b.section === 'beak') m.elements[14] += 3;
                if (b.section === 'eyes') m.elements[12] += Math.sign(p[0]) * 3;
                if (b.section === 'wings')
                  m.elements[12] += Math.sign(p[0]) * 3;
                if (b.section === 'tail') m.elements[14] -= 3;
              }
              g.mesh.setMatrixAt(i, m);
              g.edges[i].matrix.copy(m);
              g.edges[i].visible = true;
            });
            g.mesh.instanceMatrix.needsUpdate = true;
          }
        };
        let angle = 'perspective';
        const fit = (name = angle) => {
          angle = name;
          const dirs: Record<string, number[]> = {
            perspective: [-1.3, 0.85, 1.6],
            front: [0, 0.13, 1],
            side: [-1, 0.13, 0],
            back: [0, 0.13, -1],
            top: [0, 1, 0.001],
          };
          const height = model.height * 0.4 + (live.current.exploded ? 5 : 0),
            extra = live.current.exploded ? 6 : 0;
          const radius =
            Math.hypot(model.width + extra, model.depth + extra, height) / 2;
          const fov = Math.min(
            THREE.MathUtils.degToRad(camera.fov),
            2 *
              Math.atan(
                Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) *
                  camera.aspect,
              ),
          );
          orbit.target.set(0, height / 2, 0);
          camera.position
            .fromArray(dirs[name] || dirs.perspective)
            .normalize()
            .multiplyScalar((radius / Math.sin(fov / 2)) * 1.06)
            .add(orbit.target);
          orbit.update();
        };
        control.current = {
          update,
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
        let first = true;
        const resize = () => {
          const { width, height } = el.getBoundingClientRect();
          if (!width || !height) return;
          renderer.setSize(width, height);
          camera.aspect = width / height;
          camera.updateProjectionMatrix();
          if (first) {
            fit();
            first = false;
          }
        };
        const observer = new ResizeObserver(resize);
        observer.observe(el);
        resize();
        update();
        let frame = 0;
        const draw = () => {
          frame = requestAnimationFrame(draw);
          orbit.update();
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
    live.current = { layer, exploded, section, focusId };
    control.current?.update();
  }, [layer, exploded, section, focusId]);
  useEffect(() => {
    control.current?.view(view);
  }, [exploded, view, readyModel]);
  return (
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
          部件已分离展示 · 安装位置以完整模型为准
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
            aria-label="展开部件"
            title="展开部件"
            aria-pressed={exploded}
            onClick={onExplode}
          >
            <Layers3 size={17} />
          </button>
          <button
            aria-label="全屏预览"
            title="全屏"
            onClick={() => {
              if (document.fullscreenElement) void document.exitFullscreen();
              else
                void mount.current?.parentElement
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
  );
}
