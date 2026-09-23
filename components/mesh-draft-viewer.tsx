'use client';
import { useEffect, useRef, useState } from 'react';
import {
  meshFrame,
  regionPlacement,
  positionedComponent,
  type ComponentRegion,
} from '@/lib/semantic-components';
import { viewerGeometry, viewerPose } from '@/lib/assembly-render';
import { PALETTE } from '@/lib/brick-engine';
import type { V3 } from '@/lib/assembly-catalog';
import type { TriangleMesh } from '@/lib/mesh-types';
export default function MeshDraftViewer({
  mesh,
  regions = [],
  resolution = 28,
  selected = '',
  picking = false,
  onPick,
}: {
  mesh: TriangleMesh;
  regions?: ComponentRegion[];
  resolution?: number;
  selected?: string;
  picking?: boolean;
  onPick?: (point: V3) => void;
}) {
  const selection = useRef({ regions, resolution, selected, picking, onPick });
  selection.current = { regions, resolution, selected, picking, onPick };
  const refresh = useRef<() => void>(() => {});
  useEffect(() => refresh.current(), [regions, resolution, selected, picking]);
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
          new T.BufferAttribute(mesh.positions.slice(), 3),
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
        const box = geometry.boundingBox!.clone(),
          center = box.getCenter(new T.Vector3()),
          size = box.getSize(new T.Vector3()),
          extent = Math.max(size.x, size.y, size.z);
        geometry.translate(-center.x, -center.y, -center.z);
        const material = new T.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.85,
          side: T.DoubleSide,
        });
        const subject = new T.Mesh(geometry, material);
        scene.add(subject);
        const overlay = new T.Group();
        scene.add(overlay);
        let partData: Record<
          string,
          { positions: number[]; normals: number[] }
        > | null = null;
        const updateRegions = () => {
          overlay.traverse((o) => {
            if (o instanceof T.Mesh || o instanceof T.LineSegments) {
              o.geometry.dispose();
              const m = o.material;
              (Array.isArray(m) ? m : [m]).forEach((v) => v.dispose());
            }
          });
          overlay.clear();
          const { regions, resolution, selected, picking } = selection.current;
          renderer.domElement.style.cursor = picking ? 'crosshair' : 'grab';
          const f = meshFrame(mesh, resolution),
            [w, , d] = f.grid;
          for (const r of regions) {
            if (r.placementStatus === 'rejected') continue;
            const p = regionPlacement(r, f.grid);
            if (r.id === selected) {
              const lo = new T.Vector3(
                (p.min[0] - 1) / f.scale + f.min[0] - center.x,
                ((p.min[1] - 2) * 0.4) / f.scale + f.min[1] - center.y,
                (p.min[2] - 1) / f.scale + f.min[2] - center.z,
              );
              const hi = new T.Vector3(
                (p.max[0] - 1) / f.scale + f.min[0] - center.x,
                ((p.max[1] - 2) * 0.4) / f.scale + f.min[1] - center.y,
                (p.max[2] - 1) / f.scale + f.min[2] - center.z,
              );
              overlay.add(new T.Box3Helper(new T.Box3(lo, hi), 0xe17a38));
            }
            if (
              !partData ||
              r.placed === false ||
              (r.placementStatus &&
                !['kept', 'adjusted', 'candidate', 'confirmed', 'auto-applied'].includes(
                  r.placementStatus,
                ))
            )
              continue;
            const assembly = positionedComponent(
              r.kind,
              [(p.x - (w + 2) / 2) * 20, -p.y * 8, (p.z - (d + 2) / 2) * 20],
              r.rotation,
              { width: w + 2, depth: d + 2 },
              r.templateId,
              r.sceneElement,
            );
            const group = new T.Group();
            group.scale.setScalar(1 / f.scale);
            group.position.set(
              w / 2 / f.scale + f.min[0] - center.x,
              -0.8 / f.scale + f.min[1] - center.y,
              d / 2 / f.scale + f.min[2] - center.z,
            );
            for (const b of assembly) {
              const raw = partData[b.part];
              if (!raw) continue;
              const data = viewerGeometry(raw),
                geo = new T.BufferGeometry();
              geo.setAttribute(
                'position',
                new T.Float32BufferAttribute(data.positions, 3),
              );
              geo.setAttribute(
                'normal',
                new T.Float32BufferAttribute(data.normals, 3),
              );
              const obj = new T.Mesh(
                geo,
                new T.MeshStandardMaterial({
                  color: PALETTE[b.color].hex,
                  roughness: 0.4,
                  transparent: !r.confirmed && r.source !== 'manual',
                  opacity: r.confirmed || r.source === 'manual' ? 1 : 0.35,
                }),
              );
              obj.applyMatrix4(new T.Matrix4().set(...viewerPose(b.pose!)));
              group.add(obj);
            }
            overlay.add(group);
          }
          material.transparent = !!selected;
          material.opacity = selected ? 0.65 : 1;
          material.depthWrite = true;
          material.needsUpdate = true;
        };
        refresh.current = updateRegions;
        void fetch('/parts/geometry.json')
          .then((r) => r.json())
          .then((data) => {
            if (!cancelled) {
              partData = data as typeof partData;
              updateRegions();
            }
          })
          .catch(() => {});
        const ray = new T.Raycaster(),
          pointer = new T.Vector2();
        let down = [0, 0];
        const pointerDown = (event: PointerEvent) => {
          down = [event.clientX, event.clientY];
        };
        const pointerUp = (event: PointerEvent) => {
          if (
            !selection.current.picking ||
            Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5
          )
            return;
          const rect = renderer.domElement.getBoundingClientRect();
          pointer.set(
            ((event.clientX - rect.left) / rect.width) * 2 - 1,
            (-(event.clientY - rect.top) / rect.height) * 2 + 1,
          );
          ray.setFromCamera(pointer, camera);
          const hit = ray.intersectObject(subject)[0];
          if (!hit) return;
          const p = hit.point.add(center);
          selection.current.onPick?.(
            [0, 1, 2].map((a) =>
              Math.max(
                0,
                Math.min(
                  1,
                  (p.getComponent(a) - box.min.getComponent(a)) /
                    size.getComponent(a),
                ),
              ),
            ) as V3,
          );
        };
        renderer.domElement.addEventListener('pointerdown', pointerDown);
        renderer.domElement.addEventListener('pointerup', pointerUp);
        updateRegions();
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
          renderer.domElement.removeEventListener('pointerdown', pointerDown);
          renderer.domElement.removeEventListener('pointerup', pointerUp);
          overlay.traverse((o) => {
            if (o instanceof T.Mesh || o instanceof T.LineSegments) {
              o.geometry.dispose();
              const m = o.material;
              (Array.isArray(m) ? m : [m]).forEach((v) => v.dispose());
            }
          });
          refresh.current = () => {};
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
