import { beforeAll, afterEach, describe, expect, it } from 'vitest';
import { defaultGraph } from '@/app/project/defaultGraph';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import { defaultParamState, defaultParams, evalCondition, type NodeParams } from '@/contracts/params';
import type { MaskDef } from '@/contracts/material';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { flatCurve } from '@/core/curve';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import {
  applySizeScalar,
  asExtendType,
  cumulativeSizeScalar,
  EXTEND_TYPES,
  extendIsValid,
  extensionPositions,
  insideVolume,
  isOutsideClip,
  knockedOut,
  knockoutChance,
  maskGateKeeps,
  meshAlignmentAxis,
  migrateCommonGeneration,
  normalizedAlong,
  passesForceContainers,
  pruningKeeps,
  readForceContainers,
  readForceVolume,
  readPass,
  clipRange,
  validatePasses,
  type ForceVolume,
} from '@/generators/common';
import { generatePlacements, type ModeFrame } from '@/generators/modes';
import { snapshotGraph, topologicalOrder, GraphEvaluator } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { createMaskDef } from '@/materials/masks';
import { setMaterialSource } from '@/materials/materialSource';
import { getCurvePreset } from '@/core/curve';

beforeAll(() => registerDiscoveredNodes());
afterEach(() => setMaterialSource(null));

const frame = (over: Partial<ModeFrame> = {}): ModeFrame => ({
  rng: new Rng(11),
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
});

describe('Boundaries: Clip', () => {
  it('range helpers', () => {
    expect(clipRange(0.2, 0.8, 0)).toEqual({ min: 0.2, max: 0.8 });
    const r = clipRange(0.2, 0.8, 0.1);
    expect(r.min).toBeCloseTo(0.26);
    expect(r.max).toBeCloseTo(0.74);
    expect(isOutsideClip(0.1, 0.2, 0.8)).toBe(true);
    expect(isOutsideClip(0.2, 0.2, 0.8)).toBe(false);
  });

  it('modes keep pushed nodes on the parent only when clip is on, so they can be removed', () => {
    const req = { mode: 'absolute' as const, number: 10, jumble: 0, sweep: 1, alignStyle: 'group' as const };
    const held = generatePlacements(frame({ positionOffset: 0.3 }), req);
    expect(held.every((r) => r.t <= 0.9 + 1e-9)).toBe(true);
    const free = generatePlacements(frame({ positionOffset: 0.3, clip: true }), req);
    expect(free.some((r) => r.t > 0.9)).toBe(true);
    expect(free.filter((r) => !isOutsideClip(r.t, 0.1, 0.9))).toHaveLength(held.filter((r) => r.t < 0.9 - 1e-9).length);
  });
});

describe('Common: Pruning', () => {
  it('removes nodes where the curve is below 0.5 (left = First, right = Last)', () => {
    expect(pruningKeeps(null, 0.3)).toBe(true);
    expect(pruningKeeps(flatCurve(1), 0.3)).toBe(true);
    expect(pruningKeeps(flatCurve(0.3), 0.3)).toBe(false);
    const ramp = getCurvePreset('linear');
    expect(pruningKeeps(ramp, 0.2)).toBe(false);
    expect(pruningKeeps(ramp, 0.8)).toBe(true);
    expect(normalizedAlong(0.5, 0.2, 0.8)).toBeCloseTo(0.5);
    expect(normalizedAlong(0.2, 0.2, 0.8)).toBe(0);
  });
});

describe('Knockout', () => {
  it('chance = amount + resolution per level of detail, scaled by the curve, clamped', () => {
    expect(knockoutChance(0.2, 0.1, 0)).toBeCloseTo(0.2);
    expect(knockoutChance(0.2, 0.1, 2)).toBeCloseTo(0.4);
    expect(knockoutChance(0.2, -0.2, 3)).toBe(0);
    expect(knockoutChance(0.6, 0, 0, 0.5)).toBeCloseTo(0.3);
    expect(knockoutChance(2, 0, 0)).toBe(1);
  });

  it('is deterministic and removes the requested share', () => {
    const run = (seed: number): boolean[] => {
      const base = new Rng(seed);
      return Array.from({ length: 4000 }, (_, i) => knockedOut(base.fork(`ko:${i}`), 0.3));
    };
    expect(run(5)).toEqual(run(5));
    const ratio = run(5).filter(Boolean).length / 4000;
    expect(ratio).toBeGreaterThan(0.27);
    expect(ratio).toBeLessThan(0.33);
    expect(knockedOut(new Rng(1), 0)).toBe(false);
    expect(knockedOut(new Rng(1), 1)).toBe(true);
  });
});

