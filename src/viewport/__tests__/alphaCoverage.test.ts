import { describe, expect, it } from 'vitest';
import { alphaCoverage, buildCoverageMipChain, buildPlainMipChain, coverageScale, downsample, quantizeCutoff, type MipLevel } from '@/textures/alphaCoverage';

/** Synthetic leaf: soft-edged ellipse blade, a thin midrib gap and a few thin serration spikes (1-2 px features). */
function leafMask(size: number): MipLevel {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5;
      const v = (y + 0.5) / size - 0.5;
      const r = Math.hypot(u / 0.28, v / 0.45);
      let a = Math.min(1, Math.max(0, (1 - r) * 5));
      if (Math.abs(u) < 0.5 / size && Math.abs(v) < 0.4) a = Math.max(a, 0.9); // thin vein / petiole
      if ((x + y) % 11 === 0 && r < 1.4 && r > 1) a = Math.max(a, 0.8); // thin teeth
      const i = (y * size + x) * 4;
      data[i] = 40;
      data[i + 1] = Math.round(a * 255); // opacity map is read from the green channel
      data[i + 2] = 40;
      data[i + 3] = Math.round(a * 255);
    }
  }
  return { width: size, height: size, data };
}

describe('alpha coverage preserving mips', () => {
  const base = leafMask(128);
  const cutoff = 0.5;
  const target = alphaCoverage(base.data, 3, cutoff);

  it('reproduces the problem: plain box-filtered mips lose coverage', () => {
    const plain = buildPlainMipChain(base, 'a');
    const small = plain[4] as MipLevel; // 8x8
    expect(Math.abs(alphaCoverage(small.data, 3, cutoff) - target)).toBeGreaterThan(0.03);
  });

  it('keeps the level-0 coverage on every mip (remapped to a 0.5 threshold)', () => {
    const chain = buildCoverageMipChain(base, { channel: 'a', cutoff });
    expect(chain).toHaveLength(8); // 128 .. 1
    expect(chain[0]?.width).toBe(128);
    expect(chain[chain.length - 1]).toMatchObject({ width: 1, height: 1 });
    // Down to 8x8 (64 texels); smaller mips cannot represent the fraction at 1/64 granularity.
    chain.slice(0, 5).forEach((level) => {
      // 0.5 threshold on the remapped alpha == `cutoff` on the original: shadows and main pass agree.
      expect(Math.abs(alphaCoverage(level.data, 3, 0.5) - target)).toBeLessThan(0.02);
    });
  });

  it('works for the green (opacity map) channel and other cutoffs', () => {
    for (const c of [0.25, 0.4, 0.7]) {
      const t = alphaCoverage(base.data, 1, c);
      const chain = buildCoverageMipChain(base, { channel: 'g', cutoff: c });
      chain.slice(1, 5).forEach((level) => expect(Math.abs(alphaCoverage(level.data, 1, 0.5) - t)).toBeLessThan(0.025));
    }
  });

  it('does not touch the colour of fully opaque texels and weights colours by alpha', () => {
    const chain = buildCoverageMipChain(base, { channel: 'a', cutoff });
    const level1 = chain[1] as MipLevel;
    for (let i = 0; i < level1.data.length; i += 4) expect(level1.data[i]).toBe(40);
    // A transparent texel with a bright colour must not bleed into the average.
    const two: MipLevel = { width: 2, height: 1, data: new Uint8Array([0, 255, 0, 255, 255, 0, 0, 0]) };
    const d = downsample(two, 3);
    expect(d.data[0]).toBe(0);
    expect(d.data[1]).toBe(255);
  });

  it('is monotonic: a larger scale never reduces coverage', () => {
    const level = downsample(downsample(base, 3), 3);
    const s = coverageScale(level.data, 3, cutoff, target);
    expect(s).toBeGreaterThan(1);
    expect(coverageScale(level.data, 3, cutoff, 0)).toBe(1);
  });

  it('quantises the cutoff for stable cache keys', () => {
    expect(quantizeCutoff(0.5004)).toBe(0.5);
    expect(quantizeCutoff(-1)).toBe(0.01);
    expect(quantizeCutoff(7)).toBe(0.99);
  });

  it('handles non power-of-two and 1xN textures down to 1x1', () => {
    const odd: MipLevel = { width: 5, height: 3, data: new Uint8Array(5 * 3 * 4).fill(255) };
    const chain = buildCoverageMipChain(odd, { channel: 'a', cutoff: 0.5 });
    expect(chain.map((l) => `${l.width}x${l.height}`)).toEqual(['5x3', '2x1', '1x1']);
    const strip: MipLevel = { width: 1, height: 4, data: new Uint8Array(16).fill(200) };
    expect(buildCoverageMipChain(strip, { channel: 'g', cutoff: 0.5 }).map((l) => l.height)).toEqual([4, 2, 1]);
  });
});
