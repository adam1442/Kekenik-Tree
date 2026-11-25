import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { createSectionEvaluator, ROUND_SECTION, type SectionShape } from '@/geometry/crossSection';
import { createButtressProfile } from '@/geometry/buttress';
import { collarSwellBump } from '@/geometry/tubeMesher';
import { meshQuality } from '@/geometry/meshQuality';
import { createRadiusNoise, irregularityEndFade } from '@/generators/skin';
import { profileMetrics } from '@/qa';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const TRUNK = {
  number: 1,
  spread: 0,
  gravity: 0,
  curvature: 0,
  upDown: 0,
  noiseAmount: 0,
  earlyNoiseAmount: 0,
  straightness: 1,
  lean: 0,
  length: { value: 6, variance: 0 },
  radius: { value: 0.3, variance: 0 },
  taper: 0.5,
  flareRadius: 0,
  sides: 48,
  accuracy: 24,
  segments: 24,
};
const BRANCH = { number: 8, first: 0.3, last: 0.9, mode: 'absolute', spread: { value: 70, variance: 0 }, length: { value: 2, variance: 0 }, radius: { value: 0.06, variance: 0 }, noiseAmount: 0, gravity: 0, sides: 12 };

const specs = (trunk: Record<string, unknown> = {}, branch: Record<string, unknown> | null = null): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, ...trunk } as NodeSpec['params'] },
  ...(branch ? [{ id: 'br', type: 'generator.branch', parent: 'tr', params: { ...BRANCH, ...branch } as NodeSpec['params'] }] : []),
];
const run = (list: NodeSpec[], seed = 3) => new GraphEvaluator().evaluate(snapshotGraph(buildGraph(list)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const radiiOf = (sk: Skeleton, bi = 0): number[] => {
  const b = sk.branches[bi]!;
  return Array.from(sk.radius.subarray(b.start, b.start + b.count));
};
const rms = (xs: number[]): number => Math.sqrt(xs.reduce((a, x) => a + x * x, 0) / Math.max(1, xs.length));
const pearson = (a: number[], b: number[]): number => {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    num += (a[i]! - ma) * (b[i]! - mb);
    da += (a[i]! - ma) ** 2;
    db += (b[i]! - mb) ** 2;
  }
  return num / Math.sqrt(da * db || 1);
};

describe('T06 parameters', () => {
  it('exposes Irregularity, organic section, collar swell and buttress parameters with tooltips and neutral defaults', () => {
    const def = getNodeDef('generator.trunk')!;
    const ids = ['radiusNoiseAmount', 'radiusNoiseScale', 'radiusNoiseSeed', 'radiusNoiseParent', 'sectionOval', 'sectionDrift', 'grainTwist', 'collarSwell', 'buttressCount', 'buttressHeight', 'buttressLength', 'buttressThickness'];
    for (const id of ids) expect(def.params.some((p) => p.id === id), id).toBe(true);
    for (const id of ['radiusNoiseAmount', 'collarSwell', 'buttressCount', 'grainTwist']) expect(def.params.find((p) => p.id === id)!.default).toBe(0);
    expect(def.params.find((p) => p.id === 'sectionShape')!.default).toBe('round');
    expect(getNodeDef('generator.branch')!.params.some((p) => p.id === 'radiusNoiseParent')).toBe(true);
  });
});

describe('Skin > Irregularity (radius noise)', () => {
  it('has unit RMS before the amount is applied (every seed, both octaves)', () => {
    let sum = 0;
    let n = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const g = createRadiusNoise(1, seed);
      for (let i = 0; i < 3000; i++) {
        const v = g.field(i * 0.05, 0);
        sum += v * v;
        n++;
      }
    }
    expect(Math.sqrt(sum / n)).toBeGreaterThan(0.85);
    expect(Math.sqrt(sum / n)).toBeLessThan(1.15);
  });

  it('is off at amount 0, never closes the tube and fades before a split', () => {
    const g = createRadiusNoise(1, 1);
    expect(g.factor(3, 0, 0)).toBe(1);
    for (let i = 0; i < 2000; i++) expect(g.factor(i * 0.03, 0, 0.6)).toBeGreaterThanOrEqual(0.4);
    expect(irregularityEndFade(0.5, true)).toBe(1);
    expect(irregularityEndFade(1, true)).toBe(0);
    expect(irregularityEndFade(1, false)).toBe(1);
  });

  const LONG = { length: { value: 40, variance: 0 }, taper: 0.5, accuracy: 256, segments: 256, sides: 12 };

  it('the RMS roughness of a generated trunk equals the requested amount within 20 %', async () => {
    const plain = skeletonOf(await run(specs(LONG)), 'tr');
    for (const amount of [0.05, 0.1]) {
      const noisy = skeletonOf(await run(specs({ ...LONG, radiusNoiseAmount: amount, radiusNoiseScale: 0.8 })), 'tr');
      const a = radiiOf(plain);
      const b = radiiOf(noisy);
      expect(b.length).toBe(a.length);
      const rel = b.map((r, i) => r / (a[i] as number) - 1);
      expect(rms(rel)).toBeGreaterThan(amount * 0.8);
      expect(rms(rel)).toBeLessThan(amount * 1.2);
    }
  });

  it('is deterministic, depends on its seed and changes nothing at the default', async () => {
    const base = { ...LONG, radiusNoiseAmount: 0.1 };
    const a = radiiOf(skeletonOf(await run(specs(base)), 'tr'));
    const b = radiiOf(skeletonOf(await run(specs(base)), 'tr'));
    const c = radiiOf(skeletonOf(await run(specs({ ...base, radiusNoiseSeed: 9 })), 'tr'));
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
    const plain = radiiOf(skeletonOf(await run(specs(LONG)), 'tr'));
    const zero = radiiOf(skeletonOf(await run(specs({ ...LONG, radiusNoiseAmount: 0, radiusNoiseScale: 3 })), 'tr'));
    expect(zero).toEqual(plain);
  });

  it('stays watertight (zero open edges, no NaN) on a noisy trunk', async () => {
    const r = await run(specs({ radiusNoiseAmount: 0.25, radiusNoiseScale: 0.4, sectionShape: 'organic', sectionDepth: 0.15 }));
    const q = meshQuality(meshOf(r, 'tr'));
    expect(q.boundaryEdges).toBe(0);
    expect(q.nonManifoldEdges).toBe(0);
    expect(q.nanCount).toBe(0);
  });
});

