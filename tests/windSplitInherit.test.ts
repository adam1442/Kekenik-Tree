import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { SPINE_ORIGIN_ATTR, SpineOrigin } from '@/generators/split';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { computeSkeletonWind, WIND_ATTRIBUTES } from '@/geometry/windAttributes';
import { hash01 } from '@/geometry/math3';
import { defaultWindParams } from '@/viewport/wind/windParams';
import { windDisplacement, type WindVertex } from '@/viewport/wind/windReference';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const trunk = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, length: 6, radius: 0.3, splitsChance: 1, ...extra } as NodeSpec['params'] },
];
const extender = (id: string, parent: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.branch',
  parent,
  params: { ...STRAIGHT, number: 1, extendParent: 'any', extendCount: 1, knockout: 1, ...extra } as NodeSpec['params'],
});

const channels = (sk: Skeleton): Float32Array[] => WIND_ATTRIBUTES.map((k) => sk.attributes.get(k) as Float32Array);
const vec = (sk: Skeleton, i: number): number[] => channels(sk).map((a) => a[i] as number);
const origin = (sk: Skeleton, b: Skeleton['branches'][number]): number => Math.round(sk.attributes.get(SPINE_ORIGIN_ATTR)?.[b.start] ?? 0);
const near = (a: number[], b: number[]): void => a.forEach((x, i) => expect(Math.abs(x - (b[i] as number)), `channel ${i}: ${a} vs ${b}`).toBeLessThan(1e-6));

/** Every split half of `sk` starts with the wind vector of the point of the same skeleton it attaches to, and its weights never decrease. */
function expectHalvesInherit(sk: Skeleton): number {
  let halves = 0;
  for (const b of sk.branches) {
    if (origin(sk, b) !== SpineOrigin.SplitHalf) continue;
    halves += 1;
    near(vec(sk, b.start), vec(sk, b.parentPoint));
    for (const c of [0, 1, 2]) {
      const a = channels(sk)[c] as Float32Array;
      for (let k = 1; k < b.count; k++) {
        expect(a[b.start + k] as number).toBeGreaterThanOrEqual((a[b.start + k - 1] as number) - 1e-7);
        expect(a[b.start + k] as number).toBeLessThanOrEqual(1 + 1e-6);
      }
    }
  }
  return halves;
}

