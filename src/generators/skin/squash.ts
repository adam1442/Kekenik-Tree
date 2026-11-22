/**
 * Skin > Squash (pure). The cross-section becomes an ellipse whose short semi-axis points along the angle `rotate`.
 * Amount 0 = round, 1 = flat (short axis = 10 % of the radius). The long axis keeps the radius, so the section only shrinks.
 */
export const SQUASH_MIN_RATIO = 0.1;

/** Short / long semi-axis ratio for an amount 0..1. */
export function squashRatio(amount: number): number {
  const a = Math.min(1, Math.max(0, amount));
  return 1 - a * (1 - SQUASH_MIN_RATIO);
}

/** Radius multiplier (<= 1) at ring angle `angle` (radians) when the short axis lies at `rotate` (radians). */
export function squashRadius(angle: number, amount: number, rotate: number): number {
  if (!(amount > 0)) return 1;
  const k = squashRatio(amount);
  const c = Math.cos(angle - rotate);
  const s = Math.sin(angle - rotate);
  // Polar form of an ellipse with semi-axes k (along the short axis) and 1: r = k / sqrt(cos^2 + k^2 sin^2).
  return k / Math.sqrt(c * c + k * k * s * s);
}
