import type { SideScale } from './frondRibs';

/**
 * Variance helpers of the Frond generator (pure; every random number comes from the caller's seeded stream).
 *  - Left-Right Variance: each half of a frond gets its own multipliers for Fold, Curl and Gravity.
 *  - Section Variance: every painted mesh section (Section [2..8] of the cutout editor) gets its own Gravity / Fold / Curl / Roll
 *    shift. Section 1 is the default (unpainted) section and keeps the whole-mesh values.
 */

/** Highest section id the cutout editor can paint. */
export const MAX_SECTION = 8;

/** Maps a uniform draw `r` in [0, 1) to [-1, 1]. `favorOutliers` pushes the values toward the extremes (away from the median). */
export function spreadDraw(r: number, favorOutliers: boolean): number {
  const x = Math.min(1, Math.max(0, r)) * 2 - 1;
  return favorOutliers ? Math.sign(x) * Math.sqrt(Math.abs(x)) : x;
}

export interface LeftRightSettings {
  /** 0..1: every multiplier is drawn from `1 - amount .. 1 + amount`. */
  amount: number;
}

export interface FrondSides {
  left: SideScale;
  right: SideScale;
}

/**
 * Independent multipliers of the left and right half (six draws, always consumed so other values never shift).
 * Amount 0 returns exact ones: both halves are identical.
 */
export function leftRightScales(settings: LeftRightSettings, next: () => number): FrondSides {
  const a = Math.min(1, Math.max(0, settings.amount));
  const draw = (): number => 1 + a * (next() * 2 - 1);
  const half = (): SideScale => ({ fold: draw(), curl: draw(), gravity: draw() });
  const left = half();
  const right = half();
  return { left, right };
}

export interface VarianceAxis {
  /** Magnitude of the random part. */
  amount: number;
  /** Constant shift of the section's value. */
  offset: number;
}

export interface SectionVarianceSettings {
  favorOutliers: boolean;
  gravity: VarianceAxis;
  /** Degrees. */
  fold: VarianceAxis;
  curl: VarianceAxis;
  roll: VarianceAxis;
}

export const NEUTRAL_SECTION_VARIANCE: Readonly<SectionVarianceSettings> = {
  favorOutliers: false,
  gravity: { amount: 0, offset: 0 },
  fold: { amount: 0, offset: 0 },
  curl: { amount: 0, offset: 0 },
  roll: { amount: 0, offset: 0 },
};

/** Added to the whole-mesh values of one section (gravity as in the parameter, fold / curl / roll in degrees). */
export interface SectionDelta {
  gravity: number;
  fold: number;
  curl: number;
  roll: number;
}

export function hasSectionVariance(s: SectionVarianceSettings): boolean {
  return [s.gravity, s.fold, s.curl, s.roll].some((a) => a.amount !== 0 || a.offset !== 0);
}

/**
 * Per-section shifts, indexed by section id (0 and 1 are null: they use the whole-mesh values). Draws are consumed for every
 * section in a fixed order, so painting one more section never reshuffles the others.
 */
export function sectionDeltas(s: SectionVarianceSettings, next: () => number): (SectionDelta | null)[] {
  const out: (SectionDelta | null)[] = [null, null];
  for (let id = 2; id <= MAX_SECTION; id++) {
    const pick = (a: VarianceAxis): number => a.offset + a.amount * spreadDraw(next(), s.favorOutliers);
    const gravity = pick(s.gravity);
    const fold = pick(s.fold);
    const curl = pick(s.curl);
    const roll = pick(s.roll);
    out.push({ gravity, fold, curl, roll });
  }
  return out;
}
