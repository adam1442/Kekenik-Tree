/**
 * Skin > Radius maths (pure). The generators call these while a spine is grown, so children attach to the final radius.
 *
 * Base radius = (Spine radius) + Absolute + (+ % of parent) x parent radius, limited by Clamp to parent and Clamp Min / Max.
 */
export interface SkinRadiusSettings {
  /** Metres added to the base radius. */
  absolute: number;
  /** Fraction of the parent radius at the attachment that is added. */
  percentParent: number;
  /** The child never gets thicker than its parent. */
  clampToParent: boolean;
  /** Clamp Min / Max radius in metres (0 = off). */
  min: number;
  max: number;
  /** 0..1: lifts the tip radius of branches that thin out to a point. */
  lengthCompensation: number;
  /** Branches whose length / radius exceeds this are removed (0 = off). */
  killRatio: number;
}

export const NEUTRAL_SKIN_RADIUS: SkinRadiusSettings = {
  absolute: 0,
  percentParent: 0,
  clampToParent: false,
  min: 0,
  max: 0,
  lengthCompensation: 0,
  killRatio: 0,
};

/** Clamp Min / Max (a bound of 0 or less is off). */
export function clampRadius(r: number, min: number, max: number): number {
  let out = r;
  if (max > 0 && out > max) out = max;
  if (min > 0 && out < min) out = min;
  return out;
}

/** Radius at the base of a branch. `parentRadius` is null for branches without a parent. */
export function skinBaseRadius(base: number, parentRadius: number | null, s: SkinRadiusSettings): number {
  let r = base + Math.max(0, s.absolute);
  if (parentRadius !== null && parentRadius > 0) {
    r += Math.max(0, s.percentParent) * parentRadius;
    if (s.clampToParent) r = Math.min(r, parentRadius);
  }
  return clampRadius(r, s.min, s.max);
}

/** Fraction of the base radius the tip may keep at full Length compensation. */
export const COMPENSATION_TIP_FRACTION = 0.5;

/**
 * Length compensation: when the tip radius falls below `amount x 0.5 x base radius` the missing part is added along the
 * branch with a quadratic ease (the base is untouched, the tip reaches the floor). `u` is the 0..1 position of every
 * radius along the branch. The array is changed in place.
 */
export function compensateTipRadii(radii: Float32Array, u: ArrayLike<number>, amount: number): void {
  const n = radii.length;
  if (n < 2 || !(amount > 0)) return;
  const base = radii[0] as number;
  const tip = radii[n - 1] as number;
  const floor = Math.min(1, amount) * COMPENSATION_TIP_FRACTION * base;
  const lift = floor - tip;
  if (!(lift > 0)) return;
  for (let k = 0; k < n; k++) {
    const t = Math.min(1, Math.max(0, u[k] as number));
    radii[k] = (radii[k] as number) + lift * t * t;
  }
}

/** True when a branch is too slender: length / radius above the kill ratio (0 = never). */
export function exceedsKillRatio(length: number, radius: number, ratio: number): boolean {
  if (!(ratio > 0)) return false;
  return length / Math.max(1e-9, radius) > ratio;
}
