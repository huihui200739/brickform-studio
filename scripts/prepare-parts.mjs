// Vendor the bounded LDraw catalog and bake the original geometry for the viewer.
// Run explicitly when changing the catalog; never fetch parts in a user's session.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { LDrawLoader } from 'three/addons/loaders/LDrawLoader.js';
import { Vector3 } from 'three';
import { LDrawConditionalLineMaterial } from 'three/addons/materials/LDrawConditionalLineMaterial.js';
const run = promisify(execFile);
const root = 'vendor/ldraw';
const roots = [
  '3001',
  '3003',
  '3010',
  '3004',
  '3005',
  '3020',
  '3022',
  '3710',
  '3023',
  '3024',
  '3034',
  '3036',
  '3068b',
  '3069b',
  '3070b',
  '15068',
  '88930',
  '93606',
  '93273',
  '49307',
  '11477',
  '24201',
  '3039',
  '3040b',
  '87087',
  '98138',
  '3062b',
  '87580',
  '2423',
  '3941',
  '4740',
  '85861',
  '6126b',
  '973',
  '3818',
  '3819',
  '3820',
  '3815b',
  '3816c',
  '3817c',
  '3626c',
  '3844',
  '3846',
  '4497',
];
const cache = new Map();
let active = 0;
const waiting = [];
async function slot(fn) {
  if (active >= 2) await new Promise((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}
async function fetchPart(name, isRoot = false) {
  name = name.replaceAll('\\', '/').toLowerCase();
  if (cache.has(name)) return cache.get(name);
  const promise = (async () => {
    let source;
    try {
      source = await readFile(path.join(root, name), 'utf8');
    } catch {
      const folders =
        name.startsWith('s/') || isRoot ? ['parts'] : ['p', 'parts'];
      for (const folder of folders) {
        try {
          source = await slot(
            async () =>
              (
                await run(
                  'curl',
                  [
                    '--fail',
                    '--silent',
                    '--show-error',
                    '--max-time',
                    '30',
                    '--retry',
                    '4',
                    '--retry-delay',
                    '3',
                    `https://library.ldraw.org/library/official/${folder}/${name}`,
                  ],
                  { maxBuffer: 4e6 },
                )
              ).stdout,
          );
          if (!source.startsWith('0 ')) throw Error('Not LDraw');
          break;
        } catch (e) {
          if (folder === folders.at(-1)) throw e;
        }
      }
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), source);
      console.log('Fetched', name);
    }
    const deps = source
      .split(/\r?\n/)
      .filter((s) => /^\s*1\s/.test(s))
      .map((s) => s.trim().split(/\s+/).slice(14).join(' '));
    await Promise.all([...new Set(deps)].map((n) => fetchPart(n)));
    return source;
  })();
  cache.set(name, promise);
  return promise;
}
await Promise.all(roots.map((p) => fetchPart(p + '.dat', true)));
const all = await Promise.all(
  [...cache].map(async ([name, p]) => [name, await p]),
);
const embedded = all.map(([n, s]) => `0 FILE ${n}\n${s}\n`).join('');
const result = {};
for (const part of roots) {
  const loader = new LDrawLoader();
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);
  loader.addDefaultMaterials();
  loader.setFileMap(Object.fromEntries(all.map(([n]) => [n, n])));
  const text = `0 FILE main.ldr\n0 Main\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 ${part}.dat\n${embedded}`;
  const group = await new Promise((resolve, reject) =>
    loader.parse(text, resolve, reject),
  );
  group.updateMatrixWorld(true);
  const positions = [],
    normals = [];
  const point = new Vector3(),
    normal = new Vector3();
  group.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry;
    const p = g.attributes.position,
      n = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      point.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      normal.fromBufferAttribute(n, i).transformDirection(o.matrixWorld);
      positions.push(...point.toArray().map((v) => +v.toFixed(4)));
      normals.push(...normal.toArray().map((v) => +v.toFixed(4)));
    }
  });
  // Mirrored LDraw subparts (e.g. left/right arms) carry negative transforms.
  // Once baked, preserve outward winding instead of relying on renderer state.
  for (let i = 0; i < positions.length; i += 9) {
    const a = positions.slice(i, i + 3),
      b = positions.slice(i + 3, i + 6).map((v, k) => v - a[k]),
      c = positions.slice(i + 6, i + 9).map((v, k) => v - a[k]);
    const cross = [
      b[1] * c[2] - b[2] * c[1],
      b[2] * c[0] - b[0] * c[2],
      b[0] * c[1] - b[1] * c[0],
    ];
    if (cross.reduce((sum, v, k) => sum + v * normals[i + k], 0) < 0)
      for (let k = 0; k < 3; k++) {
        [positions[i + 3 + k], positions[i + 6 + k]] = [
          positions[i + 6 + k],
          positions[i + 3 + k],
        ];
        [normals[i + 3 + k], normals[i + 6 + k]] = [
          normals[i + 6 + k],
          normals[i + 3 + k],
        ];
      }
  }
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], positions[i]);
    max[i % 3] = Math.max(max[i % 3], positions[i]);
  }
  result[part] = { positions, normals, min, max };
  console.log(part, positions.length / 9, 'triangles', min, max);
}
await mkdir('public/parts', { recursive: true });
await writeFile('public/parts/geometry.json', JSON.stringify(result));
await writeFile(
  'public/parts/ATTRIBUTION.txt',
  `Geometry derived from the LDraw.org Official Parts Library.\nSource: https://library.ldraw.org/library/official/\nLicense: https://creativecommons.org/licenses/by/4.0/\nOriginal files retained in vendor/ldraw. Meshes triangulated using Three.js LDrawLoader.\nThe LEGO Group does not sponsor or endorse LDraw or Brickform.\n\n` +
    all
      .map(
        ([n, s]) =>
          `${n}\n${s
            .split(/\r?\n/)
            .filter((l) => /^0 (Author:|!LICENSE|!LDRAW_ORG)/.test(l))
            .join('\n')}\n`,
      )
      .join('\n'),
);

// Compact, original-mesh diagrams and extents shared by instructions and placement.
const special = roots.slice(roots.indexOf('3062b'));
await writeFile(
  'lib/special-part-data.ts',
  '// Generated from vendored LDraw geometry by scripts/prepare-parts.mjs.\nexport const SPECIAL_DATA: Record<string, { min: number[]; max: number[]; triangles: number[][] }> = ' +
    JSON.stringify(
      Object.fromEntries(
        special.map((id) => {
          const { positions, min, max } = result[id];
          const triangles = [];
          for (let i = 0; i < positions.length; i += 9)
            triangles.push(positions.slice(i, i + 9));
          return [id, { min, max, triangles }];
        }),
      ),
    ) +
    ';\n',
);
