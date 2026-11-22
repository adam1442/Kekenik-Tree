import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import { defaultParamState, evalCondition, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import {
  generatePlacements,
  ignoresBoundaries,
  normalizeMode,
  type BendPeak,
  type ModeFrame,
  type ModeRequest,
  type PhyllotaxyRequest,
  type PlacementRecord,
} from '@/generators/modes';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { migrateGenerationParams } from '@/nodes/generators/generationMigration';

beforeAll(() => registerDiscoveredNodes());

function frame(over: Partial<ModeFrame> = {}): ModeFrame {
  return {
    rng: new Rng(7),
    first: 0.1,
    last: 0.9,
    parentLength: 4,
    maxCount: 10_000,
    lodKeep: 1,
    rollBase: 0,
    branchPhase: 0,
    positionOffset: 0,
    warp: (s) => s,
    attract: (t) => t,
    bends: () => [],
    ...over,
  };
}

const COUNT_SETTINGS = { jumble: 0, sweep: 1, alignStyle: 'group' as const };
const STEPS = { perStep: 4, spread: 0, stepRoll: 0, balance: 1 };
const PHYLLO: PhyllotaxyRequest = {
  mode: 'phyllotaxy',
  style: 'alternating-distichous',
  internode: 0.5,
  childrenPerNode: 3,
  spread: 0,
  spiral: 0,
  limit: 0,
  alignStyle: 'group',
};
const INTERVAL: ModeRequest = {
  mode: 'interval',
  frequency: 0.5,
  frequencyCurve: () => 1,
  count: 1,
  spread: 0,
  spiral: 0,
  limit: 0,
  alignStyle: 'group',
  balance: 0,
};

const TAU = Math.PI * 2;
const wrap = (a: number): number => ((a % TAU) + TAU) % TAU;

const ALL_REQUESTS: ModeRequest[] = [
  { mode: 'absolute', number: 9, ...COUNT_SETTINGS, jumble: 0.6 },
  { mode: 'proportional', frequency: 3, ...COUNT_SETTINGS, jumble: 0.6 },
  { mode: 'density', density: 3, jitter: 0.5, ...COUNT_SETTINGS },
  { mode: 'flood', number: 9, sweep: 1 },
  { mode: 'absolute-steps', steps: 5, ...STEPS, spread: 0.3 },
  { mode: 'proportional-steps', steps: 1, ...STEPS, spread: 0.3 },
  { ...PHYLLO, spread: 1 },
  { ...(INTERVAL as ModeRequest & { mode: 'interval' }), spread: 1 },
  { mode: 'bifurcation', count: 3, threshold: 0.1, spread: 1, minSpacing: 0.1 },
];

describe('generation modes: counts', () => {
  it('Absolute creates exactly Number nodes', () => {
    for (const n of [0, 1, 7, 40]) {
      const out = generatePlacements(frame(), { mode: 'absolute', number: n, ...COUNT_SETTINGS });
      expect(out).toHaveLength(n);
    }
  });

  it('Proportional scales with the parent length', () => {
    const req: ModeRequest = { mode: 'proportional', frequency: 2.5, ...COUNT_SETTINGS };
    const short = generatePlacements(frame({ parentLength: 2 }), req);
    const long = generatePlacements(frame({ parentLength: 4 }), req);
    expect(short).toHaveLength(5);
    expect(long).toHaveLength(10);
  });

  it('Proportional spreads nodes at random but keeps them ordered by stretch', () => {
    const out = generatePlacements(frame({ parentLength: 8 }), { mode: 'proportional', frequency: 2, ...COUNT_SETTINGS });
    expect(out).toHaveLength(16);
    const ts = out.map((r) => r.t);
    expect(new Set(ts.map((t) => t.toFixed(5))).size).toBeGreaterThan(8);
    // one node per equal stretch of First..Last
    ts.forEach((t, k) => {
      expect(t).toBeGreaterThanOrEqual(0.1 + (k / 16) * 0.8 - 1e-9);
      expect(t).toBeLessThanOrEqual(0.1 + ((k + 1) / 16) * 0.8 + 1e-9);
    });
  });

  it('Flood creates exactly Number nodes along the parent, ordered by position', () => {
    const out = generatePlacements(frame(), { mode: 'flood', number: 25, sweep: 1 });
    expect(out).toHaveLength(25);
    for (let i = 1; i < out.length; i++) expect(out[i]!.t).toBeGreaterThanOrEqual(out[i - 1]!.t);
  });

  it('Parent puts exactly Number nodes at the origin of the parent, spread around it', () => {
    const out = generatePlacements(frame(), { mode: 'parent', number: 4, sweep: 1 });
    expect(out).toHaveLength(4);
    expect(out.every((r) => r.t === 0)).toBe(true);
    expect(out.map((r) => wrap(r.roll)).map((a) => Math.round((a / TAU) * 4))).toEqual([0, 1, 2, 3]);
    expect(ignoresBoundaries('parent')).toBe(true);
    expect(ignoresBoundaries('absolute')).toBe(false);
  });

  it('maxCount caps every mode', () => {
    for (const req of ALL_REQUESTS) {
      expect(generatePlacements(frame({ maxCount: 3 }), req).length).toBeLessThanOrEqual(3);
    }
    expect(generatePlacements(frame({ maxCount: 0 }), ALL_REQUESTS[0] as ModeRequest)).toEqual([]);
  });

  it('a lower level of detail keeps fewer nodes', () => {
    const full = generatePlacements(frame(), { mode: 'absolute', number: 20, ...COUNT_SETTINGS });
    const low = generatePlacements(frame({ lodKeep: 0.45 }), { mode: 'absolute', number: 20, ...COUNT_SETTINGS });
    expect(low.length).toBe(9);
    expect(low.length).toBeLessThan(full.length);
  });
});

describe('generation modes: steps', () => {
  it('lays out Steps x Per step nodes in rings from First to Last', () => {
    const out = generatePlacements(frame(), { mode: 'absolute-steps', steps: 4, ...STEPS });
    expect(out).toHaveLength(16);
    const heights = [...new Set(out.map((r) => r.t.toFixed(6)))].map(Number);
    expect(heights).toHaveLength(4);
    expect(heights[0]).toBeCloseTo(0.1, 6);
    expect(heights[3]).toBeCloseTo(0.9, 6);
    expect(out.map((r) => r.groupIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);
  });

  it('Balance 1 spaces a step evenly around the parent, Roll turns each step against the previous', () => {
    const out = generatePlacements(frame(), { mode: 'absolute-steps', steps: 3, ...STEPS, stepRoll: Math.PI / 6 });
    const step1 = out.filter((r) => r.groupIndex === 1).map((r) => r.roll);
    for (let m = 1; m < 4; m++) expect(wrap(step1[m]! - step1[m - 1]!)).toBeCloseTo(Math.PI / 2, 6);
    const step0 = out.find((r) => r.groupIndex === 0)!.roll;
    expect(wrap(step1[0]! - step0)).toBeCloseTo(Math.PI / 6, 6);
  });

  it('Balance 0 scatters the nodes of a step', () => {
    const out = generatePlacements(frame(), { mode: 'absolute-steps', steps: 1, ...STEPS, balance: 0, perStep: 6 });
    const rolls = out.map((r) => wrap(r.roll));
    const gaps = rolls.slice(1).map((r, i) => r - rolls[i]!);
    expect(new Set(gaps.map((g) => g.toFixed(3))).size).toBeGreaterThan(2);
  });

  it('Spread shifts nodes lengthwise inside the step but stays within the boundaries', () => {
    const out = generatePlacements(frame(), { mode: 'absolute-steps', steps: 3, ...STEPS, spread: 0.5 });
    expect(new Set(out.filter((r) => r.groupIndex === 1).map((r) => r.t.toFixed(6))).size).toBeGreaterThan(1);
    for (const r of out) {
      expect(r.t).toBeGreaterThanOrEqual(0.1);
      expect(r.t).toBeLessThanOrEqual(0.9);
    }
  });

  it('Proportional steps takes Steps per metre of parent length', () => {
    const req: ModeRequest = { mode: 'proportional-steps', steps: 1.5, ...STEPS, perStep: 2 };
    expect(generatePlacements(frame({ parentLength: 2 }), req)).toHaveLength(6);
    expect(generatePlacements(frame({ parentLength: 4 }), req)).toHaveLength(12);
  });
});

describe('generation modes: phyllotaxy', () => {
  it('places groups every Internode length (metres) from Last towards First', () => {
    const out = generatePlacements(frame(), PHYLLO);
    // span 0.8 x 4 m = 3.2 m, internode 0.5 m -> 7 groups
    expect(out).toHaveLength(7);
    expect(out[0]!.t).toBeCloseTo(0.9, 9);
    for (let g = 1; g < out.length; g++) expect(out[g - 1]!.t - out[g]!.t).toBeCloseTo(0.5 / 4, 9);
    expect(out[out.length - 1]!.t).toBeGreaterThanOrEqual(0.1);
  });

  it('the interval is measured in world space, so a longer parent gets more groups', () => {
    expect(generatePlacements(frame({ parentLength: 8 }), PHYLLO).length).toBeGreaterThan(generatePlacements(frame(), PHYLLO).length);
  });

  it('Alternating (distichous) alternates the sides', () => {
    const out = generatePlacements(frame(), PHYLLO);
    expect(out.map((r) => r.side)).toEqual([1, -1, 1, -1, 1, -1, 1]);
    for (let g = 1; g < out.length; g++) expect(wrap(out[g]!.roll - out[g - 1]!.roll)).toBeCloseTo(Math.PI, 6);
  });

  it('Opposite (distichous) makes pairs of two on opposite sides, every group the same way', () => {
    const out = generatePlacements(frame(), { ...PHYLLO, style: 'opposite-distichous' });
    expect(out).toHaveLength(14);
    for (let g = 0; g < 7; g++) {
      const a = out[g * 2]!;
      const b = out[g * 2 + 1]!;
      expect(wrap(b.roll - a.roll)).toBeCloseTo(Math.PI, 6);
      expect(a.side).not.toBe(b.side);
      expect(wrap(a.roll)).toBeCloseTo(wrap(out[0]!.roll), 6);
    }
  });

  it('Opposite (decussate) turns every group by 90 degrees', () => {
    const out = generatePlacements(frame(), { ...PHYLLO, style: 'opposite-decussate' });
    for (let g = 1; g < 7; g++) expect(wrap(out[g * 2]!.roll - out[(g - 1) * 2]!.roll)).toBeCloseTo(Math.PI / 2, 6);
  });

  it('Opposite (random orientation) keeps pairs opposite but turns groups at random, deterministically', () => {
    const req: PhyllotaxyRequest = { ...PHYLLO, style: 'opposite-random' };
    const a = generatePlacements(frame(), req);
    const b = generatePlacements(frame(), req);
    expect(a).toEqual(b);
    for (let g = 0; g < 7; g++) expect(wrap(a[g * 2 + 1]!.roll - a[g * 2]!.roll)).toBeCloseTo(Math.PI, 6);
    expect(new Set(a.filter((_, i) => i % 2 === 0).map((r) => wrap(r.roll).toFixed(3))).size).toBeGreaterThan(3);
  });

  it('Alternating (random) uses one node per group at random roll', () => {
    const out = generatePlacements(frame(), { ...PHYLLO, style: 'alternating-random' });
    expect(out).toHaveLength(7);
    expect(new Set(out.map((r) => wrap(r.roll).toFixed(3))).size).toBeGreaterThan(3);
  });

  it('Whorled makes Children per node nodes per group, evenly spaced', () => {
    const out = generatePlacements(frame(), { ...PHYLLO, style: 'whorled', childrenPerNode: 3 });
    expect(out).toHaveLength(21);
    expect(wrap(out[1]!.roll - out[0]!.roll)).toBeCloseTo(TAU / 3, 6);
    expect(wrap(out[2]!.roll - out[1]!.roll)).toBeCloseTo(TAU / 3, 6);
    expect(new Set(out.map((r) => r.groupIndex)).size).toBe(7);
  });

  it('Spiral adds rotation per group', () => {
    const out = generatePlacements(frame(), { ...PHYLLO, spiral: Math.PI / 12 });
    expect(wrap(out[1]!.roll - out[0]!.roll)).toBeCloseTo(Math.PI + Math.PI / 12, 6);
  });

  it('Limit caps the number of groups', () => {
    expect(generatePlacements(frame(), { ...PHYLLO, limit: 3 })).toHaveLength(3);
    expect(generatePlacements(frame(), { ...PHYLLO, style: 'whorled', limit: 2, childrenPerNode: 4 })).toHaveLength(8);
  });

  it('Spread offsets nodes lengthwise by at most one internode and stays inside the boundaries', () => {
    const plain = generatePlacements(frame(), PHYLLO);
    const out = generatePlacements(frame(), { ...PHYLLO, spread: 1 });
    out.forEach((r, i) => {
      expect(Math.abs(r.t - plain[i]!.t)).toBeLessThanOrEqual(0.5 / 4 + 1e-9);
      expect(r.t).toBeGreaterThanOrEqual(0.1);
      expect(r.t).toBeLessThanOrEqual(0.9);
    });
    expect(out.some((r, i) => Math.abs(r.t - plain[i]!.t) > 1e-6)).toBe(true);
  });

  it('Internode length 0 spreads Limit groups evenly between Last and First', () => {
    const out = generatePlacements(frame(), { ...PHYLLO, internode: 0, limit: 5 });
    expect(out.map((r) => Number(r.t.toFixed(6)))).toEqual([0.9, 0.7, 0.5, 0.3, 0.1]);
  });

  it('Individual align style turns nodes independently of the group layout', () => {
    const group = generatePlacements(frame(), { ...PHYLLO, style: 'whorled', childrenPerNode: 3 });
    const indiv = generatePlacements(frame(), { ...PHYLLO, style: 'whorled', childrenPerNode: 3, alignStyle: 'individual' });
    expect(indiv.map((r) => r.roll)).not.toEqual(group.map((r) => r.roll));
    indiv.forEach((r, i) => expect(Math.abs(r.roll - group[i]!.roll)).toBeLessThanOrEqual(Math.PI / 3 + 1e-9));
  });
});

describe('generation modes: interval', () => {
  it('puts the first group exactly at Last', () => {
    const out = generatePlacements(frame(), INTERVAL);
    expect(out[0]!.t).toBe(0.9);
    expect(out[1]!.t).toBeCloseTo(0.9 - 0.5 / 4, 9);
  });

  it('does not guarantee a group at First', () => {
    const out = generatePlacements(frame(), { ...(INTERVAL as ModeRequest & { mode: 'interval' }), frequency: 0.7 });
    // 3.2 m / 0.7 m -> groups at 0, 0.7 ... 3.15 m below Last, First (3.2 m) is not hit
    const lastT = out[out.length - 1]!.t;
    expect(lastT).toBeGreaterThan(0.1 + 1e-6);
    expect(out).toHaveLength(5);
  });

  it('a lower Frequency curve value packs the groups tighter', () => {
    const base = INTERVAL as ModeRequest & { mode: 'interval' };
    const plain = generatePlacements(frame(), base);
    const tight = generatePlacements(frame(), { ...base, frequencyCurve: (x) => 0.25 + 0.75 * x });
    expect(tight.length).toBeGreaterThan(plain.length);
    const gapsNearFirst = tight[tight.length - 2]!.t - tight[tight.length - 1]!.t;
    const gapsNearLast = tight[0]!.t - tight[1]!.t;
    expect(gapsNearFirst).toBeLessThan(gapsNearLast);
  });

  it('Count nodes per group, evenly turned; Limit caps the groups', () => {
    const base = INTERVAL as ModeRequest & { mode: 'interval' };
    const out = generatePlacements(frame(), { ...base, count: 3, limit: 4 });
    expect(out).toHaveLength(12);
    expect(wrap(out[1]!.roll - out[0]!.roll)).toBeCloseTo(TAU / 3, 6);
    expect(new Set(out.map((r) => r.groupIndex)).size).toBe(4);
  });

  it('Balance rotates every other group by half the gap to fill the gaps of the previous one', () => {
    const base = INTERVAL as ModeRequest & { mode: 'interval' };
    const out = generatePlacements(frame(), { ...base, count: 2, balance: 1 });
    expect(wrap(out[2]!.roll - out[0]!.roll)).toBeCloseTo(Math.PI / 2, 6);
    expect(wrap(out[4]!.roll - out[0]!.roll)).toBeCloseTo(0, 6);
  });

  it('Spiral turns each group, singles alternate sides', () => {
    const base = INTERVAL as ModeRequest & { mode: 'interval' };
    const out = generatePlacements(frame(), { ...base, spiral: 0.3 });
    expect(wrap(out[1]!.roll - out[0]!.roll)).toBeCloseTo(0.3, 6);
    expect(out.slice(0, 4).map((r) => r.side)).toEqual([1, -1, 1, -1]);
  });
});

describe('generation modes: bifurcation', () => {
  const peaks: BendPeak[] = [
    { t: 0.2, curvature: 0.2, roll: 1 },
    { t: 0.5, curvature: 0.9, roll: 2 },
    { t: 0.8, curvature: 0.5, roll: 3 },
  ];

  it('picks the strongest bends (at most Count) in order along the parent', () => {
    const out = generatePlacements(frame({ bends: () => peaks }), { mode: 'bifurcation', count: 2, threshold: 0.1, spread: 0, minSpacing: 0.1 });
    expect(out.map((r) => r.t)).toEqual([0.5, 0.8]);
    expect(out.map((r) => r.roll)).toEqual([2, 3]);
  });

  it('passes the threshold and spacing to the bend finder', () => {
    let seen: [number, number] | null = null;
    generatePlacements(
      frame({
        bends: (a, b) => {
          seen = [a, b];
          return peaks;
        },
      }),
      { mode: 'bifurcation', count: 5, threshold: 0.25, spread: 0, minSpacing: 0.15 },
    );
    expect(seen).toEqual([0.25, 0.15]);
  });

  it('Spread shifts nodes by at most 10 % of the parent', () => {
    const out = generatePlacements(frame({ bends: () => peaks }), { mode: 'bifurcation', count: 3, threshold: 0.1, spread: 1, minSpacing: 0.1 });
    out.forEach((r, i) => expect(Math.abs(r.t - peaks[i]!.t)).toBeLessThanOrEqual(0.1 + 1e-9));
  });

  it('a straight parent falls back to a few evenly spaced nodes', () => {
    const out = generatePlacements(frame(), { mode: 'bifurcation', count: 4, threshold: 0.1, spread: 0, minSpacing: 0.1 });
    expect(out).toHaveLength(2);
  });
});

describe('generation modes: shared guarantees', () => {
  it('is deterministic for the same stream and differs for another seed', () => {
    for (const req of ALL_REQUESTS) {
      const a = generatePlacements(frame(), req);
      const b = generatePlacements(frame(), req);
      expect(a).toEqual(b);
    }
    const a = generatePlacements(frame(), { mode: 'flood', number: 12, sweep: 1 });
    const c = generatePlacements(frame({ rng: new Rng(8) }), { mode: 'flood', number: 12, sweep: 1 });
    expect(a).not.toEqual(c);
  });

  it('respects First and Last in every mode (also with a position offset)', () => {
    const bends = (): BendPeak[] => [{ t: 0.12, curvature: 0.5, roll: 0 }, { t: 0.88, curvature: 0.4, roll: 1 }];
    for (const offset of [0, 0.3, -0.3]) {
      for (const req of ALL_REQUESTS) {
        const out = generatePlacements(frame({ first: 0.3, last: 0.6, positionOffset: offset, bends }), req);
        expect(out.length).toBeGreaterThan(0);
        for (const r of out) {
          expect(r.t).toBeGreaterThanOrEqual(0.3 - 1e-12);
          expect(r.t).toBeLessThanOrEqual(0.6 + 1e-12);
        }
      }
    }
  });

  it('every record carries a side of +1 / -1 and a group index', () => {
    for (const req of ALL_REQUESTS) {
      const out: PlacementRecord[] = generatePlacements(frame(), req);
      for (const r of out) {
        expect(r.side === 1 || r.side === -1).toBe(true);
        expect(Number.isInteger(r.groupIndex)).toBe(true);
        expect(Number.isFinite(r.roll)).toBe(true);
      }
    }
  });

  it('a parent of zero length yields no groups', () => {
    expect(generatePlacements(frame({ parentLength: 0 }), PHYLLO)).toEqual([]);
    expect(generatePlacements(frame({ parentLength: 0 }), INTERVAL)).toEqual([]);
  });

  it('normalizeMode maps old and unknown values', () => {
    expect(normalizeMode('whorled')).toBe('absolute-steps');
    expect(normalizeMode('phyllotaxy')).toBe('phyllotaxy');
    expect(normalizeMode('nonsense')).toBe('absolute');
  });
});

describe('generation modes: inspector and migration', () => {
  const visibleIds = (type: string, mode: string): Set<string> => {
    const def = getNodeDef(type);
    if (!def) throw new Error(type);
    const params: NodeParams = Object.fromEntries(def.params.map((p) => [p.id, { value: p.default as never }]));
    params.mode = { value: mode };
    return new Set(def.params.filter((p) => p.group === 'Generation' && evalCondition(p.visibleIf, params)).map((p) => p.id));
  };

  it('lists the new modes and disables Classic', () => {
    const mode = getNodeDef('generator.branch')!.params.find((p) => p.id === 'mode');
    expect(mode?.kind).toBe('enum');
    if (mode?.kind !== 'enum') return;
    const values = mode.options.map((o) => o.value);
    for (const v of ['absolute', 'proportional', 'absolute-steps', 'proportional-steps', 'phyllotaxy', 'interval', 'bifurcation', 'flood', 'parent', 'classic']) {
      expect(values).toContain(v);
    }
    expect(mode.options.find((o) => o.value === 'classic')?.disabled).toBe(true);
    expect(mode.options.filter((o) => o.disabled)).toHaveLength(1);
  });

  it('every generator exposes the Mode dropdown', () => {
    for (const type of ['generator.trunk', 'generator.branch', 'generator.root', 'generator.spine', 'generator.leaf', 'generator.batchedLeaf', 'generator.cluster', 'generator.meshes', 'generator.cap']) {
      expect(getNodeDef(type)?.params.some((p) => p.id === 'mode')).toBe(true);
    }
  });

  it('shows only the parameters of the selected mode', () => {
    const phyllo = visibleIds('generator.branch', 'phyllotaxy');
    for (const id of ['phyllotaxyStyle', 'phyllotaxyInternode', 'phyllotaxySpread', 'phyllotaxySpiral', 'phyllotaxyLimit', 'phyllotaxyAlignStyle']) expect(phyllo.has(id)).toBe(true);
    expect(phyllo.has('phyllotaxyChildren')).toBe(false);
    expect(phyllo.has('intervalStep')).toBe(false);
    expect(phyllo.has('number')).toBe(false);

    const interval = visibleIds('generator.branch', 'interval');
    for (const id of ['intervalStep', 'perStep', 'intervalSpread', 'intervalSpiral', 'intervalLimit', 'intervalAlignStyle', 'intervalBalance']) expect(interval.has(id)).toBe(true);
    expect(interval.has('phyllotaxyStyle')).toBe(false);

    const steps = visibleIds('generator.branch', 'absolute-steps');
    for (const id of ['whorlCount', 'whorlPerStep', 'whorlSpread', 'whorlRoll', 'stepsBalance']) expect(steps.has(id)).toBe(true);
    expect(steps.has('stepsFrequency')).toBe(false);
    expect(visibleIds('generator.branch', 'proportional-steps').has('stepsFrequency')).toBe(true);

    expect(visibleIds('generator.branch', 'proportional').has('proportionalCount')).toBe(true);
    expect(visibleIds('generator.branch', 'flood').has('number')).toBe(true);
    expect(visibleIds('generator.branch', 'parent').has('number')).toBe(true);
    const bif = visibleIds('generator.branch', 'bifurcation');
    for (const id of ['bifurcationCount', 'bifurcationThreshold', 'bifurcationSpread']) expect(bif.has(id)).toBe(true);
  });

  it('the whorled style shows Children per node', () => {
    const def = getNodeDef('generator.branch')!;
    const params: NodeParams = Object.fromEntries(def.params.map((p) => [p.id, { value: p.default as never }]));
    params.mode = { value: 'phyllotaxy' };
    params.phyllotaxyStyle = { value: 'whorled' };
    const kids = def.params.find((p) => p.id === 'phyllotaxyChildren');
    expect(evalCondition(kids?.visibleIf, params)).toBe(true);
  });

  it('migrates old whorled / phyllotaxy / bifurcation parameters', () => {
    expect(migrateGenerationParams({ mode: { value: 'whorled' }, whorlCount: { value: 7 } }).mode?.value).toBe('absolute-steps');
    const ph = migrateGenerationParams({ mode: { value: 'phyllotaxy' }, number: { value: 9 }, phyllotaxyAngle: { value: 137.5 } });
    expect(ph.phyllotaxyInternode?.value).toBe(0);
    expect(ph.phyllotaxyLimit?.value).toBe(9);
    expect(ph.phyllotaxySpiral?.value).toBeCloseTo(-42.5, 6);
    expect(ph.phyllotaxyAngle).toBeUndefined();
    expect(migrateGenerationParams({ mode: { value: 'bifurcation' }, number: { value: 5 } }).bifurcationCount?.value).toBe(5);
    const untouched: NodeParams = { mode: { value: 'absolute' } };
    expect(migrateGenerationParams(untouched)).toBe(untouched);
  });
});

describe('generation modes: node integration', () => {
  const trunk = (bend = 0): Skeleton => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i < 17; i++) {
      const z = i * 0.25;
      const x = i === 8 ? bend : i > 8 ? bend * (1 - (i - 8) / 8) : bend * (i / 8);
      sb.addPoint(x, 0, z, 0.05);
    }
    sb.endBranch();
    return sb.build();
  };

  function children(type: string, over: Record<string, unknown>, parent: Skeleton = trunk(), seed = 3): Skeleton {
    const def = getNodeDef(type);
    if (!def) throw new Error(type);
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    const base = { splitChance: 0, jumble: 0, ...over };
    for (const [k, v] of Object.entries(base)) if (p[k]) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    const ctx: NodeContext = { nodeId: type, name: type, rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') };
    const inputs: NodeInputs = { parent: [{ kind: 'Structure', value: { skeleton: parent } }] };
    const out = def.evaluate(ctx, inputs, p) as Record<string, { value: unknown }>;
    return (out.children?.value as { skeleton: Skeleton }).skeleton;
  }
  const direct = (sk: Skeleton): number => sk.branches.filter((b) => b.parentBranch === 0).length;
  const pointsOf = (sk: Skeleton): number[] => sk.branches.filter((b) => b.parentBranch === 0).map((b) => b.parentPoint);

  it('Branch grows the requested number of children in each counting mode', () => {
    expect(direct(children('generator.branch', { mode: 'absolute', number: 6 }))).toBe(6);
    expect(direct(children('generator.branch', { mode: 'flood', number: 5 }))).toBe(5);
    expect(direct(children('generator.branch', { mode: 'parent', number: 3 }))).toBe(3);
    expect(direct(children('generator.branch', { mode: 'absolute-steps', whorlCount: 3, whorlPerStep: 2 }))).toBe(6);
    expect(direct(children('generator.branch', { mode: 'proportional', proportionalCount: 2 }))).toBe(8);
  });

  it('Parent mode grows every child from the origin of the parent', () => {
    const pts = pointsOf(children('generator.branch', { mode: 'parent', number: 3, first: 0.5, last: 0.9 }));
    expect(pts).toHaveLength(3);
    expect(pts.every((p) => p === 0)).toBe(true);
  });

  it('Phyllotaxy and Interval place groups from Last towards First', () => {
    const phyllo = children('generator.branch', {
      mode: 'phyllotaxy',
      phyllotaxyStyle: 'opposite-distichous',
      phyllotaxyInternode: 1,
      first: 0,
      last: 1,
    });
    expect(direct(phyllo)).toBe(10);
    const sides = Array.from(phyllo.attributes.get('side') as Float32Array);
    expect(sides.filter((s) => s === 1).length).toBeGreaterThan(0);
    expect(sides.filter((s) => s === -1).length).toBeGreaterThan(0);
    const iv = children('generator.branch', { mode: 'interval', intervalStep: 1, perStep: 2, first: 0, last: 1 });
    expect(direct(iv)).toBe(10);
    expect(Math.max(...pointsOf(iv))).toBe(16);
  });

  it('Bifurcation places children at the bend of the parent', () => {
    const sk = children('generator.branch', { mode: 'bifurcation', bifurcationCount: 1, bifurcationThreshold: 3, first: 0, last: 1 }, trunk(0.8));
    expect(direct(sk)).toBe(1);
    expect(Math.abs((pointsOf(sk)[0] as number) - 8)).toBeLessThanOrEqual(1);
  });

  it('is deterministic and every other generator accepts the new modes', () => {
    const over = { mode: 'phyllotaxy', phyllotaxyStyle: 'whorled', phyllotaxyInternode: 0.7 };
    const a = children('generator.branch', over);
    const b = children('generator.branch', over);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    for (const type of ['generator.spine', 'generator.trunk']) {
      expect(() => children(type, { mode: 'interval', intervalStep: 0.5 })).not.toThrow();
    }
  });
});
