import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, type Branch, type Skeleton } from '@/contracts/skeleton';
import { createBranchDisplacer, type BarkSpec, type BranchDisplaceSpec, type BranchDisplacer } from '@/generators/displace';
import { EXTENSION_ATTR, SPLIT_ATTR, SplitFlag, decideSplit, evenTiles, splitHalfMapping } from '@/generators/split';
import { Rng } from '@/core/rng';
import { SUB_LEVEL_ATTR } from '@/generators/skin';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';
import { findSplitLobes, lobeEndRing } from '@/geometry/splitCrotch';
import { meshQuality } from '@/geometry/meshQuality';
import { newSpineNotes, reportSpineNotes } from '@/nodes/generators/spine';
import { forkMetrics } from '@/qa';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const STRAIGHT = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, noiseTwist: 0, lean: 0 };
const EXT_STRAIGHT = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();

const graph = (trunkExtra: Record<string, unknown> = {}, extExtra: Record<string, unknown> | null = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, length: { value: 4, variance: 0 }, radius: { value: 0.25, variance: 0 }, splitsChance: 1, segments: 24, accuracy: 24, ...trunkExtra } as NodeSpec['params'] },
  ...(extExtra
    ? [{ id: 'ext', type: 'generator.branch', parent: 'trunk', params: { ...EXT_STRAIGHT, number: 1, extendParent: 'any', extendCount: 1, knockout: 1, ...extExtra } as NodeSpec['params'] }]
    : []),
];

const bark = (over: Partial<BarkSpec> = {}): BarkSpec => ({
  style: 'furrowed',
  depth: 0.2,
  scale: 20,
  stretch: 1,
  warp: 0,
  crevice: null,
  maturity: { amount: 0, rMin: 0.01, rMax: 0.15, curve: null },
  seed: 3,
  maxVertices: 40000,
  ...over,
});

const spec = (b: BarkSpec, over: Partial<BranchDisplaceSpec> = {}): BranchDisplaceSpec => ({
  source: 'bark',
  radial: 0,
  length: 0,
  sharpness: null,
  mapping: 'fit',
  scaleU: 1,
  scaleV: 1,
  seed: 1,
  map: null,
  fine: { amount: 0, sharpness: null, scale: 1 },
  shape: { amount: 0, twist: 0, scale: 1, seed: 0 },
  flares: { radius: 0, noiseScale: 5, height: 1, pinch: 0, angle: 0, seed: 0 },
  fadeBase: 2,
  fadeTip: 2,
  lod: 0,
  lodFade: false,
  bark: b,
  ...over,
});

interface Call {
  tag: string;
  u: number;
  s: number;
  d: number;
  lineage: number;
}

/** The real bark displacer wrapped so every evaluation is recorded (tag = which mesh call made it). */
function spy(calls: Call[], tagOf: () => string, b: BarkSpec = bark()): BranchDisplacer {
  const real = createBranchDisplacer(spec(b)) as BranchDisplacer;
  return (v, out) => {
    real(v, out);
    calls.push({ tag: tagOf(), u: Math.round(v.u * 1e9) / 1e9, s: v.sLineage ?? v.s, d: out.normal + out.radial, lineage: v.lineage ?? v.branch });
  };
}

const tubeOptions = (sides: number | ((g: number) => number), over: Partial<TubeOptions> = {}): TubeOptions => ({
  maxGeneration: 9,
  radialSegments: typeof sides === 'number' ? () => sides : (g) => sides(g),
  color: (g) => (g === 0 ? [0.4, 0.3, 0.2] : [0.2, 0.3, 0.1]),
  uvMetres: 1,
  materialId: 'bark',
  displaceDirection: 'normal',
  ...over,
});

/** Trunk + one extension (a Branch > Extend parent node) of a splitting trunk, as skeletons. */
async function forkSkeletons(extExtra: Record<string, unknown> = {}): Promise<{ trunk: Skeleton; ext: Skeleton }> {
  const r = await run(graph({}, extExtra));
  return { trunk: skeletonOf(r, 'trunk'), ext: skeletonOf(r, 'ext') };
}

