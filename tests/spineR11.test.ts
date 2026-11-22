import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { curveToLUT } from '@/core/curve';
import { Rng } from '@/core/rng';
import {
  JINK_MAX_SHIFT,
  applyJink,
  applyPath,
  breaks,
  brokenLength,
  clampBreakSpot,
  cumulativeLength,
  earlyNoiseGate,
  jinkKnots,
  jinkSegmentCount,
  lateSmoothRadius,
  pathOffsetAt,
  pathPhase,
  polylineLength,
  smoothNoiseOffsets,
  type PathSettings,
} from '@/generators/spine';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { pathProfileCurve } from '@/nodes/generators/params';
import { buildInspectorSections } from '@/ui/panels/properties/inspectorState';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string) => r.scene.skeletons.find((s) => s.nodeId === id)!.skeleton;

/** Spine node with every shaping force switched off, so the only deviation from a straight line comes from the feature under test. */
const FLAT = { number: 1, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, spineOnly: true, segments: 40, accuracy: 64, noiseTwist: 0 };
const spine = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'sp', type: 'generator.spine', parent: 'tree', params: { ...FLAT, length: { value: 4, variance: 0 }, ...extra } as NodeSpec['params'] },
];
const firstBranchPoints = async (extra: Record<string, unknown>, seed = 1): Promise<Float32Array> => {
  const sk = skeletonOf(await run(spine(extra), seed), 'sp');
  const b = sk.branches[0]!;
  return sk.position.slice(b.start * 3, (b.start + b.count) * 3);
};

/** Largest distance of any point from the straight line through the first and the last point. */
function deviationFromChord(pos: Float32Array): number {
  const n = pos.length / 3;
  const a = [pos[0]!, pos[1]!, pos[2]!];
  const d = [pos[(n - 1) * 3]! - a[0]!, pos[(n - 1) * 3 + 1]! - a[1]!, pos[(n - 1) * 3 + 2]! - a[2]!];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!);
  const u = d.map((v) => v / dl);
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const v = [pos[i * 3]! - a[0]!, pos[i * 3 + 1]! - a[1]!, pos[i * 3 + 2]! - a[2]!];
    const along = v[0]! * u[0]! + v[1]! * u[1]! + v[2]! * u[2]!;
    worst = Math.max(worst, Math.hypot(v[0]! - along * u[0]!, v[1]! - along * u[1]!, v[2]! - along * u[2]!));
  }
  return worst;
}

const maxDiff = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  return worst;
};

/** Points on a quarter circle with equal arc spacing. */
function arcPolyline(count: number, radius = 2): Float32Array {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = ((i / (count - 1)) * Math.PI) / 2;
    pos[i * 3] = Math.sin(a) * radius;
    pos[i * 3 + 2] = (1 - Math.cos(a)) * radius;
  }
  return pos;
}

function corners(pos: Float32Array, count: number, eps = 1e-3): number {
  let n = 0;
  for (let i = 1; i < count - 1; i++) {
    const a = [pos[i * 3]! - pos[(i - 1) * 3]!, pos[i * 3 + 1]! - pos[(i - 1) * 3 + 1]!, pos[i * 3 + 2]! - pos[(i - 1) * 3 + 2]!];
    const b = [pos[(i + 1) * 3]! - pos[i * 3]!, pos[(i + 1) * 3 + 1]! - pos[i * 3 + 1]!, pos[(i + 1) * 3 + 2]! - pos[i * 3 + 2]!];
    const cos = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!));
    if (Math.acos(Math.max(-1, Math.min(1, cos))) > eps) n++;
  }
  return n;
}

describe('noise: early gate (Threshold) and late smoothing', () => {
  it('Early noise only starts after the Threshold and fades in smoothly', () => {
    expect(earlyNoiseGate(0.2, 0)).toBe(1);
    expect(earlyNoiseGate(0.2, 0.5)).toBe(0);
    expect(earlyNoiseGate(0.5, 0.5)).toBe(0);
    expect(earlyNoiseGate(0.95, 0.5)).toBe(1);
    const mid = earlyNoiseGate(0.54, 0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(earlyNoiseGate(1, 1)).toBe(0);
  });

  it('the profile curve value scales the gate (it can end the noise)', () => {
    expect(earlyNoiseGate(0.9, 0.2, 0.5)).toBeCloseTo(0.5, 6);
    expect(earlyNoiseGate(0.9, 0.2, 0)).toBe(0);
    expect(earlyNoiseGate(0.9, 0, -1)).toBe(0);
  });

  it('Smooth 0 keeps the offsets, higher values flatten the waves', () => {
    const n = 64;
    const raw = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      raw[i * 2] = i % 2 === 0 ? 1 : -1;
      raw[i * 2 + 1] = Math.sin(i * 0.2);
    }
    expect(smoothNoiseOffsets(raw, n, 0)).toBe(raw);
    expect(lateSmoothRadius(0, n)).toBe(0);
    expect(lateSmoothRadius(1, n)).toBeGreaterThan(5);
    const energy = (a: Float32Array): number => a.reduce((s, v) => s + v * v, 0);
    const soft = smoothNoiseOffsets(raw, n, 0.8);
    expect(energy(soft)).toBeLessThan(energy(raw) * 0.5);
    const constant = new Float32Array(n * 2).fill(0.3);
    for (const v of smoothNoiseOffsets(constant, n, 0.6)) expect(v).toBeCloseTo(0.3, 5);
  });
});

