/**
 * Parent skin used by the weld solver. A surface only answers three questions about the parent tube: is a point inside it
 * (signed distance), which way does the skin face there (normal) and is the nearest skin point an end cap of the parent.
 *
 * Two implementations share the interface:
 * - `coneSurface`   procedural: an infinite cone around the parent axis at the attachment (position, tangent, radius, taper).
 * - `tubeSurface`   ray cast: the union of the parent's frusta (the exact tube the parent mesh is built from), so curved parents
 *                   and end caps are handled; slower and it can fail where the procedural cone cannot.
 */
export interface ParentSurface {
  /** Radius of the parent skin at the attachment (already scaled for the polygonal sag). */
  readonly radius: number;
  /** Unit direction of the parent axis (towards its tip) at the attachment. */
  readonly axis: readonly [number, number, number];
  /** Signed distance to the skin: negative inside the parent. Only the sign and the zero crossing are meaningful. */
  signedDistance(x: number, y: number, z: number): number;
  /** Unit outward normal of the skin near the point (written to `out[offset..offset + 2]`). */
  normal(x: number, y: number, z: number, out: Float32Array, offset: number): void;
  /** True when the point is nearest to an end cap of the parent instead of its side. */
  nearEnd(x: number, y: number, z: number): boolean;
}

export interface ConeSurfaceInput {
  /** Point of the parent axis at the attachment. */
  position: readonly [number, number, number];
  /** Unit tangent of the parent axis. */
  tangent: readonly [number, number, number];
  radius: number;
  /** Radius change per metre along the tangent (negative = tapers towards the tip). */
  slope: number;
}

/**
 * Scale applied to the parent radius to hide the polygonal sag: a parent with `n` sides has flats that lie up to
 * `1 - cos(pi / n)` inside the true circle. Welding to a radius a little below the circle keeps the rim from floating
 * above the flats. 0 / unknown sides keep the exact radius.
 */
export function sagScale(parentSides: number): number {
  if (!(parentSides >= 3)) return 1;
  return 1 - 0.65 * (1 - Math.cos(Math.PI / parentSides));
}

const EPS = 1e-12;

function writeUnit(out: Float32Array, o: number, x: number, y: number, z: number, fx: number, fy: number, fz: number): void {
  const l = Math.hypot(x, y, z);
  if (l < EPS) {
    out[o] = fx;
    out[o + 1] = fy;
    out[o + 2] = fz;
    return;
  }
  out[o] = x / l;
  out[o + 1] = y / l;
  out[o + 2] = z / l;
}

export function coneSurface(input: ConeSurfaceInput): ParentSurface {
  const [ax, ay, az] = input.position;
  const [tx, ty, tz] = input.tangent;
  const r0 = input.radius;
  const slope = input.slope;
  // Any direction perpendicular to the axis (used when a point lies exactly on it).
  const fb: [number, number, number] = Math.abs(tz) < 0.9 ? [-ty, tx, 0] : [0, -tz, ty];
  return {
    radius: r0,
    axis: input.tangent,
    signedDistance(x, y, z) {
      const dx = x - ax;
      const dy = y - ay;
      const dz = z - az;
      const a = dx * tx + dy * ty + dz * tz;
      const rx = dx - a * tx;
      const ry = dy - a * ty;
      const rz = dz - a * tz;
      return Math.sqrt(rx * rx + ry * ry + rz * rz) - (r0 + slope * a);
    },
    normal(x, y, z, out, offset) {
      const dx = x - ax;
      const dy = y - ay;
      const dz = z - az;
      const a = dx * tx + dy * ty + dz * tz;
      const rx = dx - a * tx;
      const ry = dy - a * ty;
      const rz = dz - a * tz;
      const rl = Math.sqrt(rx * rx + ry * ry + rz * rz);
      if (rl < EPS) {
        writeUnit(out, offset, fb[0] - slope * tx, fb[1] - slope * ty, fb[2] - slope * tz, 0, 0, 1);
        return;
      }
      writeUnit(out, offset, rx / rl - slope * tx, ry / rl - slope * ty, rz / rl - slope * tz, 0, 0, 1);
    },
    nearEnd() {
      return false;
    },
  };
}

export interface TubeSurfaceInput {
  /** Parent spine points (`count * 3`). */
  positions: ArrayLike<number>;
  /** Parent radii (`count`). */
  radii: ArrayLike<number>;
  count: number;
  /** Local point index nearest to the attachment: only segments within `window` points of it are considered (0 = all). */
  hint: number;
  window: number;
  /** Multiplies every radius (polygonal sag). */
  radiusScale: number;
}

