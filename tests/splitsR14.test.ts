import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { asExtendType, extensionPositions } from '@/generators/common/extend';
import {
  EXTENSION_ATTR,
  SPLIT_ATTR,
  SplitFlag,
  applyExtensionSpread,
  collectOpenEnds,
  extensionRadiusFactor,
  extensionSpreadAngle,
  selectsOpenEnd,
  splitFlags,
} from '@/generators/split';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildInspectorSections } from '@/ui/panels/properties/inspectorState';
import { splitHalves } from './helpers/splitHalves';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

const angleBetween = (a: readonly number[], b: readonly number[]): number => {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return Math.acos(Math.min(1, Math.max(-1, d / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!)))));
};

describe('open end selection', () => {
  const sides = splitHalves(0.8);
  const side1Fat = splitFlags(sides[0]!);
  const side2Skinny = splitFlags(sides[1]!);

  it('picks sides by number and by thickness', () => {
    expect(selectsOpenEnd('split-1', side1Fat, false)).toBe(true);
    expect(selectsOpenEnd('split-1', side2Skinny, false)).toBe(false);
    expect(selectsOpenEnd('split-2', side2Skinny, false)).toBe(true);
    expect(selectsOpenEnd('fat', side1Fat, false)).toBe(true);
    expect(selectsOpenEnd('fat', side2Skinny, false)).toBe(false);
    expect(selectsOpenEnd('skinny', side2Skinny, false)).toBe(true);
    expect(selectsOpenEnd('skinny', side1Fat, false)).toBe(false);
  });

  it('flips fat / skinny with Balance and treats equal radii as Side 1 fat', () => {
    const flipped = splitHalves(0.2);
    expect(flipped[0]!.fat).toBe(false);
    expect(flipped[1]!.fat).toBe(true);
    const equal = splitHalves(0.5);
    expect(equal[0]!.fat).toBe(true);
    expect(equal[1]!.fat).toBe(false);
  });

  it('a branch that splits is not an open end; Breaks only ignores split sides', () => {
    expect(selectsOpenEnd('any', SplitFlag.Parent, false)).toBe(false);
    expect(selectsOpenEnd('any', 0, false)).toBe(true);
    expect(selectsOpenEnd('breaks-only', side1Fat, true)).toBe(false);
    expect(selectsOpenEnd('breaks-only', 0, true)).toBe(true);
    expect(selectsOpenEnd('breaks-only', 0, false)).toBe(false);
  });

  it('extensionPositions follows the selection; Bottom always extends the base', () => {
    expect(extensionPositions('any', 2, false, SplitFlag.Parent)).toEqual([]);
    expect(extensionPositions('split-2', 1, false, side2Skinny)).toEqual([1]);
    expect(extensionPositions('split-2', 1, false, side1Fat)).toEqual([]);
    expect(extensionPositions('skinny', 1, false, 0)).toEqual([]);
    expect(extensionPositions('bottom', 2, false, SplitFlag.Parent)).toEqual([0, 0]);
    expect(asExtendType('split-1')).toBe('split-1');
  });
});

describe('extension shaping', () => {
  it('spread keeps the base and its direction, grows along the length; one extension does not spread', () => {
    const n = 21;
    const pts = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pts[i * 3 + 2] = i * 0.15;
    const before = pts.slice();
    applyExtensionSpread(pts, n, [1, 0, 0], extensionSpreadAngle(20, 2), null);
    expect([pts[0], pts[1], pts[2]]).toEqual([0, 0, 0]);
    expect(angleBetween([pts[3]! - pts[0]!, 0, pts[5]! - pts[2]!], [0, 0, 1])).toBeLessThan(0.02);
    expect(pts[(n - 1) * 3]).toBeGreaterThan(pts[Math.floor(n / 2) * 3]!);
    expect(angleBetween([pts[(n - 1) * 3]! - pts[(n - 2) * 3]!, 0, 0.15], [0, 0, 1])).toBeCloseTo((20 * Math.PI) / 180, 1);
    const single = before.slice();
    applyExtensionSpread(single, n, [1, 0, 0], extensionSpreadAngle(20, 1), null);
    expect(Array.from(single)).toEqual(Array.from(before));
  });

  it('the spread profile curve scales the separation along the length', () => {
    const lutZero = new Float32Array(16).fill(0);
    const pts = new Float32Array([0, 0, 0, 0, 0, 1, 0, 0, 2]);
    applyExtensionSpread(pts, 3, [1, 0, 0], 0.3, lutZero);
    expect(pts[6]).toBeCloseTo(0, 9);
  });

  it('radius factor is 1 at the base whatever the curve, so the radius never jumps', () => {
    expect(extensionRadiusFactor(1, 0.5, 0.5)).toBeCloseTo(1, 9);
    expect(extensionRadiusFactor(1, 0.5, 0.25)).toBeCloseTo(0.5, 9);
    expect(extensionRadiusFactor(0, 0.5, 0.25)).toBeCloseTo(1, 9);
  });
});

