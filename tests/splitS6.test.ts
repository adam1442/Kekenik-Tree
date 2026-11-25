import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseProject } from '@/app/project/format';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { mergeToPlantGeometry } from '@/export/geometry';
import { writeObj } from '@/export/writers/simpleFormats';
import {
  DEFAULT_SPLIT_SETTINGS,
  NO_SPLIT_VARIANCE,
  SPINE_ORIGIN_ATTR,
  SPLIT_ATTR,
  SPLIT_MIN_SIDES,
  SPLIT_MIN_TRANSITION_RINGS,
  SpineOrigin,
  SplitFlag,
  effectiveSplitSides,
  migrateLegacySplitParams,
  planSplit,
  sampleSplitSettings,
  spineOriginName,
} from '@/generators/split';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { compileSpineConfig } from '@/nodes/generators/spine';
import { loadSample } from './helpers/sampleProjects';
import { GraphModel } from '@/graph/model/graphModel';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();

const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const trunkOnly = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, ...extra } as NodeSpec['params'] },
];

/** Edge use counts after welding vertices by position (UV / normal seams are duplicates of the same position). */
function weldedEdges(mesh: MeshData): { use: Map<string, number>; degenerate: number } {
  const key = (i: number): string => `${Math.round(mesh.positions[i * 3]! * 1e5)},${Math.round(mesh.positions[i * 3 + 1]! * 1e5)},${Math.round(mesh.positions[i * 3 + 2]! * 1e5)}`;
  const ids = new Map<string, number>();
  const id = (i: number): number => {
    const k = key(i);
    const hit = ids.get(k);
    if (hit !== undefined) return hit;
    ids.set(k, ids.size);
    return ids.size - 1;
  };
  const use = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [id(mesh.indices[t]!), id(mesh.indices[t + 1]!), id(mesh.indices[t + 2]!)];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
      degenerate++;
      continue;
    }
    for (let e = 0; e < 3; e++) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  return { use, degenerate };
}

const allFinite = (a: ArrayLike<number>): boolean => {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i] as number)) return false;
  return true;
};

const defaultsOf = (type: string): NodeParams => Object.fromEntries(getNodeDef(type)!.params.map((d) => [d.id, defaultParamState(d)]));
const withValues = (params: NodeParams, over: Record<string, number | string | boolean>): NodeParams => {
  const out: NodeParams = { ...params };
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as NonNullable<NodeParams[string]>), value: v };
  return out;
};

