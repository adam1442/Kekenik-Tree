/** Inputs of the additive spine length: `Absolute + (% of parent) x parent length + (% of radius) x parent radius`. */
export interface LengthTerms {
  /** Absolute length in metres. */
  absolute: number;
  /** Fraction of the parent branch length that is added (0.5 = half of the parent). */
  percentParent: number;
  /** Number of parent radii that are added. */
  percentRadius: number;
  parentLength: number;
  parentRadius: number;
}

/** Spine length before curves, envelopes and clamping: the three terms are added. Negative terms count as 0. */
export function spineLength(t: LengthTerms): number {
  return (
    Math.max(0, t.absolute) +
    Math.max(0, t.percentParent) * Math.max(0, t.parentLength) +
    Math.max(0, t.percentRadius) * Math.max(0, t.parentRadius)
  );
}

/** Clamp group: `min` / `max` of 0 mean "off". When both are set and cross, the minimum wins. */
export function clampLength(length: number, min: number, max: number): number {
  const hi = max > 0 ? max : Infinity;
  const lo = min > 0 ? min : 0;
  return Math.max(lo, Math.min(length, Math.max(hi, lo)));
}

/**
 * Length of exactly one V tile of a texture wrapped once around a branch of `radius`: the U edge of the tile is the
 * circumference, the V edge follows the texture's height / width ratio (`aspect`).
 */
export function oneVTileLength(radius: number, aspect = 1): number {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return 2 * Math.PI * Math.max(0, radius) * a;
}

/**
 * Length multiplier of the shape control (crown envelope): `scale` 0 turns it off, 1 applies it as is, above 1
 * exaggerates it. `envelope` is the crown value at the attachment position (1 = no change).
 */
export function shapedEnvelope(envelope: number, scale: number): number {
  return Math.max(0.02, 1 + (envelope - 1) * Math.max(0, scale));
}