/** A trunk with every shaping force off, so the tip direction is predictable. */
const TRUNK = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const splitTrunk = (extra: Record<string, unknown> = {}, children: NodeSpec[] = []): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, splitsChance: 1, splitsBalance: 0.7, ...extra } as NodeSpec['params'] },
  ...children,
];
const extender = (id: string, type: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.branch',
  parent: 'trunk',
  params: { ...TRUNK, number: 1, extendParent: type, extendCount: 1, knockout: 1, ...extra } as NodeSpec['params'],
});

describe('Skin > Splits (generation)', () => {
  it('a split trunk gets one parent flag, two open-end sides and conserves the cross-section', async () => {
    const sk = skeletonOf(await run(splitTrunk()), 'trunk');
    const info = sk.attributes.get(SPLIT_ATTR)!;
    expect(info).toBeDefined();
    const flagsOf = sk.branches.map((b) => Math.round(info[b.start]!));
    expect(flagsOf.filter((f) => f & SplitFlag.Parent)).toHaveLength(1);
    expect(flagsOf.filter((f) => f & SplitFlag.Side1)).toHaveLength(1);
    expect(flagsOf.filter((f) => f & SplitFlag.Side2)).toHaveLength(1);
    const ends = collectOpenEnds(sk);
    expect(ends).toHaveLength(2);
    const parent = sk.branches[0]!;
    const tipR = sk.radius[parent.start + parent.count - 1]!;
    expect(ends[0]!.radius ** 2 + ends[1]!.radius ** 2).toBeCloseTo(tipR ** 2, 6);
    expect(ends[0]!.radius).toBeGreaterThan(ends[1]!.radius);
    expect(ends[0]!.fat).toBe(true);
    const ext = sk.attributes.get(EXTENSION_ATTR)!;
    expect(sk.branches.filter((b) => (ext[b.start] ?? 0) > 0)).toHaveLength(2);
  });

  it('Chance 0 never splits', async () => {
    const sk = skeletonOf(await run(splitTrunk({ splitsChance: 0 })), 'trunk');
    expect(sk.branches).toHaveLength(1);
    expect(sk.attributes.get(SPLIT_ATTR)).toBeUndefined();
  });

  it('is deterministic and the Seed only changes the split decision, not the spines', async () => {
    const graph = (seed: number): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: TRUNK as NodeSpec['params'] },
      { id: 'br', type: 'generator.branch', parent: 'trunk', params: { spineOnly: true, number: 30, splitsChance: 0.5, splitsSeed: seed } as NodeSpec['params'] },
    ];
    const a = skeletonOf(await run(graph(3)), 'br');
    const a2 = skeletonOf(await run(graph(3)), 'br');
    const b = skeletonOf(await run(graph(4)), 'br');
    expect(Array.from(a.position)).toEqual(Array.from(a2.position));
    const info = (s: Skeleton): number[] => s.branches.map((br) => Math.round(s.attributes.get(SPLIT_ATTR)?.[br.start] ?? 0));
    expect(info(a)).toEqual(info(a2));
    expect(info(a)).not.toEqual(info(b));
    const mains = (s: Skeleton): number[] =>
      s.branches.filter((br) => !(Math.round(s.attributes.get(SPLIT_ATTR)?.[br.start] ?? 0) & (SplitFlag.Side1 | SplitFlag.Side2))).flatMap((br) => Array.from(s.position.subarray(br.start * 3, (br.start + br.count) * 3)));
    expect(mains(a)).toEqual(mains(b));
  });
});