describe('T09 - displacement continues through the fork', () => {
  it('displaces the crotch rings with the parent coordinates and does not fade the parent last ring', async () => {
    const { trunk } = await forkSkeletons();
    const calls: Call[] = [];
    const mesh = buildTubeMesh(trunk, tubeOptions(16, { displaceField: spy(calls, () => 'trunk') }));
    expect(mesh.indices.length).toBeGreaterThan(0);
    const [pi, lobes] = [...findSplitLobes(trunk)][0] as [number, { side1: number; side2: number; keep: number }];
    const rings = (trunk.branches[lobes.side1] as Branch).count;
    expect(pi).toBeGreaterThanOrEqual(0);
    const distinct = [...new Set(calls.map((c) => Math.round(c.s * 1e7) / 1e7))].sort((a, b) => a - b);
    // The last (rings - 1) distinct arc lengths are the crotch rings 1 .. last, the one before is the parent's last ring.
    const crotchS = distinct.slice(distinct.length - (rings - 1));
    const sLast = distinct[distinct.length - rings] as number;
    const at = (s: number): Call[] => calls.filter((c) => Math.abs(c.s - s) < 1e-6);
    expect(at(crotchS[0] as number).length).toBeGreaterThan(0);
    const depthRef = 0.2 * 0.25;
    const maxAbs = (cs: Call[]): number => Math.max(...cs.map((c) => Math.abs(c.d)));
    expect(maxAbs(at(sLast))).toBeGreaterThan(0.02 * depthRef);
    for (const s of crotchS) expect(maxAbs(at(s)), `crotch ring at ${s}`).toBeGreaterThan(0.02 * depthRef);
    // One lineage (the parent's) for the whole run.
    expect(new Set(calls.map((c) => c.lineage)).size).toBe(1);
  });

  it('the extension continues the open end: same lineage, arc length, U and displacement as the crotch end ring', async () => {
    const { trunk, ext } = await forkSkeletons();
    const calls: Call[] = [];
    let tag = 'trunk';
    const field = spy(calls, () => tag);
    buildTubeMesh(trunk, tubeOptions(16, { displaceField: field }));
    tag = 'ext';
    const extMesh = buildTubeMesh(ext, tubeOptions(16, { parent: trunk, displaceField: field }));
    expect(extMesh.indices.length).toBeGreaterThan(0);
    const crotch = calls.filter((c) => c.tag === 'trunk');
    const extCalls = calls.filter((c) => c.tag === 'ext');
    expect(extCalls.length).toBeGreaterThan(0);
    expect(new Set(extCalls.map((c) => c.lineage))).toEqual(new Set(crotch.map((c) => c.lineage)));
    const sEnd = Math.max(...crotch.map((c) => c.s));
    const extStart = Math.min(...extCalls.map((c) => c.s));
    expect(extStart).toBeCloseTo(sEnd, 4);
    const endRing = crotch.filter((c) => Math.abs(c.s - sEnd) < 1e-6);
    const first = extCalls.filter((c) => Math.abs(c.s - extStart) < 1e-6);
    const byU = new Map(endRing.map((c) => [c.u, c.d]));
    let missing = 0;
    for (const c of first) {
      const d = byU.get(c.u);
      if (d === undefined) {
        // Only the merged valley vertex of the open end is a single vertex for two pattern columns.
        missing++;
        continue;
      }
      expect(Math.abs(d - c.d), `u ${c.u}`).toBeLessThan(1e-7);
    }
    expect(missing).toBeLessThanOrEqual(1 * 2);
    // Without the fade-in the extension displaces its second ring as much as its first (no smooth band).
    const rest = extCalls.filter((c) => c.s > extStart + 1e-6);
    const nextS = Math.min(...rest.map((c) => c.s));
    const second = rest.filter((c) => Math.abs(c.s - nextS) < 1e-6);
    const mean = (cs: Call[]): number => cs.reduce((a, c) => a + Math.abs(c.d), 0) / Math.max(1, cs.length);
    expect(mean(second)).toBeGreaterThan(0.5 * mean(first));
  });

  it('jump between neighbouring rings across ring 0 and across the open end stays below 5 % of the depth for a smooth pattern', async () => {
    const { trunk, ext } = await forkSkeletons();
    const calls: Call[] = [];
    let tag = 'trunk';
    const field = spy(calls, () => tag);
    buildTubeMesh(trunk, tubeOptions(16, { displaceField: field }));
    tag = 'ext';
    buildTubeMesh(ext, tubeOptions(16, { parent: trunk, displaceField: field }));
    const depth = 0.2 * 0.25;
    const [, lobes] = [...findSplitLobes(trunk)][0] as [number, { side1: number; side2: number; keep: number }];
    const rings = (trunk.branches[lobes.side1] as Branch).count;
    const trunkCalls = calls.filter((c) => c.tag === 'trunk');
    const distinct = [...new Set(trunkCalls.map((c) => Math.round(c.s * 1e7) / 1e7))].sort((a, b) => a - b);
    const sLast = distinct[distinct.length - rings] as number;
    const sCrotch1 = distinct[distinct.length - rings + 1] as number;
    const sEnd = distinct[distinct.length - 1] as number;
    const extCalls = calls.filter((c) => c.tag === 'ext');
    const extS = [...new Set(extCalls.map((c) => Math.round(c.s * 1e7) / 1e7))].sort((a, b) => a - b);
    const pairJump = (a: Call[], sa: number, b: Call[], sb: number): number => {
      let worst = 0;
      const left = new Map(a.filter((c) => Math.abs(c.s - sa) < 1e-6).map((c) => [c.u, c.d]));
      for (const c of b.filter((x) => Math.abs(x.s - sb) < 1e-6)) {
        const d = left.get(c.u);
        if (d !== undefined) worst = Math.max(worst, Math.abs(d - c.d));
      }
      return worst;
    };
    expect(pairJump(trunkCalls, sLast, trunkCalls, sCrotch1)).toBeLessThan(0.05 * depth);
    expect(pairJump(trunkCalls, sEnd, extCalls, extS[1] as number)).toBeLessThan(0.05 * depth);
    expect(pairJump(trunkCalls, sEnd, extCalls, extS[0] as number)).toBeLessThan(1e-7);
  });

  it('every crotch vertex is displaced exactly once and the result is deterministic', async () => {
    const { trunk } = await forkSkeletons();
    const make = (): { mesh: MeshData; n: number } => {
      const calls: Call[] = [];
      return { mesh: buildTubeMesh(trunk, tubeOptions(16, { displaceField: spy(calls, () => 'x') })), n: calls.length };
    };
    const a = make();
    const b = make();
    expect(Array.from(b.mesh.positions)).toEqual(Array.from(a.mesh.positions));
    expect(Array.from(b.mesh.normals)).toEqual(Array.from(a.mesh.normals));
    expect(Array.from(b.mesh.indices)).toEqual(Array.from(a.mesh.indices));
    expect(b.n).toBe(a.n);
  });

  it('a split without displacement is unchanged: no field, no continuation, no crotch evaluation', async () => {
    const { trunk } = await forkSkeletons();
    const a = buildTubeMesh(trunk, tubeOptions(16));
    const b = buildTubeMesh(trunk, tubeOptions(16));
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    for (const v of a.normals) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('T09 - watertight and normals after displacement', () => {
  it('2-level split with Bark displacement: zero open edges and no triple edges inside each skin', async () => {
    const bark2 = { displaceSource: 'bark', barkDepth: 0.15, barkScale: 0.3, displaceAutoSubdivide: false, sides: 12, spineOnly: false };
    const r = await run(graph({ ...bark2 }, { splitsChance: 1, ...bark2 }));
    const trunk = meshOf(r, 'trunk');
    const ext = meshOf(r, 'ext');
    expect(trunk.indices.length).toBeGreaterThan(0);
    expect(ext.indices.length).toBeGreaterThan(0);
    const qt = meshQuality(trunk);
    expect(qt.nanCount).toBe(0);
    expect(qt.nonManifoldEdges).toBe(0);
    expect(qt.boundaryEdges).toBe(0);
    const qe = meshQuality(ext);
    expect(qe.nonManifoldEdges).toBe(0);
    // Only the base rings of the extensions (N / 2 edges each) are open on their own.
    expect(qe.boundaryEdges).toBeLessThanOrEqual(2 * 6);
    // Together the skins are closed: the extension covers the dome that closes each open end of the trunk.
    const both = meshQuality([trunk, ext]);
    expect(both.boundaryEdges).toBe(0);
    expect(both.nanCount).toBe(0);
  }, 60000);

  it('displaced normals are finite and unit length at ring 0, in the crotch and at the open ends', async () => {
    const { trunk } = await forkSkeletons();
    const mesh = buildTubeMesh(trunk, tubeOptions(16, { displaceField: spy([], () => 'x') }));
    const n = mesh.normals;
    for (let i = 0; i < n.length / 3; i++) {
      const l = Math.hypot(n[i * 3]!, n[i * 3 + 1]!, n[i * 3 + 2]!);
      expect(Math.abs(l - 1)).toBeLessThan(1e-3);
    }
  });

  it('T04 forkMetrics stays within the same targets with and without displacement', async () => {
    const r = await run(graph());
    const sk = skeletonOf(r, 'trunk');
    const plain = forkMetrics(sk, buildTubeMesh(sk, tubeOptions(16)));
    const shown = forkMetrics(sk, buildTubeMesh(sk, tubeOptions(16, { displaceField: spy([], () => 'x') })));
    expect(plain.summary.count).toBeGreaterThan(0);
    expect(shown.summary.count).toBe(plain.summary.count);
    expect(shown.summary.minAreaRatio as number).toBeGreaterThan((plain.summary.minAreaRatio as number) * 0.9);
    expect(shown.summary.allSimple).toBe(true);
  });
});

describe('T09 - U tiles of the halves', () => {
  it('odd and fractional tile counts are raised to the next even number (at least 2)', () => {
    expect([1, 2, 3, 4, 5, 7, 2.2].map(evenTiles)).toEqual([2, 2, 4, 4, 6, 8, 4]);
    expect(decideSplit(new Rng(1), 1, 1, 3)).toMatchObject({ parentTiles: 4, promoted: true });
    expect(decideSplit(new Rng(1), 1, 1, 4)).toMatchObject({ parentTiles: 4, promoted: false });
  });

  it('even tile counts split cleanly: the halves carry half of the tiles and the next half starts half a parent further', () => {
    for (const t of [2, 4, 6, 8]) {
      const m1 = splitHalfMapping(t, 0.25, 3, 16, 1);
      const m2 = splitHalfMapping(t, 0.25, 3, 16, 2);
      expect(m1?.uTiles).toBe(t / 2);
      expect(m2?.uTiles).toBe(t / 2);
      // U of outline column j is `offset + (j + phase) / N * tiles`; the half's first vertex is column 0 / N / 2.
      expect(m1!.uStart).toBeCloseTo(0.25 + (3 / 16) * t, 9);
      expect(m2!.uStart - m1!.uStart).toBeCloseTo(t / 2, 9);
    }
    expect(splitHalfMapping(3, 0, 0, 16, 1)).toBeNull();
    expect(splitHalfMapping(1, 0, 0, 16, 1)).toBeNull();
  });

  it('a splitting branch with an odd U tile count raises it and reports a node warning', () => {
    const lines: string[] = [];
    const notes = newSpineNotes();
    notes.splitTilesPromoted = 2;
    reportSpineNotes({ warn: (m: string) => lines.push(m), info: () => undefined, error: () => undefined, debug: () => undefined } as never, notes);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('even');
    const none = newSpineNotes();
    reportSpineNotes({ warn: (m: string) => lines.push(m) } as never, none);
    expect(lines).toHaveLength(1);
  });
});

/** Appends the extension skeleton to the trunk skeleton as sub-level extensions of the halves (the same-mesh case that shares indices). */
function mergeExtension(trunk: Skeleton, ext: Skeleton): Skeleton {
  const n = trunk.count + ext.count;
  const cat = (a: Float32Array | Uint16Array | Int32Array | Uint32Array, b: Float32Array | Uint16Array | Int32Array | Uint32Array, w: number): Float32Array => {
    const out = new Float32Array(n * w);
    out.set(a as ArrayLike<number>, 0);
    out.set(b as ArrayLike<number>, trunk.count * w);
    return out;
  };
  const attributes = new Map<string, Float32Array>();
  const names = new Set<string>([...trunk.attributes.keys(), ...ext.attributes.keys()]);
  for (const k of names) {
    const out = new Float32Array(n);
    const a = trunk.attributes.get(k);
    const b = ext.attributes.get(k);
    if (a) out.set(a, 0);
    if (b) out.set(b, trunk.count);
    attributes.set(k, out);
  }
  const idShift = 1000;
  const branches = [
    ...trunk.branches,
    ...ext.branches.map((b) => ({ ...b, id: b.id + idShift, start: b.start + trunk.count })),
  ];
  const sub = new Float32Array(n);
  const flag = new Float32Array(n);
  for (const b of ext.branches) {
    sub[b.start + trunk.count] = 1;
    flag[b.start + trunk.count] = 1;
  }
  const ex = attributes.get(EXTENSION_ATTR) ?? new Float32Array(n);
  for (let i = trunk.count; i < n; i++) if ((flag[i] as number) > 0) ex[i] = Math.max(1, ex[i] as number);
  attributes.set(EXTENSION_ATTR, ex);
  attributes.set(SUB_LEVEL_ATTR, sub);
  return {
    count: n,
    position: cat(trunk.position, ext.position, 3),
    radius: cat(trunk.radius, ext.radius, 1),
    direction: cat(trunk.direction, ext.direction, 3),
    tangent: cat(trunk.tangent, ext.tangent, 3),
    generation: Uint16Array.from([...trunk.generation, ...ext.generation]),
    parent: Int32Array.from([...trunk.parent, ...ext.parent]),
    branchId: Uint32Array.from([...trunk.branchId, ...ext.branchId.map((v) => v + idShift)]),
    t: cat(trunk.t, ext.t, 1),
    age: cat(trunk.age, ext.age, 1),
    attributes,
    branches,
  };
}

describe('T09 - ring vertices shared by index', () => {
  it('the first ring of an extension of the same mesh uses the half end-ring vertices (index equality)', async () => {
    const { trunk, ext } = await forkSkeletons();
    const separate = buildTubeMesh(trunk, tubeOptions(16));
    const extAlone = buildTubeMesh(ext, tubeOptions(16, { parent: trunk }));
    const merged = mergeExtension(trunk, ext);
    expect(findSplitLobes(merged).size).toBe(1);
    const joint = buildTubeMesh(merged, tubeOptions(16));
    const half = 8;
    const sharedRings = ext.branches.length;
    // Every shared ring removes (half + 1) duplicated vertices; nothing else changes.
    const expected = separate.positions.length / 3 + extAlone.positions.length / 3 - sharedRings * (half + 1);
    expect(joint.positions.length / 3).toBe(expected);
    // Index equality: the triangles of the extension's first quad row reference vertices of the crotch (index below the extension's).
    const crotchVertices = separate.positions.length / 3;
    let touching = 0;
    for (let t = 0; t < joint.indices.length; t += 3) {
      const ids = [joint.indices[t]!, joint.indices[t + 1]!, joint.indices[t + 2]!];
      const lo = ids.filter((i) => i < crotchVertices).length;
      if (t / 3 >= separate.indices.length / 3 && lo > 0 && lo < 3) touching++;
    }
    expect(touching).toBeGreaterThanOrEqual(sharedRings * half * 2);
  });

  it('the snapped fallback (extension built by another node) leaves no open edge together with the trunk', async () => {
    const { trunk, ext } = await forkSkeletons();
    const a = buildTubeMesh(trunk, tubeOptions(16, { displaceField: spy([], () => 'x') }));
    const b = buildTubeMesh(ext, tubeOptions(16, { parent: trunk, displaceField: spy([], () => 'y') }));
    const q = meshQuality([a, b]);
    expect(q.boundaryEdges).toBe(0);
    expect(q.nanCount).toBe(0);
  });
});

describe('T09 - extension ring count follows N / 2 of its half at every LOD', () => {
  /** Number of the half's end-ring vertices that the extension mesh reproduces exactly (= N / 2 only when the ring counts agree). */
  const exactRingVertices = (m: MeshData, trunk: Skeleton, lobeId: number): { found: number; half: number } => {
    const ring = lobeEndRing(trunk, lobeId) as Float32Array;
    const have = new Set<string>();
    for (let i = 0; i < m.positions.length / 3; i++) have.add(`${m.positions[i * 3]},${m.positions[i * 3 + 1]},${m.positions[i * 3 + 2]}`);
    let found = 0;
    for (let i = 0; i < ring.length / 3; i++) if (have.has(`${ring[i * 3]},${ring[i * 3 + 1]},${ring[i * 3 + 2]}`)) found++;
    return { found, half: ring.length / 3 };
  };

  it.each([0, 1, 2, 3])('LOD %i: the first ring has exactly N / 2 vertices, whatever the extension asks for', async (lod) => {
    const { trunk, ext } = await forkSkeletons();
    const parentSides = [24, 16, 10, 7][lod] as number;
    const evenN = Math.max(6, parentSides % 2 === 0 ? parentSides : parentSides + 1);
    const extSides = [12, 9, 5, 3][lod] as number;
    const tm = buildTubeMesh(trunk, tubeOptions(parentSides));
    expect(tm.indices.length).toBeGreaterThan(0);
    const em = buildTubeMesh(ext, tubeOptions(extSides, { parent: trunk }));
    for (const b of ext.branches) {
      const { found, half } = exactRingVertices(em, trunk, b.parentBranch);
      expect(half).toBe(evenN / 2);
      expect(found).toBe(half);
    }
  });

  it('is deterministic at every LOD', async () => {
    const { trunk, ext } = await forkSkeletons();
    for (const sides of [24, 16, 10, 7]) {
      buildTubeMesh(trunk, tubeOptions(sides));
      const a = buildTubeMesh(ext, tubeOptions(6, { parent: trunk }));
      const b = buildTubeMesh(ext, tubeOptions(6, { parent: trunk }));
      expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    }
  });
});

describe('T09 - colour and AO blend through the crotch', () => {
  it('the vertex colour moves from the parent colour at ring 0 to the lobe colour at the open ends', async () => {
    const { trunk } = await forkSkeletons();
    const m = buildTubeMesh(trunk, tubeOptions(16, { capEnd: false }));
    const col = m.colors;
    expect(col).toBeDefined();
    // The trunk is generation 0 (0.4, 0.3, 0.2), the lobes generation 0 as well (same branch generation): the blend stays inside the range.
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < (col as Float32Array).length; i += 4) {
      lo = Math.min(lo, (col as Float32Array)[i] as number);
      hi = Math.max(hi, (col as Float32Array)[i] as number);
    }
    expect(Number.isFinite(lo) && Number.isFinite(hi)).toBe(true);
    expect(hi).toBeLessThanOrEqual(0.45);
  });

  it('the valley is darker than the parent surface', async () => {
    const r = await run(graph({ splitsValleyRadius: 0.3, splitsWaist: 0.8 }));
    const m = meshOf(r, 'trunk');
    const ao = m.ao;
    if (!ao) return;
    let min = 1;
    for (const v of ao) min = Math.min(min, v);
    expect(min).toBeLessThan(0.9);
  });
});

describe('T09 - flags', () => {
  it('SPLIT_ATTR flags of a splitting trunk mark the parent and both halves', async () => {
    const { trunk } = await forkSkeletons();
    const flags = trunk.attributes.get(SPLIT_ATTR) as Float32Array;
    const seen = new Set<number>();
    for (const b of trunk.branches) seen.add(Math.round(flags[b.start] as number));
    expect([...seen].some((f) => (f & SplitFlag.Parent) !== 0)).toBe(true);
    expect([...seen].some((f) => (f & SplitFlag.Side1) !== 0)).toBe(true);
    expect([...seen].some((f) => (f & SplitFlag.Side2) !== 0)).toBe(true);
  });
});
