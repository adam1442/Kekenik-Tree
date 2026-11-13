import { describe, expect, it } from 'vitest';
import { bleedColorUnderAlpha, detectOpacityChannel, extractOpacityChannel, type MipLevel } from '@/textures/alphaCoverage';
import { createDensityScene, measureCoverage, sweepThreshold } from './helpers/foliageDensity';

const solid = (n: number, fn: (i: number) => [number, number, number, number]): Uint8ClampedArray => {
  const d = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) d.set(fn(i), i * 4);
  return d;
};

describe('Opacity channel decoding', () => {
  it('green-stored grey mask -> green', () => {
    const d = solid(256, (i) => [i, i, i, 255]);
    expect(detectOpacityChannel(d)).toBe('g');
  });
  it('white-on-transparent PNG (mask in alpha) -> alpha, and extraction keeps full coverage', () => {
    const d = solid(256, (i) => [255, 255, 255, i < 128 ? 0 : 255]);
    expect(detectOpacityChannel(d)).toBe('a');
    extractOpacityChannel(d, 'a');
    let hit = 0;
    for (let i = 0; i < 256; i++) if ((d[i * 4 + 1] as number) > 127) hit++;
    expect(hit).toBe(128); // without the swizzle green would read 255 everywhere (solid card)
    expect(d[3]).toBe(255);
  });
  it('black RGB with alpha mask is not read as empty', () => {
    const d = solid(256, (i) => [0, 0, 0, i % 2 ? 255 : 0]);
    expect(detectOpacityChannel(d)).toBe('a');
  });
  it('coloured leaf used as opacity -> alpha', () => {
    const d = solid(256, (i) => [30 + (i % 7) * 20, 90 + (i % 5) * 30, 20, i < 100 ? 0 : 255]);
    expect(detectOpacityChannel(d)).toBe('a');
  });
  it('opaque image -> green', () => {
    expect(detectOpacityChannel(solid(64, () => [10, 200, 30, 255]))).toBe('g');
  });
});

describe('colour bleed under transparent texels', () => {
  it('fills transparent texels with the neighbouring colour and leaves alpha untouched', () => {
    const w = 8;
    const d = solid(w * w, (i) => ((i % w) < 4 ? [200, 120, 30, 255] : [0, 0, 0, 0]));
    bleedColorUnderAlpha(d, w, w, 8);
    for (let y = 0; y < w; y++) {
      for (let x = 4; x < w; x++) {
        const o = (y * w + x) * 4;
        expect(d[o]).toBe(200);
        expect(d[o + 3]).toBe(0);
      }
    }
  });
});

describe('Foliage density scene', () => {
  const scene = createDensityScene(256);
  const cutoffs = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  it('plain mips thin the crown with distance, coverage mips keep it within 10 %', () => {
    const plain = measureCoverage(scene, 0.5, false);
    const kept = measureCoverage(scene, 0.5, true);
    expect(Math.abs(kept.far - kept.near) / kept.near).toBeLessThan(0.1);
    expect(Math.abs(kept.mid - kept.near) / kept.near).toBeLessThan(0.1);
    expect(Math.abs(plain.far - plain.near) / plain.near).toBeGreaterThan(Math.abs(kept.far - kept.near) / kept.near);
  });

  it('far coverage stays near the near coverage for every threshold of the sweep', () => {
    for (const c of cutoffs) {
      const r = measureCoverage(scene, c, true);
      expect(r.near).toBeGreaterThan(0.02);
      expect(Math.abs(r.far - r.near) / r.near).toBeLessThan(0.12);
    }
  });

  it('Alpha Threshold only changes edge crispness: monotonic, smooth, never empties the crown', () => {
    const cov = sweepThreshold(scene, cutoffs);
    for (let i = 1; i < cov.length; i++) {
      expect(cov[i] as number).toBeLessThanOrEqual((cov[i - 1] as number) + 1e-9);
      expect((cov[i - 1] as number) - (cov[i] as number)).toBeLessThan(0.08);
    }
    expect(cov[cov.length - 1]).toBeGreaterThan(0.5 * (cov[0] as number));
  });

  it('the scene mask is a valid MipLevel', () => {
    const m: MipLevel = scene.mask;
    expect(m.data.length).toBe(m.width * m.height * 4);
  });
});