describe('extensions and caps (generation)', () => {
  it('an extension continues the parent end: same position, direction and radius', async () => {
    const r = await run(splitTrunk({ splitsChance: 0 }, [extender('ext', 'any')]));
    const trunk = skeletonOf(r, 'trunk');
    const ext = skeletonOf(r, 'ext');
    const tb = trunk.branches[0]!;
    const ti = tb.start + tb.count - 1;
    const e0 = ext.branches[0]!;
    const tip = [trunk.position[ti * 3]!, trunk.position[ti * 3 + 1]!, trunk.position[ti * 3 + 2]!];
    expect(Math.hypot(ext.position[e0.start * 3]! - tip[0]!, ext.position[e0.start * 3 + 1]! - tip[1]!, ext.position[e0.start * 3 + 2]! - tip[2]!)).toBeLessThan(1e-4);
    expect(ext.radius[e0.start]!).toBeCloseTo(trunk.radius[ti]!, 5);
    const dTrunk = [trunk.direction[ti * 3]!, trunk.direction[ti * 3 + 1]!, trunk.direction[ti * 3 + 2]!];
    const dExt = [ext.direction[e0.start * 3]!, ext.direction[e0.start * 3 + 1]!, ext.direction[e0.start * 3 + 2]!];
    expect(angleBetween(dTrunk, dExt)).toBeLessThan(0.05);
    expect(ext.attributes.get(EXTENSION_ATTR)?.[e0.start]).toBe(1);
  });

  it('extensions of a split continue each open end; Skinny / Fat / Split 1 / Split 2 pick one', async () => {
    const trunkOf = async (type: string) => {
      const r = await run(splitTrunk({}, [extender('ext', type)]));
      return { trunk: skeletonOf(r, 'trunk'), ext: skeletonOf(r, 'ext') };
    };
    const any = await trunkOf('any');
    expect(any.ext.branches).toHaveLength(2);
    const ends = collectOpenEnds(any.trunk);
    for (const end of ends) {
      const match = any.ext.branches.find((b) => Math.hypot(any.ext.position[b.start * 3]! - end.position[0], any.ext.position[b.start * 3 + 1]! - end.position[1], any.ext.position[b.start * 3 + 2]! - end.position[2]) < 1e-4);
      expect(match).toBeDefined();
      expect(any.ext.radius[match!.start]!).toBeCloseTo(end.radius, 5);
      expect(angleBetween(end.direction, [any.ext.direction[match!.start * 3]!, any.ext.direction[match!.start * 3 + 1]!, any.ext.direction[match!.start * 3 + 2]!])).toBeLessThan(0.05);
    }
    const radiusOf = (s: Skeleton): number => s.radius[s.branches[0]!.start]!;
    const fat = await trunkOf('fat');
    const skinny = await trunkOf('skinny');
    expect(fat.ext.branches).toHaveLength(1);
    expect(skinny.ext.branches).toHaveLength(1);
    expect(radiusOf(fat.ext)).toBeGreaterThan(radiusOf(skinny.ext));
    const s1 = await trunkOf('split-1');
    const s2 = await trunkOf('split-2');
    expect(s1.ext.branches).toHaveLength(1);
    expect(s2.ext.branches).toHaveLength(1);
    expect(radiusOf(s1.ext)).toBeCloseTo(radiusOf(fat.ext), 5);
    expect(radiusOf(s2.ext)).toBeCloseTo(radiusOf(skinny.ext), 5);
  });

  it('Breaks only extends broken branches and not split sides', async () => {
    const split = await run(splitTrunk({}, [extender('ext', 'breaks-only')]));
    expect(skeletonOf(split, 'ext').branches).toHaveLength(0);
    const broken = await run(splitTrunk({ splitsChance: 0, breakChance: 1, breakSpot: 0.6 }, [extender('ext', 'breaks-only')]));
    expect(skeletonOf(broken, 'ext').branches).toHaveLength(1);
  });

  it('a Cap closes every open end (split sides and breaks) and honours Extend parent', async () => {
    const cap = (type: string): NodeSpec => ({ id: 'cap', type: 'generator.cap', parent: 'trunk', params: { extendParent: type } as NodeSpec['params'] });
    const all = await run(splitTrunk({}, [cap('none')]));
    const ends = collectOpenEnds(skeletonOf(all, 'trunk'));
    const caps = skeletonOf(all, 'cap');
    expect(caps.branches).toHaveLength(2);
    for (const end of ends) {
      const b = caps.branches.find((c) => Math.hypot(caps.position[c.start * 3]! - end.position[0], caps.position[c.start * 3 + 1]! - end.position[1], caps.position[c.start * 3 + 2]! - end.position[2]) < 1e-4);
      expect(b).toBeDefined();
      const last = b!.start + b!.count - 1;
      // the cap lies beyond the open end, along its direction, and narrows to a point
      const along = (caps.position[last * 3]! - end.position[0]) * end.direction[0] + (caps.position[last * 3 + 1]! - end.position[1]) * end.direction[1] + (caps.position[last * 3 + 2]! - end.position[2]) * end.direction[2];
      expect(along).toBeGreaterThan(0);
      expect(caps.radius[last]!).toBeLessThan(end.radius);
      expect(caps.radius[b!.start]!).toBeCloseTo(end.radius, 5);
    }
    const skinnyOnly = await run(splitTrunk({}, [cap('skinny')]));
    expect(skeletonOf(skinnyOnly, 'cap').branches).toHaveLength(1);
    const brokenOnly = await run(splitTrunk({ splitsChance: 0, breakChance: 1, breakSpot: 0.6 }, [cap('none')]));
    expect(skeletonOf(brokenOnly, 'cap').branches).toHaveLength(1);
    const none = await run(splitTrunk({ splitsChance: 0 }, [cap('none')]));
    expect(skeletonOf(none, 'cap').branches).toHaveLength(0);
  });
});

