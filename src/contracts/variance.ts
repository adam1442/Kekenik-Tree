/**
 * Variance model of the "+/-" parameter button (SpeedTree style): how strongly a value is randomised per instance
 * (`amount`), with which statistics (`distribution`) and how much neighbouring instances agree (`cohesion`, `scale`, `offset`).
 */

export type VarianceDistribution = 'uniform' | 'gaussian';

export interface VarianceSpec {
  /** Spread as a fraction of the parameter's span (0 = off). */
  amount: number;
  distribution: VarianceDistribution;
  /** 0 = every instance random, 1 = fully driven by smooth noise over its position on the parent. */
  cohesion: number;
  /** Noise frequency along the parent (0 = broad waves, 1 = tight). */
  scale: number;
  /** Shifts the noise pattern (0..1). */
  offset: number;
}

/**
 * Stored form: a plain number (uniform, no cohesion - the classic format) or an object listing the amount and only the
 * fields that differ from `VARIANCE_DEFAULTS`.
 */
export type VarianceValue = number | ({ amount: number } & Partial<Omit<VarianceSpec, 'amount'>>);

export const VARIANCE_DEFAULTS: Readonly<Omit<VarianceSpec, 'amount'>> = { distribution: 'uniform', cohesion: 0, scale: 0.25, offset: 0 };

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** Fill every field of a stored variance (number, partial object or nothing). Allocates: do not call per instance. */
export function resolveVariance(v: VarianceValue | undefined): VarianceSpec {
  if (typeof v === 'number') return { amount: Number.isFinite(v) ? v : 0, ...VARIANCE_DEFAULTS };
  if (!v) return { amount: 0, ...VARIANCE_DEFAULTS };
  return {
    amount: Number.isFinite(v.amount) ? v.amount : 0,
    distribution: v.distribution === 'gaussian' ? 'gaussian' : 'uniform',
    cohesion: clamp01(v.cohesion ?? VARIANCE_DEFAULTS.cohesion),
    scale: clamp01(v.scale ?? VARIANCE_DEFAULTS.scale),
    offset: clamp01(v.offset ?? VARIANCE_DEFAULTS.offset),
  };
}

/** Smallest stored form of a spec: a number when it is uniform without cohesion, else an object with non-default fields only. */
export function compactVariance(spec: VarianceSpec): VarianceValue {
  const out: { amount: number } & Partial<Omit<VarianceSpec, 'amount'>> = { amount: spec.amount };
  if (spec.distribution !== VARIANCE_DEFAULTS.distribution) out.distribution = spec.distribution;
  if (spec.cohesion > 0) {
    out.cohesion = spec.cohesion;
    if (spec.scale !== VARIANCE_DEFAULTS.scale) out.scale = spec.scale;
    if (spec.offset !== VARIANCE_DEFAULTS.offset) out.offset = spec.offset;
  }
  return Object.keys(out).length === 1 ? out.amount : out;
}

/** The amount of a stored variance (0 when absent). */
export function varianceAmount(v: VarianceValue | undefined): number {
  const a = typeof v === 'number' ? v : v?.amount;
  return typeof a === 'number' && Number.isFinite(a) ? a : 0;
}

/** Same variance with another amount (keeps distribution / cohesion). */
export function withVarianceAmount(v: VarianceValue | undefined, amount: number): VarianceValue {
  return compactVariance({ ...resolveVariance(v), amount });
}

/** True when the variance changes the result (amount above the noise floor). */
export function isVarianceActive(v: VarianceValue | undefined): boolean {
  return varianceAmount(v) > 1e-5;
}

/** True when two stored variances describe the same randomness (a number equals its object form). */
export function sameVariance(a: VarianceValue | undefined, b: VarianceValue | undefined): boolean {
  const x = resolveVariance(a);
  const y = resolveVariance(b);
  return Math.abs(x.amount - y.amount) < 1e-6 && x.distribution === y.distribution && x.cohesion === y.cohesion && x.scale === y.scale && x.offset === y.offset;
}
