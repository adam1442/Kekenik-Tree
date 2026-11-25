import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { extendIsValid } from '@/generators/common/extend';
import {
  EXTEND_COUNT_MAX,
  MAX_EXTENSION_DEPTH,
  SPLIT_ATTR,
  SplitFlag,
  CONTINUATION_BLEND_RADII,
  blendExtensionStart,
  bottomOpenEnd,
  checkExtensionDepth,
  clampExtendCount,
  collectOpenEnds,
  extendDisabledReason,
  extensionSeedKey,
  junctionError,
  selectOpenEnds,
  type ExtendSelectType,
  type SelectableEnd,
} from '@/generators/split';
import { EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES } from '@/generators/common/extend';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';
import { splitHalves } from './helpers/splitHalves';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

// ---- pure selection ----------------------------------------------------------------------------------------------------

const halves = (balance: number, broken = false): SelectableEnd[] => {
  return splitHalves(balance).map((h) => ({ ...h.openEnd, kind: h.fat ? ('fat' as const) : ('skinny' as const), broken }));
};
const single = (broken: boolean): SelectableEnd[] => [{ position: [0, 0, 1], direction: [0, 0, 1], radius: 0.1, side: 0, fat: false, broken }];
const sidesOf = (ends: SelectableEnd[], type: ExtendSelectType): number[] => selectOpenEnds(ends, type, 1).map((s) => s.end.side);