describe('jink', () => {
  it('segment count = Absolute + Relative x length, at least one', () => {
    expect(jinkSegmentCount(3, 0, 10)).toBe(3);
    expect(jinkSegmentCount(3, 0.5, 10)).toBe(8);
    expect(jinkSegmentCount(0, 0, 10)).toBe(1);
  });

  it('knots are monotone, start at 0 and end at 1; Uniformity 1 is equal spacing and ignores the seed', () => {
    const even = jinkKnots(5, 1, new Rng(1));
    const other = jinkKnots(5, 1, new Rng(99));
    expect(Array.from(even)).toEqual(Array.from(other));
    for (let i = 0; i <= 5; i++) expect(even[i]).toBeCloseTo(i / 5, 9);
    const loose = jinkKnots(8, 0, new Rng(4));
    expect(loose[0]).toBe(0);
    expect(loose[8]).toBe(1);
    for (let i = 1; i <= 8; i++) expect(loose[i]!).toBeGreaterThan(loose[i - 1]!);
    for (let i = 1; i < 8; i++) expect(Math.abs(loose[i]! - i / 8)).toBeLessThanOrEqual((JINK_MAX_SHIFT + 1e-9) / 8);
    expect(Array.from(jinkKnots(8, 0, new Rng(5)))).not.toEqual(Array.from(loose));
  });

  it('Amount 1 makes the spine piecewise linear with exactly N segments; Amount 0 changes nothing', () => {
    const count = 41;
    const pos = arcPolyline(count);
    const before = pos.slice();
    applyJink(pos, count, 0, jinkKnots(4, 1, new Rng(1)));
    expect(maxDiff(pos, before)).toBe(0);
    expect(corners(before, count)).toBe(count - 2);
    applyJink(pos, count, 1, jinkKnots(4, 1, new Rng(1)));
    expect(corners(pos, count)).toBe(3);
    // the ends are untouched
    for (const i of [0, 1, 2, (count - 1) * 3, (count - 1) * 3 + 1, (count - 1) * 3 + 2]) expect(pos[i]).toBeCloseTo(before[i]!, 6);
    // a single segment is the chord
    const one = before.slice();
    applyJink(one, count, 1, jinkKnots(1, 1, new Rng(1)));
    expect(deviationFromChord(one)).toBeLessThan(1e-5);
  });

  it('a partial Amount lies between the original and the straightened spine', () => {
    const count = 41;
    const full = arcPolyline(count);
    const half = arcPolyline(count);
    const knots = jinkKnots(2, 1, new Rng(1));
    applyJink(full, count, 1, knots);
    applyJink(half, count, 0.5, knots);
    const orig = arcPolyline(count);
    const mid = 20 * 3;
    expect(half[mid]).toBeCloseTo((full[mid]! + orig[mid]!) / 2, 5);
  });
});

