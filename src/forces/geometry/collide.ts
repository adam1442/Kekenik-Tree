import type { GeometryQuery, V3 } from './query';

export type ColliderMode = 'obstruct' | 'prune' | 'stop';

export interface ForceCollider {
  mode: ColliderMode;
  /** Gap (m) kept between the chain and the surface. */
  skin: number;
  query: GeometryQuery;
}

/**
 * Constrains one branch chain `P` (xyz per point, `n` points) against a geometry collider, in place.
 *  - Obstruct: every point is pushed out of the mesh along the surface normal (the chain slides along the surface,
 *    segment lengths are kept) and segments that would pass through a thin shell are stopped at the surface.
 *  - Prune: the chain ends at the last free point before the first intersection.
 *  - Stop: the chain ends exactly on the surface where its first segment meets it.
 * Returns the number of points that remain (n when nothing was cut). Points that start inside the mesh are tolerated
 * until the chain leaves it.
 */
export function constrainChain(P: Float64Array, n: number, c: ForceCollider): number {
  if (n < 2) return n;
  const normal: V3 = [0, 0, 1];
  if (c.mode === 'obstruct') {
    const orig = Float64Array.from(P.subarray(0, n * 3));
    for (let k = 1; k < n; k++) {
      const bx = P[(k - 1) * 3] as number;
      const by = P[(k - 1) * 3 + 1] as number;
      const bz = P[(k - 1) * 3 + 2] as number;
      const vx = (orig[k * 3] as number) - (orig[(k - 1) * 3] as number);
      const vy = (orig[k * 3 + 1] as number) - (orig[(k - 1) * 3 + 1] as number);
      const vz = (orig[k * 3 + 2] as number) - (orig[(k - 1) * 3 + 2] as number);
      const len = Math.hypot(vx, vy, vz);
      let x = bx + vx;
      let y = by + vy;
      let z = bz + vz;
      // Thin shells: a segment that crosses the surface is stopped on the near side first.
      if (!c.query.inside(bx, by, bz)) {
        const t = c.query.segmentHit([bx, by, bz], [x, y, z]);
        if (t >= 0) {
          x = bx + (x - bx) * t;
          y = by + (y - by) * t;
          z = bz + (z - bz) * t;
        }
      }
      for (let it = 0; it < 8; it++) {
        const sd = c.query.signed(x, y, z, normal);
        if (sd >= c.skin) break;
        const push = c.skin - sd;
        x += normal[0] * push;
        y += normal[1] * push;
        z += normal[2] * push;
        if (len > 1e-9) {
          const dx = x - bx;
          const dy = y - by;
          const dz = z - bz;
          const dl = Math.hypot(dx, dy, dz);
          if (dl > 1e-9) {
            x = bx + (dx / dl) * len;
            y = by + (dy / dl) * len;
            z = bz + (dz / dl) * len;
          }
        }
      }
      // Last guarantee: leave the mesh even if the length has to give a little.
      const sd = c.query.signed(x, y, z, normal);
      if (sd < c.skin) {
        x += normal[0] * (c.skin - sd);
        y += normal[1] * (c.skin - sd);
        z += normal[2] * (c.skin - sd);
      }
      P[k * 3] = x;
      P[k * 3 + 1] = y;
      P[k * 3 + 2] = z;
    }
    return n;
  }
  for (let k = 1; k < n; k++) {
    const a: V3 = [P[(k - 1) * 3] as number, P[(k - 1) * 3 + 1] as number, P[(k - 1) * 3 + 2] as number];
    if (c.query.inside(a[0], a[1], a[2])) continue;
    const b: V3 = [P[k * 3] as number, P[k * 3 + 1] as number, P[k * 3 + 2] as number];
    let t = c.query.segmentHit(a, b);
    if (t < 0 && c.query.inside(b[0], b[1], b[2])) t = 1;
    if (t < 0) continue;
    if (c.mode === 'prune') return k;
    P[k * 3] = a[0] + (b[0] - a[0]) * t;
    P[k * 3 + 1] = a[1] + (b[1] - a[1]) * t;
    P[k * 3 + 2] = a[2] + (b[2] - a[2]) * t;
    return k + 1;
  }
  return n;
}
