import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import {
  DEFAULT_SPLIT_SETTINGS,
  SPLIT_ATTR,
  SplitFlag,
  collectOpenEnds,
  decideSplit,
  evenTiles,
  lateralBalanceAngles,
  planSplit,
  sampleSpineBack,
  splitRadiiByArea,
  splitTransitionLength,
  type SplitPlanInput,
  type SplitSettings,
} from '@/generators/split';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const DEG = Math.PI / 180;
const angle = (a: readonly number[], b: readonly number[]): number => {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return Math.acos(Math.min(1, Math.max(-1, d / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!)))));
};

const baseInput = (over: Partial<SplitPlanInput> = {}, settings: Partial<SplitSettings> = {}): SplitPlanInput => ({
  end: { position: [1.2, 0.4, 3], tangent: [0, 0, 1], up: [1, 0, 0], radius: 0.12 },
  parentLength: 3,
  settings: { ...DEFAULT_SPLIT_SETTINGS, ...settings },
  ringSpacing: 0.08,
  rng: new Rng(7).fork('splits0'),
  chance: 1,
  parentTiles: 4,
  parentSpineId: 5,
  ...over,
});
const must = (input: SplitPlanInput) => {
  const plan = planSplit(input);
  if (!plan) throw new Error('expected a split');
  return plan;
};

describe('splitRadiiByArea (pipe model)', () => {
  it('keeps r1^e + r2^e = R^e for several exponents and balances', () => {
    for (const e of [1.5, 2, 2.5, 3]) {
      for (const balance of [0.3, 0.5, 0.65, 0.8]) {
        const [r1, r2] = splitRadiiByArea(0.2, balance, e);
        expect(r1 ** e + r2 ** e).toBeCloseTo(0.2 ** e, 6);
      }
    }
  });

  it('Balance 0.5 gives equal radii (area fractions, not halves)', () => {
    const [r1, r2] = splitRadiiByArea(0.2, 0.5);
    expect(r1).toBeCloseTo(r2, 12);
    expect(r1).toBeCloseTo(0.2 * Math.SQRT1_2, 9);
  });

  it('clamps both halves to at least 0.2 R at Balance 0 and 1', () => {
    expect(splitRadiiByArea(0.2, 0)).toEqual([0.2 * 0.2, 0.2]);
    expect(splitRadiiByArea(0.2, 1)).toEqual([0.2, 0.2 * 0.2]);
  });
});

describe('lateralBalanceAngles', () => {
  it('equal halves keep the neutral angles', () => {
    const [a1, a2] = lateralBalanceAngles(22 * DEG, 22 * DEG, 1, 1);
    expect(a1).toBeCloseTo(22 * DEG, 9);
    expect(a2).toBeCloseTo(22 * DEG, 9);
  });

  it('the fat half bends less, area x sin balances and the sum is preserved', () => {
    const [r1, r2] = splitRadiiByArea(0.2, 0.75);
    const [a1, a2] = lateralBalanceAngles(22 * DEG, 22 * DEG, r1 * r1, r2 * r2);
    expect(r1).toBeGreaterThan(r2);
    expect(a1).toBeLessThan(a2);
    expect(r1 * r1 * Math.sin(a1)).toBeCloseTo(r2 * r2 * Math.sin(a2), 9);
    expect(a1 + a2).toBeCloseTo(44 * DEG, 9);
  });

  it('a zero neutral angle disables the balancing of that side', () => {
    expect(lateralBalanceAngles(0, 30 * DEG, 2, 1)).toEqual([0, 30 * DEG]);
  });
});

