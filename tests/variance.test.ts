import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { compactVariance, isVarianceActive, resolveVariance, sameVariance, varianceAmount, type VarianceSpec } from '@/contracts/variance';
import { hasActiveVariance } from '@/contracts/params';
import { Rng } from '@/core/rng';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { atSite, cohesionNoise, gaussianUnit, sampleVariance, varianceUnit } from '@/graph/engine/seeds';
import { registerDiscoveredNodes } from '@/graph/registry';
import { migrateParamVariance, migrateVariance } from '@/app/project/varianceMigration';
import { previewHistogram, previewStrip } from '@/ui/components/params/variancePreview';
import { setMaterialSource } from '@/materials/materialSource';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';
import { REFERENCE_GRAPHS } from './helpers/referenceGraphs';
import { hashContent } from './helpers/varianceAudit';

beforeAll(() => registerDiscoveredNodes());

const spec = (over: Partial<VarianceSpec> = {}): VarianceSpec => ({ amount: 1, distribution: 'uniform', cohesion: 0, scale: 0.25, offset: 0, ...over });
const std = (xs: number[]): number => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
};
const draws = (n: number, s: VarianceSpec): number[] => Array.from({ length: n }, (_, i) => varianceUnit(new Rng(7).fork(i).next(), s));
const correlation = (xs: number[]): number => {
  const a = xs.slice(0, -1);
  const b = xs.slice(1);
  const ma = a.reduce((p, q) => p + q, 0) / a.length;
  const mb = b.reduce((p, q) => p + q, 0) / b.length;
  let num = 0;
  let da = 0;
  let db = 0;
  a.forEach((v, i) => {
    num += (v - ma) * ((b[i] as number) - mb);
    da += (v - ma) ** 2;
    db += ((b[i] as number) - mb) ** 2;
  });
  return num / Math.sqrt(da * db);
};

describe('variance model', () => {
  it('a number is the classic uniform form and round-trips compactly', () => {
    expect(resolveVariance(0.25)).toEqual(spec({ amount: 0.25 }));
    expect(compactVariance(spec({ amount: 0.25 }))).toBe(0.25);
    expect(compactVariance(spec({ amount: 0.25, distribution: 'gaussian' }))).toEqual({ amount: 0.25, distribution: 'gaussian' });
    expect(compactVariance(spec({ cohesion: 0.5, scale: 0.9 }))).toEqual({ amount: 1, cohesion: 0.5, scale: 0.9 });
    expect(sameVariance(0.3, { amount: 0.3 })).toBe(true);
    expect(varianceAmount({ amount: 0.4, cohesion: 1 })).toBe(0.4);
    expect(isVarianceActive(0)).toBe(false);
  });

  it('uniform + no cohesion reproduces the classic sample exactly (old projects stay identical)', () => {
    for (const seed of [1, 2, 3]) {
      const classic = 10 + (new Rng(seed).next() * 2 - 1) * 0.3 * 10;
      expect(sampleVariance(new Rng(seed), 10, 0.3)).toBe(classic);
      expect(sampleVariance(new Rng(seed), 10, { amount: 0.3 })).toBe(classic);
    }
  });

  it('consumes exactly one random number for every form', () => {
    for (const v of [0, 0.4, { amount: 0.4, distribution: 'gaussian' as const }, { amount: 0.4, cohesion: 1 }]) {
      const rng = new Rng(5);
      sampleVariance(rng, 3, v);
      const reference = new Rng(5);
      reference.next();
      expect(rng.next()).toBe(reference.next());
    }
  });

  it('gaussian clusters closer to the mean than uniform and stays within +/-1', () => {
    const g = draws(4000, spec({ distribution: 'gaussian' }));
    const u = draws(4000, spec());
    expect(std(g) / std(u)).toBeLessThan(0.7);
    expect(Math.max(...g.map(Math.abs))).toBeLessThanOrEqual(1);
    expect(gaussianUnit(0.123)).toBe(gaussianUnit(0.123));
  });

  it('cohesion makes neighbours alike, deterministically', () => {
    const along = (cohesion: number, offset = 0): number[] =>
      Array.from({ length: 60 }, (_, i) => {
        const site = atSite(new Rng(9).fork(i), i / 59, 0, 77);
        return varianceUnit(site.next(), spec({ cohesion, scale: 0.2, offset }), site);
      });
    expect(correlation(along(1))).toBeGreaterThan(0.5);
    expect(correlation(along(0))).toBeLessThan(0.5);
    expect(along(1)).toEqual(along(1));
    expect(along(1, 0.5)).not.toEqual(along(1, 0));
    expect(cohesionNoise(1, 0.5, 0, 0.2, 0)).not.toBe(cohesionNoise(2, 0.5, 0, 0.2, 0));
  });

  it('the stream of one (node, parameter) pair does not depend on other parameters', () => {
    const site = (key: string): number => sampleVariance(atSite(new Rng(3).fork('child'), 0.4, 1, 9).fork(key), 5, { amount: 0.5, cohesion: 0.5 });
    const a = site('len');
    site('rad');
    site('spread');
    expect(site('len')).toBe(a);
    expect(site('rad')).not.toBe(a);
  });

  it('preview uses the engine sampler', () => {
    expect(previewStrip(spec())).toHaveLength(23);
    expect(previewStrip(spec({ cohesion: 1, scale: 0 }))).toEqual(previewStrip(spec({ cohesion: 1, scale: 0 })));
    expect(Math.max(...previewHistogram(spec({ distribution: 'gaussian' })))).toBe(1);
  });
});

describe('variance migration', () => {
  it('keeps numbers, compacts objects, drops garbage', () => {
    expect(migrateVariance(0.2)).toBe(0.2);
    expect(migrateVariance({ amount: 0.2, distribution: 'bogus', cohesion: 7 })).toEqual({ amount: 0.2, cohesion: 1 });
    expect(migrateVariance('x')).toBeUndefined();
    expect(migrateVariance(Number.NaN)).toBe(0);
    const params = { a: { value: 1, variance: 0.1 }, b: { value: 2, variance: { amount: 0.3, cohesion: 9 } }, c: { value: 3 } };
    const out = migrateParamVariance(params);
    expect(out.a).toBe(params.a);
    expect(out.b?.variance).toEqual({ amount: 0.3, cohesion: 1 });
    expect(migrateParamVariance({ a: params.a })).toEqual({ a: params.a });
    expect(hasActiveVariance(params)).toBe(true);
    expect(hasActiveVariance({ c: params.c })).toBe(false);
  });
});

describe('old project golden', () => {
  it('the oak reference graph (numeric variance) evaluates to the hash recorded before the variance model changed', async () => {
    setMaterialSource(null);
    const model = buildGraph(REFERENCE_GRAPHS.oak_broadleaf as NodeSpec[]);
    const result = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: 1337, lod: 0, token: new CancellationSource().token });
    expect(hashContent(result.scene).hex()).toBe('773074b87e256cc6');
  }, 120000);
});
