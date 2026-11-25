import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { SplitSettings } from './splitMath';

/** Variance fractions (0..1, the "±" toggle) of the Skin > Splits parameters. 0 = the value is used as is. */
export interface SplitVariance {
  readonly chance: number;
  readonly balance: number;
  readonly spread1: number;
  readonly spread2: number;
  readonly expand1: number;
  readonly expand2: number;
  readonly smoothInner: number;
  readonly smoothOuter: number;
  /** T10 (optional: missing = 0). */
  readonly dominance?: number;
  readonly lateralChance?: number;
  readonly includedBark?: number;
}

export const NO_SPLIT_VARIANCE: SplitVariance = {
  chance: 0,
  balance: 0,
  spread1: 0,
  spread2: 0,
  expand1: 0,
  expand2: 0,
  smoothInner: 0,
  smoothOuter: 0,
};

/** One draw of a stream of its own; the draw is always made so the stream position never depends on the variance value. */
function jitter(rng: Rng, key: string, value: number, variance: number, span: number): number {
  const r = rng.fork(key).next() * 2 - 1;
  return variance > 0 ? value + r * variance * span : value;
}

export interface SampledSplit {
  readonly chance: number;
  readonly settings: SplitSettings;
}

/**
 * Applies the variances to Chance and the split settings of ONE branch. Every parameter draws from its own fork of `rng`
 * (`var:chance`, `var:balance`, ...), so adding a variance to one parameter never changes the value another one gets, and the
 * main split stream (`split`) is not touched. Results are clamped to the parameter ranges.
 * Chance, Balance and Smooth vary by +-variance in absolute units (0..1 ranges); Spread and Expand vary relative to their value.
 */
export function sampleSplitSettings(chance: number, settings: SplitSettings, variance: SplitVariance, rng: Rng): SampledSplit {
  return {
    chance: clamp(jitter(rng, 'var:chance', chance, variance.chance, 1), 0, 1),
    settings: {
      ...settings,
      balance: clamp(jitter(rng, 'var:balance', settings.balance, variance.balance, 1), 0, 1),
      spread1Deg: clamp(jitter(rng, 'var:spread1', settings.spread1Deg, variance.spread1, Math.abs(settings.spread1Deg)), 0, 80),
      spread2Deg: clamp(jitter(rng, 'var:spread2', settings.spread2Deg, variance.spread2, Math.abs(settings.spread2Deg)), 0, 80),
      expand1: clamp(jitter(rng, 'var:expand1', settings.expand1, variance.expand1, Math.abs(settings.expand1)), 0.5, 2),
      expand2: clamp(jitter(rng, 'var:expand2', settings.expand2, variance.expand2, Math.abs(settings.expand2)), 0.5, 2),
      smoothInner: clamp(jitter(rng, 'var:smoothInner', settings.smoothInner, variance.smoothInner, 1), 0, 1),
      smoothOuter: clamp(jitter(rng, 'var:smoothOuter', settings.smoothOuter, variance.smoothOuter, 1), 0, 1),
      ...(settings.dominance !== undefined ? { dominance: clamp(jitter(rng, 'var:dominance', settings.dominance, variance.dominance ?? 0, 1), 0, 1) } : {}),
      ...(settings.lateralChance !== undefined ? { lateralChance: clamp(jitter(rng, 'var:lateralChance', settings.lateralChance, variance.lateralChance ?? 0, 1), 0, 1) } : {}),
      ...(settings.includedBark !== undefined ? { includedBark: clamp(jitter(rng, 'var:includedBark', settings.includedBark, variance.includedBark ?? 0, 1), 0, 1) } : {}),
    },
  };
}
