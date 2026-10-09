import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  diagnoseSourceSections,
  SOURCE_SECTION_LIMITS,
  type SourceSectionsInput,
  type SourceSectionsResult,
} from './source-sections.ts';

type Point = [number, number, number];
const quad = (a: Point, b: Point, c: Point, d: Point) => [
  ...a,
  ...b,
  ...c,
  ...a,
  ...c,
  ...d,
];
function reverse(positions: number[]) {
  const p = [...positions];
  for (let i = 0; i < p.length; i += 9)
    for (let axis = 0; axis < 3; axis++)
      [p[i + 3 + axis], p[i + 6 + axis]] = [p[i + 6 + axis], p[i + 3 + axis]];
  return p;
}
function box(min: Point = [0, 0, 0], max: Point = [2, 3, 1]) {
  const [x, y, z] = min,
    [X, Y, Z] = max;
  return [
    ...quad([x, y, z], [x, Y, z], [X, Y, z], [X, y, z]),
    ...quad([x, y, Z], [X, y, Z], [X, Y, Z], [x, Y, Z]),
    ...quad([x, y, z], [x, y, Z], [x, Y, Z], [x, Y, z]),
    ...quad([X, y, z], [X, Y, z], [X, Y, Z], [X, y, Z]),
    ...quad([x, y, z], [X, y, z], [X, y, Z], [x, y, Z]),
    ...quad([x, Y, z], [x, Y, Z], [X, Y, Z], [X, Y, z]),
  ];
}
function section(
  positions: number[],
  options: Partial<Omit<SourceSectionsInput, 'positions'>> = {},
) {
  return diagnoseSourceSections({
    positions: Float64Array.from(positions),
    faceIds: Array.from({ length: positions.length / 9 }, (_, id) => id),
    complete: true,
    sweepAxis: 2,
    stations: [0.25, 0.5, 0.75],
    ...options,
  });
}
function diagnosed(result: SourceSectionsResult) {
  assert.equal(
    result.status,
    'diagnosed',
    JSON.stringify(result.stations.map((s) => s.reasons)),
  );
  return result;
}
function validReferences(result: SourceSectionsResult) {
  for (const station of result.stations) {
    const ids = new Set(station.points.map((p) => p.id));
    for (const segment of station.segments) {
      assert.ok(ids.has(segment.from));
      assert.ok(ids.has(segment.to));
    }
    for (const face of station.coplanarFaces)
      for (const id of face.pointIds) assert.ok(ids.has(id));
    for (const path of [...station.loops, ...station.openChains]) {
      for (const id of path.pointIds) assert.ok(ids.has(id));
      for (const id of path.segmentIds) assert.ok(station.segments[id]);
    }
  }
}

void test('closed rectangular source has the analytic section and persistent exact corner provenance', () => {
  const result = diagnosed(section(box()));
  assert.equal(result.sourceTopology.sourceClosureVerified, true);
  assert.deepEqual(result.planeAxes, [0, 1]);
  assert.equal(result.comparison.status, 'comparable');
  for (const station of result.stations) {
    assert.equal(station.loops.length, 1);
    assert.equal(station.openChains.length, 0);
    assert.equal(station.solidHoleStatus, 'classified');
    assert.equal(station.loops[0].exactSignedArea, '6/1');
    assert.equal(station.solidRegions[0].exactAreaStudsSquared, '6/1');
    assert.equal(station.loops[0].corners.length, 4);
    assert.deepEqual(station.bounds, { min: [0, 0], max: [2, 3] });
    assert.deepEqual(
      station.loops[0].sourceFaceIds,
      [4, 5, 6, 7, 8, 9, 10, 11],
    );
  }
  assert.ok(
    result.comparison.pairs.every(
      (pair) => pair.paths[0].maxCornerOffsetStuds === 0,
    ),
  );
  assert.equal(result.sourceTruthVerified, false);
  assert.equal(result.constructionTargetVerified, false);
  validReferences(result);
});