describe('Force containers', () => {
  const sphere: ForceVolume = { name: 'Ball', shape: 'sphere', center: [0, 0, 2], radius: 1, size: [0, 0, 0] };
  const box: ForceVolume = { name: 'Crate', shape: 'box', center: [5, 0, 0], radius: 0, size: [2, 4, 6] };

  it('sphere and box containment', () => {
    expect(insideVolume(sphere, [0, 0, 2.9])).toBe(true);
    expect(insideVolume(sphere, [0, 0, 3.1])).toBe(false);
    expect(insideVolume(box, [5.9, 1.9, -2.9])).toBe(true);
    expect(insideVolume(box, [6.1, 0, 0])).toBe(false);
  });

  it('Include keeps only nodes inside, Exclude removes nodes inside', () => {
    const vols = [sphere, box];
    expect(passesForceContainers([0, 0, 2], { include: ['Ball'], exclude: [] }, vols)).toBe(true);
    expect(passesForceContainers([0, 0, 5], { include: ['Ball'], exclude: [] }, vols)).toBe(false);
    expect(passesForceContainers([5, 0, 0], { include: ['Ball', 'Crate'], exclude: [] }, vols)).toBe(true);
    expect(passesForceContainers([0, 0, 2], { include: [], exclude: ['Ball'] }, vols)).toBe(false);
    expect(passesForceContainers([0, 0, 5], { include: [], exclude: ['Ball'] }, vols)).toBe(true);
    expect(passesForceContainers([0, 0, 2], { include: ['Ball'], exclude: ['Ball'] }, vols)).toBe(false);
    // unknown names never restrict
    expect(passesForceContainers([9, 9, 9], { include: ['Gone'], exclude: ['Gone'] }, vols)).toBe(true);
  });

  it('reads the Volume section of a Force node and the container lists of a generator', () => {
    const force = getNodeDef('force.gravity');
    expect(force).toBeDefined();
    const p = defaultParams(force?.params ?? []);
    expect(readForceVolume('G', p)).toBeNull();
    p.volumeShape = { value: 'box' };
    p.volumeSize = { value: [1, 2, 3] };
    expect(readForceVolume('G', p)).toMatchObject({ shape: 'box', size: [1, 2, 3] });
    const gen = defaultParams(getNodeDef('generator.branch')?.params ?? []);
    gen.forceInclude = { value: [{ forceName: 'A' }, { forceName: '' }] };
    gen.forceExclude = { value: [{ forceName: 'B' }] };
    expect(readForceContainers(gen)).toEqual({ include: ['A'], exclude: ['B'] });
  });
});

describe('Masks', () => {
  const sample = (z: number, nz = 1) => ({ position: [0, 0, z] as [number, number, number], normal: [0, 0, nz] as [number, number, number], height: z / 10 });
  const high: MaskDef = { ...createMaskDef('hi', 'High'), elevationMode: 'absolute', absoluteElevation: { min: 5, max: 50 } };

  it('keeps a node where every mask is >= 0.5 (inclusive / exclusive)', () => {
    expect(maskGateKeeps([], sample(0))).toBe(true);
    expect(maskGateKeeps([high], sample(6))).toBe(true);
    expect(maskGateKeeps([high], sample(2))).toBe(false);
    const low: MaskDef = { ...high, id: 'lo', behavior: 'exclusive' };
    expect(maskGateKeeps([low], sample(2))).toBe(true);
    expect(maskGateKeeps([low], sample(6))).toBe(false);
    expect(maskGateKeeps([high, low], sample(6))).toBe(false);
  });
});

