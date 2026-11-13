/**
 * Alpha-coverage preserving mipmaps (pure, worker friendly).
 *
 * With plain box-filtered mips the fraction of texels above the alpha-test threshold shrinks level by level, so
 * distant cut-out foliage thins out and sparkles. Here every mip level gets its alpha rescaled so that exactly the
 * same fraction of texels passes the test as in level 0.
 *
 * The result is additionally remapped so that the user's cutoff lands on 0.5: shadow passes (three.js uses a fixed
 * 0.5 for alpha-to-coverage materials) then agree with the main pass.
 */

export interface MipLevel {
  width: number;
  height: number;
  /** RGBA, 8 bit, row 0 first. */
  data: Uint8Array;
}

/** `a` = alpha channel (colour map with transparency), `g` = green channel (three.js alphaMap / Opacity slot). */
export type CoverageChannel = 'a' | 'g';

export const channelIndex = (c: CoverageChannel): number => (c === 'a' ? 3 : 1);

/** Cutoff snapped to 1/100 so cached chains and pool keys stay few while a slider is dragged. */
export const quantizeCutoff = (c: number): number => Math.min(0.99, Math.max(0.01, Math.round(c * 100) / 100));

/** Fraction (0..1) of texels whose channel value is >= cutoff. */
export function alphaCoverage(data: ArrayLike<number>, channel: number, cutoff: number): number {
  const n = Math.floor(data.length / 4);
  if (n === 0) return 0;
  const t = cutoff * 255;
  let hit = 0;
  for (let i = 0; i < n; i++) if ((data[i * 4 + channel] as number) >= t) hit++;
  return hit / n;
}

/** 2x2 box filter. Odd sizes clamp at the border. Colours are alpha-weighted for the `a` channel (no dark fringes). */
export function downsample(src: MipLevel, channel: number): MipLevel {
  const w = Math.max(1, src.width >> 1);
  const h = Math.max(1, src.height >> 1);
  const out = new Uint8Array(w * h * 4);
  const weighted = channel === 3;
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.height - 1, y * 2);
    const y1 = Math.min(src.height - 1, y * 2 + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(src.width - 1, x * 2);
      const x1 = Math.min(src.width - 1, x * 2 + 1);
      const idx = [(y0 * src.width + x0) * 4, (y0 * src.width + x1) * 4, (y1 * src.width + x0) * 4, (y1 * src.width + x1) * 4];
      let a = 0;
      for (const i of idx) a += src.data[i + 3] as number;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        let wsum = 0;
        for (const i of idx) {
          const wt = weighted ? (src.data[i + 3] as number) : 1;
          sum += (src.data[i + c] as number) * wt;
          wsum += wt;
        }
        out[o + c] = wsum > 0 ? Math.round(sum / wsum) : Math.round(idx.reduce((s, i) => s + (src.data[i + c] as number), 0) / 4);
      }
      out[o + 3] = Math.round(a / 4);
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Smallest-error scale `s` such that the fraction of texels with `value * s >= cutoff` matches `target`
 * (coverage is monotonic in `s`, so a bisection over a 256 bin histogram is exact enough and O(256) per step).
 */
export function coverageScale(data: ArrayLike<number>, channel: number, cutoff: number, target: number): number {
  const n = Math.floor(data.length / 4);
  if (n === 0 || target <= 0) return 1;
  const hist = new Float64Array(256);
  for (let i = 0; i < n; i++) hist[data[i * 4 + channel] as number]++;
  const t = cutoff * 255;
  const cov = (s: number): number => {
    let hit = 0;
    for (let v = 0; v < 256; v++) if (v * s >= t) hit += hist[v] as number;
    return hit / n;
  };
  let lo = 0.05;
  let hi = 32;
  if (cov(hi) < target) return hi;
  if (cov(lo) >= target) return lo;
  for (let i = 0; i < 28; i++) {
    const mid = Math.sqrt(lo * hi);
    if (cov(mid) >= target) hi = mid;
    else lo = mid;
  }
  return target - cov(lo) < cov(hi) - target ? lo : hi;
}

function scaleChannel(level: MipLevel, channel: number, factor: number): MipLevel {
  const data = new Uint8Array(level.data);
  if (factor !== 1) for (let i = channel; i < data.length; i += 4) data[i] = Math.min(255, Math.round((data[i] as number) * factor));
  return { width: level.width, height: level.height, data };
}

export interface CoverageOptions {
  channel: CoverageChannel;
  /** Alpha-test threshold (0..1) the coverage is preserved for. */
  cutoff: number;
}

/**
 * Full mip chain (level 0 .. 1x1) whose alpha channel keeps the level-0 coverage at `cutoff`, remapped so the cutoff
 * becomes 0.5 (use `alphaTest = 0.5` with these textures).
 */
