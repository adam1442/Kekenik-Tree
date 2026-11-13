import { describe, expect, it } from 'vitest';
import { RefinementState, TaaAccumulator, clampPixelRatio, describeAa, halton, jitterOffset, planAa, viewFingerprint } from '../quality/aaLogic';
import { DEFAULT_QUALITY, QUALITY_PRESETS, effectiveAlphaMode, sanitizeQuality, gridCellMeters } from '../quality/qualitySettings';

const ctx = { interactive: false, animating: false, maxSamples: 8 };

describe('planAa (AA mode switching)', () => {
  it('uses the requested MSAA + post AA at full quality', () => {
    expect(planAa({ msaaSamples: 4, postAA: 'smaa', progressive: true }, ctx)).toEqual({ samples: 4, post: 'smaa' });
    expect(planAa({ msaaSamples: 8, postAA: 'taa', progressive: true }, ctx)).toEqual({ samples: 8, post: 'taa' });
  });

  it('clamps MSAA to what the GPU supports', () => {
    expect(planAa({ msaaSamples: 8, postAA: 'none', progressive: true }, { ...ctx, maxSamples: 4 }).samples).toBe(4);
    expect(planAa({ msaaSamples: 8, postAA: 'none', progressive: true }, { ...ctx, maxSamples: 0 }).samples).toBe(0);
  });

  it('drops to a cheap level while interacting and refines afterwards', () => {
    const q = { msaaSamples: 8, postAA: 'taa', progressive: true } as const;
    expect(planAa(q, { ...ctx, interactive: true })).toEqual({ samples: 2, post: 'none' });
    expect(planAa(q, { ...ctx, interactive: false })).toEqual({ samples: 8, post: 'taa' });
  });

  it('keeps edges smooth with FXAA when MSAA is off and SMAA/TAA are too expensive', () => {
    expect(planAa({ msaaSamples: 0, postAA: 'smaa', progressive: true }, { ...ctx, interactive: true })).toEqual({ samples: 0, post: 'fxaa' });
    expect(planAa({ msaaSamples: 0, postAA: 'fxaa', progressive: true }, { ...ctx, interactive: true })).toEqual({ samples: 0, post: 'fxaa' });
  });

  it('ignores interaction when progressive refinement is disabled', () => {
    expect(planAa({ msaaSamples: 4, postAA: 'smaa', progressive: false }, { ...ctx, interactive: true })).toEqual({ samples: 4, post: 'smaa' });
  });

  it('cannot accumulate TAA while the content animates', () => {
    expect(planAa({ msaaSamples: 4, postAA: 'taa', progressive: true }, { ...ctx, animating: true })).toEqual({ samples: 4, post: 'none' });
    expect(planAa({ msaaSamples: 0, postAA: 'taa', progressive: true }, { ...ctx, animating: true })).toEqual({ samples: 0, post: 'fxaa' });
  });

  it('describes the active mode', () => {
    expect(describeAa({ samples: 4, post: 'smaa' }, 2)).toBe('MSAA 4x + SMAA @ 2.00x');
    expect(describeAa({ samples: 0, post: 'none' }, 1)).toBe('Off @ 1.00x');
  });

  it('every preset resolves to a valid plan', () => {
    for (const p of Object.values(QUALITY_PRESETS)) {
      const q = sanitizeQuality({ ...DEFAULT_QUALITY, ...p });
      const plan = planAa(q, ctx);
      expect(plan.samples).toBeLessThanOrEqual(8);
    }
  });
});