describe('organic cross-section', () => {
  const shape: SectionShape = { ...ROUND_SECTION, kind: 'organic', lobes: 5, depth: 0.12, oval: 0.1, drift: 2, seed: 4 };
  const ring = (ev: ReturnType<typeof createSectionEvaluator>, s: number, n = 64): number[] => Array.from({ length: n }, (_, k) => ev.radius((2 * Math.PI * k) / n, s));

  it('drifts slowly: neighbouring rings correlate > 0.9, the first and the last ring differ', () => {
    for (const grainTwist of [0, 20]) {
      const ev = createSectionEvaluator({ ...shape, grainTwist });
      const rings: number[][] = [];
      for (let s = 0; s <= 6.0001; s += 0.05) rings.push(ring(ev, s));
      for (let i = 1; i < rings.length; i++) expect(pearson(rings[i - 1]!, rings[i]!)).toBeGreaterThan(0.9);
      const first = rings[0]!;
      const last = rings[rings.length - 1]!;
      expect(pearson(first, last)).toBeLessThan(0.9);
      expect(Math.max(...first.map((v, k) => Math.abs(v - (last[k] as number))))).toBeGreaterThan(0.02);
    }
  });

  it('is not a circle, stays bounded and is deterministic', () => {
    const ev = createSectionEvaluator(shape);
    const again = createSectionEvaluator(shape);
    const r = ring(ev, 1.3);
    expect(Math.max(...r) - Math.min(...r)).toBeGreaterThan(0.05);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0.2);
    expect(Math.max(...r)).toBeLessThan(1.6);
    expect(ring(again, 1.3)).toEqual(r);
    const round = createSectionEvaluator(ROUND_SECTION);
    expect(ring(round, 1.3).every((v) => v === 1)).toBe(true);
  });

  it('grain twist turns the lobes along the stem', () => {
    const a = createSectionEvaluator({ ...shape, oval: 0, grainTwist: 0 });
    const b = createSectionEvaluator({ ...shape, oval: 0, grainTwist: 90 });
    expect(ring(a, 0)).toEqual(ring(b, 0));
    expect(pearson(ring(a, 2), ring(b, 2))).toBeLessThan(0.9);
  });

  it('a Branch / Trunk with the organic profile meshes watertight, also when it splits', async () => {
    const organic = { sectionShape: 'organic', sectionOval: 0.15, sectionDepth: 0.15, grainTwist: 30, sectionDrift: 1.5 };
    const plain = await run(specs({ ...organic, splitsChance: 1, splitsSpread1: 30, splitsSpread2: 30, sides: 24, radiusNoiseAmount: 0.1 }));
    const q = meshQuality(meshOf(plain, 'tr'));
    expect(meshOf(plain, 'tr').indices.length).toBeGreaterThan(300);
    expect(q.boundaryEdges).toBe(0);
    expect(q.nanCount).toBe(0);
    expect(skeletonOf(plain, 'tr').branches.length).toBeGreaterThanOrEqual(3);
  });

  it('works with flatten and squash', async () => {
    const r = await run(specs({ sectionShape: 'organic', flatten: 0.7, squashAmount: 0.4 }));
    const q = meshQuality(meshOf(r, 'tr'));
    expect(q.boundaryEdges).toBe(0);
    expect(q.nanCount).toBe(0);
  });
});

