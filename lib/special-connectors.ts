import type { V3 } from './assembly-catalog.ts';
export type PartPort = { point: V3; type: string; role: 'plug' | 'socket' };
const plug = (point: V3, type = 'stud'): PartPort => ({
  point,
  type,
  role: 'plug',
});
const socket = (point: V3, type = 'stud'): PartPort => ({
  point,
  type,
  role: 'socket',
});
// Seating positions in the original LDraw coordinate system. Accessory and
// minifigure joints require physical review; these points check placement only.
export const SPECIAL_PORTS: Record<string, PartPort[]> = {
  '87580': [
    ...[-10, 10].flatMap((x) => [-10, 10].map((z) => socket([x, 8, z]))),
    plug([0, 0, 0]),
  ],
  '3062b': [socket([0, 24, 0]), plug([0, 0, 0])],
  '2423': [socket([0, 8, 0]), plug([0, 0, 0])],
  '3941': [-10, 10].flatMap((x) =>
    [-10, 10].flatMap((z) => [socket([x, 24, z]), plug([x, 0, z])]),
  ),
  '4740': [socket([0, 8, 0]), plug([0, 0, 0])],
  '85861': [socket([0, 8, 0]), plug([0, 0, 0]), socket([0, 0, 0], 'bar')],
  '6126b': [plug([0, 0, -2], 'bar')],
  '3816c': [socket([-10, 28, -1.25]), socket([-10, 0, 0], 'hip')],
  '3817c': [socket([10, 28, -1.25]), socket([10, 0, 0], 'hip')],
  '3815b': [
    plug([-10, 12, 0], 'hip'),
    plug([10, 12, 0], 'hip'),
    plug([0, 0, 0], 'waist'),
  ],
  '973': [
    socket([0, 32, 0], 'waist'),
    plug([0, 0, 0], 'neck'),
    plug([-15.552, 9, 0], 'arm'),
    plug([15.552, 9, 0], 'arm'),
  ],
  '3818': [socket([0, 0, 0], 'arm'), plug([-5, 18.8948, -9.8982], 'wrist')],
  '3819': [socket([0, 0, 0], 'arm'), plug([5, 18.8948, -9.8982], 'wrist')],
  '3820': [socket([0, 0, 0], 'wrist'), socket([0, -0.8229, -9.8948], 'grip')],
  '3626c': [socket([0, 24, 0], 'neck'), plug([0, 0, 0], 'hat')],
  '3844': [socket([0, 0, 0], 'hat')],
  '3846': [plug([0, 0, 10], 'grip')],
  '4497': [plug([0, 60, 0], 'grip')],
};
