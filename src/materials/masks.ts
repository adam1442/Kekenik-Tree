import type { MaskDef } from '@/contracts/material';

export interface MaskSample {
  position: readonly [number, number, number];
  /** Unit surface normal (Z-up). */
  normal: readonly [number, number, number];
  /** Elevation relative to the terrain's height range, 0..1 (used by the `relative` elevation mode). */
  height: number;
}

export function createMaskDef(id: string, name: string): MaskDef {
  return {
    id,
    name,
    behavior: 'inclusive',
    fuzziness: 0,
    type: 'terrain',
    slope: { min: 0, max: 1 },
    elevationMode: 'relative',
    relativeElevation: { min: 0, max: 1 },
    absoluteElevation: { min: 0, max: 50 },
  };
}

/** Slope 0 = flat ground, 1 = vertical wall (angle / 90 degrees). */
export function slopeOf(normal: readonly [number, number, number]): number {
  const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
  return Math.acos(Math.min(1, Math.max(-1, normal[2] / len))) / (Math.PI / 2);
}

/** 1 inside [min, max]; smooth fall-off to 0 over `fuzz` outside. */
export function rangeFactor(value: number, min: number, max: number, fuzz: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (value >= lo && value <= hi) return 1;
  if (fuzz <= 0) return 0;
  const d = value < lo ? lo - value : value - hi;
  const t = Math.min(1, d / fuzz);
  return 1 - t * t * (3 - 2 * t);
}

/** Mask value 0..1. `inclusive` keeps what is inside the ranges, `exclusive` keeps what is outside. */
export function evaluateMask(mask: MaskDef, s: MaskSample): number {
  const slope = rangeFactor(slopeOf(s.normal), mask.slope.min, mask.slope.max, mask.fuzziness);
  const elev =
    mask.elevationMode === 'relative'
      ? rangeFactor(s.height, mask.relativeElevation.min, mask.relativeElevation.max, mask.fuzziness)
      : rangeFactor(s.position[2], mask.absoluteElevation.min, mask.absoluteElevation.max, mask.fuzziness);
  const inside = Math.min(slope, elev);
  return mask.behavior === 'exclusive' ? 1 - inside : inside;
}
