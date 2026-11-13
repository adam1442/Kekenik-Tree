import { cross, norm, type V3 } from './math3';

/** Column-major 4x4 rigid transform (rotation + translation, unit basis). */
export type Mat4 = readonly number[] | Float32Array;

/** Orthonormal frame: `direction` = +Y (growth), `up` = +Z (card normal), +X = direction x up. */
export interface Frame {
  position: V3;
  direction: V3;
  up: V3;
}

export const IDENTITY_FRAME: Frame = { position: [0, 0, 0], direction: [0, 1, 0], up: [0, 0, 1] };

/** Orthonormal (x, y, z) basis of a frame. `up` is made perpendicular to `direction`. */
export function frameBasis(f: Frame): { x: V3; y: V3; z: V3 } {
  const y = norm(f.direction, [0, 1, 0]);
  const d = f.up[0] * y[0] + f.up[1] * y[1] + f.up[2] * y[2];
  let z = norm([f.up[0] - y[0] * d, f.up[1] - y[1] * d, f.up[2] - y[2] * d], [0, 0, 1]);
  if (Math.hypot(f.up[0] - y[0] * d, f.up[1] - y[1] * d, f.up[2] - y[2] * d) < 1e-9) {
    z = Math.abs(y[2]) < 0.9 ? norm(cross([0, 0, 1], y), [1, 0, 0]) : norm(cross([1, 0, 0], y), [0, 1, 0]);
    z = norm(cross(y, cross(z, y)), z);
  }
  const x = norm(cross(y, z), [1, 0, 0]);
  return { x, y, z };
}

export function frameToMat(f: Frame): number[] {
  const { x, y, z } = frameBasis(f);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, f.position[0], f.position[1], f.position[2], 1];
}

export function matToFrame(m: Mat4): Frame {
  return { position: [m[12] as number, m[13] as number, m[14] as number], direction: [m[4] as number, m[5] as number, m[6] as number], up: [m[8] as number, m[9] as number, m[10] as number] };
}

export function mat4Mul(a: Mat4, b: Mat4): number[] {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += (a[k * 4 + r] as number) * (b[c * 4 + k] as number);
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Inverse of a rigid transform (unit basis): R^T and -R^T t. */
export function rigidInverse(m: Mat4): number[] {
  const x = [m[0], m[1], m[2]] as number[];
  const y = [m[4], m[5], m[6]] as number[];
  const z = [m[8], m[9], m[10]] as number[];
  const t = [m[12], m[13], m[14]] as number[];
  const d = (a: number[]): number => -(a[0]! * t[0]! + a[1]! * t[1]! + a[2]! * t[2]!);
  // Rows of R^T are the basis vectors, so column c of the inverse holds component c of x, y, z.
  return [x[0]!, y[0]!, z[0]!, 0, x[1]!, y[1]!, z[1]!, 0, x[2]!, y[2]!, z[2]!, 0, d(x), d(y), d(z), 1];
}

export function transformPoint(m: Mat4, p: V3): V3 {
  return [
    (m[0] as number) * p[0] + (m[4] as number) * p[1] + (m[8] as number) * p[2] + (m[12] as number),
    (m[1] as number) * p[0] + (m[5] as number) * p[1] + (m[9] as number) * p[2] + (m[13] as number),
    (m[2] as number) * p[0] + (m[6] as number) * p[1] + (m[10] as number) * p[2] + (m[14] as number),
  ];
}

/**
 * Transform of a child instance planted on an anchor.
 *   world = parentInstanceTransform * anchorFrame * inverse(childBaseFrame)
 * `anchor` is expressed in the PARENT INSTANCE's local frame; `childBase` is the child's own base frame in ITS local
 * frame (identity for cutouts: origin = axis base, +Y = base tangent, +Z = card normal).
 */
export function composeFrame(parentInstanceTransform: Mat4, anchor: Frame, childBase: Frame = IDENTITY_FRAME): number[] {
  return mat4Mul(mat4Mul(parentInstanceTransform, frameToMat(anchor)), rigidInverse(frameToMat(childBase)));
}