describe('planSplit geometry', () => {
  it('the two open-end circles are tangent: centre distance == r1 + r2', () => {
    for (const balance of [0.5, 0.7, 0.2]) {
      const plan = must(baseInput({}, { balance }));
      const [a, b] = plan.openEnds;
      const dist = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
      expect(Math.abs(dist - (a.radius + b.radius))).toBeLessThan(1e-6);
    }
  });

  it('the shared axis passes between the circles, the fat one is closer to it', () => {
    const plan = must(baseInput({}, { balance: 0.75 }));
    const tip = [1.2, 0.4, 3];
    const [f, s] = plan.openEnds;
    const d1 = Math.hypot(f.position[0] - tip[0]!, f.position[1] - tip[1]!);
    const d2 = Math.hypot(s.position[0] - tip[0]!, s.position[1] - tip[1]!);
    expect(f.kind).toBe('fat');
    expect(d1).toBeLessThan(d2);
  });

  it('is C1: the lobe leaves the axis along the parent tangent, no ring turns by more than 20 degrees', () => {
    const tangent: [number, number, number] = [0.1, 0.05, 0.99];
    const l = Math.hypot(...tangent);
    const T: [number, number, number] = [tangent[0] / l, tangent[1] / l, tangent[2] / l];
    const plan = must(baseInput({ end: { position: [1, 1, 2], tangent: T, up: [1, 0, 0], radius: 0.1 } }));
    for (const lobe of plan.lobes) {
      expect(angle(lobe.startTangent, T)).toBeLessThan(1e-6);
      let max = 0;
      let prevDir: number[] | null = null;
      const p = lobe.positions;
      for (let k = 1; k < lobe.ringCount; k++) {
        const dir = [p[k * 3]! - p[(k - 1) * 3]!, p[k * 3 + 1]! - p[(k - 1) * 3 + 1]!, p[k * 3 + 2]! - p[(k - 1) * 3 + 2]!];
        max = Math.max(max, prevDir ? angle(prevDir, dir) : angle(T, dir));
        prevDir = dir;
      }
      expect(max).toBeLessThan(20 * DEG);
      expect(angle(prevDir!, lobe.endTangent)).toBeLessThan(20 * DEG);
    }
  });

  it('stays smooth for the widest allowed spread too', () => {
    const plan = must(baseInput({ ringSpacing: 0.5 }, { spread1Deg: 80, spread2Deg: 80 }));
    for (const lobe of plan.lobes) {
      const p = lobe.positions;
      let prev: number[] | null = null;
      for (let k = 1; k < lobe.ringCount; k++) {
        const dir = [p[k * 3]! - p[(k - 1) * 3]!, p[k * 3 + 1]! - p[(k - 1) * 3 + 1]!, p[k * 3 + 2]! - p[(k - 1) * 3 + 2]!];
        if (prev) expect(angle(prev, dir)).toBeLessThan(20 * DEG);
        prev = dir;
      }
    }
  });

  it('transition length is clamp(3.5 R, 0.08 L, 0.35 L)', () => {
    expect(splitTransitionLength(0.1, 3)).toBeCloseTo(0.35, 12);
    expect(splitTransitionLength(0.01, 3)).toBeCloseTo(0.24, 12);
    expect(splitTransitionLength(1, 3)).toBeCloseTo(1.05, 12);
  });

  it('open ends carry side, kind, frame, tiles (half of the parent each) and the parent spine id', () => {
    const plan = must(baseInput({ parentTiles: 6 }));
    const [e1, e2] = plan.openEnds;
    expect([e1.side, e2.side]).toEqual([1, 2]);
    expect([e1.kind, e2.kind]).toEqual(['fat', 'skinny']);
    expect([e1.uTiles, e2.uTiles]).toEqual([3, 3]);
    expect([e1.uStart, e2.uStart]).toEqual([0, 3]);
    expect(e1.parentSpineId).toBe(5);
    const f = e1.frame;
    expect(Math.hypot(...f.normal)).toBeCloseTo(1, 9);
    expect(f.normal[0] * e1.direction[0] + f.normal[1] * e1.direction[1] + f.normal[2] * e1.direction[2]).toBeCloseTo(0, 9);
  });

  it('Side 1 leans away from the tree centre axis', () => {
    const plan = must(baseInput());
    const [e1, e2] = plan.openEnds;
    const away = (p: readonly number[]): number => p[0]! * 1.2 + p[1]! * 0.4;
    expect(away(e1.position)).toBeGreaterThan(away(e2.position));
  });

  it('a parent on the tree axis picks the divergence from the seeded stream', () => {
    const onAxis = (seed: number) => must(baseInput({ end: { position: [0, 0, 3], tangent: [0, 0, 1], up: [1, 0, 0], radius: 0.12 }, rng: new Rng(seed).fork('splits0') })).divergence;
    expect(onAxis(1)).toEqual(onAxis(1));
    expect(onAxis(1)).not.toEqual(onAxis(2));
  });
});

