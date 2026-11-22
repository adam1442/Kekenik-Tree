const MIN_SPOT = 0.02;
const MAX_SPOT = 0.99;

/** Break Spot as a fraction of the spine length (a break never happens at the very base or beyond the tip). */
export function clampBreakSpot(spot: number): number {
  return Math.max(MIN_SPOT, Math.min(MAX_SPOT, Number.isFinite(spot) ? spot : MAX_SPOT));
}

/** Whether a node breaks: `draw` is a uniform random number in [0, 1). A chance of 1 always breaks, 0 never. */
export function breaks(chance: number, draw: number): boolean {
  return chance > 0 && draw < chance;
}

/** Length in metres that stays after a break at `spot` of a spine of `fullLength`. */
export function brokenLength(fullLength: number, spot: number): number {
  return Math.max(0, fullLength) * clampBreakSpot(spot);
}
