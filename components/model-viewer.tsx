'use client';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
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
  } | null>(null);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!mount.current) return;
    const el = mount.current;
    setError('');
    setReady(false);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setError('当前设备无法启动 3D。你仍可查看下方分层图纸和零件清单。');
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor('#edf1eb');
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute(
      'aria-label',
      '积木模型 3D 预览。拖动旋转，滚轮缩放。',
    );
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
    const size = Math.max(model.width, model.height * 1.2, model.depth);
    const target = new THREE.Vector3(0, model.height * 0.56, 0);
    camera.position.set(size * 0.92, size * 0.95, size * 1.42);
    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.target.copy(target);
    orbit.enableDamping = true;
    orbit.minDistance = size * 0.65;
    orbit.maxDistance = size * 4.5;
    orbit.maxPolarAngle = Math.PI * 0.49;
    orbit.enablePan = false;
    orbit.update();
    orbit.saveState();
    control.current = {
      zoom: (f) => {
        camera.position.sub(orbit.target).multiplyScalar(f).add(orbit.target);
        orbit.update();
      },
      reset: () => orbit.reset(),
    };
    scene.add(new THREE.HemisphereLight('#ffffff', '#788b71', 2.7));
    const light = new THREE.DirectionalLight('#fff9e9', 3.5);
    light.position.set(-size, size * 2, size);
    light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048);
    Object.assign(light.shadow.camera, {
      left: -size,
      right: size,
      top: size,
      bottom: -size,
      near: 0.1,
      far: size * 6,
    });
    light.shadow.normalBias = 0.08;
    light.shadow.bias = -0.0002;
    scene.add(light);
    const fill = new THREE.DirectionalLight('#edf5ff', 1.4);
    fill.position.set(size, size * 0.5, -size);
    scene.add(fill);
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(size * 18, size * 18),
      new THREE.MeshStandardMaterial({ color: '#edf1eb', roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.03;
    ground.receiveShadow = true;
    scene.add(ground);
    const grid = new THREE.GridHelper(
      size * 8,
      Math.round(size * 8),
      '#cbd4c6',
      '#dce3d7',
    );
    grid.position.y = -0.02;
    scene.add(grid);
    const bodyGeometry = new THREE.BoxGeometry(1, 1, 1);
    const studGeometry = new THREE.CylinderGeometry(0.295, 0.3, 0.18, 16);
    const object = new THREE.Object3D();
    const materials: THREE.Material[] = [];
    PALETTE.forEach((color, index) => {
      const bricks = model.bricks.filter(
        (b) => b.color === index && b.y < layer,
      );
      if (!bricks.length) return;
      const mat = new THREE.MeshStandardMaterial({
        color: color.hex,
        roughness: 0.28,
        metalness: 0.02,
      });
      materials.push(mat);
      const bodies = new THREE.InstancedMesh(bodyGeometry, mat, bricks.length);
      const studCount = bricks.reduce((n, b) => n + b.w * b.d, 0);
      const studs = new THREE.InstancedMesh(studGeometry, mat, studCount);
      let i = 0;
      bricks.forEach((b, j) => {
        const base = b.y * (exploded ? 2.0 : 1.2);
        object.position.set(
          b.x + b.w / 2 - model.width / 2,
          base + 0.59,
          b.z + b.d / 2 - model.depth / 2,
        );
        object.scale.set(b.w - 0.035, 1.17, b.d - 0.035);
        object.updateMatrix();
        bodies.setMatrixAt(j, object.matrix);
        for (let x = 0; x < b.w; x++)
          for (let z = 0; z < b.d; z++) {
            object.position.set(
              b.x + x + 0.5 - model.width / 2,
              base + 1.25,
              b.z + z + 0.5 - model.depth / 2,
            );
            object.scale.set(1, 1, 1);
            object.updateMatrix();
            studs.setMatrixAt(i++, object.matrix);
          }
      });
      bodies.castShadow = true;
      bodies.receiveShadow = true;
      studs.castShadow = true;
      studs.receiveShadow = true;
      scene.add(bodies, studs);
    });
    const resize = () => {
      const { width, height } = el.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    resize();
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
      setError('3D 显示已中断，请刷新页面后重试。');
    };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      orbit.dispose();
      bodyGeometry.dispose();
      studGeometry.dispose();
      materials.forEach((m) => m.dispose());
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.domElement.remove();
      control.current = null;
    };
  }, [model, layer, exploded]);
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
        <span className="live-dot" />{' '}
        {model.source === 'sample' ? '示例模型' : '图片轮廓模型'}
        <span className="label-line" />
        {model.name}
      </div>
      <div className="viewer-controls">
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
          title="重置视角"
          aria-label="重置视角"
          onClick={() => control.current?.reset()}
        >
          <RotateCcw size={17} />
        </button>
        <button
          title="分层展开"
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
            const container = mount.current?.parentElement;
            if (document.fullscreenElement) void document.exitFullscreen();
            else
              void container
                ?.requestFullscreen()
                .catch(() =>
                  setError('此浏览器暂不支持全屏，请使用放大按钮。'),
                );
          }}
        >
          <Maximize size={17} />
        </button>
      </div>
      <div className="viewer-caption">
        拖动旋转<span>·</span>滚轮缩放<span>·</span>含底座与支撑
      </div>
      <div className="axis-label">
        <b>Y</b>
        <span>↗ Z</span>
        <span>→ X</span>
      </div>
    </div>
  );
}
