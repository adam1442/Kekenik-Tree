const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Length (as a fraction of the spine) over which Early noise fades in once the Threshold is exceeded. */
export const EARLY_NOISE_RAMP = 0.08;

/**
 * Weight of the Early noise at `f` (0 = base, 1 = tip). Zero before the Threshold, then a smooth fade-in, multiplied by the
 * profile curve (which can switch the noise off again further along the spine). A Threshold of 0 keeps the noise on everywhere.
 */
export function earlyNoiseGate(f: number, threshold: number, profile = 1): number {
  const th = clamp01(threshold);
  const p = Math.max(0, profile);
  if (th <= 0) return p;
  const x = clamp01((f - th) / EARLY_NOISE_RAMP);
  return x * x * (3 - 2 * x) * p;
}

/** Half-width (in samples) of the box filter that Late noise Smooth applies to the noise offsets. */
export function lateSmoothRadius(smooth: number, count: number): number {
  return Math.round(clamp01(smooth) * Math.max(0, count - 1) * 0.25);
}

/**
 * Low-pass filters packed 2D noise offsets (`count` pairs) with a box filter whose width follows `smooth`. The caller scales the
 * result by `1 - smooth`, so `smooth = 1` removes the noise completely (straight spine) and values in between give fewer, broader waves.
 */
export function smoothNoiseOffsets(offsets: Float32Array, count: number, smooth: number): Float32Array {
  const r = lateSmoothRadius(smooth, count);
  if (r <= 0 || count < 3) return offsets;
  const out = new Float32Array(offsets.length);
  for (let c = 0; c < 2; c++) {
    const prefix = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) prefix[i + 1] = (prefix[i] as number) + (offsets[i * 2 + c] as number);
    for (let i = 0; i < count; i++) {
      const lo = Math.max(0, i - r);
      const hi = Math.min(count - 1, i + r);
      out[i * 2 + c] = ((prefix[hi + 1] as number) - (prefix[lo] as number)) / (hi - lo + 1);
    }
  }
  return out;
}
