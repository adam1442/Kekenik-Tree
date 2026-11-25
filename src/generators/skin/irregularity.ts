import { createSimplex, type SimplexNoise } from '@/core/noise';

/**
 * Skin > Irregularity (pure). A slow, seeded wobble of the radius along a branch: swells and pinches with a second octave at
 * three times the frequency and 0.4 of the amplitude. The generators multiply the spine radius with it while the spine is grown,
 * so children, welds and the mesh all see the same (real) radius.
 */
export interface RadiusIrregularity {
  /** Fraction of the radius (RMS). 0 = off. */
  amount: number;
  /** Wavelength of the first octave in metres. */
  scale: number;
  seed: number;
}

export const NEUTRAL_IRREGULARITY: RadiusIrregularity = { amount: 0, scale: 1, seed: 1 };

/** The factor never drops below this, so a pinch cannot close the tube. */
export const MIN_IRREGULARITY_FACTOR = 0.4;

/** Second octave: frequency and amplitude relative to the first. */
const OCTAVE_FREQUENCY = 3;
const OCTAVE_AMPLITUDE = 0.4;
/** RMS of the raw two-octave sum, measured on many seeds (see tests/organicProfile.test.ts); makes `amount` the RMS roughness. */
const RAW_RMS = 0.4391;

export interface RadiusNoise {
  /** Unit-RMS field at arc length `s` (metres); `phase` shifts the field (per branch variation). */
  field(s: number, phase: number): number;
  /** Radius factor `1 + amount x field`, never below `MIN_IRREGULARITY_FACTOR`. */
  factor(s: number, phase: number, amount: number): number;
  readonly scale: number;
}

export function createRadiusNoise(scale: number, seed: number): RadiusNoise {
  const gen: SimplexNoise = createSimplex(Math.round(seed) * 7919 + 104729);
  const wavelength = Math.max(0.02, scale);
  const norm = 1 / (RAW_RMS * Math.sqrt(1 + OCTAVE_AMPLITUDE * OCTAVE_AMPLITUDE));
  const field = (s: number, phase: number): number => {
    const x = s / wavelength + phase;
    return (gen.noise3(x, 0.5, 1.3) + OCTAVE_AMPLITUDE * gen.noise3(x * OCTAVE_FREQUENCY, 4.1, 2.7)) * norm;
  };
  return {
    field,
    factor: (s, phase, amount) => (amount > 0 ? Math.max(MIN_IRREGULARITY_FACTOR, 1 + amount * field(s, phase)) : 1),
    scale: wavelength,
  };
}

/**
 * Fade for the irregularity near the end of a spine that splits: the halves take their radius from the tip, so the wobble dies out
 * over the last 15 % and the crotch keeps its clean geometry.
 */
export function irregularityEndFade(f: number, splits: boolean): number {
  if (!splits) return 1;
  const x = Math.min(1, Math.max(0, (1 - f) / 0.15));
  return x * x * (3 - 2 * x);
}