describe('RefinementState (progressive refinement)', () => {
  it('is interactive for 150 ms after the last touch, then refined', () => {
    const r = new RefinementState(150);
    expect(r.isInteractive(1000)).toBe(false);
    r.touch(1000);
    expect(r.isInteractive(1000)).toBe(true);
    expect(r.isInteractive(1149)).toBe(true);
    expect(r.isInteractive(1150)).toBe(false);
    expect(r.msUntilRefine(1100)).toBe(50);
    expect(r.msUntilRefine(2000)).toBe(0);
  });

  it('restarts the hold time on every new touch (slider drag)', () => {
    const r = new RefinementState(150);
    for (let t = 0; t < 1000; t += 50) r.touch(t);
    expect(r.isInteractive(1000)).toBe(true);
    expect(r.isInteractive(1100)).toBe(false);
  });
});

describe('TaaAccumulator', () => {
  it('uses running-average weights 1/(n+1) and finishes after `target` frames', () => {
    const a = new TaaAccumulator(4);
    const weights: number[] = [];
    while (!a.done) {
      weights.push(a.next().weight);
      a.commit();
    }
    expect(weights).toEqual([1, 1 / 2, 1 / 3, 1 / 4]);
    expect(a.count).toBe(4);
  });

  it('resets on any change', () => {
    const a = new TaaAccumulator(8);
    a.commit();
    a.commit();
    a.reset();
    expect(a.count).toBe(0);
    expect(a.next().weight).toBe(1);
  });

  it('jitters inside the pixel and never repeats within a cycle', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const [x, y] = jitterOffset(i);
      expect(Math.abs(x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(y)).toBeLessThanOrEqual(0.5);
      seen.add(`${x.toFixed(4)},${y.toFixed(4)}`);
    }
    expect(seen.size).toBe(16);
    expect(halton(1, 2)).toBe(0.5);
    expect(halton(3, 2)).toBe(0.75);
  });

  it('detects camera / size changes through the view fingerprint', () => {
    const m = new Array<number>(16).fill(0);
    const p = new Array<number>(16).fill(0);
    const a = viewFingerprint(m, p, 800, 600);
    expect(viewFingerprint(m, p, 800, 600)).toBe(a);
    m[12] = 0.001;
    expect(viewFingerprint(m, p, 800, 600)).not.toBe(a);
    expect(viewFingerprint(m, p, 801, 600)).not.toBe(viewFingerprint(m, p, 800, 600));
  });
});

describe('pixel ratio and settings', () => {
  it('clamps the device pixel ratio', () => {
    expect(clampPixelRatio(3, 2)).toBe(2);
    expect(clampPixelRatio(1.5, 2)).toBe(1.5);
    expect(clampPixelRatio(0, 2)).toBe(1);
  });

  it('sanitises persisted data', () => {
    const q = sanitizeQuality({ msaaSamples: 3, postAA: 'bogus', maxPixelRatio: 99, gridUnit: 'ft', taaFrames: 'x' });
    expect(q.msaaSamples).toBe(DEFAULT_QUALITY.msaaSamples);
    expect(q.postAA).toBe(DEFAULT_QUALITY.postAA);
    expect(q.maxPixelRatio).toBe(4);
    expect(q.gridUnit).toBe('ft');
    expect(q.taaFrames).toBe(DEFAULT_QUALITY.taaFrames);
    expect(sanitizeQuality(null)).toEqual(DEFAULT_QUALITY);
  });

  it('converts grid units to metres', () => {
    expect(gridCellMeters({ gridSize: 2, gridUnit: 'cm' })).toBeCloseTo(0.02);
    expect(gridCellMeters({ gridSize: 1, gridUnit: 'ft' })).toBeCloseTo(0.3048);
  });

  it('falls back from alpha-to-coverage to hashed alpha without MSAA', () => {
    expect(effectiveAlphaMode({ alphaMode: 'coverage', msaaSamples: 4 })).toBe('coverage');
    expect(effectiveAlphaMode({ alphaMode: 'coverage', msaaSamples: 0 })).toBe('hashed');
    expect(effectiveAlphaMode({ alphaMode: 'coverage', msaaSamples: 4 }, false)).toBe('hashed');
    expect(effectiveAlphaMode({ alphaMode: 'test', msaaSamples: 4 })).toBe('test');
  });
});
