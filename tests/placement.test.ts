import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { Rng } from '@/core/rng';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import {
  computeInstances,
  DEFAULT_PLACEMENT,
  DISTRIBUTION_MODES,
  type DistributionMode,
  type DistributionOptions,
} from '@/nodes/generators/placement';
import { getSliderBounds } from '@/ui/components/params/valueOps';
import { getNodeDef } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const opts = (mode: DistributionMode, count: number, extra: Partial<DistributionOptions> = {}): DistributionOptions => ({
  mode,
  count,
  position: 0.49,
  positionVar: 0.59,
  rotation: 0.4,
  rotationVar: 0.15,
  sweep: 1,
  jumble: 0.2,
  roll: 0,
  minDistance: 1,
  sink: 0.425,
  sinkVar: 0,
  splayDeg: 0,
  ...extra,
});
const disc = { ...DEFAULT_PLACEMENT, radius: 10 };

describe('computeInstances', () => {
  it.each(DISTRIBUTION_MODES)('%s: every instance lies inside the disc, no NaN', (mode) => {
    const set = computeInstances(disc, opts(mode, 300), new Rng(7));
    expect(set.count).toBeGreaterThan(0);
    for (let i = 0; i < set.count; i++) {
      const x = set.position[i * 3] as number;
      const y = set.position[i * 3 + 1] as number;
      expect(Number.isFinite(x + y + (set.yaw[i] as number))).toBe(true);
      expect(Math.hypot(x, y)).toBeLessThanOrEqual(10 + 1e-3);
      expect(set.position[i * 3 + 2]).toBeCloseTo(-0.425, 4);
    }
  });

  it.each(['parametric', 'uniform', 'poisson', 'spiral'] as const)('%s: raising the count does not reshuffle existing instances', (mode) => {
    const a = computeInstances(disc, opts(mode, 10, { jumble: 0 }), new Rng(3));
    const b = computeInstances(disc, opts(mode, 60, { jumble: 0 }), new Rng(3));
    if (mode === 'spiral') return; // radius depends on i / n by design
    for (let i = 0; i < Math.min(a.count, 10); i++) {
      expect(b.position[i * 3]).toBeCloseTo(a.position[i * 3] as number, 5);
      expect(b.position[i * 3 + 1]).toBeCloseTo(a.position[i * 3 + 1] as number, 5);
    }
  });

  it('changing only the radius scales the pattern uniformly (stable ordering)', () => {
    const a = computeInstances({ ...disc, radius: 10 }, opts('uniform', 50), new Rng(5));
    const b = computeInstances({ ...disc, radius: 20 }, opts('uniform', 50), new Rng(5));
    for (let i = 0; i < 50; i++) {
      expect(b.position[i * 3] as number).toBeCloseTo((a.position[i * 3] as number) * 2, 3);
      expect(b.position[i * 3 + 1] as number).toBeCloseTo((a.position[i * 3 + 1] as number) * 2, 3);
    }
  });

  it('uniform mode is area-correct (r = R*sqrt(u))', () => {
    const set = computeInstances(disc, opts('uniform', 4000, { jumble: 0 }), new Rng(11));
    let inner = 0;
    for (let i = 0; i < set.count; i++) if ((set.radial[i] as number) < 0.5) inner++;
    expect(inner / set.count).toBeGreaterThan(0.22);
    expect(inner / set.count).toBeLessThan(0.28);
  });

  it('poisson disk honours the minimum distance', () => {
    const set = computeInstances(disc, opts('poisson', 120, { minDistance: 1.2 }), new Rng(2));
    expect(set.count).toBeGreaterThan(60);
    for (let i = 0; i < set.count; i++) {
      for (let j = i + 1; j < set.count; j++) {
        const d = Math.hypot((set.position[i * 3] as number) - (set.position[j * 3] as number), (set.position[i * 3 + 1] as number) - (set.position[j * 3 + 1] as number));
        expect(d).toBeGreaterThanOrEqual(1.2 - 1e-3);
      }
    }
  });

  it('parametric: Position is the normalised radius, Rotation the normalised angle', () => {
    const set = computeInstances(disc, opts('parametric', 1, { position: 0.5, positionVar: 0, rotation: 0.25, rotationVar: 0, jumble: 0 }), new Rng(1));
    expect(Math.hypot(set.position[0] as number, set.position[1] as number)).toBeCloseTo(5, 3);
    expect(set.position[0] as number).toBeCloseTo(0, 3);
    expect(set.position[1] as number).toBeCloseTo(5, 3);
  });

  it('unify child orientation gives every child the same (zero) yaw and no splay', () => {
    const set = computeInstances({ ...disc, unify: true }, opts('uniform', 20, { splayDeg: 30 }), new Rng(1));
    expect(Array.from(set.tiltDeg).every((t) => t === 0)).toBe(true);
    expect(Array.from(set.yaw).every((t) => t === 0)).toBe(true);
  });
});

