import test from 'node:test';
import assert from 'node:assert/strict';
import { toLDraw, type Model } from './brick-engine.ts';

void test('layout-only assembly groups preserve exact CAD poses, colours and STEP order without invented duck parameters', () => {
  const model: Model = {
    name: 'explicit CAD layout grouping, no image or motion-plan claim',
    source: 'sample', shape: 'sculpture', resolution: 4,
    width: 4, depth: 4, height: 8, supportCount: 0, levels: [0, 1],
    assembly: {
      sections: [{ id: 'layout', name: 'Imported layout grouping' }],
      reference: 'Source groups only; installation actions and photograph provenance unknown.',
      steps: [
        { name: '底座', description: 'Source group, not a verified action.', section: 'layout' },
        { name: '火盆 · 火焰', description: 'Source group, not a verified action.', section: 'layout' },
      ],
    },
    bricks: [
      { id: 1, part: '3022', x: 1, y: 0, z: 1, w: 2, h: 1, d: 2, color: 7, step: 0,
        pose: { position: [0, -8, 0], matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1] } },
      { id: 2, part: '6126b', x: 2, y: 4, z: 1, w: 1, h: 3, d: 1, color: 14, step: 1,
        pose: { position: [12, -49.5, -8], matrix: [0, 0, -1, 0, 1, 0, 1, 0, 0] } },
    ],
  };
  const before = structuredClone(model);
  assert.equal(Object.hasOwn(model.assembly!, 'parameters'), false);
  assert.equal(toLDraw(model), [
    '0 Brickform V3 model',
    '0 Name: brickform.ldr',
    '0 Author: Brickform',
    '0 Coordinates: studs in X/Z, plate units in Y. Physical stability unverified.',
    '0 // 底座',
    '1 19 0 -8 0 1 0 0 0 1 0 0 0 1 3022.dat',
    '0 STEP',
    '0 // 火盆 · 火焰',
    '1 57 12 -49.5 -8 0 0 -1 0 1 0 1 0 0 6126b.dat',
    '0 STEP',
  ].join('\n'));
  assert.deepEqual(model, before);
});
