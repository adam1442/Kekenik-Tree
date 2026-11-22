/** Skin > Radius > Light seam reduction (pure): normals lean toward the spine direction, most strongly at the base. */
export type Vec3 = readonly [number, number, number];

/** Length (in branch radii) over which the seam reduction fades out along the branch. */
export const SEAM_FALLOFF_RADII = 3;

/** Weight 0..1 of the bend at arc length `s` from the base of a branch with base radius `r0`. Falls off monotonically with `s`. */
export function seamWeight(s: number, r0: number, amount: number): number {
  if (!(amount > 0)) return 0;
  const a = Math.min(1, amount);
  return a * Math.exp(-Math.max(0, s) / Math.max(1e-6, SEAM_FALLOFF_RADII * r0));
}

/**
 * Unit normal `n` moved toward the unit direction `to` by `w` (0 = unchanged, 1 = `to`). The one normal-lean helper of the skin:
 * Light seam reduction leans toward the spine, the weld Lighting curve toward the spine or away from it.
 */
export function leanNormal(n: Vec3, to: Vec3, w: number): [number, number, number] {
  if (!(w > 0)) return [n[0], n[1], n[2]];
  const k = Math.min(1, w);
  const x = n[0] + (to[0] - n[0]) * k;
  const y = n[1] + (to[1] - n[1]) * k;
  const z = n[2] + (to[2] - n[2]) * k;
  const l = Math.hypot(x, y, z);
  return l < 1e-12 ? [n[0], n[1], n[2]] : [x / l, y / l, z / l];
}

/** Bend of the radius at a ring: `1 / cos(half the turn)` limited to 60 degrees, used by Smooth to push vertices out around bends. */
export function bendPushFactor(turnCos: number): number {
  const c = Math.min(1, Math.max(-1, turnCos));
  // cos(half) = sqrt((1 + cos) / 2)
  const half = Math.sqrt((1 + c) / 2);
  return 1 / Math.max(0.5, half);
}