void test('a pre-existing missing side remains an open compound profile', () => {
  // Remove the entire x-min wall; retain both caps and three differently oriented walls.
  const p = box();
  const selected = [0, 1, 2, 3, 6, 7, 8, 9, 10, 11];
  const result = diagnosed(section(p, { faceIds: selected }));
  assert.equal(result.sourceTopology.boundaryEdges, 4);
  assert.equal(result.sourceTopology.externalInterfaceEdges, 4);
  for (const station of result.stations) {
    assert.equal(station.loops.length, 0);
    assert.equal(station.openChains.length, 1);
    assert.equal(station.solidHoleStatus, 'unavailable-open-profile');
    assert.equal(station.openChains[0].pointIds.length, 7);
    const endpoints = station.openChains[0].pointIds.filter(
      (_, i, ids) => i === 0 || i === ids.length - 1,
    );
    assert.deepEqual(
      endpoints
        .map((id) => station.points.find((p) => p.id === id)!.point)
        .sort(),
      [
        [0, 0],
        [0, 3],
      ],
    );
    assert.ok(
      station.points.filter((p) => p.externalSourceInterface).length >= 2,
    );
  }
});

void test('an actual source opening is preserved when omitted faces do not exist at all', () => {
  const p = box();
  const result = diagnosed(section([...p.slice(0, 36), ...p.slice(54)]));
  assert.equal(result.sourceTopology.externalInterfaceEdges, 0);
  assert.equal(result.sourceTopology.sourceClosureVerified, false);
  assert.ok(
    result.stations.every((s) => s.openChains.length === 1 && !s.loops.length),
  );
});

void test('arbitrarily thin parallel layers keep two independent open source chains', () => {
  const plane = (z: number) => quad([0, 0, z], [2, 0, z], [2, 1, z], [0, 1, z]);
  const result = diagnosed(
    section([...plane(0), ...reverse(plane(1e-12))], {
      sweepAxis: 0,
      stations: [0.25, 1, 1.75],
    }),
  );
  for (const station of result.stations) {
    assert.equal(station.openChains.length, 2);
    assert.deepEqual(station.openChains.map((c) => c.sourceFaceIds).sort(), [
      [0, 1],
      [2, 3],
    ]);
    assert.deepEqual(
      station.openChains.map((c) => c.bounds.min[1]).sort((a, b) => a - b),
      [0, 1e-12],
    );
  }
});

void test('equal-coordinate contact without a source edge never invents a connected path', () => {
  const result = section(
    [0, 0, 0, -1, 0, -1, -1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, -1],
    { stations: [-0.2, 0, 0.2] },
  );
  const station = result.stations[1];
  assert.equal(station.openChains.length, 2);
  assert.equal(station.loops.length, 0);
  assert.equal(
    station.points.filter((p) => p.point[0] === 0 && p.point[1] === 0).length,
    2,
  );
  assert.equal(station.status, 'unresolved');
  assert.ok(station.reasons.some((r) => r.includes('nonvertex contact')));
});

void test('a crossing through a real shared vertex fan traces a single analytic open chain', () => {
  const center: Point = [0, 0, 0];
  const a: Point = [-1, 0, -1],
    b: Point = [1, 0, -1],
    c: Point = [1, 0, 1],
    d: Point = [-1, 0, 1];
  const result = diagnosed(
    section(
      [
        ...a,
        ...b,
        ...center,
        ...b,
        ...c,
        ...center,
        ...c,
        ...d,
        ...center,
        ...d,
        ...a,
        ...center,
      ],
      {
        stations: [0],
      },
    ),
  );
  const station = result.stations[0];
  assert.equal(station.openChains.length, 1);
  assert.equal(station.segments.length, 2);
  assert.deepEqual(
    station.points.find((p) => p.point[0] === 0)!.sourceFaceIds,
    [0, 1, 2, 3],
  );
  assert.deepEqual(station.bounds, { min: [-1, 0], max: [1, 0] });
});

void test('station exactly on a real source edge keeps the whole edge once with both face IDs', () => {
  const result = diagnosed(
    section(quad([-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1]), {
      sweepAxis: 1,
      stations: [0],
    }),
  );
  // The whole quad is coplanar: its two triangles and their common diagonal remain source evidence.
  const station = result.stations[0];
  assert.equal(station.coplanarFaces.length, 2);
  assert.equal(station.segments.length, 4);
  assert.equal(station.loops.length, 1);
  assert.equal(station.solidHoleStatus, 'unavailable-coplanar-section');
  assert.equal(result.sourceTopology.edges.length, 5);
  assert.ok(
    station.coplanarFaces[0].sourceEdgeIds.some((id) =>
      station.coplanarFaces[1].sourceEdgeIds.includes(id),
    ),
  );
  validReferences(result);
});

