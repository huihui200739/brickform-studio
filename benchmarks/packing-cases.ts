import { finishModel, sampleModel, type Model } from '../lib/brick-engine.ts';

type Cell = { color: number; support: boolean };
type Solid = (x: number, y: number, z: number) => boolean;
type Colour = (x: number, y: number, z: number) => number;

function volume(
  name: string,
  width: number,
  subjectHeight: number,
  depth: number,
  solid: Solid,
  colour: Colour = () => 7,
) {
  const cells = new Map<string, Cell>();
  for (let y = 0; y < subjectHeight; y++)
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++)
        if (solid(x, y, z))
          cells.set(`${x},${y + 2},${z}`, {
            color: colour(x, y, z),
            support: false,
          });
  return finishModel(
    cells,
    width,
    subjectHeight + 2,
    depth,
    'sample',
    name,
    20,
    7,
  );
}

export type PackingCase = { id: string; create: () => Model };

export const PACKING_CASES: PackingCase[] = [
  {
    id: 'solid-box',
    create: () => volume('solid-box', 8, 9, 6, () => true),
  },
  {
    id: 'striped-box',
    create: () =>
      volume(
        'striped-box',
        8,
        9,
        6,
        () => true,
        (x, y, z) => ((x + y + z) % 2 ? 7 : 8),
      ),
  },
  {
    id: 'noisy-interior-box',
    create: () =>
      volume(
        'noisy-interior-box',
        8,
        9,
        6,
        () => true,
        (x, y, z) => {
          const surface =
            x === 0 || x === 7 || y === 0 || y === 8 || z === 0 || z === 5;
          return surface ? 7 : (x + y + z) % 2 ? 7 : 8;
        },
      ),
  },
  {
    id: 'stairs',
    create: () =>
      volume('stairs', 8, 12, 4, (x, y) => y < 3 + Math.floor(x / 2) * 3),
  },
  {
    id: 'arch',
    create: () =>
      volume('arch', 10, 12, 4, (x, y) => x < 3 || x >= 7 || y >= 7),
  },
  {
    id: 'bridge',
    create: () =>
      volume('bridge', 12, 12, 4, (x, y) => y >= 9 || x < 3 || x >= 9),
  },
  {
    id: 'hollow-tower',
    create: () =>
      volume(
        'hollow-tower',
        10,
        12,
        10,
        (x, _y, z) => x < 2 || x >= 8 || z < 2 || z >= 8,
      ),
  },
  {
    id: 'sample-duck',
    create: () => sampleModel(20, 8),
  },
];