describe('wind inheritance of split halves and extensions', () => {
  it('a: both halves of a trunk split start with the wind of the fork point', async () => {
    const r = await run(trunk());
    const sk = skeletonOf(r, 'trunk');
    expect(expectHalvesInherit(sk)).toBe(2);
    const half = sk.branches.find((b) => origin(sk, b) === SpineOrigin.SplitHalf)!;
    expect(vec(sk, half.parentPoint)[0]).toBeGreaterThan(0.3);
    expect(vec(sk, half.parentPoint)[0]).toBeLessThan(1);
    // the two halves share the phase of the trunk
    const phases = sk.branches.map((b) => vec(sk, b.start)[3] as number);
    expect(new Set(phases.map((p) => p.toFixed(6))).size).toBe(1);
  });

  it('b: a second split (halves of a split extension) inherits the same way', async () => {
    const r = await run([...trunk({ sides: 32 }), extender('ext', 'trunk', { splitsChance: 1, sides: 32 })]);
    const t = skeletonOf(r, 'trunk');
    const e = skeletonOf(r, 'ext');
    expect(expectHalvesInherit(t)).toBe(2);
    expect(expectHalvesInherit(e)).toBeGreaterThanOrEqual(2);
    const ext = e.branches.find((b) => origin(e, b) === SpineOrigin.Extension)!;
    expect(ext).toBeDefined();
  });

  it('c: Trunk (split) -> extension -> children: every first point equals its attach point', async () => {
    const r = await run([
      ...trunk(),
      extender('ext', 'trunk'),
      { id: 'kids', type: 'generator.branch', parent: 'ext', params: { ...STRAIGHT, number: 3, first: 0.2, last: 0.9, length: 1 } as NodeSpec['params'] },
    ]);
    const t = skeletonOf(r, 'trunk');
    const e = skeletonOf(r, 'ext');
    const k = skeletonOf(r, 'kids');
    expect(e.branches.length).toBeGreaterThan(0);
    for (const b of e.branches) {
      expect(origin(e, b)).toBe(SpineOrigin.Extension);
      const host = t.branches.find((h) => h.id === b.parentBranch)!;
      expect(b.parentPoint).toBe(host.start + host.count - 1);
      near(vec(e, b.start), vec(t, b.parentPoint));
      expect(e.attributes.get('wind0')![b.start]!).toBeGreaterThan(0.9);
      for (const c of [0, 1, 2]) {
        const a = channels(e)[c] as Float32Array;
        for (let i = 1; i < b.count; i++) expect(a[b.start + i] as number).toBeGreaterThanOrEqual((a[b.start + i - 1] as number) - 1e-7);
      }
    }
    expect(k.branches.length).toBe(3 * e.branches.length);
    for (const b of k.branches) {
      const w = vec(k, b.start);
      const host = vec(e, b.parentPoint);
      // regular children inherit the levels above their own from the attach point; the own level starts at 0
      expect(w[0]).toBeCloseTo(host[0] as number, 6);
    }
  });

  it('d: no tearing on the final mesh: coincident rest-pose vertices move together', async () => {
    const r = await run([...trunk({ sides: 16 }), extender('ext', 'trunk', { splitsChance: 0 })]);
    const p = { ...defaultWindParams(), enabled: true, strength: 2 };
    let pairs = 0;
    const meshes = ['trunk', 'ext'].map((id) => meshOf(r, id));
    for (const m of meshes) expect(m.wind).toBeDefined();
    const cell = 1e-3;
    const grid = new Map<string, Array<[number, number]>>();
    const key = (x: number, y: number, z: number): string => `${Math.round(x / cell)},${Math.round(y / cell)},${Math.round(z / cell)}`;
    const vertex = (m: number, i: number): WindVertex => {
      const mesh = meshes[m] as MeshData;
      return {
        position: [mesh.positions[i * 3]!, mesh.positions[i * 3 + 1]!, mesh.positions[i * 3 + 2]!],
        weights: [0, 1, 2, 3].map((c) => mesh.wind!.weights[i * 4 + c]!) as [number, number, number, number],
        phase1: mesh.wind!.phase1![i]!,
      };
    };
    let crossPairs = 0;
    meshes.forEach((mesh, m) => {
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        const a = vertex(m, i);
        const [x, y, z] = a.position;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          for (const [m2, j] of grid.get(key(x + dx * cell, y + dy * cell, z + dz * cell)) ?? []) {
            const b = vertex(m2, j);
            if (Math.hypot(x - b.position[0], y - b.position[1], z - b.position[2]) >= 1e-4) continue;
            pairs += 1;
            if (m2 !== m) crossPairs += 1;
            for (const t of [0.7, 2.3, 5.1, 9.4]) {
              for (const H of [4, 10]) {
                const da = windDisplacement(p, a, t, H);
                const db = windDisplacement(p, b, t, H);
                expect(Math.hypot(da[0] - db[0], da[1] - db[1], da[2] - db[2])).toBeLessThan(1e-4);
              }
            }
          }
        }
        const k = key(x, y, z);
        const list = grid.get(k);
        if (list) list.push([m, i]);
        else grid.set(k, [[m, i]]);
      }
    });
    expect(crossPairs).toBeGreaterThan(8);
    expect(pairs).toBeGreaterThan(50);
  });

  it('e: a regular (non-split) tree keeps the previous wind formula bit for bit', () => {
    const b = new SkeletonBuilder();
    const t0 = b.beginBranch(-1, -1, 0);
    for (let k = 0; k < 6; k++) b.addPoint(0, 0, k, 0.3 - k * 0.03);
    b.endBranch();
    const b1 = b.beginBranch(t0, 3, 1);
    for (let k = 0; k < 5; k++) b.addPoint(k * 0.4, 0, 3 + k * 0.3, 0.1);
    b.endBranch();
    const b2 = b.beginBranch(b1, 7, 2);
    for (let k = 0; k < 4; k++) b.addPoint(1 + k * 0.2, 0.5 * k, 4 + k * 0.2, 0.05);
    b.endBranch();
    const sk = b.build();
    const w = computeSkeletonWind(sk, null, 5);
    // reference: the formula before the split inheritance (host arrays only come from `parent`, which is null here)
    const ref = [new Float32Array(sk.count), new Float32Array(sk.count), new Float32Array(sk.count), new Float32Array(sk.count)];
    for (const br of sk.branches) {
      const level = Math.min(br.generation, 2);
      const attach = br.parentPoint;
      const inherit = [0, 0, 0, 0];
      if (attach >= 0) for (let c = 0; c < 4; c++) inherit[c] = c < 3 && c < level ? 1 : 0;
      const phase = (inherit[3] as number) * 0.5 + hash01(br.id * 7 + 1, 5) * 0.5 + (attach >= 0 ? 0 : hash01(5, 3) * 0.2);
      for (let k = 0; k < br.count; k++) {
        const i = br.start + k;
        const own = Math.pow(Math.max(0, Math.min(1, sk.t[i] as number)), 1.5);
        const x: [number, number, number] = [inherit[0] as number, inherit[1] as number, inherit[2] as number];
        if (br.generation >= 2) x[2] = x[2] + own * (1 - x[2]);
        else x[level] = own;
        for (let c = level + 1; c < 3; c++) x[c] = 0;
        (ref[0] as Float32Array)[i] = x[0];
        (ref[1] as Float32Array)[i] = x[1];
        (ref[2] as Float32Array)[i] = x[2];
        (ref[3] as Float32Array)[i] = phase - Math.floor(phase);
      }
    }
    expect(b2).toBeGreaterThan(b1);
    for (let c = 0; c < 4; c++) expect(Array.from(w[c] as Float32Array)).toEqual(Array.from(ref[c] as Float32Array));
  });
});
