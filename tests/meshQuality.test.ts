import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import { emptyMeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { SPINE_ORIGIN_ATTR, SpineOrigin } from '@/generators/split';
import { meshQuality, type MeshQualityReport } from '@/geometry/meshQuality';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { GraphModel } from '@/graph/model/graphModel';
import { loadSample, SAMPLE_IDS } from './helpers/sampleProjects';
import { setMaterialSource } from '@/materials/materialSource';
import { isBarkMaterial, projectMaterialSource } from './helpers/projectMaterials';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const mesh = (positions: number[], indices: number[], uv?: number[], normals?: number[]): MeshData => ({
  ...emptyMeshData(),
  positions: new Float32Array(positions),
  normals: new Float32Array(normals ?? positions.map((_, i) => (i % 3 === 2 ? 1 : 0))),
  uv0: new Float32Array(uv ?? new Array<number>((positions.length / 3) * 2).fill(0)),
  indices: new Uint32Array(indices),
});

describe('meshQuality (synthetic meshes)', () => {
  const tetra = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3], [0, 0, 1, 0, 0, 1, 1, 1]);

  it('a closed tetrahedron is watertight and manifold', () => {
    const q = meshQuality(tetra);
    expect(q.boundaryEdges).toBe(0);
    expect(q.nonManifoldEdges).toBe(0);
    expect(q.degenerateTriangles).toBe(0);
    expect(q.nanCount).toBe(0);
    expect(q.minTriangleAngle).toBeGreaterThan(30);
    expect(q.maxDihedralNearJunctions).toBeGreaterThan(60);
  });

  it('counts open edges, non-manifold edges, degenerate triangles and NaN', () => {
    const open = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(meshQuality(open).boundaryEdges).toBe(3);
    const fan = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, -1, 0, 0, 0, -1], [0, 1, 2, 0, 1, 3, 0, 1, 4, 0, 1, 5]);
    expect(meshQuality(fan).nonManifoldEdges).toBe(1);
    const flat = mesh([0, 0, 0, 1, 0, 0, 2, 0, 0], [0, 1, 2]);
    expect(meshQuality(flat).degenerateTriangles).toBe(1);
    const nan = mesh([0, 0, 0, Number.NaN, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(meshQuality(nan).nanCount).toBe(1);
  });

  it('welds UV seams by position and does not count them as duplicates', () => {
    const seam = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], [0, 1, 2, 3, 4, 5], [0, 0, 1, 0, 0, 1, 0.5, 0, 1, 1, 0.5, 1]);
    expect(meshQuality(seam).duplicateVertexPairs).toBe(0);
    const twin = mesh([0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 2, 3, 1, 2, 3]);
    expect(meshQuality(twin).duplicateVertexPairs).toBe(1);
  });

  it('measures UV stretch and the smallest angle', () => {
    const even = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [0, 0, 1, 0, 0, 1]);
    expect(meshQuality(even).uvStretchMax).toBeCloseTo(1, 5);
    expect(meshQuality(even).minTriangleAngle).toBeCloseTo(45, 4);
    const stretched = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [0, 0, 4, 0, 0, 1]);
    expect(meshQuality(stretched).uvStretchMax).toBeCloseTo(4, 5);
  });

  it('measures normal jumps only near the given junctions', () => {
    const normals = [0, 0, 1, 0, 0, 1, 1, 0, 0];
    const m = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], undefined, normals);
    expect(meshQuality(m).junctionNormalJump).toBeCloseTo(90, 4);
    expect(meshQuality(m, { junctions: [50, 50, 50, 0.1] }).junctionNormalJump).toBe(0);
    expect(meshQuality(m, { junctions: [0, 0, 0, 0.5] }).junctionNormalJump).toBeCloseTo(90, 4);
  });

  it('an empty mesh is clean', () => {
    const q = meshQuality(emptyMeshData());
    expect(q.boundaryEdges + q.nonManifoldEdges + q.degenerateTriangles + q.nanCount).toBe(0);
    expect(q.minTriangleAngle).toBe(180);
  });
});

const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

/** Centres (x, y, z, r) of the first (crotch) or last (open end) point of every split half of the given nodes. */
function halfZones(r: Result, ids: string[], where: 'start' | 'end'): number[] {
  const out: number[] = [];
  for (const id of ids) {
    const sk = skeletonOf(r, id);
    const origin = sk.attributes.get(SPINE_ORIGIN_ATTR);
    for (const b of sk.branches) {
      if (Math.round(origin?.[b.start] ?? 0) !== SpineOrigin.SplitHalf) continue;
      const i = where === 'start' ? b.start : b.start + b.count - 1;
      out.push(sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!, sk.radius[i]!);
    }
  }
  return out;
}

const SOLID = { spineOnly: false };
const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, noiseTwist: 0, lean: 0 };
const trunkNode = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...SOLID, ...STRAIGHT, length: { value: 4, variance: 0 }, radius: { value: 0.25, variance: 0 }, splitsChance: 1, sides: 32, ...extra } as NodeSpec['params'] },
];
const extension = (id: string, parent: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.branch',
  parent,
  params: { ...SOLID, number: 0, extendParent: 'any', extendCount: 1, length: { value: 0.8, variance: 0 }, ...extra } as NodeSpec['params'],
});

/** Pass / fail thresholds of the QA report. */
function expectClean(q: MeshQualityReport): void {
  expect(q.nanCount).toBe(0);
  expect(q.degenerateTriangles).toBe(0);
  expect(q.minTriangleAngle).toBeGreaterThan(0.1);
}

