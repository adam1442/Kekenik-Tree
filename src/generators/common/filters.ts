import { evaluateCurve, type Curve } from '@/contracts/curve';
import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';

/**
 * Boundary range used by Clip: First..Last shrunk by `inset` (a fraction of the First..Last stretch, 0 = exact boundaries).
 */
export function clipRange(first: number, last: number, inset: number): { min: number; max: number } {
  const lo = Math.min(first, last);
  const hi = Math.max(first, last);
  const margin = clamp(inset, 0, 0.49) * (hi - lo);
  return { min: lo + margin, max: hi - margin };
}

/** True when a node sits outside the clip range (a tiny tolerance keeps nodes that sit exactly on a boundary). */
export function isOutsideClip(t: number, min: number, max: number): boolean {
  return t < min - 1e-9 || t > max + 1e-9;
}

/** Position of a node on the First..Last stretch: 0 = at First, 1 = at Last. */
export function normalizedAlong(u: number, first: number, last: number): number {
  const span = last - first;
  return span > 1e-6 ? clamp((u - first) / span, 0, 1) : 0.5;
}

/** Pruning: the curve runs from First (left) to Last (right); a node is removed where the curve is below 0.5. */
export function pruningKeeps(curve: Curve | null | undefined, along: number): boolean {
  if (!curve) return true;
  return evaluateCurve(curve, clamp(along, 0, 1)) >= 0.5;
}

/**
 * Probability that Knockout removes a node: Amount (scaled by the parent curve) plus `resolution` for every level of
 * detail above the highest (negative values remove fewer nodes at lower detail).
 */
export function knockoutChance(amount: number, resolution: number, lod: number, curveFactor = 1): number {
  return clamp((amount + resolution * Math.max(0, lod)) * curveFactor, 0, 1);
}

/** Random removal; always consumes exactly one number of `rng` so the stream does not depend on the chance. */
export function knockedOut(rng: Rng, chance: number): boolean {
  const draw = rng.next();
  return chance > 0 && draw < chance;
}