describe('selectOpenEnds', () => {
  const types: ExtendSelectType[] = ['none', 'any', 'split-1', 'split-2', 'skinny', 'fat', 'breaks-only'];
  // Rows: [name, ends, expected sides per type]. A split replaces the break at the tip, so the halves of a broken+split parent are
  // not Break ends.
  const table: [string, SelectableEnd[], Record<string, number[]>][] = [
    ['unsplit', single(false), { none: [], any: [0], 'split-1': [0], 'split-2': [], skinny: [], fat: [0], 'breaks-only': [] }],
    ['split balanced', halves(0.5), { none: [], any: [1, 2], 'split-1': [1], 'split-2': [2], skinny: [2], fat: [1], 'breaks-only': [] }],
    ['split unbalanced', halves(0.7), { none: [], any: [1, 2], 'split-1': [1], 'split-2': [2], skinny: [2], fat: [1], 'breaks-only': [] }],
    ['broken', single(true), { none: [], any: [0], 'split-1': [0], 'split-2': [], skinny: [], fat: [0], 'breaks-only': [0] }],
    ['broken + split', halves(0.3, false), { none: [], any: [1, 2], 'split-1': [1], 'split-2': [2], skinny: [1], fat: [2], 'breaks-only': [] }],
  ];
  for (const [name, ends, expected] of table) {
    it(`table: ${name}`, () => {
      for (const t of types) expect(sidesOf(ends, t), `${name} / ${t}`).toEqual(expected[t]);
    });
  }

  it('Skinny / Fat pick the right half for Balance 0.3 and 0.7', () => {
    const b7 = halves(0.7);
    expect(selectOpenEnds(b7, 'fat', 1)[0]!.end.side).toBe(1);
    expect(selectOpenEnds(b7, 'skinny', 1)[0]!.end.side).toBe(2);
    expect(selectOpenEnds(b7, 'fat', 1)[0]!.end.radius).toBeGreaterThan(selectOpenEnds(b7, 'skinny', 1)[0]!.end.radius);
    const b3 = halves(0.3);
    expect(selectOpenEnds(b3, 'fat', 1)[0]!.end.side).toBe(2);
    expect(selectOpenEnds(b3, 'skinny', 1)[0]!.end.side).toBe(1);
  });

  it('Bottom uses the synthetic base end: direction -tangent, base radius, consistently flipped frame', () => {
    const t: [number, number, number] = [0, 0.6, 0.8];
    const base = bottomOpenEnd([1, 2, 3], t, [1, 0, 0], 0.25);
    expect(base.direction[0]).toBeCloseTo(0, 12);
    expect(base.direction[1]).toBeCloseTo(-0.6, 12);
    expect(base.direction[2]).toBeCloseTo(-0.8, 12);
    expect(base.radius).toBe(0.25);
    const f = base.frame!;
    const d = base.direction;
    const crossNB = [f.normal[1] * f.binormal[2] - f.normal[2] * f.binormal[1], f.normal[2] * f.binormal[0] - f.normal[0] * f.binormal[2], f.normal[0] * f.binormal[1] - f.normal[1] * f.binormal[0]];
    for (let i = 0; i < 3; i++) expect(crossNB[i]!).toBeCloseTo(d[i]!, 9);
    expect(f.normal[0] * d[0] + f.normal[1] * d[1] + f.normal[2] * d[2]).toBeCloseTo(0, 9);
    const sel = selectOpenEnds(halves(0.5), 'bottom', 1, base);
    expect(sel).toHaveLength(1);
    expect(sel[0]!.end).toBe(base);
    expect(selectOpenEnds(halves(0.5), 'bottom', 1)).toHaveLength(0);
  });

  it('Count makes 1-8 nodes per end with deterministic per-index keys', () => {
    const ends = halves(0.5);
    const sel = selectOpenEnds(ends, 'any', 3);
    expect(sel).toHaveLength(6);
    expect(sel.map((s) => s.seedKey)).toEqual([0, 1, 2].map((i) => extensionSeedKey(1, i)).concat([0, 1, 2].map((i) => extensionSeedKey(2, i))));
    expect(new Set(sel.map((s) => s.seedKey)).size).toBe(6);
    expect(selectOpenEnds(ends, 'any', 3)).toEqual(sel);
    expect(selectOpenEnds(ends, 'split-2', 3).map((s) => s.seedKey)).toEqual([0, 1, 2].map((i) => extensionSeedKey(2, i)));
    expect(clampExtendCount(0)).toBe(1);
    expect(clampExtendCount(99)).toBe(EXTEND_COUNT_MAX);
    expect(selectOpenEnds(ends, 'any', 99)).toHaveLength(2 * EXTEND_COUNT_MAX);
  });

  it('measures junction continuity', () => {
    const e = { position: [1, 2, 3] as const, direction: [0, 0, 1] as const, radius: 0.1 };
    const ok = junctionError(e, { position: [1, 2, 3], direction: [0, 0, 1], radius: 0.1 });
    expect(ok.dPos).toBe(0);
    expect(ok.angleDeg).toBeCloseTo(0, 6);
    const bad = junctionError(e, { position: [1, 2, 3.1], direction: [0, 1, 1], radius: 0.2 });
    expect(bad.dPos).toBeCloseTo(0.1, 9);
    expect(bad.angleDeg).toBeCloseTo(45, 6);
    expect(bad.dRadius).toBeCloseTo(0.1, 9);
  });

  it('guards: depth limit with a message, and a reason for non-Branch parents', () => {
    expect(checkExtensionDepth(MAX_EXTENSION_DEPTH).ok).toBe(true);
    const over = checkExtensionDepth(MAX_EXTENSION_DEPTH + 1);
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/32/);
    expect(extendDisabledReason('generator.branch', 'generator.trunk', EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES)).toBeNull();
    expect(extendDisabledReason('generator.cap', 'generator.branch', EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES)).toBeNull();
    expect(extendDisabledReason('generator.branch', 'output.tree', EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES)).toMatch(/Branch, Trunk or Root generator/);
    expect(extendDisabledReason('generator.branch', undefined, EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES)).not.toBeNull();
    expect(extendDisabledReason('generator.knot', 'generator.branch', EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES)).toMatch(/only available/);
    expect(extendIsValid('generator.branch', 'generator.branch')).toBe(true);
  });
});