describe('children on an organic, noisy trunk', () => {
  it('weld without a failed weld', async () => {
    const r = await run(specs({ sectionShape: 'organic', sectionOval: 0.15, radiusNoiseAmount: 0.12, radiusNoiseScale: 0.7 }, { weldEnabled: true, weldSpreadAmount: 0.3 }));
    const sk = skeletonOf(r, 'br');
    expect(sk.branches.length).toBe(8);
    expect(sk.attributes.get('weld')!.every((v) => v === 1)).toBe(true);
    expect(meshQuality(meshOf(r, 'br')).nanCount).toBe(0);
  });

  it('keep growing from the real (noisy) radius', async () => {
    const r = await run(specs({ radiusNoiseAmount: 0.2, radiusNoiseScale: 0.5 }, {}));
    const tr = skeletonOf(r, 'tr');
    const br = skeletonOf(r, 'br');
    expect(br.branches.length).toBe(8);
    for (const b of br.branches) {
      const p = b.parentPoint;
      const base = new Float32Array(3).map((_, c) => br.position[b.start * 3 + c] as number);
      // The child starts on the trunk spine at a real trunk point.
      const px = [tr.position[p * 3] as number, tr.position[p * 3 + 1] as number, tr.position[p * 3 + 2] as number];
      expect(Math.hypot(base[0]! - px[0]!, base[1]! - px[1]!, base[2]! - px[2]!)).toBeLessThan(1.5);
    }
  });
});

describe('collar swell', () => {
  const plainBranch = { collarAmount: 0.3, collarLength: 1.5 };

  it('bump is 1 inside, 0 outside and smooth', () => {
    expect(collarSwellBump(-1)).toBe(1);
    expect(collarSwellBump(0)).toBe(1);
    expect(collarSwellBump(1)).toBe(0);
    expect(collarSwellBump(2)).toBe(0);
    let last = 1;
    for (let x = 0; x <= 1; x += 0.02) {
      const v = collarSwellBump(x);
      expect(v).toBeLessThanOrEqual(last + 1e-12);
      last = v;
    }
  });

  it('pushes the skin out by at most collarSwell x the child radius, with no cracks', async () => {
    const swell = 0.6;
    const a = await run(specs({}, plainBranch));
    const b = await run(specs({}, { ...plainBranch, collarSwell: swell }));
    const ma = meshOf(a, 'br');
    const mb = meshOf(b, 'br');
    expect(mb.positions.length).toBe(ma.positions.length);
    let maxMove = 0;
    let moved = 0;
    for (let i = 0; i < ma.positions.length; i += 3) {
      const d = Math.hypot(mb.positions[i]! - ma.positions[i]!, mb.positions[i + 1]! - ma.positions[i + 1]!, mb.positions[i + 2]! - ma.positions[i + 2]!);
      maxMove = Math.max(maxMove, d);
      if (d > 1e-6) moved++;
    }
    const sk = skeletonOf(b, 'br');
    const childRadius = Math.max(...sk.branches.map((br) => sk.radius[br.start] as number));
    expect(moved).toBeGreaterThan(0);
    expect(maxMove).toBeLessThanOrEqual(swell * childRadius * 1.0001 + 1e-6);
    const q = meshQuality(mb);
    expect(q.nanCount).toBe(0);
    expect(q.nonManifoldEdges).toBe(0);
  });

  it('default (0) leaves the mesh exactly as before', async () => {
    const a = await run(specs({}, plainBranch));
    const b = await run(specs({}, { ...plainBranch, collarSwell: 0 }));
    expect(Array.from(meshOf(b, 'br').positions)).toEqual(Array.from(meshOf(a, 'br').positions));
  });
});