describe('Pass', () => {
  it('reads an integer >= 1', () => {
    expect(readPass({})).toBe(1);
    expect(readPass({ pass: { value: 2.6 } })).toBe(3);
    expect(readPass({ pass: { value: -4 } })).toBe(1);
  });

  it('flags nodes whose pass is lower than an ancestor', () => {
    const errors = validatePasses([
      { id: 'a', pass: 2, parentId: null },
      { id: 'b', pass: 3, parentId: 'a' },
      { id: 'c', pass: 1, parentId: 'b' },
      { id: 'd', pass: 3, parentId: 'b' },
    ]);
    expect([...errors.keys()]).toEqual(['c']);
    expect(errors.get('c')).toMatch(/lower than the pass of an ancestor/);
  });

  it('shows an error badge in the evaluation and orders siblings by pass', async () => {
    const m = new GraphModel();
    m.load(defaultGraph());
    m.setParam('trunk', 'pass', { value: 2 });
    const result = await new GraphEvaluator().evaluate(snapshotGraph(m), { seed: 1, lod: 0, token: new CancellationSource().token });
    const badge = result.diagnostics.get('big');
    expect(badge?.messages.some((x) => x.level === 'error' && /lower than the pass/.test(x.text))).toBe(true);
    expect(result.diagnostics.get('trunk')?.messages.some((x) => x.level === 'error')).toBe(false);
    expect(badge?.state).not.toBe('error');

    const snap = snapshotGraph(m);
    const plain = topologicalOrder(snap).order;
    m.setParam('trunk', 'pass', { value: 1 });
    m.setParam('roots', 'pass', { value: 5 });
    const ordered = topologicalOrder(snapshotGraph(m)).order;
    expect(ordered.indexOf('roots')).toBeGreaterThan(ordered.indexOf('big'));
    expect(plain).toHaveLength(ordered.length);
  });
});

describe('Extend parent', () => {
  it('lists the eight types', () => {
    expect(EXTEND_TYPES).toHaveLength(8);
    expect(asExtendType('Nonsense')).toBe('none');
  });

  it('positions: Any = tip, Bottom = base, Breaks only = tip of broken parents, None = nothing', () => {
    expect(extensionPositions('none', 3, true)).toEqual([]);
    expect(extensionPositions('any', 2, false)).toEqual([1, 1]);
    expect(extensionPositions('bottom', 1, false)).toEqual([0]);
    expect(extensionPositions('breaks-only', 1, false)).toEqual([]);
    expect(extensionPositions('breaks-only', 2, true)).toEqual([1, 1]);
  });

  it('is valid only for a Branch or Trunk parent and Branch / Cap / Leaf / Batched leaf children', () => {
    expect(extendIsValid('generator.leaf', 'generator.branch')).toBe(true);
    expect(extendIsValid('generator.cap', 'generator.branch')).toBe(true);
    expect(extendIsValid('generator.leaf', 'generator.trunk')).toBe(true);
    expect(extendIsValid('generator.trunk', 'generator.branch')).toBe(false);
    expect(extendIsValid('generator.leaf', 'generator.root')).toBe(false);
  });

  it('only Branch, Cap, Leaf and Batched leaf show the section', () => {
    const has = (type: string): boolean => (getNodeDef(type)?.params ?? []).some((p) => p.id === 'extendParent');
    expect(['generator.branch', 'generator.cap', 'generator.leaf', 'generator.batchedLeaf'].every(has)).toBe(true);
    expect(['generator.trunk', 'generator.root', 'generator.spine'].some(has)).toBe(false);
  });
});

describe('Mesh alignment', () => {
  const f = { tangent: [0, 1, 0] as [number, number, number], normal: [1, 0, 0] as [number, number, number], binormal: [0, 0, 1] as [number, number, number] };
  it('resolves the growth axis', () => {
    expect(meshAlignmentAxis('none', f)).toBeNull();
    expect(meshAlignmentAxis('tangent', f)).toEqual([0, 1, 0]);
    expect(meshAlignmentAxis('binormal', f)).toEqual([0, 0, 1]);
    expect(meshAlignmentAxis('parent-x', f)).toEqual([1, 0, 0]);
    expect(meshAlignmentAxis('world-z', f)).toEqual([0, 0, 1]);
    const z = meshAlignmentAxis('parent-z', f);
    expect(z && Math.abs(z[2])).toBeCloseTo(1);
  });
});

