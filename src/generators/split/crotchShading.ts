/**
 * Shading / mapping helpers of a split junction (pure): light seam reduction around the crotch, the U mapping of each half and the
 * material blend ramp of an extension. The seam and ramp maths are the existing ones (`skin/seam`, `weld/blend`), not copies.
 */
import { seamWeight } from '@/generators/skin/seam';
import { weldBlendValue } from '@/generators/weld/blend';

/** Light seam reduction at a split crotch when Skin > Radius > Light seam reduction is 0 (the junction always gets a mild one). */
export const CROTCH_SEAM_BASE = 0.25;
/** Falloff of the crotch seam reduction, in parent radii (the weight is 1/e of its peak at this distance). */
export const CROTCH_SEAM_RADII = 1.5;

const smooth01 = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Amount of the crotch seam reduction for the skin's own `Light seam reduction` value. */
export function crotchSeamAmount(seam: number | undefined): number {
  const s = Number.isFinite(seam) ? (seam as number) : 0;
  return Math.min(1, Math.max(CROTCH_SEAM_BASE, s));
}

/**
 * Weight 0..1 of the normal bend toward the axis at distance `distance` (metres, either side of the crotch start) from the start of
 * the transition. Falls off over `CROTCH_SEAM_RADII` parent radii; `arcEnd > 0` fades it to exactly 0 at the open ends so the
 * extension that continues them starts from the plain cylinder normal.
 */
export function crotchSeamWeight(distance: number, parentRadius: number, amount: number, arcEnd = 0): number {
  // Same amount rule as the skin's Light seam reduction (`seamWeight` at s = 0); the falloff is a Gaussian so the weight has zero
  // slope at the start of the transition and the normals of the two rings straddling it stay continuous.
  const peak = seamWeight(0, 1, amount);
  const d = Math.max(0, distance) / Math.max(1e-6, CROTCH_SEAM_RADII * parentRadius);
  const base = peak * Math.exp(-d * d);
  if (!(arcEnd > 0)) return base;
  return base * (1 - smooth01(distance / arcEnd));
}

export interface HalfMapping {
  /** U tiles around one half (half of the parent's, which is even). */
  uTiles: number;
  /** U offset of the half's first ring vertex (tiles). */
  uStart: number;
}

/**
 * U mapping of one half of a split. Outline column `j` of the crotch keeps the parent's U of vertex `j + phase`, so lobe 1 (columns
 * 0 .. N / 2) begins at `phase / N` of the parent's tiles and lobe 2 (columns N / 2 .. N) half a parent further. Returns null when the
 * parent's tile count is odd or below 2 (locked / patched mappings: the extension keeps its own mapping).
 */
export function splitHalfMapping(parentTiles: number, parentOffset: number, phase: number, sides: number, lobe: 1 | 2): HalfMapping | null {
  const t = Math.round(parentTiles);
  if (!(t >= 2) || t % 2 !== 0 || Math.abs(parentTiles - t) > 1e-6 || sides < 2) return null;
  const start = parentOffset + (phase / sides) * t + (lobe === 2 ? t / 2 : 0);
  return { uTiles: t / 2, uStart: start };
}

/**
 * Junction blend of an extension at arc length `s` of its branch (`s0` = first ring): 0 = parent material at the first ring, 1 = the
 * extension's own material after `length` parent radii (smooth, monotonic).
 */
export function extensionBlendValue(s: number, s0: number, parentRadius: number, length: number): number {
  return weldBlendValue(s, s0, s0, Math.max(1e-9, parentRadius), Math.max(0.01, length));
}

/** Darkest AO factor of a valley with included bark 1, and how much its width shrinks (T10). */
export const INCLUDED_BARK_AO = 0.22;
export const INCLUDED_BARK_AO_NARROW = 0.45;

/** Darkest AO factor in the valley of a fork at full strength (1 = no darkening). */
export const CROTCH_VALLEY_AO = 0.55;

/**
 * Ambient-occlusion factor (1 = open, lower = darker) of a crotch vertex: darkest at the pinch axis (the valley between the lobes)
 * and falling off with the outline distance `distance` over `width` (a Gaussian). `t` is the position along the transition: the
 * factor is exactly 1 at both ends so the parent and the extensions that continue the open ends keep their own AO.
 */
export function valleyAoFactor(distance: number, width: number, t: number, includedBark = 0): number {
  const x = Math.min(1, Math.max(0, t));
  const ends = Math.sin(Math.PI * x);
  const ib = Math.min(1, Math.max(0, includedBark));
  // Included bark (T10): a darker, narrower crevice.
  const d = Math.max(0, distance) / Math.max(1e-9, width * (1 - INCLUDED_BARK_AO_NARROW * ib));
  const darkest = CROTCH_VALLEY_AO + (INCLUDED_BARK_AO - CROTCH_VALLEY_AO) * ib;
  return 1 - (1 - darkest) * ends * Math.exp(-d * d);
}