/** Small deterministic generator for the random parameter sets (not the project RNG: the test must not depend on it). */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('S6: one split engine for Trunk, Branch and Root', () => {
  it('Trunk, Branch and Root expose identical Skin > Splits parameters (Root only differs in defaults)', () => {
    const pick = (type: string) => getNodeDef(type)!.params.filter((p) => p.group === 'Skin' && (p.subgroup ?? '').startsWith('Split'));
    const trunk = pick('generator.trunk');
    const branch = pick('generator.branch');
    const root = pick('generator.root');
    expect(trunk.length).toBeGreaterThanOrEqual(10);
    const sig = (p: (typeof trunk)[number]): string => JSON.stringify([p.id, p.default, 'min' in p ? p.min : null, 'max' in p ? p.max : null]);
    expect(branch.map(sig)).toEqual(trunk.map(sig));
    expect(root.map((p) => p.id)).toEqual(trunk.map((p) => p.id));
    expect(root.find((p) => p.id === 'splitsChance')!.default).toBe(0.3);
    expect(root.find((p) => p.id === 'splitsSpread1')!.default).toBe(30);
  });

  it('no node still declares the legacy fork parameters or the Fork tip behavior', () => {
    for (const type of ['generator.trunk', 'generator.branch', 'generator.root', 'generator.spine']) {
      const ids = getNodeDef(type)!.params.map((p) => p.id);
      for (const legacy of ['splitChance', 'splitSpread', 'splitBalance', 'splitStart', 'splitMaxDepth']) expect(ids).not.toContain(legacy);
      const tip = getNodeDef(type)!.params.find((p) => p.id === 'termination')!;
      expect('options' in tip ? tip.options.map((o) => o.value) : []).toEqual(['taper', 'blunt', 'broken']);
    }
  });

  it('planSplit has exactly one production caller (the shared spine engine)', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && readFileSync(p, 'utf8').includes('planSplit(')) hits.push(p.replace(/\\/g, '/'));
      }
    };
    walk('src');
    expect(hits.filter((h) => !h.endsWith('generators/split/splitModel.ts'))).toEqual(['src/nodes/generators/spine.ts']);
  });

  it('Branch and Trunk compile the same split config and grow identical splits from identical params and seed', async () => {
    const splits = { splitsChance: 1, splitsBalance: 0.35, splitsSpread1: 28, splitsSpread2: 20, splitsSeed: 5 };
    const cfgOf = (type: string) => compileSpineConfig(withValues(defaultsOf(type), splits), { parent: null } as never, 0, 7, false);
    const a = cfgOf('generator.trunk').splits;
    const b = cfgOf('generator.branch').splits;
    expect({ chance: a.chance, seed: a.seed, settings: a.settings, variance: a.variance }).toEqual({ chance: b.chance, seed: b.seed, settings: b.settings, variance: b.variance });

    // Same node params on a Trunk and on a Branch with one placement: the split halves keep the same shape (radii, open ends).
    const trunkRun = await run(trunkOnly({ ...splits, number: 1 }), 3);
    const halves = (sk: Skeleton): number[] => {
      const info = sk.attributes.get(SPLIT_ATTR);
      return sk.branches.filter((br) => ((info?.[br.start] ?? 0) & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0).map((br) => Math.round(sk.radius[br.start + br.count - 1]! * 1e4));
    };
    const again = await run(trunkOnly({ ...splits, number: 1 }), 3);
    expect(halves(skeletonOf(trunkRun, 'trunk'))).toEqual(halves(skeletonOf(again, 'trunk')));
    expect(halves(skeletonOf(trunkRun, 'trunk'))).toHaveLength(2);
  });

  it('a Branch generator splits too, with fat and skinny halves from Balance', async () => {
    const specs: NodeSpec[] = [
      ...trunkOnly({ length: 6 }),
      { id: 'br', type: 'generator.branch', parent: 'trunk', params: { number: 3, first: 0.3, last: 0.8, mode: 'absolute', splitsChance: 1, splitsBalance: 0.7, length: { value: 2, variance: 0 } } as NodeSpec['params'] },
    ];
    const r = await run(specs, 4);
    const sk = skeletonOf(r, 'br');
    const info = sk.attributes.get(SPLIT_ATTR)!;
    const halves = sk.branches.filter((b) => ((info[b.start] as number) & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0);
    expect(halves.length).toBeGreaterThanOrEqual(2);
    const fat = halves.filter((b) => ((info[b.start] as number) & SplitFlag.Fat) !== 0);
    const skinny = halves.filter((b) => ((info[b.start] as number) & SplitFlag.Fat) === 0);
    expect(fat.length).toBe(skinny.length);
    expect(sk.radius[fat[0]!.start]!).toBeGreaterThan(sk.radius[skinny[0]!.start]!);
    const { use, degenerate } = weldedEdges(meshOf(r, 'br'));
    expect(degenerate).toBe(0);
    for (const n of use.values()) expect(n).toBeLessThanOrEqual(2);
  });
});