describe('blendExtensionStart', () => {
  const arc = (n: number, step: number, bend: number): Float32Array => {
    const p = new Float32Array(n * 3);
    let a = 0;
    for (let i = 1; i < n; i++) {
      a += bend * 0.02;
      p[i * 3] = p[(i - 1) * 3]! + Math.sin(a) * step;
      p[i * 3 + 2] = p[(i - 1) * 3 + 2]! + Math.cos(a) * step;
    }
    return p;
  };

  it('makes the first segment follow the tangent, keeps point 0 and everything beyond the blend', () => {
    const p = arc(60, 0.02, 8);
    const before = Float32Array.from(p);
    // the raw spine already turns on its first segment
    expect(Math.atan2(before[3]!, before[5]!)).toBeGreaterThan(0.1);
    const moved = blendExtensionStart(p, 60, [0, 0, 1], 0.2);
    expect(moved).toBeGreaterThan(5);
    expect(Array.from(p.subarray(0, 3))).toEqual([0, 0, 0]);
    const first = Math.atan2(p[3]!, p[5]!);
    expect((first * 180) / Math.PI).toBeLessThan(0.5);
    const span = CONTINUATION_BLEND_RADII * 0.2;
    expect(Array.from(p.subarray(moved * 3 + 6))).toEqual(Array.from(before.subarray(moved * 3 + 6)));
    expect(span).toBeCloseTo(0.3, 9);
  });

  it('does nothing for a straight spine along the tangent, or degenerate input', () => {
    const p = arc(10, 0.05, 0);
    const before = Float32Array.from(p);
    blendExtensionStart(p, 10, [0, 0, 1], 0.1);
    for (let i = 0; i < p.length; i++) expect(p[i]!).toBeCloseTo(before[i]!, 6);
    expect(blendExtensionStart(p, 1, [0, 0, 1], 0.1)).toBe(0);
    expect(blendExtensionStart(p, 10, [0, 0, 0], 0.1)).toBe(0);
    expect(blendExtensionStart(p, 10, [0, 0, 1], 0)).toBe(0);
  });
});

// ---- generation --------------------------------------------------------------------------------------------------------

const STRAIGHT = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const trunkSpec = (extra: Record<string, unknown>, children: NodeSpec[]): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, splitsChance: 0, ...extra } as NodeSpec['params'] },
  ...children,
];
const extender = (id: string, type: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.branch',
  parent: 'trunk',
  params: { ...STRAIGHT, number: 1, extendParent: type, extendCount: 1, knockout: 1, ...extra } as NodeSpec['params'],
});

const startOf = (sk: Skeleton, b: Skeleton['branches'][number]) => ({
  position: [sk.position[b.start * 3]!, sk.position[b.start * 3 + 1]!, sk.position[b.start * 3 + 2]!] as const,
  direction: [sk.direction[b.start * 3]!, sk.direction[b.start * 3 + 1]!, sk.direction[b.start * 3 + 2]!] as const,
  radius: sk.radius[b.start]!,
});

function expectContinuous(trunk: Skeleton, ext: Skeleton, expectedBranches: number): void {
  const ends = collectOpenEnds(trunk);
  expect(ext.branches).toHaveLength(expectedBranches);
  for (const b of ext.branches) {
    const s = startOf(ext, b);
    const near = ends.map((e) => ({ e, err: junctionError(e, s) })).sort((x, y) => x.err.dPos - y.err.dPos)[0]!;
    expect(near.err.dPos).toBeLessThan(1e-5);
    expect(near.err.angleDeg).toBeLessThan(0.5);
    expect(near.err.dRadius).toBeLessThan(1e-5);
  }
}

describe('extension continuity (generation)', () => {
  it('straight: first point, direction and radius equal the open end', async () => {
    const r = await run(trunkSpec({ breakChance: 1, breakSpot: 0.6 }, [extender('ext', 'any')]));
    expectContinuous(skeletonOf(r, 'trunk'), skeletonOf(r, 'ext'), 1);
  });

  it('curved: a child that wants another direction still starts on the end without a kink', async () => {
    const r = await run(
      trunkSpec({ curvature: 0.6, breakChance: 1, breakSpot: 0.7 }, [extender('ext', 'any', { gravity: 0.8, curvature: -0.6, upDown: -0.5 })]),
    );
    expectContinuous(skeletonOf(r, 'trunk'), skeletonOf(r, 'ext'), 1);
  });

  it('split halves: both extensions start on their open ends', async () => {
    const r = await run(trunkSpec({ splitsChance: 1, splitsBalance: 0.7 }, [extender('ext', 'any')]));
    expectContinuous(skeletonOf(r, 'trunk'), skeletonOf(r, 'ext'), 2);
  });

  it('Bottom extends the base of the parent pointing back along -tangent', async () => {
    const r = await run(trunkSpec({}, [extender('ext', 'bottom')]));
    const trunk = skeletonOf(r, 'trunk');
    const ext = skeletonOf(r, 'ext');
    expect(ext.branches).toHaveLength(1);
    const tb = trunk.branches[0]!;
    const base = { position: [trunk.position[tb.start * 3]!, trunk.position[tb.start * 3 + 1]!, trunk.position[tb.start * 3 + 2]!] as const, direction: [-trunk.direction[tb.start * 3]!, -trunk.direction[tb.start * 3 + 1]!, -trunk.direction[tb.start * 3 + 2]!] as const, radius: trunk.radius[tb.start]! };
    const err = junctionError(base, startOf(ext, ext.branches[0]!));
    expect(err.dPos).toBeLessThan(1e-5);
    expect(err.angleDeg).toBeLessThan(0.5);
    expect(err.dRadius).toBeLessThan(1e-5);
  });
});