void test('noncoplanar two-face cut on their true common edge retains both contributors', () => {
  const result = diagnosed(
    section([-1, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0, 0, -1, 0, 0, 0, -1, -1], {
      stations: [0],
    }),
  );
  const station = result.stations[0];
  assert.equal(station.segments.length, 1);
  assert.deepEqual(station.segments[0].sourceFaceIds, [0, 1]);
  assert.equal(station.openChains.length, 1);
  assert.deepEqual(station.bounds, { min: [-1, 0], max: [1, 0] });
});

void test('a tangent vertex remains an isolated source contact', () => {
  const result = diagnosed(
    section([0, 0, 0, 2, 0, 1, 0, 2, 1], { stations: [0] }),
  );
  const station = result.stations[0];
  assert.equal(station.points.length, 1);
  assert.equal(station.isolatedPointIds.length, 1);
  assert.equal(station.segments.length, 0);
  assert.deepEqual(station.points[0].sourceFaceIds, [0]);
  assert.equal(station.points[0].originalEdges.length, 2);
});

void test('closed tetrahedron station through a source vertex retains the exact triangular loop', () => {
  const a: Point = [0, 0, -1],
    b: Point = [2, 0, 1],
    c: Point = [0, 2, 1],
    d: Point = [0, 0, 0];
  const result = diagnosed(
    section(
      [...a, ...c, ...b, ...a, ...b, ...d, ...a, ...d, ...c, ...b, ...c, ...d],
      { stations: [0] },
    ),
  );
  const station = result.stations[0];
  assert.equal(station.loops.length, 1);
  assert.equal(station.points.length, 3);
  assert.equal(station.segments.length, 3);
  assert.equal(station.solidRegions[0].exactAreaStudsSquared, '1/2');
  assert.equal(station.solidHoleStatus, 'classified');
  assert.deepEqual(station.points.map((p) => p.point).sort(), [
    [0, 0],
    [0, 1],
    [1, 0],
  ]);
});

void test('closed tetrahedron station along a source edge merges only the real common edge', () => {
  const a: Point = [0, 0, 0],
    b: Point = [1, 0, 0],
    c: Point = [0, 1, -1],
    d: Point = [0, 1, 1];
  const result = diagnosed(
    section(
      [...a, ...c, ...b, ...a, ...b, ...d, ...a, ...d, ...c, ...b, ...c, ...d],
      { stations: [0] },
    ),
  );
  const station = result.stations[0];
  assert.equal(station.loops.length, 1);
  assert.equal(station.segments.length, 3);
  assert.deepEqual(
    station.segments.find((s) => s.sourceFaceIds.length === 2)!.sourceFaceIds,
    [0, 1],
  );
  assert.equal(station.solidRegions[0].exactAreaStudsSquared, '1/2');
  assert.equal(station.solidHoleStatus, 'classified');
  validReferences(result);
});

void test('a source cap on the station is retained as two exact area triangles', () => {
  const result = diagnosed(section(box(), { stations: [0, 1] }));
  for (const station of result.stations) {
    assert.equal(station.coplanarFaces.length, 2);
    assert.equal(station.loops.length, 1);
    assert.equal(station.solidHoleStatus, 'unavailable-coplanar-section');
    assert.equal(station.solidRegions.length, 0);
    assert.equal(station.sourceClosureVerified, false);
    assert.equal(station.segments.length, 4);
  }
  validReferences(result);
});

function squareTube() {
  const outer = box([0, 0, 0], [4, 4, 1]).slice(36);
  const inner = reverse(box([1, 1, 0], [3, 3, 1]).slice(36));
  const cap = (z: number) => [
    ...quad([0, 0, z], [4, 0, z], [3, 1, z], [1, 1, z]),
    ...quad([4, 0, z], [4, 4, z], [3, 3, z], [3, 1, z]),
    ...quad([4, 4, z], [0, 4, z], [1, 3, z], [3, 3, z]),
    ...quad([0, 4, z], [0, 0, z], [1, 1, z], [1, 3, z]),
  ];
  return [...outer, ...inner, ...reverse(cap(0)), ...cap(1)];
}