describe('path', () => {
  const lut = curveToLUT(pathProfileCurve(), 256);
  const st = (over: Partial<PathSettings> = {}): PathSettings => ({ amount: 0.5, tileLength: 2, offset: 0, twistPerMetre: 0, lut, ...over });

  it('the phase repeats with the tile length and the offset shifts it', () => {
    expect(pathPhase(0, 2, 0)).toBe(0);
    expect(pathPhase(2, 2, 0)).toBeCloseTo(0, 9);
    expect(pathPhase(0.5, 2, 0.25)).toBeCloseTo(0.5, 9);
    expect(pathPhase(3, 2, 0)).toBeCloseTo(0.5, 9);
  });

  it('the displacement is zero at the base and periodic with the tile length', () => {
    expect(pathOffsetAt(0, st())).toBe(0);
    for (const s of [0.3, 0.77, 1.4]) {
      expect(pathOffsetAt(s + 2, st())).toBeCloseTo(pathOffsetAt(s, st()), 4);
      expect(pathOffsetAt(s + 6, st())).toBeCloseTo(pathOffsetAt(s, st()), 4);
    }
    // the default profile is a sine: positive crest at a quarter, trough at three quarters
    expect(pathOffsetAt(0.5, st())).toBeGreaterThan(0.4);
    expect(pathOffsetAt(1.5, st())).toBeLessThan(-0.4);
    // Offset keeps the base attached and shifts the pattern
    expect(pathOffsetAt(0, st({ offset: 0.25 }))).toBe(0);
    expect(pathOffsetAt(0.5, st({ offset: 0.25 }))).not.toBeCloseTo(pathOffsetAt(0.5, st()), 2);
  });

  it('moves points perpendicular to a straight spine and turns the direction with Twist', () => {
    const count = 81;
    const make = (): { pos: Float32Array; nrm: Float32Array } => {
      const pos = new Float32Array(count * 3);
      const nrm = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        pos[i * 3 + 2] = (i / (count - 1)) * 4;
        nrm[i * 3] = 1;
      }
      return { pos, nrm };
    };
    const a = make();
    applyPath(a.pos, a.nrm, count, st());
    for (let i = 0; i < count; i++) {
      expect(a.pos[i * 3 + 1]).toBeCloseTo(0, 5);
      expect(a.pos[i * 3 + 2]).toBeCloseTo((i / (count - 1)) * 4, 4);
    }
    expect(a.pos[0]).toBe(0);
    expect(Math.max(...Array.from({ length: count }, (_, i) => Math.abs(a.pos[i * 3]!)))).toBeGreaterThan(0.45);
    // two tiles of 2 m: the displacement at s and s + 2 is the same
    expect(a.pos[10 * 3]).toBeCloseTo(a.pos[50 * 3]!, 3);
    const t = make();
    applyPath(t.pos, t.nrm, count, st({ twistPerMetre: Math.PI / 2 }));
    expect(Math.max(...Array.from({ length: count }, (_, i) => Math.abs(t.pos[i * 3 + 1]!)))).toBeGreaterThan(0.2);
    const none = make();
    applyPath(none.pos, none.nrm, count, st({ amount: 0 }));
    expect(maxDiff(none.pos, make().pos)).toBe(0);
  });
});

describe('break', () => {
  it('the spot is a fraction of the length and the chance is a probability', () => {
    expect(brokenLength(4, 0.5)).toBeCloseTo(2, 9);
    expect(brokenLength(4, 0.25)).toBeCloseTo(1, 9);
    expect(clampBreakSpot(5)).toBeLessThan(1);
    expect(clampBreakSpot(-1)).toBeGreaterThan(0);
    expect(breaks(0, 0)).toBe(false);
    expect(breaks(1, 0.999)).toBe(true);
    expect(breaks(0.3, 0.29)).toBe(true);
    expect(breaks(0.3, 0.31)).toBe(false);
  });
});

