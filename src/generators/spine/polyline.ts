/** Cumulative arc length of a packed xyz polyline (`out[0] = 0`). */
export function cumulativeLength(pos: ArrayLike<number>, count: number): Float64Array {
  const out = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const dx = (pos[i * 3] as number) - (pos[(i - 1) * 3] as number);
    const dy = (pos[i * 3 + 1] as number) - (pos[(i - 1) * 3 + 1] as number);
    const dz = (pos[i * 3 + 2] as number) - (pos[(i - 1) * 3 + 2] as number);
    out[i] = (out[i - 1] as number) + Math.hypot(dx, dy, dz);
  }
  return out;
}

/** Total length of a packed xyz polyline. */
export function polylineLength(pos: ArrayLike<number>, count: number): number {
  if (count < 2) return 0;
  return cumulativeLength(pos, count)[count - 1] as number;
}
