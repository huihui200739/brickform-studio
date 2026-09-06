'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import {
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  Layers3,
  LoaderCircle,
} from 'lucide-react';
import { PALETTE, type Model } from '@/lib/brick-engine';
export default function ModelViewer({
  model,
  layer,
  exploded,
  onExplode,
}: {
  model: Model;
  layer: number;
  exploded: boolean;
  onExplode: () => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const control = useRef<{
    zoom: (f: number) => void;
    reset: () => void;
    update: (layer: number, exploded: boolean) => void;
  } | null>(null);
  const viewState = useRef({ layer, exploded });
  viewState.current = { layer, exploded };
  const [error, setError] = useState(''),
    [ready, setReady] = useState(false);
  useEffect(() => {
    if (!mount.current) return;
    const el = mount.current;
    setError('');
    setReady(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError('此设备无法启动 3D，请使用下方的分步图纸。');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor('#f1f3f5');
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.3;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      'aria-label',
      '积木模型：拖动旋转、滚轮缩放，使用工具栏复位。',
    );
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene(),
      camera = new THREE.PerspectiveCamera(32, 1, 0.1, 2000);
    const size = Math.max(model.width, model.height * 0.4, model.depth),
      target = new THREE.Vector3(0, model.height * 0.2, 0);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.copy(target);
    orbit.enableDamping = true;
    orbit.minDistance = size * 0.7;
    orbit.maxDistance = size * 7;
    orbit.maxPolarAngle = Math.PI * 0.49;
    orbit.enablePan = false;
    const fit = () => {
      const verticalFov = THREE.MathUtils.degToRad(camera.fov),
        fov = Math.min(
          verticalFov,
          2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect),
        );
      const tall = model.height * 0.4 * (viewState.current.exploded ? 1.55 : 1);
      const radius = Math.hypot(model.width, tall, model.depth) / 2;
      orbit.target.set(0, tall / 2, 0);
      camera.position.copy(
        new THREE.Vector3(0.92, 0.62, 1.5)
          .normalize()
          .multiplyScalar((radius / Math.sin(fov / 2)) * 1.12)
          .add(orbit.target),
      );
      orbit.update();
    };
    scene.add(new THREE.HemisphereLight('#ffffff', '#758399', 2.5));
    const keyLight = new THREE.DirectionalLight('#ffffff', 3.6);
    keyLight.position.set(-size, size * 1.8, size * 1.4);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    Object.assign(keyLight.shadow.camera, {
      left: -size,
      right: size,
      top: size,
      bottom: -size,
      near: 0.1,
      far: size * 6,
    });
    keyLight.shadow.normalBias = 0.05;
    keyLight.shadow.bias = -0.0001;
    scene.add(keyLight);
    const fill = new THREE.DirectionalLight('#deebff', 1.2);
    fill.position.set(size, size, -size);
    scene.add(fill);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 8, size * 8),
      new THREE.ShadowMaterial({ color: '#17283b', opacity: 0.16 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(
      size * 4,
      Math.round(size * 2),
      '#acb8c5',
      '#bdc7d2',
    );
    grid.position.y = -0.04;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.24;
    scene.add(grid);
    const bodyGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.025),
      studGeometry = new THREE.CylinderGeometry(0.295, 0.3, 0.17, 20);
    const object = new THREE.Object3D();
    const materials: THREE.Material[] = [];
    const groups: {
      bricks: Model['bricks'];
      bodies: THREE.InstancedMesh;
      studs: THREE.InstancedMesh;
    }[] = [];
    PALETTE.forEach((color, index) => {
      const bricks = model.bricks.filter((b) => b.color === index);
      if (!bricks.length) return;
      const mat = new THREE.MeshStandardMaterial({
        color: color.hex,
        roughness: 0.3,
        metalness: 0,
      });
      materials.push(mat);
      const bodies = new THREE.InstancedMesh(bodyGeometry, mat, bricks.length),
        studs = new THREE.InstancedMesh(
          studGeometry,
          mat,
          bricks.reduce((n, b) => n + b.w * b.d, 0),
        );
      bodies.castShadow = true;
      bodies.receiveShadow = true;
      studs.castShadow = true;
      studs.receiveShadow = true;
      bodies.frustumCulled = false;
      studs.frustumCulled = false;
      scene.add(bodies, studs);
      groups.push({ bricks, bodies, studs });
    });
    const update = (count: number, expand: boolean) => {
      const limit = model.levels[Math.min(count, model.levels.length) - 1];
      for (const { bricks, bodies, studs } of groups) {
        let i = 0;
        bricks.forEach((b, j) => {
          const visible = b.y <= limit,
            base = b.y * 0.4 * (expand ? 1.55 : 1);
          object.position.set(
            b.x + b.w / 2 - model.width / 2,
            base + b.h * 0.2,
            b.z + b.d / 2 - model.depth / 2,
          );
          object.scale.set(
            visible ? b.w - 0.028 : 0,
            visible ? b.h * 0.4 - 0.018 : 0,
            visible ? b.d - 0.028 : 0,
          );
          object.updateMatrix();
          bodies.setMatrixAt(j, object.matrix);
          for (let x = 0; x < b.w; x++)
            for (let z = 0; z < b.d; z++) {
              object.position.set(
                b.x + x + 0.5 - model.width / 2,
                base + b.h * 0.4 + 0.075,
                b.z + z + 0.5 - model.depth / 2,
              );
              object.scale.setScalar(visible ? 1 : 0);
              object.updateMatrix();
              studs.setMatrixAt(i++, object.matrix);
            }
        });
        bodies.instanceMatrix.needsUpdate = true;
        studs.instanceMatrix.needsUpdate = true;
      }
    };
    control.current = {
      zoom: (f) => {
        const v = camera.position.clone().sub(orbit.target);
        v.setLength(
          THREE.MathUtils.clamp(
            v.length() * f,
            orbit.minDistance,
            orbit.maxDistance,
          ),
        );
        camera.position.copy(orbit.target).add(v);
        orbit.update();
      },
      reset: fit,
      update,
    };
    let initial = true;
    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      if (initial) {
        fit();
        initial = false;
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
    update(viewState.current.layer, viewState.current.exploded);
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      orbit.update();
      renderer.render(scene, camera);
    };
    draw();
    setReady(true);
    const lost = (e: Event) => {
      e.preventDefault();
      setError('3D 显示中断，请刷新页面重试。');
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.dispose();
      bodyGeometry.dispose();
      studGeometry.dispose();
      materials.forEach((m) => m.dispose());
      groups.forEach((g) => {
        g.bodies.dispose();
        g.studs.dispose();
      });
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      grid.geometry.dispose();
      gridMaterial.dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.remove();
      control.current = null;
    };
  }, [model]);
  useEffect(() => {
    control.current?.update(layer, exploded);
  }, [layer, exploded]);
  useEffect(() => {
    control.current?.reset();
  }, [exploded]);
  return (
    <div className="viewer">
      <div className="canvas-mount" ref={mount} />
      {!ready && !error && (
        <div className="viewer-message">
          <LoaderCircle className="spin" /> 正在构建 3D 模型
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
          {model.source === 'sample'
            ? '示例模型'
            : model.shape === 'relief'
              ? '轮廓浮雕'
              : '圆润立体'}
        </span>
        <span className="label-line" />
        <span className="model-name" title={model.name}>
          {model.name}
        </span>
      </div>
      <div className="viewer-controls" role="toolbar" aria-label="模型视图工具">
        <button
          title="放大"
          aria-label="放大模型"
          onClick={() => control.current?.zoom(0.85)}
        >
          <Plus size={18} />
        </button>
        <button
          title="缩小"
          aria-label="缩小模型"
          onClick={() => control.current?.zoom(1.18)}
        >
          <Minus size={18} />
        </button>
        <i />
        <button
          title="复位视角"
          aria-label="重置视角"
          onClick={() => control.current?.reset()}
        >
          <RotateCcw size={17} />
        </button>
        <button
          title="展开各搭建层"
          aria-label="分层展开"
          aria-pressed={exploded}
          className={exploded ? 'active' : ''}
          onClick={onExplode}
        >
          <Layers3 size={18} />
        </button>
        <button
          title="全屏预览"
          aria-label="全屏预览"
          onClick={() => {
            if (document.fullscreenElement) void document.exitFullscreen();
            else
              void mount.current?.parentElement
                ?.requestFullscreen()
                .catch(() =>
                  setError('当前浏览器不支持全屏，请使用缩放按钮。'),
                );
          }}
        >
          <Maximize size={17} />
        </button>
      </div>
      <div className="viewer-caption">
        拖动旋转<span>·</span>滚轮缩放<span>·</span>砖块 + 薄板
      </div>
      <div className="axis-label">
        <b>Y</b>
        <span>↗ Z</span>
        <span>→ X</span>
      </div>
    </div>
  );
}