void test('closed tube preserves its analytic hole and exact net section area', () => {
  const result = diagnosed(section(squareTube()));
  for (const station of result.stations) {
    assert.equal(station.solidHoleStatus, 'classified');
    assert.deepEqual(station.loops.map((l) => l.loopKind).sort(), [
      'hole-boundary',
      'solid-boundary',
    ]);
    assert.deepEqual(station.loops.map((l) => l.exactSignedArea).sort(), [
      '-4/1',
      '16/1',
    ]);
    assert.equal(station.solidRegions.length, 1);
    assert.equal(station.solidRegions[0].holeLoopIds.length, 1);
    assert.equal(station.solidRegions[0].exactAreaStudsSquared, '12/1');
  }
});

void test('globally reversed source winding preserves geometry, holes and positive region area', () => {
  const result = diagnosed(section(reverse(squareTube())));
  for (const station of result.stations) {
    assert.deepEqual(station.loops.map((l) => l.exactSignedArea).sort(), [
      '-16/1',
      '4/1',
    ]);
    assert.equal(station.solidRegions[0].exactAreaStudsSquared, '12/1');
  }
});

void test('closed-looking loops from an open source never acquire solid or hole claims', () => {
  const result = diagnosed(section(squareTube().slice(0, 144)));
  for (const station of result.stations) {
    assert.equal(station.loops.length, 2);
    assert.equal(station.solidHoleStatus, 'unavailable-source-closure');
    assert.ok(station.loops.every((loop) => loop.loopKind === undefined));
    assert.equal(station.solidRegions.length, 0);
  }
});

void test('exact tiny closed sections survive numeric area underflow', () => {
  const size = 2 ** -600;
  const result = diagnosed(
    section(box([0, 0, 0], [size, size, 1]), { stations: [0.5] }),
  );
  const station = result.stations[0];
  assert.equal(station.solidHoleStatus, 'classified');
  assert.equal(station.loops[0].signedAreaStudsSquared, 0);
  assert.equal(
    station.solidRegions[0].exactAreaStudsSquared,
    `1/${BigInt(1) << BigInt(1200)}`,
  );
  assert.equal(station.loops[0].corners.length, 4);
});

void test('negative coordinates and each cyclic projection axis give analytic signed areas', () => {
  const p = box([-4, -3, -2], [-2, 0, 2]);
  for (const [sweepAxis, stations, area, min, max] of [
    [0, [-3], 12, [-3, -2], [0, 2]],
    [1, [-1], 8, [-2, -4], [2, -2]],
    [2, [-1], 6, [-4, -3], [-2, 0]],
  ] as const) {
    const result = diagnosed(section(p, { sweepAxis, stations }));
    assert.equal(result.stations[0].solidRegions[0].areaStudsSquared, area);
    assert.deepEqual(result.stations[0].bounds, {
      min: [...min],
      max: [...max],
    });
  }
});

void test('an unselected third incident face prevents a false closed-source certification', () => {
  const p = box();
  p.push(0, 0, 0, 0, 0, 1, -1, -1, 0.5);
  const result = section(p, {
    faceIds: Array.from({ length: 12 }, (_, id) => id),
  });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.sourceTopology.nonmanifoldEdges, 1);
  const edge = result.sourceTopology.edges.find(
    (e) => e.references.length === 3,
  )!;
  assert.deepEqual(
    edge.references.map((r) => r.sourceFaceId).sort((a, b) => a - b),
    [4, 9, 12],
  );
  assert.equal(edge.externalSourceInterface, true);
  assert.equal(result.sourceTopology.sourceClosureVerified, false);
  validReferences(result);
});

void test('selected nonmanifold branches retain every cut segment without choosing a continuation', () => {
  const result = section(
    [
      0, 0, -1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1, 0, 0, 0, -1, 0, 0, 1,
      -1, 0, 0,
    ],
    { stations: [0] },
  );
  const station = result.stations[0];
  assert.equal(station.segments.length, 3);
  assert.equal(station.untracedSegmentIds.length, 3);
  assert.equal(station.openChains.length, 0);
  assert.equal(station.loops.length, 0);
  assert.equal(station.status, 'unresolved');
  validReferences(result);
});