describe('extension mesh', () => {
  it('starts on the parent end: no buried ring or collar behind the junction, finite vertices', async () => {
    const r = await run(splitTrunk({ splitsChance: 0, spineOnly: false, skinType: 'Polygons' }, [extender('ext', 'any', { spineOnly: false, skinType: 'Polygons' })]));
    const trunk = skeletonOf(r, 'trunk');
    const tb = trunk.branches[0]!;
    const ti = tb.start + tb.count - 1;
    const tip = [trunk.position[ti * 3]!, trunk.position[ti * 3 + 1]!, trunk.position[ti * 3 + 2]!];
    const dir = [trunk.direction[ti * 3]!, trunk.direction[ti * 3 + 1]!, trunk.direction[ti * 3 + 2]!];
    const entry = r.scene.entries.find((e) => e.nodeId === 'ext')!;
    expect(entry).toBeDefined();
    const pos = entry.mesh.positions;
    expect(pos.length).toBeGreaterThan(0);
    let behind = 0;
    for (let i = 0; i < pos.length / 3; i++) {
      expect(Number.isFinite(pos[i * 3]!)).toBe(true);
      behind = Math.min(behind, (pos[i * 3]! - tip[0]!) * dir[0]! + (pos[i * 3 + 1]! - tip[1]!) * dir[1]! + (pos[i * 3 + 2]! - tip[2]!) * dir[2]!);
    }
    expect(behind).toBeGreaterThan(-1e-3);
  });
});

describe('Splits and Extensions parameters', () => {
  it('Skin > Splits has Chance, Balance, Seed and the Spread / Expand / Smooth sub-heads', () => {
    const def = getNodeDef('generator.branch')!;
    const ids = def.params.filter((p) => p.group === 'Skin' && (p.subgroup ?? '').startsWith('Split')).map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(['splitsChance', 'splitsBalance', 'splitsSeed', 'splitsSpread1', 'splitsSpread2', 'splitsExpand1', 'splitsExpand2', 'splitsSmoothInner', 'splitsSmoothOuter']),
    );
    const sections = buildInspectorSections(def.params, 'Skin');
    const splits = sections.find((s) => s.title === 'Splits')!;
    expect(splits).toBeDefined();
    expect(splits.blocks.map((b) => b.subhead)).toEqual([null, 'Spread', 'Expand', 'Smooth', 'Advanced']);
  });

  it('Branch has the Extensions groups; Cap has no Extend parent Count', () => {
    const branch = getNodeDef('generator.branch')!;
    const has = (id: string, group: string): boolean => branch.params.some((p) => p.id === id && p.group === group && p.subgroup === 'Extensions');
    expect(has('extensionLengthScale', 'Spine')).toBe(true);
    expect(has('extensionSpread', 'Spine')).toBe(true);
    expect(has('extensionRadius', 'Skin')).toBe(true);
    expect(has('extensionNormalSmooth', 'Skin')).toBe(true);
    expect(has('extensionDisplaceScale', 'Skin')).toBe(true);
    const style = branch.params.find((p) => p.id === 'extensionUvStyle');
    expect(style?.kind === 'enum' ? style.options.map((o) => o.label) : []).toEqual(['Automatic', 'Manual (match)', 'Manual (match u only)', 'Manual (full control)']);
    expect(getNodeDef('generator.cap')!.params.some((p) => p.id === 'extendCount')).toBe(false);
    expect(getNodeDef('generator.cap')!.params.some((p) => p.id === 'extendParent')).toBe(true);
    expect(getNodeDef('generator.trunk')!.params.some((p) => p.subgroup === 'Extensions')).toBe(false);
  });

  it('Length scale scales the extension length', async () => {
    const len = async (scale: number): Promise<number> => {
      const r = await run(splitTrunk({ splitsChance: 0 }, [extender('ext', 'any', { extensionLengthScale: scale })]));
      const ext = skeletonOf(r, 'ext');
      return ext.branches[0]!.length;
    };
    const one = await len(1);
    const half = await len(0.5);
    expect(half / one).toBeCloseTo(0.5, 1);
  });
});