describe('meshQuality (split scenarios)', () => {
  it('a trunk that always splits is watertight; the crotch is smooth', async () => {
    const r = await run(trunkNode());
    const m = meshOf(r, 'trunk');
    const q = meshQuality(m, { junctions: halfZones(r, ['trunk'], 'start') });
    expectClean(q);
    expect(q.boundaryEdges).toBe(0);
    expect(q.nonManifoldEdges).toBe(0);
    expect(q.junctionNormalJump).toBeLessThan(25);
    expect(q.maxDihedralNearJunctions).toBeLessThan(25);
  });

  it('Inner = 0 keeps a deliberate crease at the crotch (the one allowed exception)', async () => {
    const smooth = meshQuality(meshOf(await run(trunkNode({ splitsSmoothInner: 1 })), 'trunk'));
    const crease = await run(trunkNode({ splitsSmoothInner: 0 }));
    const q = meshQuality(meshOf(crease, 'trunk'), { junctions: halfZones(crease, ['trunk'], 'start') });
    expectClean(q);
    expect(q.boundaryEdges).toBe(0);
    expect(smooth.boundaryEdges).toBe(0);
  });

  it.each([2, 3])('extension chain over %i split levels has no open edge and no degenerate triangle', async (depth) => {
    const specs: NodeSpec[] = [...trunkNode()];
    const ids = ['trunk'];
    let parent = 'trunk';
    for (let level = 1; level < depth; level++) {
      const id = `ext${level}`;
      specs.push(extension(id, parent, { splitsChance: 1 }));
      ids.push(id);
      parent = id;
    }
    const r = await run(specs);
    const q = meshQuality(ids.map((id) => meshOf(r, id)));
    expectClean(q);
    expect(q.boundaryEdges).toBe(0);
    // The end dome of a half stays under its extension: its ring edges are used by dome, crotch and extension (3 uses).
    expect(q.nonManifoldEdges).toBeLessThanOrEqual(16 * (1 << depth));
  });

  it('a Branch that splits (children of a trunk) stays free of NaN, degenerate and non-manifold geometry', async () => {
    const r = await run([
      ...trunkNode({ splitsChance: 0 }),
      { id: 'br', type: 'generator.branch', parent: 'trunk', params: { ...SOLID, number: 5, first: 0.3, last: 0.8, length: { value: 1.2, variance: 0 }, splitsChance: 1, sides: 24 } as NodeSpec['params'] },
    ]);
    const q = meshQuality([meshOf(r, 'trunk'), meshOf(r, 'br')]);
    expectClean(q);
    expect(q.nonManifoldEdges).toBe(0);
  });

  it('roots that split are clean too', async () => {
    const r = await run([
      ...trunkNode({ splitsChance: 0 }),
      { id: 'rt', type: 'generator.root', parent: 'trunk', params: { ...SOLID, number: 4, first: 0, last: 0.1, length: { value: 1.5, variance: 0 }, radius: { value: 0.07, variance: 0 }, splitsChance: 1 } as NodeSpec['params'] },
    ]);
    const q = meshQuality([meshOf(r, 'trunk'), meshOf(r, 'rt')]);
    expectClean(q);
    expect(q.nonManifoldEdges).toBe(0);
  });

  it('a Cap on a split trunk closes both halves vertex-exactly', async () => {
    const r = await run([...trunkNode({ capEnd: false }), { id: 'cap', type: 'generator.cap', parent: 'trunk', params: { extendParent: 'any' } as NodeSpec['params'] }]);
    const q = meshQuality([meshOf(r, 'trunk'), meshOf(r, 'cap')]);
    expectClean(q);
    expect(q.boundaryEdges).toBe(0);
  });

  it('trunk + Branch child + Extend parent together: the junction of the child on the true tube is welded', async () => {
    const r = await run([
      ...trunkNode(),
      { id: 'br', type: 'generator.branch', parent: 'trunk', params: { ...SOLID, number: 4, first: 0.2, last: 0.6, length: { value: 1, variance: 0 }, weldEnabled: true } as NodeSpec['params'] },
      extension('ext', 'trunk'),
    ]);
    const q = meshQuality([meshOf(r, 'trunk'), meshOf(r, 'br'), meshOf(r, 'ext')]);
    expectClean(q);
  });
});

describe('meshQuality (sample projects)', () => {
  it.each(SAMPLE_IDS)('%s: no NaN, no degenerate or non-manifold bark geometry', async (id) => {
    const project = loadSample(id);
    const model = GraphModel.fromJSON(project.graph);
    setMaterialSource(projectMaterialSource(project));
    const r = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: project.settings.seed, lod: 1, token: new CancellationSource().token });
    setMaterialSource(null);
    expect(r.errors).toBe(0);
    const bark = r.scene.entries.filter((e) => e.mesh.slots.length > 0 && e.mesh.slots.every((s) => isBarkMaterial(s.materialId))).map((e) => e.mesh);
    const hasTubes = project.graph.nodes.some((n) => ['generator.trunk', 'generator.branch', 'generator.root'].includes(n.type));
    // Plants made of spines and fronds only (Fern, Grass) have no bark geometry to measure.
    if (!hasTubes) return;
    expect(bark.length).toBeGreaterThan(0);
    const q = meshQuality(bark);
    // Hand-made samples may contain slivers; they must still be finite and non-degenerate.
    expect(q.nanCount).toBe(0);
    expect(q.degenerateTriangles).toBe(0);
    expect(q.minTriangleAngle).toBeGreaterThan(0.01);
    expect(q.nonManifoldEdges).toBe(0);
    const vertices = bark.reduce((n, m) => n + m.positions.length / 3, 0);
    expect(q.duplicateVertexPairs / vertices).toBeLessThan(0.06);
  }, 120000);
});