export function buildCoverageMipChain(base: MipLevel, opts: CoverageOptions): MipLevel[] {
  const ch = channelIndex(opts.channel);
  const cutoff = quantizeCutoff(opts.cutoff);
  const target = alphaCoverage(base.data, ch, cutoff);
  const remap = 0.5 / cutoff;
  const chain: MipLevel[] = [scaleChannel(base, ch, remap)];
  let cur = base;
  while (cur.width > 1 || cur.height > 1) {
    cur = downsample(cur, ch);
    chain.push(scaleChannel(cur, ch, coverageScale(cur.data, ch, cutoff, target) * remap));
  }
  return chain;
}

/** Plain (un-corrected) chain for comparisons / tests. */
export function buildPlainMipChain(base: MipLevel, channel: CoverageChannel): MipLevel[] {
  const ch = channelIndex(channel);
  const chain: MipLevel[] = [base];
  let cur = base;
  while (cur.width > 1 || cur.height > 1) {
    cur = downsample(cur, ch);
    chain.push(cur);
  }
  return chain;
}

/** Which channel of an Opacity image carries the cut-out mask. */
export type OpacityChannel = 'r' | 'g' | 'b' | 'a';

const CH: Record<OpacityChannel, number> = { r: 0, g: 1, b: 2, a: 3 };

interface ChannelStats {
  min: number;
  max: number;
}

function channelStats(data: ArrayLike<number>, c: number): ChannelStats {
  let min = 255;
  let max = 0;
  const n = Math.floor(data.length / 4);
  for (let i = 0; i < n; i++) {
    const v = data[i * 4 + c] as number;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/**
 * Pick the channel of an Opacity image that holds the mask. three.js `alphaMap` always reads green, so an image that
 * stores its mask in alpha (white-on-transparent PNG, or a colour leaf used as Opacity) would otherwise look empty or
 * solid. Rules: alpha wins when it varies and the RGB channels are flat or coloured (not a grey mask); otherwise green.
 */
export function detectOpacityChannel(data: ArrayLike<number>): OpacityChannel {
  const a = channelStats(data, 3);
  const alphaVaries = a.min < 128 && a.max > 128;
  if (!alphaVaries) return 'g';
  const g = channelStats(data, 1);
  if (g.max - g.min < 24) return 'a';
  // Grey mask (R == G == B everywhere): the mask is in the colour channels, alpha is just padding.
  const n = Math.floor(data.length / 4);
  let grey = 0;
  const step = Math.max(1, Math.floor(n / 4096));
  let seen = 0;
  for (let i = 0; i < n; i += step) {
    seen++;
    if (Math.abs((data[i * 4] as number) - (data[i * 4 + 1] as number)) < 6 && Math.abs((data[i * 4 + 1] as number) - (data[i * 4 + 2] as number)) < 6) grey++;
  }
  return grey / Math.max(1, seen) > 0.98 ? 'g' : 'a';
}

/** Rewrite `data` (RGBA, in place) so the chosen channel sits in R = G = B and alpha is 1: a clean linear mask. */
export function extractOpacityChannel(data: Uint8Array | Uint8ClampedArray, channel: OpacityChannel): void {
  const c = CH[channel];
  const n = Math.floor(data.length / 4);
  for (let i = 0; i < n; i++) {
    const v = data[i * 4 + c] as number;
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
}

/**
 * Edge padding / colour bleed: texels with (almost) no alpha get the colour of the nearest opaque neighbour, so bilinear
 * filtering and mips never blend black (or white) fringes into the leaf edge. `iterations` rings are filled.
 * Alpha is not touched. Works in place.
 */
export function bleedColorUnderAlpha(data: Uint8Array | Uint8ClampedArray, width: number, height: number, iterations = 8, minAlpha = 8): void {
  const filled = new Uint8Array(width * height);
  for (let i = 0; i < filled.length; i++) filled[i] = (data[i * 4 + 3] as number) >= minAlpha ? 1 : 0;
  for (let it = 0; it < iterations; it++) {
    const next = filled.slice();
    let changed = false;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (filled[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
            const j = ny * width + nx;
            if (!filled[j]) continue;
            r += data[j * 4] as number;
            g += data[j * 4 + 1] as number;
            b += data[j * 4 + 2] as number;
            k++;
          }
        }
        if (k > 0) {
          data[i * 4] = Math.round(r / k);
          data[i * 4 + 1] = Math.round(g / k);
          data[i * 4 + 2] = Math.round(b / k);
          next[i] = 1;
          changed = true;
        }
      }
    }
    filled.set(next);
    if (!changed) break;
  }
}