describe('several generators on one parent', () => {
  it('Skinny and Fat generators extend different halves and do not interfere', async () => {
    const both = await run(trunkSpec({ splitsChance: 1, splitsBalance: 0.3 }, [extender('skinny', 'skinny'), extender('fat', 'fat')]));
    const trunk = skeletonOf(both, 'trunk');
    const skinny = skeletonOf(both, 'skinny');
    const fat = skeletonOf(both, 'fat');
    expect(skinny.branches).toHaveLength(1);
    expect(fat.branches).toHaveLength(1);
    const ends = collectOpenEnds(trunk);
    const thin = ends.find((e) => !e.fat)!;
    const thick = ends.find((e) => e.fat)!;
    expect(junctionError(thin, startOf(skinny, skinny.branches[0]!)).dPos).toBeLessThan(1e-5);
    expect(junctionError(thick, startOf(fat, fat.branches[0]!)).dPos).toBeLessThan(1e-5);
    expect(thick.radius).toBeGreaterThan(thin.radius);
    // Each generator alone produces the same skeleton as next to the other one.
    const alone = await run(trunkSpec({ splitsChance: 1, splitsBalance: 0.3 }, [extender('skinny', 'skinny')]));
    expect(Array.from(skeletonOf(alone, 'skinny').position)).toEqual(Array.from(skinny.position));
  });
});

describe('determinism and seed independence', () => {
  const info = (s: Skeleton): number[] => s.branches.map((b) => Math.round(s.attributes.get(SPLIT_ATTR)?.[b.start] ?? 0));

  it('same graph and seed give the same extension', async () => {
    const g = (): NodeSpec[] => trunkSpec({ splitsChance: 1 }, [extender('ext', 'any', { extendCount: 3, noiseAmount: 0.3 })]);
    const a = skeletonOf(await run(g(), 7), 'ext');
    const b = skeletonOf(await run(g(), 7), 'ext');
    expect(a.branches.length).toBe(6);
    expect(Array.from(a.position)).toEqual(Array.from(b.position));
    expect(Array.from(a.radius)).toEqual(Array.from(b.radius));
  });

  it('changing the Splits seed changes the splits but not the Break decision or the extension noise', async () => {
    const g = (seed: number): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT } as NodeSpec['params'] },
      { id: 'br', type: 'generator.branch', parent: 'trunk', params: { spineOnly: true, number: 30, splitsChance: 0.5, splitsSeed: seed, breakChance: 0.5, breakSeed: 5 } as NodeSpec['params'] },
    ];
    const a = skeletonOf(await run(g(3)), 'br');
    const b = skeletonOf(await run(g(4)), 'br');
    expect(info(a)).not.toEqual(info(b));
    // Main branches (not split sides) keep their order; compare the Break flag wherever neither run split the branch.
    const mains = (s: Skeleton) =>
      s.branches
        .filter((br) => !(Math.round(s.attributes.get(SPLIT_ATTR)?.[br.start] ?? 0) & (SplitFlag.Side1 | SplitFlag.Side2)))
        .map((br) => ({ parent: (Math.round(s.attributes.get(SPLIT_ATTR)?.[br.start] ?? 0) & SplitFlag.Parent) !== 0, broken: (s.attributes.get('openEnd')?.[br.start] ?? 0) > 0 }));
    const ma = mains(a);
    const mb = mains(b);
    expect(ma.length).toBe(mb.length);
    let compared = 0;
    let brokenSeen = 0;
    for (let i = 0; i < ma.length; i++) {
      if (ma[i]!.parent || mb[i]!.parent) continue;
      compared++;
      if (ma[i]!.broken) brokenSeen++;
      expect(ma[i]!.broken).toBe(mb[i]!.broken);
    }
    expect(compared).toBeGreaterThan(5);
    expect(brokenSeen).toBeGreaterThan(0);
  });
});