void test('full original positions and external source interfaces remain exact and unmodified', () => {
  const positions = Float64Array.from(box());
  const before = Array.from(positions);
  const result = diagnoseSourceSections({
    positions,
    faceIds: [4, 5],
    complete: true,
    sweepAxis: 2,
    stations: [0.5],
  });
  assert.equal(result.originalPositions, positions);
  assert.deepEqual(Array.from(positions), before);
  assert.deepEqual(result.selectedSourceFaceIds, [4, 5]);
  assert.equal(result.sourceTopology.originalFaces, 12);
  assert.equal(result.sourceTopology.edges.length, 5);
  const external = result.sourceTopology.edges.filter(
    (e) => e.externalSourceInterface,
  );
  assert.equal(external.length, 4);
  assert.ok(external.every((e) => e.references.length === 2));
  for (const edge of result.sourceTopology.edges)
    for (const ref of edge.references)
      for (let endpoint = 0; endpoint < 2; endpoint++) {
        const offset = ref.positionOffsets[endpoint];
        assert.equal(
          offset,
          ref.sourceFaceId * 9 + ref.localVertices[endpoint] * 3,
        );
        assert.ok(
          edge.vertices.some((p) =>
            p.every((v, axis) => v === positions[offset + axis]),
          ),
        );
      }
});

void test('incomplete source declaration still diagnoses cuts while withholding source closure', () => {
  const result = diagnosed(section(box(), { complete: false }));
  assert.equal(result.sourceTopology.sourceClosureVerified, false);
  assert.ok(
    result.stations.every(
      (s) => s.solidHoleStatus === 'unavailable-source-closure',
    ),
  );
});

void test('budget exhaustion retains valid partial evidence and explicitly stops later stations', () => {
  const result = section(box(), { limits: { segments: 2 } });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.stations.length, 3);
  assert.equal(result.stations[0].segments.length, 2);
  assert.ok(result.stations[0].points.length >= 3);
  assert.ok(result.stations[1].reasons.some((r) => r.includes('not computed')));
  assert.equal(result.stations[1].segments.length, 0);
  validReferences(result);
});

void test('topology budget stops computation and leaves no classification claim', () => {
  const result = section(box(), { limits: { topologyTests: 1 } });
  assert.equal(result.status, 'unresolved');
  assert.equal(result.stations[0].solidHoleStatus, 'unresolved');
  assert.ok(result.stations[1].reasons.some((r) => r.includes('not computed')));
  validReferences(result);
});

void test('bounds and geometric intersection validation preserve a tiny separate source patch', () => {
  const tiny = 2 ** -40;
  const result = diagnosed(
    section([...box(), 4, 0, 0, 4 + tiny, 0, 1, 4, tiny, 1]),
  );
  assert.ok(
    result.stations.every(
      (s) => s.loops.length === 1 && s.openChains.length === 1,
    ),
  );
  assert.ok(
    result.stations.every((s) =>
      s.segments.some((seg) => seg.sourceFaceIds.includes(12)),
    ),
  );
  assert.ok(
    result.stations.every((s) => s.loops.every((loop) => !loop.loopKind)),
  );
});

void test('input validation reports invalid or excessive source data without truncating selection', () => {
  const base = {
    positions: box(),
    faceIds: [0],
    stations: [0.5],
    sweepAxis: 2 as const,
  };
  for (const changes of [
    { stations: [] },
    { stations: [0.5, 0.5] },
    { stations: [NaN] },
    { faceIds: [0, 0] },
    { faceIds: [-1] },
    { faceIds: [12] },
    { limits: { selectedFaces: SOURCE_SECTION_LIMITS.selectedFaces + 1 } },
    { stations: Array.from({ length: 33 }, (_, id) => id) },
    { limits: { faceStationTests: 1 }, faceIds: [0, 1] },
  ]) {
    const result = diagnoseSourceSections({ ...base, ...changes });
    assert.equal(result.status, 'unresolved');
    assert.ok(result.reasons.length);
    assert.equal(result.stations.length, 0);
  }
});