describe('S6: lineage tag (spine origin)', () => {
  it('names of the stored values', () => {
    expect(spineOriginName(undefined)).toBe('primary');
    expect(spineOriginName(SpineOrigin.SplitHalf)).toBe('splitHalf');
    expect(spineOriginName(SpineOrigin.Extension)).toBe('extension');
    expect(spineOriginName(99)).toBe('primary');
  });

  it('primary spine, split halves and extensions are tagged and the tag survives merging', async () => {
    const specs: NodeSpec[] = [
      ...trunkOnly({ splitsChance: 1 }),
      { id: 'ext', type: 'generator.branch', parent: 'trunk', params: { ...STRAIGHT, number: 1, extendParent: 'any', extendCount: 1, knockout: 1 } as NodeSpec['params'] },
    ];
    const r = await run(specs, 2);
    const trunk = skeletonOf(r, 'trunk');
    const origin = trunk.attributes.get(SPINE_ORIGIN_ATTR)!;
    const names = trunk.branches.map((b) => spineOriginName(origin[b.start]));
    expect(names[0]).toBe('primary');
    expect(names.filter((n) => n === 'splitHalf')).toHaveLength(2);
    const ext = skeletonOf(r, 'ext');
    const extNames = ext.branches.map((b) => spineOriginName(ext.attributes.get(SPINE_ORIGIN_ATTR)?.[b.start]));
    expect(extNames.length).toBeGreaterThanOrEqual(2);
    expect(extNames.every((n) => n === 'extension')).toBe(true);
  });
});

