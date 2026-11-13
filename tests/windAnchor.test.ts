import { describe, expect, it } from 'vitest';
import { SkeletonBuilder } from '@/contracts/skeleton';
import { attachSkeletonWind, markSkeletonWindStatic } from '@/geometry/windAttributes';
import { defaultWindParams, WIND_PARAM_RANGES, windParamsFromSettings } from '@/viewport/wind/windParams';
import { defaultWindSettings } from '@/contracts/material';
import { anchorWeight, windDisplacement, type WindVertex } from '@/viewport/wind/windReference';
import { WIND_GLSL_FUNCTION } from '@/viewport/wind/windShader';

const params = () => ({ ...defaultWindParams(), enabled: true, strength: 2, gustStrength: 0.6, turbulence: 0.5 });
const len = (d: number[]): number => Math.hypot(d[0] ?? 0, d[1] ?? 0, d[2] ?? 0);

describe('wind ground anchor', () => {
  it('has a Base hold parameter that round-trips through the settings', () => {
    expect(WIND_PARAM_RANGES.some((r) => r.key === 'baseHold')).toBe(true);
    expect(windParamsFromSettings(defaultWindSettings()).baseHold).toBeGreaterThan(0);
  });

  it('the GLSL contains the same anchor rule', () => {
    expect(WIND_GLSL_FUNCTION).toContain('smoothstep(0.0, hold, wp.z)');
    expect(WIND_GLSL_FUNCTION).toContain('if (anchor <= 0.0) return p;');
  });

  it('displacement is exactly 0 at the anchor for every time and gust setting', () => {
    for (const gust of [0, 0.5, 1]) {
      for (let t = 0; t < 40; t += 0.37) {
        const p = { ...params(), gustStrength: gust };
        const v: WindVertex = { position: [3, -2, 0], weights: [1, 1, 1, 0.3] };
        expect(len(windDisplacement(p, v, t, 12))).toBe(0);
        expect(len(windDisplacement(p, { ...v, position: [3, -2, -0.4] }, t, 12))).toBe(0);
      }
    }
  });

  it('is monotonic (non-decreasing) with height for a static wind', () => {
    const p = { ...params(), gustStrength: 0, damping: 1 };
    let prev = -1;
    for (let z = -0.5; z <= 3; z += 0.05) {
      const d = len(windDisplacement(p, { position: [0, 0, z], weights: [1, 0, 0, 0] }, 1.3, 10));
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = d;
    }
    expect(prev).toBeGreaterThan(0);
  });

  it('anchorWeight ramps smoothly from 0 to 1', () => {
    expect(anchorWeight(0, 0.6)).toBe(0);
    expect(anchorWeight(0.3, 0.6)).toBeCloseTo(0.5, 5);
    expect(anchorWeight(0.6, 0.6)).toBe(1);
    expect(anchorWeight(0.0001, 0)).toBe(0);
    expect(anchorWeight(1, 0)).toBe(1);
  });

  it('every trunk of a multi-trunk disc is anchored at its own base (height based, not world-origin based)', () => {
    const p = params();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const base: [number, number, number] = [Math.cos(a) * 6, Math.sin(a) * 6, 0];
      expect(len(windDisplacement(p, { position: base, weights: [0.4, 0, 0, 0] }, 2, 10))).toBe(0);
      const up: [number, number, number] = [base[0], base[1], 2];
      expect(len(windDisplacement(p, { position: up, weights: [0.4, 0, 0, 0] }, 2, 10))).toBeGreaterThan(0);
    }
  });

  it('roots carry all-zero wind channels (children inherit them)', () => {
    const b = new SkeletonBuilder();
    b.beginBranch(-1, -1, 0);
    for (let i = 0; i < 6; i++) b.addPoint(i * 0.3, 0, -i * 0.2, 0.05);
    b.endBranch();
    const sk = b.build();
    markSkeletonWindStatic(sk);
    attachSkeletonWind(sk, null, 3); // idempotent: must not overwrite the static marker
    for (const k of ['wind0', 'wind1', 'wind2']) expect(Math.max(...(sk.attributes.get(k) as Float32Array))).toBe(0);
  });
});