describe('Size scalar', () => {
  it('multiplies down the hierarchy and scales the size parameters of the node', () => {
    expect(cumulativeSizeScalar(undefined, 1.5)).toBe(1.5);
    expect(cumulativeSizeScalar(2, 1.5)).toBe(3);
    const p: NodeParams = { length: { value: 3 }, radius: { value: 0.1, variance: 0.2 }, other: { value: 7 } };
    const scaled = applySizeScalar('generator.branch', p, 2);
    expect(scaled.length?.value).toBe(6);
    expect(scaled.radius).toEqual({ value: 0.2, variance: 0.2 });
    expect(scaled.other?.value).toBe(7);
    expect(applySizeScalar('generator.branch', p, 1)).toBe(p);
  });
});

describe('migration', () => {
  it('folds the old scalar Pruning into Knockout', () => {
    const m = migrateCommonGeneration({ knockout: { value: 0.5 }, pruning: { value: 0.5 } });
    expect(m.pruning).toBeUndefined();
    expect(m.knockout?.value).toBeCloseTo(0.75);
    const untouched: NodeParams = { knockout: { value: 0.2 } };
    expect(migrateCommonGeneration(untouched)).toBe(untouched);
    const zero = migrateCommonGeneration({ pruning: { value: 0 }, knockout: { value: 0.2 } });
    expect(zero.knockout?.value).toBe(0.2);
  });

  it('every generator node was bumped and migrates', () => {
    const def = getNodeDef('generator.branch');
    expect(def?.version).toBeGreaterThanOrEqual(3);
    const out = def?.migrate?.({ pruning: { value: 0.4 }, knockout: { value: 0 } }, 2);
    expect(out?.pruning).toBeUndefined();
    expect(out?.knockout?.value).toBeCloseTo(0.4);
  });
});

describe('inspector layout', () => {
  it('Generation tab carries the shared sections', () => {
    const defs = getNodeDef('generator.leaf')?.params ?? [];
    const sections = new Set(defs.filter((d) => d.group === 'Generation').map((d) => d.subgroup));
    for (const s of ['Boundaries', 'Common', 'Extend parent', 'Knockout', 'Force containers', 'More', 'Masks']) expect(sections.has(s)).toBe(true);
    const ids = defs.filter((d) => d.group === 'Generation').map((d) => d.id);
    for (const id of ['first', 'last', 'clipEnabled', 'active', 'pass', 'rotationOffset', 'positionOffset', 'sink', 'pruningCurve', 'knockout', 'knockoutResolution', 'forceInclude', 'forceExclude', 'clickPlace', 'meshAlignment', 'sizeScalar', 'genMasks']) {
      expect(ids).toContain(id);
    }
    expect(defs.find((d) => d.id === 'extendParent')).toMatchObject({ kind: 'enum' });
    const branch = getNodeDef('generator.branch')?.params ?? [];
    expect(branch.some((d) => d.id === 'meshAlignment')).toBe(false);
    expect(evalCondition(undefined, {})).toBe(true);
  });

  it('Tree node only offers Size scalar from the shared properties', () => {
    const tree = getNodeDef('output.tree')?.params ?? [];
    expect(tree.find((d) => d.id === 'scale')?.label).toBe('Size scalar');
    for (const id of ['pass', 'knockout', 'forceInclude', 'genMasks', 'pruningCurve']) expect(tree.some((d) => d.id === id)).toBe(false);
  });
});

