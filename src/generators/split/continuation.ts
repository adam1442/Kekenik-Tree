/** Length of the start blend of an extension, in radii of the open end. */
export const CONTINUATION_BLEND_RADII = 1.5;

/**
 * Seamless start of an extension (pure, in place). The first `blendRadii x radius` metres of the polyline `positions` (`count` points,
 * point 0 = the open end) are blended from the straight continuation `p0 + tangent x arc` to the spine's own path with a smoothstep
 * weight (zero slope at both ends). The start direction therefore equals `tangent` exactly (no kink) while the spine keeps the
 * direction it wants beyond the blend, with matching position and direction there (C1). Point 0 never moves.
 * Returns the number of points that were moved.
 */
export function blendExtensionStart(positions: Float32Array, count: number, tangent: readonly [number, number, number], radius: number, blendRadii = CONTINUATION_BLEND_RADII): number {
  if (count < 2 || !(radius > 0)) return 0;
  const len = Math.hypot(tangent[0], tangent[1], tangent[2]);
  if (len < 1e-9) return 0;
  const tx = tangent[0] / len;
  const ty = tangent[1] / len;
  const tz = tangent[2] / len;
  const span = Math.max(1e-6, blendRadii * radius);
  const p0x = positions[0] as number;
  const p0y = positions[1] as number;
  const p0z = positions[2] as number;
  let arc = 0;
  let moved = 0;
  for (let i = 1; i < count; i++) {
    const o = i * 3;
    arc += Math.hypot((positions[o] as number) - (positions[o - 3] as number), (positions[o + 1] as number) - (positions[o - 2] as number), (positions[o + 2] as number) - (positions[o - 1] as number));
    const x = arc / span;
    if (x >= 1) break;
    const h = x * x * (3 - 2 * x);
    positions[o] = (p0x + tx * arc) * (1 - h) + (positions[o] as number) * h;
    positions[o + 1] = (p0y + ty * arc) * (1 - h) + (positions[o + 1] as number) * h;
    positions[o + 2] = (p0z + tz * arc) * (1 - h) + (positions[o + 2] as number) * h;
    moved++;
  }
  return moved;
}

/**
 * Index of the first polyline point at or beyond a quarter of the start blend (at least 1, at most `count - 1`): resampling that keeps this
 * point makes the first output segment a chord inside the blend, so it follows the start tangent.
 */
export function extensionStartSampleIndex(positions: ArrayLike<number>, count: number, radius: number, blendRadii = CONTINUATION_BLEND_RADII): number {
  if (count < 2) return 0;
  const half = 0.25 * blendRadii * radius;
  let arc = 0;
  for (let i = 1; i < count; i++) {
    const o = i * 3;
    arc += Math.hypot((positions[o] as number) - (positions[o - 3] as number), (positions[o + 1] as number) - (positions[o - 2] as number), (positions[o + 2] as number) - (positions[o - 1] as number));
    if (arc >= half) return i;
  }
  return count - 1;
}