describe('buttresses', () => {
  const minZ = (m: MeshData): number => {
    let z = Infinity;
    for (let i = 2; i < m.positions.length; i += 3) z = Math.min(z, m.positions[i] as number);
    return z;
  };
  const reachNearGround = (m: MeshData, zMax: number): number => {
    let r = 0;
    for (let i = 0; i < m.positions.length; i += 3) if ((m.positions[i + 2] as number) < zMax) r = Math.max(r, Math.hypot(m.positions[i] as number, m.positions[i + 1] as number));
    return r;
  };
  const fins = { buttressCount: 5, buttressHeight: 2, buttressLength: 1.5, buttressThickness: 0.3, sides: 64 };

  it('profile: reach shrinks with height, is 0 above it and between fins, deterministic', () => {
    const p = createButtressProfile({ count: 4, height: 2, length: 1, thickness: 0.3 }, 5, 64);
    const q = createButtressProfile({ count: 4, height: 2, length: 1, thickness: 0.3 }, 5, 64);
    let atGround = 0;
    let atMid = 0;
    let between = Infinity;
    for (let k = 0; k < 720; k++) {
      const a = (2 * Math.PI * k) / 720;
      atGround = Math.max(atGround, p(a, 0, 0.3));
      atMid = Math.max(atMid, p(a, 1, 0.3));
      between = Math.min(between, p(a, 0, 0.3));
      expect(p(a, 3, 0.3)).toBe(0);
      expect(q(a, 0.4, 0.3)).toBe(p(a, 0.4, 0.3));
    }
    expect(atGround).toBeGreaterThan(0.15);
    expect(atMid).toBeLessThan(atGround);
    expect(atMid).toBeGreaterThan(0);
    expect(between).toBe(0);
  });

  it('fins stick out at the base and never go below the ground anchor (also on a leaning trunk)', async () => {
    for (const lean of [0, 25]) {
      const flat = await run(specs({ lean, sides: fins.sides }));
      const withFins = await run(specs({ lean, ...fins }));
      const m = meshOf(withFins, 'tr');
      expect(minZ(m)).toBeGreaterThanOrEqual(minZ(meshOf(flat, 'tr')) - 1e-5);
      if (lean === 0) expect(minZ(m)).toBeGreaterThanOrEqual(-1e-3);
      if (lean === 0) {
        expect(reachNearGround(m, 0.3)).toBeGreaterThan(reachNearGround(meshOf(flat, 'tr'), 0.3) * 1.3);
        // Above the fins the trunk is untouched.
        expect(reachNearGround(m, 100)).toBeLessThan(reachNearGround(meshOf(flat, 'tr'), 100) * 1.0 + 0.3 * 1.5 * 1.4);
      }
      const q = meshQuality(m);
      expect(q.boundaryEdges).toBe(0);
      expect(q.nanCount).toBe(0);
    }
  });

  it('defaults to off: identical mesh', async () => {
    const a = await run(specs({}));
    const b = await run(specs({ buttressCount: 0, buttressHeight: 3 }));
    expect(Array.from(meshOf(b, 'tr').positions)).toEqual(Array.from(meshOf(a, 'tr').positions));
  });
});

describe('T04 realism metrics move toward the targets', () => {
  it('circularity deviation (target 2-6 %) and radius roughness (target 1-3 %) grow when enabled', async () => {
    const base = { length: { value: 8, variance: 0 }, sides: 48, accuracy: 64, segments: 64 };
    const off = profileMetrics(skeletonOf(await run(specs(base)), 'tr'), meshOf(await run(specs(base)), 'tr')).trunk!;
    const onSpec = { ...base, sectionShape: 'organic', sectionOval: 0.05, sectionDepth: 0.05, radiusNoiseAmount: 0.03, radiusNoiseScale: 0.9 };
    const onRun = await run(specs(onSpec));
    const on = profileMetrics(skeletonOf(onRun, 'tr'), meshOf(onRun, 'tr')).trunk!;
    expect(on.circularityDeviation).toBeGreaterThan(off.circularityDeviation);
    expect(on.circularityDeviation).toBeGreaterThan(0.015);
    expect(on.circularityDeviation).toBeLessThan(0.1);
    expect(on.radiusRoughness).toBeGreaterThan(off.radiusRoughness);
    expect(on.radiusRoughness).toBeGreaterThan(0.005);
    expect(on.radiusRoughness).toBeLessThan(0.06);
  });
});
