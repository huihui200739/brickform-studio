'use client';
import { useEffect, useRef, useState } from 'react';
import type { TriangleMesh } from '@/lib/mesh-types';
export default function MeshDraftViewer({ mesh }: { mesh: TriangleMesh }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false,
      dispose = () => {};
    void Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
    ])
      .then(([T, { OrbitControls }]) => {
        if (cancelled || !host.current) return;
        const el = host.current,
          renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
        renderer.outputColorSpace = T.SRGBColorSpace;
        el.appendChild(renderer.domElement);
        renderer.domElement.setAttribute(
          'aria-label',
          '三维草稿，拖动旋转，滚轮缩放',
        );
        const scene = new T.Scene(),
          camera = new T.PerspectiveCamera(38, 1, 0.01, 1000),
          geometry = new T.BufferGeometry();
        geometry.setAttribute(
          'position',
          new T.BufferAttribute(mesh.positions, 3),
        );
        const colors = new Float32Array(mesh.positions.length);
        for (let i = 0; i < mesh.colors.length / 3; i++) {
          const c = new T.Color().setRGB(
            mesh.colors[i * 3] / 255,
            mesh.colors[i * 3 + 1] / 255,
            mesh.colors[i * 3 + 2] / 255,
            T.SRGBColorSpace,
          );
          for (let j = 0; j < 3; j++)
            colors.set([c.r, c.g, c.b], i * 9 + j * 3);
        }
        geometry.setAttribute('color', new T.BufferAttribute(colors, 3));
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        const box = geometry.boundingBox!,
          center = box.getCenter(new T.Vector3()),
          size = box.getSize(new T.Vector3()),
          extent = Math.max(size.x, size.y, size.z);
        geometry.translate(-center.x, -center.y, -center.z);
        const material = new T.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.85,
          side: T.DoubleSide,
        });
        scene.add(new T.Mesh(geometry, material));
        scene.add(new T.HemisphereLight(0xffffff, 0x78889a, 2.2));
        const light = new T.DirectionalLight(0xffffff, 2.3);
        light.position.set(extent, extent * 2, extent * 3);
        scene.add(light);
        camera.near = extent / 1000;
        camera.far = extent * 100;
        camera.position.set(extent * 1.3, extent * 0.8, extent * 2);
        const controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        const resize = () => {
          renderer.setSize(el.clientWidth, el.clientHeight);
          camera.aspect = el.clientWidth / Math.max(1, el.clientHeight);
          camera.updateProjectionMatrix();
        };
        const observer = new ResizeObserver(resize);
        observer.observe(el);
        resize();
        let frame = 0;
        const draw = () => {
          frame = requestAnimationFrame(draw);
          controls.update();
          renderer.render(scene, camera);
        };
        draw();
        dispose = () => {
          cancelAnimationFrame(frame);
          observer.disconnect();
          controls.dispose();
          geometry.dispose();
          material.dispose();
          renderer.dispose();
          renderer.domElement.remove();
        };
      })
      .catch(() => setError('三维预览未能启动，请使用支持 WebGL 的浏览器。'));
    return () => {
      cancelled = true;
      dispose();
    };
  }, [mesh]);
  return (
    <div className="mesh-draft-canvas" ref={host}>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
