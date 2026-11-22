/** Welds whose Keep curve value is below this are dropped (the child then starts on the parent's spine without fusing). */
export const WELD_KEEP_THRESHOLD = 0.5;

/** Whether a weld survives the Keep curve at one position. */
export function weldKept(curveValue: number): boolean {
  return curveValue >= WELD_KEEP_THRESHOLD;
}

/**
 * Position of an attachment on the model for the Keep curve: its height as a 0..1 fraction of the height range of the
 * structure it grows on (0 = lowest point of the parent structure, 1 = highest). For a Trunk parent this is the trunk height.
 */
export function weldHeightFraction(z: number, zMin: number, zMax: number): number {
  const span = zMax - zMin;
  if (!(span > 1e-9)) return 0;
  const f = (z - zMin) / span;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}
