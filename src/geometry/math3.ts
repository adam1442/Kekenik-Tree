/** Tiny allocation-friendly vector helpers shared by the mesh builders. */
export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function norm(a: V3, fallback: V3 = [0, 0, 1]): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l < 1e-12 ? [fallback[0], fallback[1], fallback[2]] : [a[0] / l, a[1] / l, a[2] / l];
}

/** Rodrigues rotation of `v` around unit `axis`. */
export function rotate(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

/** Any unit vector perpendicular to `t`, stable for the world-up case. */
export function perpendicular(t: V3, hint: V3 = [0, 0, 1]): V3 {
  const h = Math.abs(dot(t, hint)) > 0.95 ? ([1, 0, 0] as V3) : hint;
  return norm(cross(h, t), [1, 0, 0]);
}

/** Remove the component of `v` along unit `t`, normalise. Falls back to `perpendicular(t)`. */
export function orthogonalize(v: V3, t: V3): V3 {
  const d = dot(v, t);
  const r: V3 = [v[0] - t[0] * d, v[1] - t[1] * d, v[2] - t[2] * d];
  return len(r) < 1e-6 ? perpendicular(t) : norm(r);
}

/** Deterministic 0..1 hash of an integer pair (no RNG state needed). */
export function hash01(a: number, b = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x165667b1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