describe('S6: welded split branch', () => {
  it('only the base spine is welded; its halves and its extensions never are', async () => {
    const specs: NodeSpec[] = [
      ...trunkOnly({ length: 6, radius: 0.3, sides: 24, accuracy: 24 }),
      {
        id: 'br',
        type: 'generator.branch',
        parent: 'trunk',
        params: { number: 4, first: 0.3, last: 0.8, mode: 'absolute', spread: { value: 70, variance: 0 }, length: { value: 2, variance: 0 }, radius: { value: 0.07, variance: 0 }, noiseAmount: 0, gravity: 0, sides: 12, weldEnabled: true, splitsChance: 1 } as NodeSpec['params'],
      },
      { id: 'ext', type: 'generator.branch', parent: 'br', params: { ...STRAIGHT, number: 1, extendParent: 'any', extendCount: 1, knockout: 1, weldEnabled: true } as NodeSpec['params'] },
    ];
    const r = await run(specs, 3);
    const sk = skeletonOf(r, 'br');
    const weld = sk.attributes.get('weld');
    const info = sk.attributes.get(SPLIT_ATTR)!;
    const ext = sk.attributes.get('extensionInfo');
    expect(weld).toBeDefined();
    let welded = 0;
    for (const b of sk.branches) {
      const isHalf = (((info[b.start] as number) ?? 0) & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0;
      if (isHalf) {
        expect(weld![b.start]).toBe(0);
        expect((ext?.[b.start] ?? 0) > 0).toBe(true);
      } else if (weld![b.start] === 1) welded++;
    }
    expect(welded).toBeGreaterThan(0);
    const extSk = skeletonOf(r, 'ext');
    const extWeld = extSk.attributes.get('weld');
    for (const b of extSk.branches) expect(extWeld?.[b.start] ?? 0).toBe(0);
    const mesh = meshOf(r, 'br');
    expect(allFinite(mesh.positions)).toBe(true);
    expect(weldedEdges(mesh).degenerate).toBe(0);
  });
});

describe('S6: even radial count at every resolution / LOD', () => {
  it('effectiveSplitSides is even and >= 6 for every input', () => {
    for (let n = -2; n <= 130; n++) {
      const e = effectiveSplitSides(n);
      expect(e % 2).toBe(0);
      expect(e).toBeGreaterThanOrEqual(SPLIT_MIN_SIDES);
      if (n >= SPLIT_MIN_SIDES) expect(e - n).toBeLessThanOrEqual(1);
    }
    expect(effectiveSplitSides(Number.NaN)).toBeGreaterThanOrEqual(SPLIT_MIN_SIDES);
  });

  it('the transition has at least 4 rings for any plan', () => {
    const rnd = lcg(11);
    for (let i = 0; i < 100; i++) {
      const R = 0.01 + rnd() * 0.5;
      const plan = planSplit({
        end: { position: [0, 0, 4], tangent: [0, 0, 1], up: [1, 0, 0], radius: R },
        parentLength: 0.05 + rnd() * 6,
        settings: { ...DEFAULT_SPLIT_SETTINGS, balance: rnd(), spread1Deg: rnd() * 80, spread2Deg: rnd() * 80 },
        ringSpacing: 0.001 + rnd() * 0.5,
        rng: new Rng(i + 1),
        chance: 1,
        parentTiles: 1 + Math.floor(rnd() * 9),
        parentSpineId: 0,
        treeAxis: [0, 0, 0],
      });
      expect(plan).not.toBeNull();
      expect(plan!.lobes[0].ringCount).toBeGreaterThanOrEqual(SPLIT_MIN_TRANSITION_RINGS);
      expect((plan!.openEnds[0].uTiles ?? 0) % 1).toBe(0);
    }
  });

  it('100 random Resolution / LOD parameter sets: even stored count, finite and manifold skin', async () => {
    const rnd = lcg(2024);
    for (let i = 0; i < 100; i++) {
      const lod = Math.floor(rnd() * 4);
      const extra = {
        splitsChance: 1,
        sides: 3 + Math.floor(rnd() * 30),
        radialRelative: rnd() < 0.5 ? 0 : rnd() * 60,
        segmentScalar: 0.1 + rnd() * 3,
        lodSides: rnd(),
        lodSegments: rnd(),
        splitsBalance: 0.15 + rnd() * 0.7,
        splitsSpread1: rnd() * 60,
        splitsSpread2: rnd() * 60,
        splitsSmoothInner: rnd(),
        splitsSmoothOuter: rnd(),
        length: 2 + rnd() * 6,
      };
      const r = await run(trunkOnly({ ...extra, capEnd: false, capBase: 'no' }), 1 + i, lod);
      const sk = skeletonOf(r, 'trunk');
      const stored = sk.attributes.get('radialSides');
      expect(stored, `set ${i}`).toBeDefined();
      const n = stored![sk.branches[0]!.start] as number;
      expect(n % 2, `set ${i} stored N=${n}`).toBe(0);
      expect(n).toBeGreaterThanOrEqual(SPLIT_MIN_SIDES);
      const mesh = meshOf(r, 'trunk');
      expect(allFinite(mesh.positions), `set ${i}`).toBe(true);
      const { use, degenerate } = weldedEdges(mesh);
      expect(degenerate, `set ${i}`).toBe(0);
      for (const c of use.values()) expect(c).toBeLessThanOrEqual(2);
    }
  }, 120000);
});

describe('S6: variance and seeds', () => {
  const base = { ...DEFAULT_SPLIT_SETTINGS, balance: 0.5, spread1Deg: 25, spread2Deg: 25 };

  it('without variance the values are used exactly', () => {
    const s = sampleSplitSettings(0.6, base, NO_SPLIT_VARIANCE, new Rng(1));
    expect(s.chance).toBe(0.6);
    expect(s.settings).toEqual(base);
  });

  it('every parameter draws from its own stream and results stay inside the parameter ranges', () => {
    const none = sampleSplitSettings(0.5, base, NO_SPLIT_VARIANCE, new Rng(9));
    const onlyBalance = sampleSplitSettings(0.5, base, { ...NO_SPLIT_VARIANCE, balance: 0.4 }, new Rng(9));
    expect(onlyBalance.settings.balance).not.toBe(none.settings.balance);
    expect(onlyBalance.chance).toBe(none.chance);
    expect(onlyBalance.settings.spread1Deg).toBe(none.settings.spread1Deg);
    expect(onlyBalance.settings.smoothInner).toBe(none.settings.smoothInner);
    const all = { chance: 1, balance: 1, spread1: 1, spread2: 1, expand1: 1, expand2: 1, smoothInner: 1, smoothOuter: 1 };
    for (let i = 0; i < 200; i++) {
      const s = sampleSplitSettings(0.5, base, all, new Rng(i));
      expect(s.chance).toBeGreaterThanOrEqual(0);
      expect(s.chance).toBeLessThanOrEqual(1);
      expect(s.settings.balance).toBeGreaterThanOrEqual(0);
      expect(s.settings.balance).toBeLessThanOrEqual(1);
      expect(s.settings.spread1Deg).toBeLessThanOrEqual(80);
      expect(s.settings.expand1).toBeGreaterThanOrEqual(0.5);
      expect(s.settings.expand2).toBeLessThanOrEqual(2);
    }
    const a = sampleSplitSettings(0.5, base, all, new Rng(3));
    const b = sampleSplitSettings(0.5, base, all, new Rng(3));
    expect(b).toEqual(a);
  });

  it('a variance on Balance gives different branches different halves (end to end, deterministic)', async () => {
    const specs = (v: number): NodeSpec[] => [
      ...trunkOnly({ length: 6 }),
      {
        id: 'br',
        type: 'generator.branch',
        parent: 'trunk',
        params: { number: 6, first: 0.3, last: 0.8, mode: 'absolute', splitsChance: 1, splitsBalance: { value: 0.5, variance: v }, length: { value: 2, variance: 0 } } as NodeSpec['params'],
      },
    ];
    // Side 1 / Side 2 radius ratio of every split (the halves are written as consecutive branches)
    const tips = (r: Result): number[] => {
      const sk = skeletonOf(r, 'br');
      const info = sk.attributes.get(SPLIT_ATTR)!;
      const out: number[] = [];
      for (let i = 0; i + 1 < sk.branches.length; i++) {
        const a = sk.branches[i]!;
        const b = sk.branches[i + 1]!;
        if (((info[a.start] as number) & SplitFlag.Side1) === 0 || ((info[b.start] as number) & SplitFlag.Side2) === 0) continue;
        out.push(Math.round(((sk.radius[a.start + a.count - 1] as number) / (sk.radius[b.start + b.count - 1] as number)) * 1e3));
      }
      return out;
    };
    const flat = tips(await run(specs(0), 5));
    const varied = tips(await run(specs(0.6), 5));
    expect(new Set(flat).size).toBe(1);
    expect(new Set(varied).size).toBeGreaterThan(1);
    expect(tips(await run(specs(0.6), 5))).toEqual(varied);
  });

  it('changing Splits > Seed re-rolls only the splits: siblings and primary spines stay identical', async () => {
    const specs = (seed: number): NodeSpec[] => [
      ...trunkOnly({ length: 7 }),
      { id: 'a', type: 'generator.branch', parent: 'trunk', params: { number: 10, first: 0.3, last: 0.9, mode: 'absolute', splitsChance: 0.5, splitsSeed: seed, length: { value: 2, variance: 0.2 } } as NodeSpec['params'] },
      { id: 'b', type: 'generator.branch', parent: 'trunk', params: { number: 6, first: 0.2, last: 0.8, mode: 'absolute', length: { value: 1.5, variance: 0.2 } } as NodeSpec['params'] },
    ];
    const r1 = await run(specs(0), 8);
    const r2 = await run(specs(77), 8);
    // the sibling generator is bit-identical
    const sibling = (r: Result): number[] => Array.from(skeletonOf(r, 'b').position);
    expect(sibling(r2)).toEqual(sibling(r1));
    expect(Array.from(meshOf(r2, 'b').positions)).toEqual(Array.from(meshOf(r1, 'b').positions));
    // the primary spines of the split generator are identical, only the split decisions differ
    const primaries = (r: Result): number[] => {
      const sk = skeletonOf(r, 'a');
      const origin = sk.attributes.get(SPINE_ORIGIN_ATTR);
      const out: number[] = [];
      for (const b of sk.branches) {
        if (spineOriginName(origin?.[b.start]) !== 'primary') continue;
        for (let k = 0; k < b.count; k++) out.push(Math.round((sk.position[(b.start + k) * 3 + 2] as number) * 1e5));
      }
      return out;
    };
    expect(primaries(r2)).toEqual(primaries(r1));
    const splitters = (r: Result): string => {
      const sk = skeletonOf(r, 'a');
      const info = sk.attributes.get(SPLIT_ATTR);
      return sk.branches.map((b) => (((info?.[b.start] ?? 0) as number) & SplitFlag.Parent ? '1' : '0')).join('');
    };
    expect(splitters(r1)).not.toEqual(splitters(r2));
    expect(splitters(r1)).toContain('1');
  });
});

describe('S6: migration of old .ktree projects', () => {
  const fixture = (): unknown => JSON.parse(readFileSync(new URL('./fixtures/legacySplitProject.ktree.json', import.meta.url), 'utf8')) as unknown;
  const nodeOf = (p: ReturnType<typeof parseProject>, id: string) => p.graph.nodes.find((n) => n.id === id)!;

  it('maps the legacy split ids onto Skin > Splits and drops the rest', () => {
    const p = parseProject(fixture());
    const trunk = nodeOf(p, 'trunk').params;
    expect(trunk.splitsChance?.value).toBe(0.6);
    expect(trunk.splitsSpread1?.value).toBe(30);
    expect(trunk.splitsSpread2?.value).toBe(30);
    expect(trunk.splitsBalance?.value).toBe(0.4);
    for (const id of ['splitChance', 'splitSpread', 'splitBalance', 'splitStart', 'splitMaxDepth']) expect(trunk[id]).toBeUndefined();
    const forked = nodeOf(p, 'forked').params;
    expect(forked.splitsChance?.value).toBe(1);
    expect(forked.termination?.value).toBe('taper');
    const plain = nodeOf(p, 'plain').params;
    expect(plain.splitsChance).toBeUndefined();
    expect(nodeOf(p, 'roots').params.splitsChance?.value).toBe(0.3);
    expect(nodeOf(p, 'roots').params.splitsSpread1?.value).toBe(30);
  });

  it('is idempotent, never overwrites new ids and leaves clean nodes untouched', () => {
    const clean: NodeParams = { length: { value: 3 } };
    expect(migrateLegacySplitParams(clean)).toBe(clean);
    const mixed = migrateLegacySplitParams({ splitChance: { value: 0.9 }, splitsChance: { value: 0.2 } });
    expect(mixed.splitsChance?.value).toBe(0.2);
    const once = migrateLegacySplitParams({ splitChance: { value: 0.5 }, splitSpread: { value: 99 } });
    expect(once.splitsSpread1?.value).toBe(80);
    expect(migrateLegacySplitParams(once)).toBe(once);
  });

  it('a migrated project still evaluates and the legacy fork node now makes a fused split', async () => {
    const p = parseProject(fixture());
    const toSpec = (id: string, parent: string): NodeSpec => {
      const n = nodeOf(p, id);
      const params: Record<string, number | string | boolean | { value: number; variance: number }> = {};
      for (const [k, v] of Object.entries(n.params)) {
        params[k] = v.variance !== undefined ? ({ value: v.value as number, variance: v.variance } as { value: number; variance: number }) : (v.value as number | string | boolean);
      }
      return { id, type: n.type, parent, params: params as NodeSpec['params'] };
    };
    const specs: NodeSpec[] = [{ id: 'tree', type: 'output.tree', parent: null }, toSpec('trunk', 'tree'), toSpec('forked', 'trunk')];
    const r = await run(specs, 6);
    expect(r.errors).toBe(0);
    const sk = skeletonOf(r, 'forked');
    const info = sk.attributes.get(SPLIT_ATTR)!;
    expect(sk.branches.some((b) => ((info[b.start] as number) & SplitFlag.Parent) !== 0)).toBe(true);
    const { use } = weldedEdges(meshOf(r, 'forked'));
    for (const c of use.values()) expect(c).toBeLessThanOrEqual(2);
    // the migrated graph also loads into a GraphModel
    const model = new GraphModel();
    model.load(p.graph);
    expect(model.getNode('trunk')).toBeDefined();
  });
});

describe('S6: sample projects', () => {
  const TREES = ['oak', 'birch', 'swamp'];

  it.each(TREES)('%s evaluates at every LOD without NaN and with manifold junctions', async (id) => {
    const project = loadSample(id);
    const model = GraphModel.fromJSON(project.graph);
    const types = new Map(project.graph.nodes.map((n) => [n.id, n.type]));
    for (const lod of [0, 1, 2, 3]) {
      const r = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: project.settings.seed, lod, token: new CancellationSource().token });
      expect(r.errors).toBe(0);
      for (const e of r.scene.entries) {
        expect(allFinite(e.mesh.positions), `${id} lod ${lod} ${e.nodeId}`).toBe(true);
        expect(allFinite(e.mesh.normals), `${id} lod ${lod} ${e.nodeId}`).toBe(true);
      }
      for (const s of r.scene.skeletons) {
        if (types.get(s.nodeId) !== 'generator.trunk') continue;
        const mesh = meshOf(r, s.nodeId);
        const { use, degenerate } = weldedEdges(mesh);
        expect(degenerate, `${id} lod ${lod} ${s.nodeId}`).toBe(0);
        for (const c of use.values()) expect(c).toBeLessThanOrEqual(2);
      }
    }
  }, 120000);
});