describe('node integration', () => {
  const trunk = (): Skeleton => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i < 21; i++) sb.addPoint(0, 0, i * 0.5, 0.05);
    sb.endBranch();
    return sb.build();
  };

  interface Result {
    sk: Skeleton;
    scalar: number | undefined;
  }

  function grow(type: string, over: Record<string, unknown>, opts: { parent?: Skeleton; volumes?: ForceVolume[]; parentScalar?: number; parentType?: string; seed?: number; lod?: number } = {}): Result {
    const def = getNodeDef(type);
    if (!def) throw new Error(type);
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    for (const [k, v] of Object.entries({ splitChance: 0, jumble: 0, ...over })) if (p[k]) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    const seed = opts.seed ?? 3;
    const ctx: NodeContext = {
      nodeId: type,
      name: type,
      rng: new Rng(seed),
      seed,
      cancel: new CancellationSource().token,
      lod: opts.lod ?? 0,
      logger: createLogger('dev', 'error'),
      ...(opts.volumes ? { forceVolumes: opts.volumes } : {}),
      ...(opts.parentType ? { parentType: opts.parentType } : {}),
    };
    const inputs: NodeInputs = { parent: [{ kind: 'Structure', value: { skeleton: opts.parent ?? trunk(), ...(opts.parentScalar ? { sizeScalar: opts.parentScalar } : {}) } }] };
    const out = def.evaluate(ctx, inputs, p) as Record<string, { value: { skeleton: Skeleton; sizeScalar?: number } }>;
    return { sk: out.children!.value.skeleton, scalar: out.children!.value.sizeScalar };
  }
  const direct = (r: Result): Skeleton['branches'] => r.sk.branches.filter((b) => b.parentBranch === 0);
  const BASE = { mode: 'absolute', number: 12, first: 0.1, last: 0.9 };
  const zOf = (r: Result, b: Skeleton['branches'][number]): number => r.sk.position[b.start * 3 + 2] as number;

  it('Clip removes nodes pushed outside First..Last by Position', () => {
    const base = { ...BASE, positionOffset: 0.3 };
    const held = grow('generator.branch', base);
    const clipped = grow('generator.branch', { ...base, clipEnabled: true });
    expect(direct(held)).toHaveLength(12);
    expect(direct(clipped).length).toBeLessThan(12);
    expect(direct(clipped).length).toBeGreaterThan(0);
    for (const b of direct(clipped)) expect(zOf(clipped, b)).toBeLessThanOrEqual(0.9 * 10 + 0.01);
  });

  it('Pruning curve removes the nodes in the part of the range where it is below 0.5', () => {
    const ramp = getNodeDef('generator.branch')?.params.find((d) => d.id === 'pruningCurve');
    expect(ramp?.kind).toBe('curve');
    const def = getNodeDef('generator.branch');
    expect(def).toBeDefined();
    const r = growWithCurve({ ...BASE }, getCurvePreset('linear'));
    const zs = direct(r).map((b) => zOf(r, b));
    expect(zs.length).toBeGreaterThan(0);
    expect(zs.length).toBeLessThan(12);
    // right half of First..Last = z >= 5 m
    expect(Math.min(...zs)).toBeGreaterThanOrEqual(5 - 0.01);
  });

  function growWithCurve(over: Record<string, unknown>, curve: ReturnType<typeof getCurvePreset>): Result {
    const def = getNodeDef('generator.branch');
    if (!def) throw new Error('branch');
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    for (const [k, v] of Object.entries({ splitChance: 0, jumble: 0, ...over })) if (p[k]) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    p.pruningCurve = { value: curve as never };
    const ctx: NodeContext = { nodeId: 'b', name: 'b', rng: new Rng(3), seed: 3, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') };
    const out = def.evaluate(ctx, { parent: [{ kind: 'Structure', value: { skeleton: trunk() } }] }, p) as Record<string, { value: { skeleton: Skeleton } }>;
    return { sk: out.children!.value.skeleton, scalar: undefined };
  }

  it('Knockout is deterministic and removes about the requested share; + Resolution removes more at lower detail', () => {
    const cfg = { ...BASE, number: 400, knockout: 0.5 };
    const a = grow('generator.branch', cfg);
    const b = grow('generator.branch', cfg);
    expect(direct(a).map((x) => x.parentPoint)).toEqual(direct(b).map((x) => x.parentPoint));
    const ratio = direct(a).length / 400;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
    const lowDetail = (res: number): number => grow('generator.branch', { ...BASE, number: 400, knockout: 0.2, knockoutResolution: res }, { lod: 2 }).sk.branches.filter((x) => x.parentBranch === 0).length;
    expect(lowDetail(0.2)).toBeLessThan(lowDetail(0));
  });

  it('Force containers: Include keeps nodes inside the box, Exclude removes them', () => {
    const upper: ForceVolume = { name: 'Upper', shape: 'box', center: [0, 0, 7.5], radius: 0, size: [4, 4, 5] };
    const lower: ForceVolume = { name: 'Lower', shape: 'sphere', center: [0, 0, 1], radius: 3, size: [0, 0, 0] };
    const inc = grow('generator.branch', { ...BASE, forceInclude: [{ forceName: 'Upper' }] }, { volumes: [upper, lower] });
    expect(direct(inc).length).toBeGreaterThan(0);
    expect(direct(inc).length).toBeLessThan(12);
    for (const b of direct(inc)) expect(zOf(inc, b)).toBeGreaterThanOrEqual(5 - 0.01);
    const exc = grow('generator.branch', { ...BASE, forceExclude: [{ forceName: 'Lower' }] }, { volumes: [upper, lower] });
    expect(direct(exc).length).toBeGreaterThan(0);
    expect(direct(exc).length).toBeLessThan(12);
    for (const b of direct(exc)) expect(zOf(exc, b)).toBeGreaterThan(3.9);
  });

  it('Masks gate placement by elevation', () => {
    const mask: MaskDef = { ...createMaskDef('hi', 'High'), elevationMode: 'absolute', absoluteElevation: { min: 6, max: 50 } };
    setMaterialSource({ materials: () => [], sets: () => [], displacements: () => [], masks: () => [mask], season: () => 0 });
    const r = grow('generator.branch', { ...BASE, genMasks: [{ genMaskId: 'hi' }] });
    expect(direct(r).length).toBeGreaterThan(0);
    expect(direct(r).length).toBeLessThan(12);
    for (const b of direct(r)) expect(zOf(r, b)).toBeGreaterThanOrEqual(6 - 0.2);
    const none = grow('generator.branch', { ...BASE, genMasks: [{ genMaskId: 'missing' }] });
    expect(direct(none)).toHaveLength(12);
  });

  it('Extend parent adds tip / base extensions under a Branch parent', () => {
    const any = grow('generator.branch', { ...BASE, number: 3, extendParent: 'any', extendCount: 2 }, { parentType: 'generator.branch' });
    expect(direct(any)).toHaveLength(5);
    const bottom = grow('generator.branch', { ...BASE, number: 0, extendParent: 'bottom', extendCount: 1 }, { parentType: 'generator.branch' });
    expect(direct(bottom)).toHaveLength(1);
    expect(direct(bottom)[0]?.parentPoint).toBe(0);
    const wrongParent = grow('generator.branch', { ...BASE, number: 3, extendParent: 'any' }, { parentType: 'generator.root' });
    expect(direct(wrongParent)).toHaveLength(3);
    const none = grow('generator.branch', { ...BASE, number: 3, extendParent: 'none' }, { parentType: 'generator.branch' });
    expect(direct(none)).toHaveLength(3);
  });

  it('Size scalar scales the node and is handed to its children', () => {
    const total = (r: Result): number => r.sk.branches.reduce((s, b) => s + b.length, 0);
    const one = grow('generator.branch', { ...BASE, number: 6, lengthVariance: 0 });
    const two = grow('generator.branch', { ...BASE, number: 6, sizeScalar: 2 });
    expect(one.scalar).toBeUndefined();
    expect(two.scalar).toBe(2);
    expect(total(two) / total(one)).toBeGreaterThan(1.7);
    // a child multiplies its own value into the scalar of the parent
    const child = grow('generator.branch', { ...BASE, number: 6, sizeScalar: 1.5 }, { parentScalar: 2 });
    expect(child.scalar).toBe(3);
    const inherited = grow('generator.branch', { ...BASE, number: 6 }, { parentScalar: 2 });
    expect(inherited.scalar).toBe(2);
    expect(total(inherited)).toBeCloseTo(total(two), 3);
  });

  it('Sink moves the start of the nodes along the parent', () => {
    const flat = grow('generator.branch', { ...BASE, number: 4 });
    const sunk = grow('generator.branch', { ...BASE, number: 4, sink: 0.5 });
    const first = (r: Result): number => r.sk.position[direct(r)[0]!.start * 3 + 2] as number;
    expect(first(sunk)).toBeLessThan(first(flat));
  });
});
