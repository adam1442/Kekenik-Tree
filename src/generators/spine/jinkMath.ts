import type { Rng } from '@/core/rng';
import { cumulativeLength } from './polyline';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Share of a segment that a knot may move at Uniformity 0. Below 0.5 so the knots can never cross. */
export const JINK_MAX_SHIFT = 0.45;

/** Number of straight segments: `Absolute` (minimum) plus `Relative` per metre of branch length. */
export function jinkSegmentCount(absolute: number, relative: number, branchLength: number): number {
  const n = Math.max(0, absolute) + Math.max(0, relative) * Math.max(0, branchLength);
  return Math.max(1, Math.min(256, Math.round(n)));
}

/**
 * Arc-length fractions (`segments + 1` values from 0 to 1) of the corners of the straight runs. Uniformity 1 gives equal
 * segments and never touches the random stream; lower values jitter every inner corner by up to `JINK_MAX_SHIFT` of a segment.
 */
export function jinkKnots(segments: number, uniformity: number, rng: Rng): Float64Array {
  const n = Math.max(1, Math.round(segments));
  const u = clamp01(uniformity);
  const knots = new Float64Array(n + 1);
  knots[n] = 1;
  for (let i = 1; i < n; i++) {
    const jitter = u >= 1 ? 0 : (rng.next() * 2 - 1) * (1 - u) * JINK_MAX_SHIFT;
    knots[i] = (i + jitter) / n;
  }
  return knots;
}

/**
 * Straightens a packed xyz polyline in place: every point moves towards the straight chord of the run it belongs to.
 * Amount 0 leaves the spine unchanged, 1 makes it exactly piecewise linear with `knots.length - 1` segments. The end points never move.
 */
export function applyJink(pos: Float32Array, count: number, amount: number, knots: ArrayLike<number>): void {
  const a = clamp01(amount);
  const segs = knots.length - 1;
  if (a <= 0 || count < 3 || segs < 1) return;
  const cum = cumulativeLength(pos, count);
  const total = cum[count - 1] as number;
  if (total < 1e-9) return;
  const arc = (i: number): number => (cum[i] as number) / total;

  // Positions of the corners on the original polyline
  const corner = new Float64Array(knots.length * 3);
  let j = 0;
  for (let k = 0; k <= segs; k++) {
    const f = knots[k] as number;
    while (j < count - 2 && arc(j + 1) < f) j++;
    const span = arc(j + 1) - arc(j);
    const w = span > 1e-12 ? clamp01((f - arc(j)) / span) : 0;
    for (let c = 0; c < 3; c++) {
      const p0 = pos[j * 3 + c] as number;
      const p1 = pos[(j + 1) * 3 + c] as number;
      corner[k * 3 + c] = p0 + (p1 - p0) * w;
    }
  }

  let seg = 0;
  for (let i = 1; i < count - 1; i++) {
    const f = arc(i);
    while (seg < segs - 1 && f > (knots[seg + 1] as number)) seg++;
    const k0 = knots[seg] as number;
    const span = (knots[seg + 1] as number) - k0;
    const w = span > 1e-12 ? clamp01((f - k0) / span) : 0;
    for (let c = 0; c < 3; c++) {
      const chord = (corner[seg * 3 + c] as number) * (1 - w) + (corner[(seg + 1) * 3 + c] as number) * w;
      const p = pos[i * 3 + c] as number;
      pos[i * 3 + c] = p + (chord - p) * a;
    }
  }
}
