import { clamp } from '@/core/math';
import type { KnotSegments } from './types';

export const MAX_KNOT_SLICES = 128;
export const MAX_KNOT_RINGS = 24;
export const MIN_KNOT_SLICES = 4;

/** Fraction of segments kept at a level of detail (1 at LOD 0, falling by `reduction` * 0.4 per level, never below 10 %). */
export function lodKeep(lod: number, reduction: number): number {
  if (!(lod > 0)) return 1;
  return clamp(Math.pow(1 - clamp(reduction, 0, 0.9) * 0.4, Math.min(lod, 3)), 0.1, 1);
}

export interface KnotSegmentSettings {
  ringsOuter: number;
  ringsInner: number;
  ringsCore: number;
  slices: number;
  /** Segments > Resolution: scales slices and rings. */
  resolution: number;
  /** Dynamic LOD > Ring segments / Slice segments reduction (0..1). */
  lodRings: number;
  lodSlices: number;
}

/** Ring and slice counts of a knot at a level of detail: base counts x Resolution x LOD keep, clamped to sane limits. */
export function knotSegments(s: KnotSegmentSettings, lod: number): KnotSegments {
  const res = clamp(s.resolution, 0.1, 4);
  const rk = res * lodKeep(lod, s.lodRings);
  const sk = res * lodKeep(lod, s.lodSlices);
  const rings = (n: number): number => clamp(Math.round(n * rk), 1, MAX_KNOT_RINGS);
  return {
    outer: rings(s.ringsOuter),
    inner: rings(s.ringsInner),
    core: rings(s.ringsCore),
    slices: clamp(Math.round(s.slices * sk), MIN_KNOT_SLICES, MAX_KNOT_SLICES),
  };
}

/**
 * Dynamic LOD > Weight (0..1): the importance of the knots. A knot is dropped when its (seeded) draw falls below the
 * cull share `(1 - weight) * lod / 3`; weight 1 keeps every knot at every level of detail.
 */
export function knotSurvivesLod(weight: number, lod: number, draw: number): boolean {
  const cull = clamp(1 - weight, 0, 1) * (clamp(lod, 0, 3) / 3);
  return draw >= cull;
}