export function tubeSurface(input: TubeSurfaceInput): ParentSurface {
  const { positions: P, radii: R, count, radiusScale } = input;
  const segs = Math.max(0, count - 1);
  const lo = input.window > 0 ? Math.max(0, input.hint - input.window) : 0;
  const hi = input.window > 0 ? Math.min(segs, input.hint + input.window) : segs;
  // Scratch result of the last `nearest` call (the surface is used by one solver at a time).
  let bValue = 0;
  let bSegment = 0;
  let bRaw = 0;

  const nearest = (x: number, y: number, z: number): void => {
    let bestValue = Infinity;
    for (let k = lo; k < hi; k++) {
      const ax = P[k * 3] as number;
      const ay = P[k * 3 + 1] as number;
      const az = P[k * 3 + 2] as number;
      const dx = (P[(k + 1) * 3] as number) - ax;
      const dy = (P[(k + 1) * 3 + 1] as number) - ay;
      const dz = (P[(k + 1) * 3 + 2] as number) - az;
      const l2 = dx * dx + dy * dy + dz * dz;
      const raw = l2 > EPS ? ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2 : 0;
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const ex = x - ax - dx * t;
      const ey = y - ay - dy * t;
      const ez = z - az - dz * t;
      const d = Math.sqrt(ex * ex + ey * ey + ez * ez);
      const r = ((R[k] as number) * (1 - t) + (R[k + 1] as number) * t) * radiusScale;
      const v = d - r;
      if (v < bestValue) {
        bestValue = v;
        bValue = v;
        bSegment = k;
        bRaw = raw;
      }
    }
  };

  // Attachment axis: tangent of the hinted segment.
  const hk = Math.min(Math.max(0, input.hint), Math.max(0, segs - 1));
  let axis: [number, number, number] = [0, 0, 1];
  let radius = 0;
  if (segs > 0) {
    const dx = (P[(hk + 1) * 3] as number) - (P[hk * 3] as number);
    const dy = (P[(hk + 1) * 3 + 1] as number) - (P[hk * 3 + 1] as number);
    const dz = (P[(hk + 1) * 3 + 2] as number) - (P[hk * 3 + 2] as number);
    const l = Math.hypot(dx, dy, dz);
    if (l > EPS) axis = [dx / l, dy / l, dz / l];
    radius = (R[hk] as number) * radiusScale;
  }
  const h = Math.max(1e-6, radius * 1e-3);
  const sdf = (x: number, y: number, z: number): number => {
    nearest(x, y, z);
    return bValue;
  };
  return {
    radius,
    axis,
    signedDistance: sdf,
    normal(x, y, z, out, offset) {
      writeUnit(out, offset, sdf(x + h, y, z) - sdf(x - h, y, z), sdf(x, y + h, z) - sdf(x, y - h, z), sdf(x, y, z + h) - sdf(x, y, z - h), axis[0], axis[1], axis[2]);
    },
    nearEnd(x, y, z) {
      if (segs === 0) return true;
      nearest(x, y, z);
      // On an end cap when the nearest axis point is the very end of the polyline and the point lies beyond it.
      return (bSegment === 0 && bRaw < 0) || (bSegment === segs - 1 && bRaw > 1);
    },
  };
}

/**
 * Procedural surface at the point of a polyline (parent spine) nearest to `base`: position, tangent, radius and taper are
 * taken from the segment the base lies on. Null when the polyline is degenerate.
 */
export function coneFromPolyline(
  positions: ArrayLike<number>,
  radii: ArrayLike<number>,
  count: number,
  base: readonly [number, number, number],
  hint: number,
  window: number,
  radiusScale: number,
): ParentSurface | null {
  if (count < 2) return null;
  const segs = count - 1;
  const lo = window > 0 ? Math.max(0, hint - window) : 0;
  const hi = window > 0 ? Math.min(segs, hint + window) : segs;
  let bestD = Infinity;
  let bk = -1;
  let bt = 0;
  for (let k = lo; k < hi; k++) {
    const ax = positions[k * 3] as number;
    const ay = positions[k * 3 + 1] as number;
    const az = positions[k * 3 + 2] as number;
    const dx = (positions[(k + 1) * 3] as number) - ax;
    const dy = (positions[(k + 1) * 3 + 1] as number) - ay;
    const dz = (positions[(k + 1) * 3 + 2] as number) - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    const raw = l2 > EPS ? ((base[0] - ax) * dx + (base[1] - ay) * dy + (base[2] - az) * dz) / l2 : 0;
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const d = Math.hypot(base[0] - ax - dx * t, base[1] - ay - dy * t, base[2] - az - dz * t);
    if (d < bestD) {
      bestD = d;
      bk = k;
      bt = t;
    }
  }
  if (bk < 0) return null;
  const ax = positions[bk * 3] as number;
  const ay = positions[bk * 3 + 1] as number;
  const az = positions[bk * 3 + 2] as number;
  const dx = (positions[(bk + 1) * 3] as number) - ax;
  const dy = (positions[(bk + 1) * 3 + 1] as number) - ay;
  const dz = (positions[(bk + 1) * 3 + 2] as number) - az;
  const l = Math.hypot(dx, dy, dz);
  if (l < EPS) return null;
  const r0 = radii[bk] as number;
  const r1 = radii[bk + 1] as number;
  return coneSurface({
    position: [ax + dx * bt, ay + dy * bt, az + dz * bt],
    tangent: [dx / l, dy / l, dz / l],
    radius: (r0 + (r1 - r0) * bt) * radiusScale,
    slope: ((r1 - r0) / l) * radiusScale,
  });
}