describe('features on a real spine', () => {
  it('Late noise: Smooth 1 gives a straight spine, Smooth 0 does not', async () => {
    const shaped = await firstBranchPoints({});
    const noisy = await firstBranchPoints({ noiseAmount: 0.8, noiseFrequency: 3, noiseSmooth: 0 });
    const smooth = await firstBranchPoints({ noiseAmount: 0.8, noiseFrequency: 3, noiseSmooth: 1 });
    expect(maxDiff(noisy, shaped)).toBeGreaterThan(0.05);
    // Smooth 1 removes all of the noise: the spine is exactly the one that was shaped (no noise)
    expect(maxDiff(smooth, shaped)).toBeLessThan(1e-4);
    const half = await firstBranchPoints({ noiseAmount: 0.8, noiseFrequency: 3, noiseSmooth: 0.5 });
    expect(maxDiff(half, shaped)).toBeLessThan(maxDiff(noisy, shaped));
    expect(maxDiff(half, shaped)).toBeGreaterThan(1e-3);
  });

  it('Early and Late noise produce different shapes and the early Threshold keeps the base straight', async () => {
    const early = await firstBranchPoints({ earlyNoiseAmount: 0.6, earlyNoiseFrequency: 3 });
    const late = await firstBranchPoints({ noiseAmount: 0.6, noiseFrequency: 3 });
    expect(deviationFromChord(early)).toBeGreaterThan(0.02);
    expect(deviationFromChord(late)).toBeGreaterThan(0.02);
    expect(maxDiff(early, late)).toBeGreaterThan(0.02);

    const gated = await firstBranchPoints({ earlyNoiseAmount: 0.6, earlyNoiseFrequency: 3, earlyNoiseThreshold: 0.6 });
    const half = (pts: Float32Array): Float32Array => pts.slice(0, Math.floor((pts.length / 3) * 0.5) * 3);
    expect(deviationFromChord(half(gated))).toBeLessThan(deviationFromChord(half(early)) / 3);
    expect(maxDiff(gated, early)).toBeGreaterThan(0.01);
    const never = await firstBranchPoints({ earlyNoiseAmount: 0.6, earlyNoiseThreshold: 1 });
    expect(maxDiff(never, await firstBranchPoints({}))).toBeLessThan(1e-4);
  });

  it('the Late Seed changes only the late noise', async () => {
    const earlyOnlyA = await firstBranchPoints({ earlyNoiseAmount: 0.5, noiseSeed: 0 });
    const earlyOnlyB = await firstBranchPoints({ earlyNoiseAmount: 0.5, noiseSeed: 11 });
    expect(maxDiff(earlyOnlyA, earlyOnlyB)).toBe(0);
    const lateA = await firstBranchPoints({ noiseAmount: 0.5, noiseSeed: 0 });
    const lateB = await firstBranchPoints({ noiseAmount: 0.5, noiseSeed: 11 });
    expect(maxDiff(lateA, lateB)).toBeGreaterThan(0.01);
  });

  it('Jink Amount 1 with one segment is a straight line and Amount 0 changes nothing', async () => {
    const curved = { curvature: 0.5, noiseAmount: 0.3, noiseFrequency: 2 };
    const plain = await firstBranchPoints(curved);
    const off = await firstBranchPoints({ ...curved, jinkAmount: 0 });
    expect(maxDiff(plain, off)).toBe(0);
    expect(deviationFromChord(plain)).toBeGreaterThan(0.1);
    const one = await firstBranchPoints({ ...curved, jinkAmount: 1, jinkAbsolute: 1, jinkRelative: 0 });
    expect(deviationFromChord(one)).toBeLessThan(1e-3);
    const three = await firstBranchPoints({ ...curved, jinkAmount: 1, jinkAbsolute: 3, jinkRelative: 0, jinkUniformity: 1 });
    expect(deviationFromChord(three)).toBeGreaterThan(0.02);
    expect(deviationFromChord(three)).toBeLessThan(deviationFromChord(plain));
  });

  it('the Jink Seed matters below Uniformity 1 only', async () => {
    const base = { curvature: 0.5, jinkAmount: 1, jinkAbsolute: 4 };
    const even = await firstBranchPoints({ ...base, jinkUniformity: 1, jinkSeed: 0 });
    const even2 = await firstBranchPoints({ ...base, jinkUniformity: 1, jinkSeed: 9 });
    expect(maxDiff(even, even2)).toBe(0);
    const loose = await firstBranchPoints({ ...base, jinkUniformity: 0, jinkSeed: 0 });
    const loose2 = await firstBranchPoints({ ...base, jinkUniformity: 0, jinkSeed: 9 });
    expect(maxDiff(loose, loose2)).toBeGreaterThan(0.005);
  });

  it('Path deforms the spine, keeps the base attached and is deterministic', async () => {
    const plain = await firstBranchPoints({});
    const a = await firstBranchPoints({ pathAmount: 0.3, pathLength: 1 });
    const b = await firstBranchPoints({ pathAmount: 0.3, pathLength: 1 });
    expect(maxDiff(a, b)).toBe(0);
    expect(deviationFromChord(a)).toBeGreaterThan(deviationFromChord(plain) + 0.2);
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(plain[i]!, 6);
    const none = await firstBranchPoints({ pathAmount: 0 });
    expect(maxDiff(none, plain)).toBe(0);
  });

  it('Break: the spine ends at Spot x length, is flagged as an open end and a Cap-ready attribute is written', async () => {
    const full = polylineLength(await firstBranchPoints({}), 41);
    const sk = skeletonOf(await run(spine({ breakChance: 1, breakSpot: 0.5 })), 'sp');
    const b = sk.branches[0]!;
    const pts = sk.position.slice(b.start * 3, (b.start + b.count) * 3);
    expect(cumulativeLength(pts, b.count)[b.count - 1]).toBeCloseTo(full * 0.5, 1);
    expect(sk.attributes.get('openEnd')?.[b.start]).toBe(1);
    const quarter = skeletonOf(await run(spine({ breakChance: 1, breakSpot: 0.25 })), 'sp').branches[0]!.length;
    expect(quarter).toBeCloseTo(full * 0.25, 1);
    const intact = skeletonOf(await run(spine({ breakChance: 0, breakSpot: 0.5 })), 'sp');
    expect(intact.attributes.get('openEnd')?.[intact.branches[0]!.start]).toBe(0);
    expect(intact.branches[0]!.length).toBeCloseTo(full, 1);
  });

  it('Break Seed changes only which nodes break; the other seeds do not', async () => {
    const graph = (extra: Record<string, unknown>): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { length: { value: 8, variance: 0 } } },
      { id: 'br', type: 'generator.branch', parent: 'tr', params: { number: 40, breakChance: 0.5, splitChance: 0, ...extra } as NodeSpec['params'] },
    ];
    const flags = async (extra: Record<string, unknown>): Promise<number[]> => {
      const sk = skeletonOf(await run(graph(extra)), 'br');
      const oe = sk.attributes.get('openEnd')!;
      return sk.branches.map((b) => oe[b.start]!);
    };
    const base = await flags({});
    expect(base.some((v) => v === 1)).toBe(true);
    expect(base.some((v) => v === 0)).toBe(true);
    expect(await flags({})).toEqual(base);
    expect(await flags({ noiseSeed: 5 })).toEqual(base);
    expect(await flags({ jinkSeed: 5 })).toEqual(base);
    expect(await flags({ breakSeed: 5 })).not.toEqual(base);
  });

  it('Extend parent: Breaks only uses the open-end flag', async () => {
    const graph = (breakChance: number, extend: string): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { length: { value: 8, variance: 0 } } },
      { id: 'br', type: 'generator.branch', parent: 'tr', params: { number: 12, breakChance, splitChance: 0 } as NodeSpec['params'] },
      { id: 'ext', type: 'generator.branch', parent: 'br', params: { number: 0, extendParent: extend, extendCount: 1 } as NodeSpec['params'] },
    ];
    const count = async (breakChance: number, extend: string): Promise<number> =>
      (await run(graph(breakChance, extend))).scene.skeletons.find((s) => s.nodeId === 'ext')?.skeleton.branches.length ?? 0;
    expect(await count(1, 'breaks-only')).toBe(12);
    expect(await count(0, 'breaks-only')).toBe(0);
    expect(await count(0, 'any')).toBe(12);
  });
});