void test('crossing disconnected source sheets keep both chains and report the actual contact', () => {
  const result = section(
    [
      ...quad([-1, -1, -1], [1, 1, -1], [1, 1, 1], [-1, -1, 1]),
      ...quad([-1, 1, -1], [1, -1, -1], [1, -1, 1], [-1, 1, 1]),
    ],
    { stations: [0] },
  );
  const station = result.stations[0];
  assert.equal(station.status, 'unresolved');
  assert.equal(station.openChains.length, 2);
  assert.equal(station.segments.length, 4);
  assert.ok(station.reasons.some((r) => r.includes('nonvertex contact')));
  validReferences(result);
});

void test('one altered face winding is diagnosed without erasing the observed closed trace', () => {
  const p = box();
  p.splice(36, 9, ...reverse(p.slice(36, 45)));
  const result = section(p, { stations: [0.5] });
  assert.equal(result.status, 'unresolved');
  assert.ok(result.sourceTopology.inconsistentWindingEdges > 0);
  assert.equal(result.stations[0].loops.length, 1);
  assert.equal(result.stations[0].solidHoleStatus, 'unresolved');
  validReferences(result);
});

void test('nested source island and disconnected reverse-oriented shell have independent solid regions', () => {
  const result = diagnosed(
    section(
      [
        ...squareTube(),
        ...box([1.5, 1.5, 0], [2.5, 2.5, 1]),
        ...reverse(box([6, 0, 0], [8, 3, 1])),
      ],
      { stations: [0.5] },
    ),
  );
  const station = result.stations[0];
  assert.deepEqual(
    station.loops.map((l) => l.nestingDepth).sort(),
    [0, 0, 1, 2],
  );
  assert.deepEqual(
    station.solidRegions.map((r) => r.exactAreaStudsSquared).sort(),
    ['1/1', '12/1', '6/1'],
  );
});

void test('50,000 selected source faces and 32 stations fit the published input and work limits', () => {
  const positions = new Float64Array(SOURCE_SECTION_LIMITS.selectedFaces * 9);
  for (let id = 0; id < SOURCE_SECTION_LIMITS.selectedFaces; id++)
    positions.set([id * 3, 0, -1, id * 3 + 1, 0, 1, id * 3, 1, 1], id * 9);
  const faceIds = Array.from(
    { length: SOURCE_SECTION_LIMITS.selectedFaces },
    (_, id) => id,
  );
  const result = diagnosed(
    diagnoseSourceSections({
      positions,
      faceIds,
      complete: true,
      sweepAxis: 2,
      stations: Array.from(
        { length: SOURCE_SECTION_LIMITS.stations },
        (_, id) => id + 2,
      ),
    }),
  );
  assert.equal(result.stations.length, 32);
  assert.equal(result.selectedSourceFaceIds.length, 50000);
  assert.equal(result.sourceTopology.edges.length, 150000);
  assert.equal(result.work.faceStationTests, 1600000);
  assert.equal(result.work.segments, 0);
  assert.ok(
    result.stations.every((s) => !s.points.length && !s.segments.length),
  );
});

void test('50,000 nonempty source intersections retain every distinct face and open segment', () => {
  const positions = new Float64Array(SOURCE_SECTION_LIMITS.selectedFaces * 9);
  for (let id = 0; id < SOURCE_SECTION_LIMITS.selectedFaces; id++)
    positions.set([id * 3, 0, -1, id * 3 + 1, 0, 1, id * 3, 1, 1], id * 9);
  const result = diagnosed(
    diagnoseSourceSections({
      positions,
      complete: true,
      sweepAxis: 2,
      stations: [0],
      faceIds: Array.from(
        { length: SOURCE_SECTION_LIMITS.selectedFaces },
        (_, id) => id,
      ),
    }),
  );
  const station = result.stations[0];
  assert.equal(station.points.length, 100000);
  assert.equal(station.segments.length, 50000);
  assert.equal(station.openChains.length, 50000);
  assert.equal(station.loops.length, 0);
  assert.equal(station.segments[49999].sourceFaceIds[0], 49999);
  assert.deepEqual(station.bounds, { min: [0, 0], max: [149997.5, 0.5] });
  validReferences(result);
});
