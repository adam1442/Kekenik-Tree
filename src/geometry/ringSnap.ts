/**
 * Ring snapping: makes the first ring of an extension (or a cap) coincide with the real end ring of the split half it continues,
 * vertex for vertex, so the two skins meet without a gap. Pure and allocation-light (typed arrays only).
 */

/** Positions (xyz per vertex, closed ring in order) of the end ring of a split half, as the crotch mesh built it. */
export type EndRing = Float32Array;

/** Largest distance between a ring vertex and the target polygon, in ring radii, for which a snap is accepted. */
export const SNAP_MAX_RADII = 0.6;

function sqDist(a: ArrayLike<number>, ai: number, b: ArrayLike<number>, bi: number): number {
  const dx = (a[ai] as number) - (b[bi] as number);
  const dy = (a[ai + 1] as number) - (b[bi + 1] as number);
  const dz = (a[ai + 2] as number) - (b[bi + 2] as number);
  return dx * dx + dy * dy + dz * dz;
}

/** Closest point of the closed polygon `target` (m vertices) to the point at `p[pi]`, written to `out`. */
function closestOnPolygon(p: ArrayLike<number>, pi: number, target: ArrayLike<number>, m: number, out: Float64Array): number {
  let best = Infinity;
  for (let k = 0; k < m; k++) {
    const a = k * 3;
    const b = ((k + 1) % m) * 3;
    const ex = (target[b] as number) - (target[a] as number);
    const ey = (target[b + 1] as number) - (target[a + 1] as number);
    const ez = (target[b + 2] as number) - (target[a + 2] as number);
    const wx = (p[pi] as number) - (target[a] as number);
    const wy = (p[pi + 1] as number) - (target[a + 1] as number);
    const wz = (p[pi + 2] as number) - (target[a + 2] as number);
    const l2 = ex * ex + ey * ey + ez * ez;
    const t = l2 > 1e-18 ? Math.min(1, Math.max(0, (wx * ex + wy * ey + wz * ez) / l2)) : 0;
    const cx = (target[a] as number) + ex * t;
    const cy = (target[a + 1] as number) + ey * t;
    const cz = (target[a + 2] as number) + ez * t;
    const d = ((p[pi] as number) - cx) ** 2 + ((p[pi + 1] as number) - cy) ** 2 + ((p[pi + 2] as number) - cz) ** 2;
    if (d < best) {
      best = d;
      out[0] = cx;
      out[1] = cy;
      out[2] = cz;
    }
  }
  return best;
}

/**
 * Moves the `count` ring vertices stored at `ring[offset + j * 3]` onto the closed polygon `target` (xyz, any vertex count).
 * With equal counts the vertices land exactly on the target vertices (best cyclic shift and direction); otherwise each vertex goes
 * to the closest point of the polygon. Nothing changes (returns false) when the ring is not close to the target: the largest
 * vertex distance must stay below {@link SNAP_MAX_RADII} x `radius`.
 */
export function snapRingToPolygon(ring: Float32Array, offset: number, count: number, target: ArrayLike<number>, radius: number): boolean {
  const m = Math.floor(target.length / 3);
  if (count < 3 || m < 3 || !(radius > 0)) return false;
  const limit = SNAP_MAX_RADII * SNAP_MAX_RADII * radius * radius;
  if (m === count) {
    let bestCost = Infinity;
    let bestShift = 0;
    let bestDir = 1;
    for (const dir of [1, -1]) {
      for (let s = 0; s < m; s++) {
        let cost = 0;
        for (let j = 0; j < count; j++) {
          const k = (((s + dir * j) % m) + m) % m;
          cost += sqDist(ring, offset + j * 3, target, k * 3);
        }
        if (cost < bestCost) {
          bestCost = cost;
          bestShift = s;
          bestDir = dir;
        }
      }
    }
    for (let j = 0; j < count; j++) {
      const k = (((bestShift + bestDir * j) % m) + m) % m;
      if (sqDist(ring, offset + j * 3, target, k * 3) > limit) return false;
    }
    for (let j = 0; j < count; j++) {
      const k = (((bestShift + bestDir * j) % m) + m) % m;
      ring[offset + j * 3] = target[k * 3] as number;
      ring[offset + j * 3 + 1] = target[k * 3 + 1] as number;
      ring[offset + j * 3 + 2] = target[k * 3 + 2] as number;
    }
    return true;
  }
  const hit = new Float64Array(3);
  const moved = new Float64Array(count * 3);
  for (let j = 0; j < count; j++) {
    if (closestOnPolygon(ring, offset + j * 3, target, m, hit) > limit) return false;
    moved[j * 3] = hit[0] as number;
    moved[j * 3 + 1] = hit[1] as number;
    moved[j * 3 + 2] = hit[2] as number;
  }
  for (let i = 0; i < count * 3; i++) ring[offset + i] = moved[i] as number;
  return true;
}

/**
 * Exact snap with a known cyclic shift (T09): vertex `j` of the ring lands on target vertex `(j - shift) mod m`. Only valid for equal
 * counts, the same winding and a ring that is close to the target (same limit as {@link snapRingToPolygon}); nothing changes otherwise.
 */
export function snapRingShifted(ring: Float32Array, offset: number, count: number, target: ArrayLike<number>, shift: number, radius: number): boolean {
  const m = Math.floor(target.length / 3);
  if (m !== count || count < 3 || !(radius > 0)) return false;
  const limit = SNAP_MAX_RADII * SNAP_MAX_RADII * radius * radius;
  for (let j = 0; j < count; j++) {
    const k = (((j - shift) % m) + m) % m;
    if (sqDist(ring, offset + j * 3, target, k * 3) > limit) return false;
  }
  for (let j = 0; j < count; j++) {
    const k = (((j - shift) % m) + m) % m;
    ring[offset + j * 3] = target[k * 3] as number;
    ring[offset + j * 3 + 1] = target[k * 3 + 1] as number;
    ring[offset + j * 3 + 2] = target[k * 3 + 2] as number;
  }
  return true;
}

/**
 * Angle (radians, in the ring frame `centre`, `n`, `b`) of the first vertex of the closed polygon `target` (same winding assumed:
 * increasing from `n` towards `b`). `null` when the polygon winds the other way or has a different vertex count. Rolling the child's
 * frames by this angle puts the child's vertex 0 exactly on the polygon's vertex 0.
 */
export function ringStartAngle(target: ArrayLike<number>, count: number, centre: readonly [number, number, number], n: readonly [number, number, number], b: readonly [number, number, number]): number | null {
  const m = Math.floor(target.length / 3);
  if (m !== count || count < 3) return null;
  const angle = (k: number): number => {
    const x = (target[k * 3] as number) - centre[0];
    const y = (target[k * 3 + 1] as number) - centre[1];
    const z = (target[k * 3 + 2] as number) - centre[2];
    return Math.atan2(x * b[0] + y * b[1] + z * b[2], x * n[0] + y * n[1] + z * n[2]);
  };
  let turn = angle(1) - angle(0);
  turn -= Math.round(turn / (2 * Math.PI)) * 2 * Math.PI;
  return turn > 0 ? angle(0) : null;
}