const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });

describe('instance counts (no hidden 24 cap)', () => {
  it.each([24, 100, 1000])('Trunk Number %i produces that many trunks', async (n) => {
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { number: n, spineOnly: true, segments: 4, accuracy: 8 } },
    ]);
    expect(r.diagnostics.get('trunk')?.branches).toBe(n);
  }, 60000);

  it.each([100, 1000])('Branch Number %i on one trunk produces that many branches', async (n) => {
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { spineOnly: true } },
      { id: 'br', type: 'generator.branch', parent: 'trunk', params: { number: n, first: 0, last: 1, spineOnly: true, segments: 3, accuracy: 8, pruneGround: false } },
    ]);
    expect(r.diagnostics.get('br')?.branches).toBe(n);
  }, 60000);

  it('Tree -> Spine (6) creates six spines without any tube geometry', async () => {
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 6 } },
    ]);
    expect(r.diagnostics.get('sp')?.branches).toBe(6);
    expect(r.diagnostics.get('sp')?.triangles).toBe(0);
  });

  it('1000 trunks are generated in under 1 s (meshing excluded)', async () => {
    const t0 = performance.now();
    const r = await run([
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { number: 1000, spineOnly: true, segments: 6, accuracy: 8, length: 1 } },
    ]);
    const ms = performance.now() - t0;
    expect(r.diagnostics.get('trunk')?.branches).toBe(1000);
    expect(ms).toBeLessThan(1000);
  }, 60000);

  it('trunks stay inside the Tree disc and follow its radius', async () => {
    const specs = (radius: number): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null, params: { radius } },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { number: 200, spineOnly: true, lean: 0, noiseAmount: 0, earlyNoiseAmount: 0, length: 1 } },
    ];
    const small = await run(specs(5));
    const big = await run(specs(15));
    const base = (res: Awaited<ReturnType<typeof run>>) => {
      const sk = res.scene.skeletons.find((s) => s.nodeId === 'trunk')?.skeleton;
      expect(sk).toBeDefined();
      return sk!.branches.map((b) => Math.hypot(sk!.position[b.start * 3] as number, sk!.position[b.start * 3 + 1] as number));
    };
    expect(Math.max(...base(small))).toBeLessThanOrEqual(5.001);
    expect(Math.max(...base(big))).toBeLessThanOrEqual(15.001);
    expect(Math.max(...base(big))).toBeGreaterThan(10);
  }, 60000);
});

describe('number slider range', () => {
  it('Number has a 0..100 soft range, a hard max >= 1000 and a performance warning threshold', () => {
    for (const type of ['generator.trunk', 'generator.branch', 'generator.spine', 'generator.leaf', 'generator.decoration']) {
      const def = getNodeDef(type)?.params.find((p) => p.id === 'number');
      expect(def?.kind).toBe('int');
      if (def?.kind !== 'int') continue;
      const b = getSliderBounds(def);
      expect(b.sliderMax).toBe(100);
      expect(b.hardMax).toBeGreaterThanOrEqual(1000);
      expect(def.warnAbove).toBeGreaterThan(100);
    }
  });
});
