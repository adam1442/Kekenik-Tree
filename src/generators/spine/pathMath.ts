import { sampleCurveLUT } from '@/core/curve';
import { cumulativeLength } from './polyline';

type V3 = [number, number, number];

export interface PathSettings {
  /** Size of the deformation in metres (the profile curve is multiplied by it). */
  readonly amount: number;
  /** Length of exactly one tile in metres. */
  readonly tileLength: number;
  /** Shift of the tiles along the spine as a fraction of one tile. */
  readonly offset: number;
  /** Rotation of the displacement direction around the spine, in radians per metre. */
  readonly twistPerMetre: number;
  /** Profile of one tile (x = position inside the tile 0..1, y = sideways offset). */
  readonly lut: Float32Array;
}

/** Position inside the tile (0..1) at arc length `s`. */
export function pathPhase(s: number, tileLength: number, offset: number): number {
  const p = s / Math.max(1e-4, tileLength) + offset;
  return p - Math.floor(p);
}

/**
 * Sideways displacement in metres at arc length `s`. It is measured from the value at the start of the spine, so the base of the
 * branch always stays on its parent; it repeats exactly every `tileLength`.
 */
export function pathOffsetAt(s: number, st: PathSettings): number {
  const here = sampleCurveLUT(st.lut, pathPhase(s, st.tileLength, st.offset));
  const start = sampleCurveLUT(st.lut, pathPhase(0, st.tileLength, st.offset));
  return st.amount * (here - start);
}

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, 1];
};
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Traces the tile profile along a packed xyz polyline (in place): every point moves perpendicular to the spine by
 * `pathOffsetAt(arc length)`, in a direction that turns around the spine with Twist. `normals` (packed xyz, one per point) only
 * seeds the side direction. The first point never moves.
 */
export function applyPath(pos: Float32Array, normals: ArrayLike<number>, count: number, st: PathSettings): void {
  if (count < 2 || st.amount === 0) return;
  const cum = cumulativeLength(pos, count);
  const shift = new Float32Array(count * 3);
  for (let i = 1; i < count; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(count - 1, i + 1);
    const t = norm([
      (pos[b * 3] as number) - (pos[a * 3] as number),
      (pos[b * 3 + 1] as number) - (pos[a * 3 + 1] as number),
      (pos[b * 3 + 2] as number) - (pos[a * 3 + 2] as number),
    ]);
    const hint: V3 = [normals[i * 3] as number, normals[i * 3 + 1] as number, normals[i * 3 + 2] as number];
    const d = t[0] * hint[0] + t[1] * hint[1] + t[2] * hint[2];
    let n = norm([hint[0] - t[0] * d, hint[1] - t[1] * d, hint[2] - t[2] * d]);
    if (Math.abs(d) > 0.999) n = norm(cross(t, Math.abs(t[0]) < 0.85 ? [1, 0, 0] : [0, 1, 0]));
    const bn = norm(cross(t, n));
    const s = cum[i] as number;
    const ang = st.twistPerMetre * s;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const off = pathOffsetAt(s, st);
    for (let k = 0; k < 3; k++) shift[i * 3 + k] = off * ((n[k] as number) * c + (bn[k] as number) * sn);
  }
  for (let i = 1; i < count * 3; i++) pos[i] = (pos[i] as number) + (shift[i] as number);
}
