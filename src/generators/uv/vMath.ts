import type { VAnchor, VStyle } from './types';

const TWO_PI = Math.PI * 2;
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

export interface VInput {
  style: VStyle;
  anchor: VAnchor;
  /** V Scale: tiles per metre factor (Absolute), density factor (aspect ratio) or tiles along the branch (Relative). */
  scale: number;
  /** 0..1, aspect-ratio style only. */
  skew: number;
  /** 0..1, aspect-ratio style only. */
  pinch: number;
  /** V Offset (already varied per branch). */
  offset: number;
  /** Tiles around the branch (aspect ratio keeps one V tile as long as one U tile is wide). */
  uTiles: number;
  metresPerTile: number;
  /** Arc length of every ring from the branch base (the first ring of a buried junction may be negative). */
  s: ArrayLike<number>;
  radius: ArrayLike<number>;
  /** Radius the U tile count was derived from (thickest ring). */
  refRadius: number;
}

/** Fraction of the reference radius below which the radius used for V density never drops (Pinch 0 = 2 %, 1 = 50 %). */
export const pinchFloor = (pinch: number): number => 0.02 + 0.48 * clamp01(pinch);

/**
 * Radius used to convert metres along the branch into V for the aspect-ratio style. Skew correction 0 keeps the
 * reference radius (texture follows the taper), 1 uses the local radius (texture keeps its proportions everywhere).
 * Never smaller than the Pinch floor, so V does not race away at a pointed tip.
 */
export function aspectRadius(local: number, ref: number, skew: number, pinch: number): number {
  const blended = ref + (local - ref) * clamp01(skew);
  return Math.max(blended, ref * pinchFloor(pinch), 1e-6);
}

/** Piecewise-linear V at arc length `at` (clamped to the ring range). */
export function atS(s: ArrayLike<number>, v: ArrayLike<number>, at: number): number {
  const n = s.length;
  if (n === 0) return 0;
  if (at <= (s[0] as number)) return v[0] as number;
  if (at >= (s[n - 1] as number)) return v[n - 1] as number;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((s[mid] as number) <= at) lo = mid;
    else hi = mid;
  }
  const span = (s[hi] as number) - (s[lo] as number);
  const f = span > 1e-12 ? (at - (s[lo] as number)) / span : 0;
  return (v[lo] as number) + ((v[hi] as number) - (v[lo] as number)) * f;
}

/** V per ring. Non-decreasing, 0 at the base of the branch (arc length 0) before Anchor / Offset are applied. */
export function computeRingV(i: VInput): Float64Array {
  const n = i.s.length;
  const v = new Float64Array(n);
  if (n === 0) return v;
  const metres = Math.max(1e-4, i.metresPerTile);
  const total = Math.max(1e-9, i.s[n - 1] as number);
  if (i.style === 'absolute') {
    for (let k = 0; k < n; k++) v[k] = ((i.s[k] as number) * i.scale) / metres;
  } else if (i.style === 'relative') {
    for (let k = 0; k < n; k++) v[k] = ((i.s[k] as number) / total) * i.scale;
  } else {
    const density = (k: number): number => (i.scale * i.uTiles) / (TWO_PI * aspectRadius(i.radius[k] as number, i.refRadius, i.skew, i.pinch));
    for (let k = 1; k < n; k++) {
      const ds = Math.max(0, (i.s[k] as number) - (i.s[k - 1] as number));
      v[k] = (v[k - 1] as number) + 0.5 * (density(k - 1) + density(k)) * ds;
    }
  }
  // V = 0 at the base of the branch (arc length 0), not at a buried junction ring below it.
  const zero = atS(i.s, v, Math.max(0, i.s[0] as number));
  const tip = (v[n - 1] as number) - zero;
  const shift = i.anchor === 'end' ? Math.ceil(tip - 1e-9) - tip - zero : -zero;
  for (let k = 0; k < n; k++) v[k] = (v[k] as number) + shift + i.offset;
  return v;
}

/**
 * Moves rings that lie within `tolerance` of a whole V number onto it (V Tolerance with Optimize segments). Only the
 * closest ring of every whole number moves, so no two rings end up on the same V and the order never changes.
 * Returns a new array.
 */
export function snapRingsToWhole(v: ArrayLike<number>, tolerance: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = v[k] as number;
  if (!(tolerance > 0)) return out;
  const best = new Map<number, number>();
  for (let k = 0; k < n; k++) {
    const whole = Math.round(v[k] as number);
    const d = Math.abs((v[k] as number) - whole);
    if (d > tolerance) continue;
    const prev = best.get(whole);
    if (prev === undefined || d < Math.abs((v[prev] as number) - whole)) best.set(whole, k);
  }
  for (const [whole, k] of best) {
    const below = k > 0 ? (out[k - 1] as number) : -Infinity;
    const above = k < n - 1 ? (v[k + 1] as number) : Infinity;
    if (whole >= below && whole <= above) out[k] = whole;
  }
  return out;
}
