import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import {
  DEFAULT_SPLIT_SETTINGS,
  INCLUDED_BARK_AO,
  SPLIT_ATTR,
  SplitFlag,
  decideSplitMode,
  dominantSplit,
  planSplit,
  resolveSplitSettings,
  sampleSplitSettings,
  valleyAoFactor,
  type SplitPlan,
  type SplitPlanInput,
  type SplitSettings,
} from '@/generators/split';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { defaultParamState } from '@/contracts/params';
import { readSplitConfig } from '@/nodes/generators/splitConfig';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const DEG = Math.PI / 180;
const angle = (a: readonly number[], b: readonly number[]): number => {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  return Math.acos(Math.min(1, Math.max(-1, d / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!)))));
};

const input = (settings: Partial<SplitSettings> = {}, over: Partial<SplitPlanInput> = {}): SplitPlanInput => ({
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
const plan = (settings: Partial<SplitSettings> = {}, over: Partial<SplitPlanInput> = {}): SplitPlan => {
  const p = planSplit(input(settings, over));
  if (!p) throw new Error('no split');
  return p;
};
const fatOf = (p: SplitPlan) => (p.lobes[0].kind === 'fat' ? p.lobes[0] : p.lobes[1]);
const skinnyOf = (p: SplitPlan) => (p.lobes[0].kind === 'fat' ? p.lobes[1] : p.lobes[0]);
const finite = (a: ArrayLike<number>): boolean => Array.from(a).every(Number.isFinite);

describe('T10: dominant leader', () => {
  it('dominance 0 is exactly the former plan (all new parameters neutral)', () => {
    const base = plan();
    const explicit = plan({ dominance: 0, mode: 'y', lateralChance: 0, includedBark: 0 });
    expect(explicit.mode).toBe('y');
    for (let i = 0; i < 2; i++) {
      expect(Array.from(explicit.lobes[i]!.positions)).toEqual(Array.from(base.lobes[i]!.positions));
      expect(explicit.lobes[i]!.radius).toBe(base.lobes[i]!.radius);
      expect(explicit.lobes[i]!.angle).toBe(base.lobes[i]!.angle);
    }
    expect(explicit.settings).toEqual(input({ dominance: 0, mode: 'y', lateralChance: 0, includedBark: 0 }).settings);
  });

  it('the deviation of the fat half decreases monotonically with the dominance', () => {
    for (const balance of [0.5, 0.65, 0.9]) {
      let prev = Infinity;
      for (let k = 0; k <= 10; k++) {
        const fat = fatOf(plan({ balance, dominance: k / 10 })).angle;
        expect(fat).toBeLessThanOrEqual(prev + 1e-9);
        prev = fat;
      }
    }
  });

  it('at full dominance the fat half keeps <= 25 % of its Spread and the skinny half leaves at its full Spread', () => {
    const p = plan({ balance: 0.5, dominance: 1, spread1Deg: 24, spread2Deg: 30 });
    const fat = fatOf(p);
    const skinny = skinnyOf(p);
    expect(fat.angle).toBeLessThanOrEqual(0.25 * 24 * DEG + 1e-9);
    expect(skinny.angle).toBeCloseTo(30 * DEG, 6);
    expect(skinny.radius).toBeLessThan(0.45 * 0.12);
    expect(angle(fat.endTangent, [0, 0, 1])).toBeLessThan(angle(skinny.endTangent, [0, 0, 1]) / 3);
  });

  it('keeps the pipe model r1^e + r2^e = R^e for several exponents and dominances', () => {
    for (const e of [1.8, 2, 2.4]) {
      for (const dominance of [0, 0.4, 1]) {
        const p = plan({ areaExponent: e, dominance, balance: 0.6 });
        expect(p.lobes[0].radius ** e + p.lobes[1].radius ** e).toBeCloseTo(0.12 ** e, 9);
      }
    }
  });

  it('both Extend parent targets stay assigned (one fat, one skinny open end)', () => {
    const p = plan({ dominance: 1 });
    expect(p.openEnds.map((o) => o.kind).sort()).toEqual(['fat', 'skinny']);
    expect(p.openEnds.map((o) => o.side).sort()).toEqual([1, 2]);
    expect(fatOf(p).openEnd.radius).toBeGreaterThan(skinnyOf(p).openEnd.radius);
  });

  it('dominantSplit is pure and returns the balance it used', () => {
    const a = dominantSplit(0.5, 22 * DEG, 22 * DEG, 0.5, 2);
    const b = dominantSplit(0.5, 22 * DEG, 22 * DEG, 0.5, 2);
    expect(a).toEqual(b);
    expect(a.balance).toBeGreaterThan(0.5);
    expect(dominantSplit(0.5, 22 * DEG, 22 * DEG, 0, 2).balance).toBe(0.5);
  });
});

describe('T10: lateral fork', () => {
  it('the fat half stays within a slight kink of the parent direction and a clearly thinner branch leaves at the Spread angle', () => {
    const p = plan({ mode: 'lateral', spread1Deg: 25, spread2Deg: 35 });
    expect(p.mode).toBe('lateral');
    const fat = fatOf(p);
    const skinny = skinnyOf(p);
    expect(angle(fat.endTangent, [0, 0, 1])).toBeLessThan(6 * DEG);
    expect(skinny.angle).toBeCloseTo(35 * DEG, 6);
    expect(skinny.radius).toBeLessThan(0.4 * 0.12);
    expect(fat.radius ** 2 + skinny.radius ** 2).toBeCloseTo(0.12 ** 2, 9);
  });

  it('applies swell, ridge and valley fillet of the junction unless the user set larger values (idempotent)', () => {
    const r = resolveSplitSettings(DEFAULT_SPLIT_SETTINGS, 'lateral');
    expect(r.neckSwell).toBeGreaterThan(0);
    expect(r.ridge).toBeGreaterThan(0);
    expect(r.valleyRadius).toBeGreaterThan(0);
    expect(resolveSplitSettings(r, 'lateral')).toEqual(r);
    expect(resolveSplitSettings({ ...DEFAULT_SPLIT_SETTINGS, ridge: 0.6 }, 'lateral').ridge).toBe(0.6);
    expect(resolveSplitSettings(DEFAULT_SPLIT_SETTINGS, 'y')).toBe(DEFAULT_SPLIT_SETTINGS);
    expect(plan({ mode: 'lateral' }).settings.neckSwell).toBeGreaterThan(0);
  });

  it('lateral chance mixes Y and lateral forks, obeys the seed and is deterministic', () => {
    const modes = (chance: number, seedOffset = 0): string[] =>
      Array.from({ length: 60 }, (_, i) => decideSplitMode(new Rng(i + seedOffset).fork('splits0'), { mode: 'y', lateralChance: chance }));
    expect(new Set(modes(0)).size).toBe(1);
    expect(modes(0)[0]).toBe('y');
    expect(new Set(modes(1))).toEqual(new Set(['lateral']));
    const mixed = modes(0.5);
    expect(mixed.filter((m) => m === 'lateral').length).toBeGreaterThan(15);
    expect(mixed.filter((m) => m === 'y').length).toBeGreaterThan(15);
    expect(modes(0.5)).toEqual(mixed);
    expect(modes(0.5, 1000)).not.toEqual(mixed);
    expect(decideSplitMode(new Rng(3), { mode: 'lateral', lateralChance: 0 })).toBe('lateral');
  });

  it('variance of the new parameters is drawn from their own streams', () => {
    const settings: SplitSettings = { ...DEFAULT_SPLIT_SETTINGS, dominance: 0.5, lateralChance: 0.5, includedBark: 0.5 };
    const rng = new Rng(11).fork('splits0');
    const flat = sampleSplitSettings(1, settings, { chance: 0, balance: 0, spread1: 0, spread2: 0, expand1: 0, expand2: 0, smoothInner: 0, smoothOuter: 0 }, rng);
    expect(flat.settings.dominance).toBe(0.5);
    const varied = sampleSplitSettings(1, settings, { chance: 0, balance: 0, spread1: 0, spread2: 0, expand1: 0, expand2: 0, smoothInner: 0, smoothOuter: 0, dominance: 1, includedBark: 1 }, rng);
    expect(varied.settings.dominance).not.toBe(0.5);
    expect(varied.settings.includedBark).not.toBe(0.5);
    expect(varied.settings.lateralChance).toBe(0.5);
    expect(varied.settings.balance).toBe(flat.settings.balance);
    const again = sampleSplitSettings(1, settings, { chance: 0, balance: 0, spread1: 0, spread2: 0, expand1: 0, expand2: 0, smoothInner: 0, smoothOuter: 0, dominance: 1, includedBark: 1 }, rng);
    expect(again).toEqual(varied);
  });
});

describe('T10: included bark', () => {
  it('narrows the valley fillet, adds a ridge and a narrower neck; zero changes nothing', () => {
    const r = resolveSplitSettings({ ...DEFAULT_SPLIT_SETTINGS, valleyRadius: 0.6, includedBark: 1 }, 'y');
    expect(r.valleyRadius).toBeLessThanOrEqual(0.1);
    expect(r.valleyRadius).toBeGreaterThan(0);
    expect(r.ridge).toBeGreaterThan(0.3);
    expect(r.waist).toBeLessThan(0.8);
    expect(resolveSplitSettings(r, 'y')).toEqual(r);
    expect(resolveSplitSettings({ ...DEFAULT_SPLIT_SETTINGS, includedBark: 0 }, 'y').ridge).toBeUndefined();
  });

  it('the valley AO is darker and narrower with included bark and still exactly 1 at both ends', () => {
    expect(valleyAoFactor(0, 0.1, 0.5, 1)).toBeCloseTo(INCLUDED_BARK_AO, 6);
    expect(valleyAoFactor(0, 0.1, 0.5, 1)).toBeLessThan(valleyAoFactor(0, 0.1, 0.5, 0));
    expect(valleyAoFactor(0.1, 0.1, 0.5, 1)).toBeGreaterThan(valleyAoFactor(0.1, 0.1, 0.5, 0));
    expect(valleyAoFactor(0, 0.1, 0, 1)).toBe(1);
    expect(valleyAoFactor(0, 0.1, 1, 1)).toBeCloseTo(1, 12);
    expect(valleyAoFactor(0, 0.1, 0.5)).toBe(valleyAoFactor(0, 0.1, 0.5, 0));
  });
});

describe('T10: robustness (spread 0, gravity, down bias)', () => {
  it('Spread 0 gives finite, non-degenerate lobes in every mode', () => {
    for (const mode of ['y', 'lateral'] as const) {
      for (const dominance of [0, 1]) {
        const p = plan({ mode, dominance, spread1Deg: 0, spread2Deg: 0, includedBark: 0.5 });
        for (const lobe of p.lobes) {
          expect(finite(lobe.positions)).toBe(true);
          expect(finite(lobe.radii)).toBe(true);
          expect(Number.isFinite(lobe.angle)).toBe(true);
          expect(lobe.radius).toBeGreaterThan(0);
        }
      }
    }
  });

  it('down bias never lets a half point higher than its parent (S1 invariant) in the new modes', () => {
    const tangent: [number, number, number] = [0.6, 0, -0.8];
    const parentPhi = Math.acos(0.8);
    for (const mode of ['y', 'lateral'] as const) {
      for (const dominance of [0, 0.7, 1]) {
        for (const downBias of [0.2, 0.6, 1]) {
          const p = plan({ mode, dominance, downBias, spread1Deg: 60, spread2Deg: 60 }, { end: { position: [0, 0, 1], tangent, up: [0, 1, 0], radius: 0.1 } });
          for (const lobe of p.lobes) {
            expect(finite(lobe.positions)).toBe(true);
            expect(Math.acos(Math.min(1, Math.max(-1, -lobe.endTangent[2])))).toBeLessThanOrEqual(parentPhi + 1e-6);
          }
        }
      }
    }
  });

  it('sweeping the parameters never gives NaN', () => {
    for (let i = 0; i < 40; i++) {
      const f = (k: number): number => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
      const u = (k: number): number => Math.abs(f(k));
      const p = plan(
        { mode: u(1) > 0.5 ? 'lateral' : 'y', dominance: u(2), balance: u(3), spread1Deg: 80 * u(4), spread2Deg: 80 * u(5), includedBark: u(6), downBias: u(7), areaExponent: 1.5 + 1.5 * u(8) },
        { rng: new Rng(i).fork('splits0') },
      );
      for (const lobe of p.lobes) {
        expect(finite(lobe.positions)).toBe(true);
        expect(finite(lobe.radii)).toBe(true);
      }
    }
  });
});

describe('T10: node parameters and pipeline', () => {
  it('new parameters exist on Trunk, Branch and Root with neutral defaults and tooltips', () => {
    for (const type of ['generator.trunk', 'generator.branch', 'generator.root']) {
      const defs = getNodeDef(type)!.params;
      for (const id of ['splitsMode', 'splitsDominance', 'splitsLateralChance', 'splitsIncludedBark']) {
        const def = defs.find((d) => d.id === id);
        expect(def, `${type}.${id}`).toBeDefined();
        expect(def!.tooltip ?? '').not.toBe('');
      }
      const params = Object.fromEntries(defs.map((d) => [d.id, defaultParamState(d)]));
      const cfg = readSplitConfig(params);
      expect(cfg.settings.mode).toBe('y');
      expect(cfg.settings.dominance).toBe(0);
      expect(cfg.settings.lateralChance).toBe(0);
      expect(cfg.settings.includedBark).toBe(0);
    }
  });

  const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
  const run = async (extra: Record<string, unknown>, seed = 1) => {
    const specs: NodeSpec[] = [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, splitsChance: 1, ...extra } as NodeSpec['params'] },
      { id: 'ext', type: 'generator.branch', parent: 'trunk', params: { ...STRAIGHT, number: 1, extendParent: 'any', extendCount: 1, knockout: 1 } as NodeSpec['params'] },
    ];
    const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
    const mesh: MeshData = r.scene.entries.find((e) => e.nodeId === 'trunk')?.mesh ?? emptyMeshData();
    const sk: Skeleton = r.scene.skeletons.find((s) => s.nodeId === 'trunk')?.skeleton ?? emptySkeleton();
    return { mesh, sk };
  };
  const edges = (mesh: MeshData): { open: number; over: number; degenerate: number } => {
    const key = (i: number): string => `${Math.round(mesh.positions[i * 3]! * 1e5)},${Math.round(mesh.positions[i * 3 + 1]! * 1e5)},${Math.round(mesh.positions[i * 3 + 2]! * 1e5)}`;
    const ids = new Map<string, number>();
    const id = (i: number): number => {
      const k = key(i);
      if (!ids.has(k)) ids.set(k, ids.size);
      return ids.get(k)!;
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
    let open = 0;
    let over = 0;
    for (const n of use.values()) {
      if (n === 1) open++;
      if (n > 2) over++;
    }
    return { open, over, degenerate };
  };

  it('default forks are unchanged by the explicit neutral values (old projects)', async () => {
    const a = await run({});
    const b = await run({ splitsMode: 'y', splitsDominance: 0, splitsLateralChance: 0, splitsIncludedBark: 0 });
    expect(Array.from(b.mesh.positions)).toEqual(Array.from(a.mesh.positions));
  });

  it('lateral, dominant and included-bark forks are watertight (same open boundary as the plain fork) and deterministic', async () => {
    const plain = edges((await run({})).mesh);
    for (const extra of [
      { splitsMode: 'lateral' },
      { splitsDominance: 1 },
      { splitsIncludedBark: 1 },
      { splitsMode: 'lateral', splitsIncludedBark: 0.6, splitsDominance: 0.5, splitsDownBias: 0.5 },
      { splitsLateralChance: 1 },
      { splitsMode: 'lateral', splitsSpread1: 0, splitsSpread2: 0 },
    ]) {
      const one = await run(extra, 3);
      const two = await run(extra, 3);
      expect(Array.from(one.mesh.positions)).toEqual(Array.from(two.mesh.positions));
      expect(finite(one.mesh.positions)).toBe(true);
      expect(finite(one.mesh.normals)).toBe(true);
      const e = edges(one.mesh);
      expect(e.degenerate, JSON.stringify(extra)).toBe(0);
      expect(e.over, JSON.stringify(extra)).toBe(0);
      expect(e.open, JSON.stringify(extra)).toBeLessThanOrEqual(plain.open + 0);
    }
  });

  it('the fork writes Fat / Skinny split flags in every mode and changes the shape', async () => {
    const plain = await run({});
    const lateral = await run({ splitsMode: 'lateral' });
    const flags = lateral.sk.attributes.get(SPLIT_ATTR)!;
    const sides = lateral.sk.branches.map((b) => flags[b.start] as number);
    expect(sides.filter((f) => (f & SplitFlag.Fat) !== 0)).toHaveLength(1);
    expect(sides.filter((f) => (f & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0)).toHaveLength(2);
    expect(Array.from(lateral.mesh.positions)).not.toEqual(Array.from(plain.mesh.positions));
    const bark = await run({ splitsIncludedBark: 1 });
    const ao = bark.mesh.ao;
    expect(ao && Math.min(...ao)).toBeLessThan(0.5);
  });

  it('works under gravity and a crown envelope on a branch that splits', async () => {
    const specs: NodeSpec[] = [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT } as NodeSpec['params'] },
      {
        id: 'br',
        type: 'generator.branch',
        parent: 'trunk',
        params: { number: 6, gravity: 0.8, spread: 0, crownShape: 'conical', splitsChance: 1, splitsMode: 'lateral', splitsDominance: 1, splitsIncludedBark: 0.5, splitsDownBias: 0.5 } as NodeSpec['params'],
      },
    ];
    const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 5, lod: 0, token: new CancellationSource().token });
    const mesh = r.scene.entries.find((e) => e.nodeId === 'br')?.mesh ?? emptyMeshData();
    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(finite(mesh.positions)).toBe(true);
    expect(finite(mesh.normals)).toBe(true);
    expect(edges(mesh).degenerate).toBe(0);
  });
});