describe('decision and tiles', () => {
  it('Chance 0 never splits, Chance 1 always splits', () => {
    for (let seed = 0; seed < 50; seed++) {
      expect(planSplit(baseInput({ chance: 0, rng: new Rng(seed).fork('s') }))).toBeNull();
      expect(planSplit(baseInput({ chance: 1, rng: new Rng(seed).fork('s') }))).not.toBeNull();
    }
  });

  it('the profile curve scales the chance', () => {
    expect(decideSplit(new Rng(1), 1, 0, 4).split).toBe(false);
    expect(decideSplit(new Rng(1), 0.5, 2, 4).split).toBe(true);
  });

  it('odd or fractional tile counts are promoted to the next even number (>= 2), even ones are kept', () => {
    expect([1, 2, 3, 4, 5, 2.5, 0.4].map(evenTiles)).toEqual([2, 2, 4, 4, 6, 4, 2]);
    const odd = decideSplit(new Rng(1), 1, 1, 3);
    expect(odd).toEqual({ split: true, parentTiles: 4, promoted: true });
    expect(decideSplit(new Rng(1), 1, 1, 6).promoted).toBe(false);
    const plan = must(baseInput({ parentTiles: 5 }));
    expect(plan.decision.parentTiles).toBe(6);
    expect(plan.openEnds[0].uTiles).toBe(3);
  });

  it('same seed -> identical plan; the plan reads only its own stream', () => {
    const a = must(baseInput());
    const b = must(baseInput());
    expect(Array.from(a.lobes[0].positions)).toEqual(Array.from(b.lobes[0].positions));
    expect(a.divergence).toEqual(b.divergence);
    const c = must(baseInput({ rng: new Rng(7).fork('splits9') }));
    expect(c.divergence).not.toEqual(a.divergence);
  });
});

describe('sampleSpineBack', () => {
  const pts = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 3]);
  it('walks back along the polyline and reports the segment tangent and point index', () => {
    const s = sampleSpineBack(pts, 3, 1);
    expect(s.position[2]).toBeCloseTo(2, 6);
    expect(s.tangent).toEqual([0, 0, 1]);
    expect(s.index).toBe(1);
    expect(sampleSpineBack(pts, 3, 2.5).position[2]).toBeCloseTo(0.5, 6);
    expect(sampleSpineBack(pts, 3, 99).position[2]).toBeCloseTo(0, 6);
  });
});

// ---- generation (graph level) --------------------------------------------------------------------------------------------

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
const TRUNK = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const trunkGraph = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, splitsChance: 1, ...extra } as NodeSpec['params'] },
];

describe('split generation with the new model', () => {
  it('the halves start on the shared axis inside the parent and end as tangent open ends', async () => {
    const sk = skeletonOf(await run(trunkGraph({ splitsBalance: 0.7 })), 'trunk');
    const parent = sk.branches[0]!;
    const tip = parent.start + parent.count - 1;
    const ends = collectOpenEnds(sk);
    expect(ends).toHaveLength(2);
    const [a, b] = ends;
    const dist = Math.hypot(a!.position[0] - b!.position[0], a!.position[1] - b!.position[1], a!.position[2] - b!.position[2]);
    expect(dist).toBeCloseTo(a!.radius + b!.radius, 4);
    expect(a!.kind).toBe('fat');
    expect(b!.kind).toBe('skinny');
    // The first ring of each half lies on the parent's axis, before the parent's tip.
    for (const br of sk.branches.slice(1)) {
      expect(sk.position[br.start * 3 + 2]!).toBeLessThan(sk.position[tip * 3 + 2]! - 1e-4);
    }
  });

  it('the Splits seed leaves every other branch untouched (the parent spine is identical)', async () => {
    const parentOf = async (seed: number): Promise<number[]> => {
      const sk = skeletonOf(await run(trunkGraph({ splitsSeed: seed })), 'trunk');
      const b = sk.branches[0]!;
      return [...Array.from(sk.position.subarray(b.start * 3, (b.start + b.count) * 3)), ...Array.from(sk.radius.subarray(b.start, b.start + b.count))];
    };
    expect(await parentOf(1)).toEqual(await parentOf(99));
  });

  it('flags a splitting parent and keeps old projects (no Area exponent / old spread) on defaults', async () => {
    const sk = skeletonOf(await run(trunkGraph()), 'trunk');
    expect(Math.round(sk.attributes.get(SPLIT_ATTR)![sk.branches[0]!.start]!) & SplitFlag.Parent).toBe(SplitFlag.Parent);
    const def = getNodeDef('generator.trunk')!;
    const byId = (id: string) => def.params.find((p) => p.id === id);
    expect(byId('splitsSpread1')).toMatchObject({ default: 22, min: 0, max: 80 });
    expect(byId('splitsExpand1')).toMatchObject({ default: 1, min: 0.5, max: 2 });
    expect(byId('splitsAreaExponent')).toMatchObject({ default: 2, min: 1.5, max: 3 });
  });

  it('warns once when an odd U tile count had to be raised', async () => {
    const odd = await run(trunkGraph({ uvUAbsolute: 3, uvURelative: 0 }));
    const messages = (r: Result): string[] => [...r.diagnostics.values()].flatMap((d) => d.messages.map((m) => m.text));
    expect(messages(odd).filter((m) => m.includes('Skin > Splits'))).toHaveLength(1);
    const even = await run(trunkGraph({ uvUAbsolute: 4, uvURelative: 0 }));
    expect(messages(even).filter((m) => m.includes('Skin > Splits'))).toHaveLength(0);
  });
});
