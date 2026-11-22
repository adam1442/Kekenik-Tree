import { squashRadius, squashRatio } from '@/generators/skin/squash';
import type { ParentSurface } from './surface';

export interface SquashInput {
  /** Point of the parent axis at the attachment. */
  position: readonly [number, number, number];
  /** Unit vector perpendicular to the parent axis: the 0 degree direction of the parent's rings. */
  normal: readonly [number, number, number];
  /** Squash Amount 0..1. */
  amount: number;
  /** Radians: Squash Rotate + the skin Roll of the parent (rings are measured from its unrolled frame normal). */
  angle: number;
}

/** Unit vector of `rmf` perpendicular to `axis` (any perpendicular when they are parallel). */
export function frameNormalFor(rmf: readonly [number, number, number] | null, axis: readonly [number, number, number]): [number, number, number] {
  const [ax, ay, az] = axis;
  const seed = rmf ?? (Math.abs(az) < 0.9 ? ([0, 0, 1] as const) : ([1, 0, 0] as const));
  const d = seed[0] * ax + seed[1] * ay + seed[2] * az;
  let x = seed[0] - ax * d;
  let y = seed[1] - ay * d;
  let z = seed[2] - az * d;
  let l = Math.hypot(x, y, z);
  if (l < 1e-9) {
    const alt = Math.abs(ax) < 0.9 ? ([1, 0, 0] as const) : ([0, 1, 0] as const);
    const e = alt[0] * ax + alt[1] * ay + alt[2] * az;
    x = alt[0] - ax * e;
    y = alt[1] - ay * e;
    z = alt[2] - az * e;
    l = Math.hypot(x, y, z) || 1;
  }
  return [x / l, y / l, z / l];
}

/**
 * The parent skin of a squashed parent: the radius at ring angle phi is multiplied by `squashRadius(phi)`, so the weld rings
 * land on the flattened profile that the parent's mesh really has. Normals come from the gradient of the new distance.
 */
export function squashSurface(base: ParentSurface, input: SquashInput): ParentSurface {
  if (!(input.amount > 0)) return base;
  const [px, py, pz] = input.position;
  const [tx, ty, tz] = base.axis;
  const [nx, ny, nz] = input.normal;
  // B = axis x normal
  const bx = ty * nz - tz * ny;
  const by = tz * nx - tx * nz;
  const bz = tx * ny - ty * nx;
  const distance = (x: number, y: number, z: number): number => {
    const dx = x - px;
    const dy = y - py;
    const dz = z - pz;
    const a = dx * tx + dy * ty + dz * tz;
    const rx = dx - a * tx;
    const ry = dy - a * ty;
    const rz = dz - a * tz;
    const rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const sd = base.signedDistance(x, y, z);
    const local = Math.max(0, rho - sd);
    const phi = Math.atan2(rx * bx + ry * by + rz * bz, rx * nx + ry * ny + rz * nz);
    return rho - local * squashRadius(phi, input.amount, input.angle);
  };
  return {
    // The weld solver sizes its search from the radius: the mean of the short and the long semi-axis.
    radius: base.radius * (1 + squashRatio(input.amount)) * 0.5,
    axis: base.axis,
    signedDistance: distance,
    normal(x, y, z, out, offset) {
      const e = Math.max(1e-5, base.radius * 1e-3);
      const gx = distance(x + e, y, z) - distance(x - e, y, z);
      const gy = distance(x, y + e, z) - distance(x, y - e, z);
      const gz = distance(x, y, z + e) - distance(x, y, z - e);
      const l = Math.hypot(gx, gy, gz);
      if (l < 1e-12) {
        base.normal(x, y, z, out, offset);
        return;
      }
      out[offset] = gx / l;
      out[offset + 1] = gy / l;
      out[offset + 2] = gz / l;
    },
    nearEnd: (x, y, z) => base.nearEnd(x, y, z),
  };
}