describe('Spine tab layout', () => {
  it('Noise has Early and Late blocks, followed by Jink, Path and Break sections with the specified parameters', () => {
    const defs = getNodeDef('generator.branch')!.params;
    const sections = buildInspectorSections(defs, 'Spine');
    const titles = sections.map((s) => s.title);
    for (const t of ['Noise', 'Jink', 'Path', 'Break']) expect(titles).toContain(t);
    expect(titles.indexOf('Noise')).toBeLessThan(titles.indexOf('Jink'));
    expect(titles.indexOf('Jink')).toBeLessThan(titles.indexOf('Path'));
    expect(titles.indexOf('Path')).toBeLessThan(titles.indexOf('Break'));
    const labels = (title: string, subhead: string | null): string[] =>
      sections.find((s) => s.title === title)!.blocks.filter((b) => b.subhead === subhead).flatMap((b) => b.entries.map((e) => e.def.label));
    expect(labels('Noise', 'Early')).toEqual(['Amount', 'Turbulence', 'Threshold']);
    expect(labels('Noise', 'Late')).toEqual(expect.arrayContaining(['Amount', 'Turbulence', 'Smooth', 'Seed']));
    expect(labels('Jink', null)).toEqual(['Amount', 'Absolute', '+ Relative', 'Uniformity', 'Seed']);
    expect(labels('Path', null)).toEqual(['Amount', 'Profile', 'Twist', 'Length', 'Offset']);
    expect(labels('Break', null)).toEqual(['Chance', 'Spot', 'Seed']);
    const byId = new Map(defs.map((d) => [d.id, d]));
    expect(byId.get('earlyNoiseAmount')).toMatchObject({ curveAllowed: true });
    expect(byId.get('earlyNoiseThreshold')).toMatchObject({ curveAllowed: true });
    expect(byId.get('pathOffset')).toMatchObject({ variance: { default: 1 } });
    expect(byId.get('pathProfile')).toMatchObject({ kind: 'curve' });
    expect(byId.get('breakSpot')).toMatchObject({ variance: expect.anything() });
  });
});