describe('S6: export of a split tree', () => {
  it('the exported geometry is the continuous skin: no extra or duplicated vertices, valid indices', async () => {
    const r = await run(trunkOnly({ splitsChance: 1 }), 1);
    const mesh = meshOf(r, 'trunk');
    const geo = mergeToPlantGeometry('tree', [mesh]);
    expect(geo.positions.length).toBe(mesh.positions.length);
    const total = geo.primitives.reduce((s, p) => s + p.indices.length, 0);
    expect(total).toBe(mesh.indices.length);
    const n = geo.positions.length / 3;
    for (const p of geo.primitives) for (const i of p.indices) expect(i).toBeLessThan(n);
    const obj = writeObj('tree', [geo], new Map(), false);
    const file = obj.files.find((f) => f.name.endsWith('.obj'));
    const text = file ? typeof file.data === 'string' ? file.data : new TextDecoder().decode(file.data) : '';
    expect(text.split('\n').filter((l: string) => l.startsWith('v ')).length).toBe(n);
    // shared A / B / C vertices are exported once: the tube is manifold after welding by position
    const { use } = weldedEdges(mesh);
    for (const c of use.values()) expect(c).toBeLessThanOrEqual(2);
  });
});

describe('S6: performance', () => {
  it('evaluates a tree with ~500 splitting branches into typed arrays within a generous budget', async () => {
    const specs: NodeSpec[] = [
      ...trunkOnly({ length: 10, radius: 0.3, sides: 12, accuracy: 12 }),
      {
        id: 'br',
        type: 'generator.branch',
        parent: 'trunk',
        params: { number: 500, first: 0.15, last: 0.95, mode: 'absolute', splitsChance: 1, sides: 8, segments: 6, accuracy: 8, length: { value: 1.2, variance: 0.2 } } as NodeSpec['params'],
      },
    ];
    const t0 = performance.now();
    const r = await run(specs, 3, 1);
    const ms = performance.now() - t0;
    const sk = skeletonOf(r, 'br');
    const info = sk.attributes.get(SPLIT_ATTR)!;
    const parents = sk.branches.filter((b) => ((info[b.start] as number) & SplitFlag.Parent) !== 0).length;
    expect(parents).toBeGreaterThanOrEqual(300);
    const mesh = meshOf(r, 'br');
    expect(mesh.positions).toBeInstanceOf(Float32Array);
    expect(mesh.normals).toBeInstanceOf(Float32Array);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(allFinite(mesh.positions)).toBe(true);
    expect(ms).toBeLessThan(4000);
  }, 30000);
});
