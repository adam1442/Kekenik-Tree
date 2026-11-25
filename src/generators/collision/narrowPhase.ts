import { cross, dot, sub, type V3 } from '@/geometry/math3';
import type { Obb } from './bounds';

const EPS = 1e-9;

/** Sphere vs sphere (strict overlap). */
export function sphereHit(ax: number, ay: number, az: number, ar: number, bx: number, by: number, bz: number, br: number): boolean {
  const rr = ar + br;
  return (ax - bx) ** 2 + (ay - by) ** 2 + (az - bz) ** 2 < rr * rr;
}

/** Oriented box vs oriented box (separating axis test, 15 axes). */
export function obbHit(a: Obb, b: Obb): boolean {
  const R: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const AbsR: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const v = dot(a.axes[i] as V3, b.axes[j] as V3);
      (R[i] as number[])[j] = v;
      (AbsR[i] as number[])[j] = Math.abs(v) + EPS;
    }
  const d = sub(b.c, a.c);
  const t: V3 = [dot(d, a.axes[0]), dot(d, a.axes[1]), dot(d, a.axes[2])];
  const ah = a.h;
  const bh = b.h;
  const r = (i: number, j: number): number => (R[i] as number[])[j] as number;
  const ar = (i: number, j: number): number => (AbsR[i] as number[])[j] as number;
  for (let i = 0; i < 3; i++) {
    const ra = ah[i] as number;
    const rb = (bh[0] as number) * ar(i, 0) + (bh[1] as number) * ar(i, 1) + (bh[2] as number) * ar(i, 2);
    if (Math.abs(t[i] as number) > ra + rb) return false;
  }
  for (let j = 0; j < 3; j++) {
    const ra = (ah[0] as number) * ar(0, j) + (ah[1] as number) * ar(1, j) + (ah[2] as number) * ar(2, j);
    const rb = bh[j] as number;
    if (Math.abs((t[0] as number) * r(0, j) + (t[1] as number) * r(1, j) + (t[2] as number) * r(2, j)) > ra + rb) return false;
  }
  for (let i = 0; i < 3; i++) {
    const i1 = (i + 1) % 3;
    const i2 = (i + 2) % 3;
    for (let j = 0; j < 3; j++) {
      const j1 = (j + 1) % 3;
      const j2 = (j + 2) % 3;
      const ra = (ah[i1] as number) * ar(i2, j) + (ah[i2] as number) * ar(i1, j);
      const rb = (bh[j1] as number) * ar(i, j2) + (bh[j2] as number) * ar(i, j1);
      if (Math.abs((t[i2] as number) * r(i1, j) - (t[i1] as number) * r(i2, j)) > ra + rb) return false;
    }
  }
  return true;
}

/** Distance from a point to a box (0 inside). */
export function pointObbDistance(p: V3, b: Obb): number {
  const d = sub(p, b.c);
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const x = Math.abs(dot(d, b.axes[i] as V3)) - (b.h[i] as number);
    if (x > 0) s += x * x;
  }
  return Math.sqrt(s);
}

/** Minimum of `f(t)` for convex `f` on [0, 1] (ternary search). */
function minConvex(f: (t: number) => number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 28; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return f((lo + hi) / 2);
}

/** Tapered capsule (segment a-b, radii ra-rb) vs sphere. */
export function capsuleSphereHit(a: V3, b: V3, ra: number, rb: number, c: V3, r: number): boolean {
  const f = (t: number): number => Math.hypot(a[0] + (b[0] - a[0]) * t - c[0], a[1] + (b[1] - a[1]) * t - c[1], a[2] + (b[2] - a[2]) * t - c[2]) - (ra + (rb - ra) * t);
  return minConvex(f) < r;
}

/** Tapered capsule vs oriented box. */
export function capsuleObbHit(a: V3, b: V3, ra: number, rb: number, box: Obb): boolean {
  const f = (t: number): number => pointObbDistance([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], box) - (ra + (rb - ra) * t);
  return minConvex(f) < 0;
}

/** Axis-aligned boxes of two triangles overlap? (cheap reject before the exact test). */
export function triBoxesOverlap(a: readonly V3[], b: readonly V3[]): boolean {
  for (let k = 0; k < 3; k++) {
    const a0 = Math.min((a[0] as V3)[k] as number, (a[1] as V3)[k] as number, (a[2] as V3)[k] as number);
    const a1 = Math.max((a[0] as V3)[k] as number, (a[1] as V3)[k] as number, (a[2] as V3)[k] as number);
    const b0 = Math.min((b[0] as V3)[k] as number, (b[1] as V3)[k] as number, (b[2] as V3)[k] as number);
    const b1 = Math.max((b[0] as V3)[k] as number, (b[1] as V3)[k] as number, (b[2] as V3)[k] as number);
    if (a1 < b0 || b1 < a0) return false;
  }
  return true;
}

/** Overlap of two coplanar triangles (2D separating axes in the plane with normal `n`). */
function coplanarOverlap(a: readonly V3[], b: readonly V3[], n: V3): boolean {
  const axes: V3[] = [];
  for (const tri of [a, b])
    for (let i = 0; i < 3; i++) {
      const e = sub(tri[(i + 1) % 3] as V3, tri[i] as V3);
      axes.push(cross(n, e));
    }
  for (const ax of axes) {
    let a0 = Infinity;
    let a1 = -Infinity;
    let b0 = Infinity;
    let b1 = -Infinity;
    for (const p of a) {
      const d = dot(p, ax);
      a0 = Math.min(a0, d);
      a1 = Math.max(a1, d);
    }
    for (const p of b) {
      const d = dot(p, ax);
      b0 = Math.min(b0, d);
      b1 = Math.max(b1, d);
    }
    if (a1 < b0 - EPS || b1 < a0 - EPS) return false;
  }
  return true;
}

/**
 * Exact triangle - triangle intersection. The segment of A on the plane of B is clipped against B (Cyrus-Beck), so the
 * result is exactly A ∩ B. Returns the (possibly degenerate) segment, or null when the triangles do not touch.
 * Coplanar overlapping triangles return the centroid of A as a zero-length segment.
 */
export function triTriSegment(a: readonly V3[], b: readonly V3[]): [V3, V3] | null {
  const a0 = a[0] as V3;
  const a1 = a[1] as V3;
  const a2 = a[2] as V3;
  const b0 = b[0] as V3;
  const b1 = b[1] as V3;
  const b2 = b[2] as V3;
  const nB = cross(sub(b1, b0), sub(b2, b0));
  const lenB = Math.hypot(nB[0], nB[1], nB[2]);
  const nA = cross(sub(a1, a0), sub(a2, a0));
  const lenA = Math.hypot(nA[0], nA[1], nA[2]);
  if (lenB < 1e-14 || lenA < 1e-14) return null;
  const tol = 1e-9 * Math.sqrt(Math.max(lenA, lenB));
  const dA = [dot(nB, sub(a0, b0)) / lenB, dot(nB, sub(a1, b0)) / lenB, dot(nB, sub(a2, b0)) / lenB];
  if (dA.every((d) => d > tol) || dA.every((d) => d < -tol)) return null;
  const dB = [dot(nA, sub(b0, a0)) / lenA, dot(nA, sub(b1, a0)) / lenA, dot(nA, sub(b2, a0)) / lenA];
  if (dB.every((d) => d > tol) || dB.every((d) => d < -tol)) return null;
  if (dA.every((d) => Math.abs(d) <= tol)) {
    if (!coplanarOverlap(a, b, nB)) return null;
    const c: V3 = [(a0[0] + a1[0] + a2[0]) / 3, (a0[1] + a1[1] + a2[1]) / 3, (a0[2] + a1[2] + a2[2]) / 3];
    return [c, c];
  }
  const pts: V3[] = [];
  for (let i = 0; i < 3; i++) {
    const p = a[i] as V3;
    const q = a[(i + 1) % 3] as V3;
    const di = dA[i] as number;
    const dj = dA[(i + 1) % 3] as number;
    if (Math.abs(di) <= tol) pts.push(p);
    if ((di > tol && dj < -tol) || (di < -tol && dj > tol)) {
      const t = di / (di - dj);
      pts.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t]);
    }
  }
  if (pts.length === 0) return null;
  const p0 = pts[0] as V3;
  const p1 = pts.length > 1 ? (pts[pts.length - 1] as V3) : p0;
  let t0 = 0;
  let t1 = 1;
  const dir = sub(p1, p0);
  const slack = 1e-9 * Math.sqrt(lenB);
  for (let i = 0; i < 3; i++) {
    const e0 = b[i] as V3;
    const e1 = b[(i + 1) % 3] as V3;
    const m = cross(nB, sub(e1, e0));
    const ml = Math.hypot(m[0], m[1], m[2]);
    if (ml < 1e-18) return null;
    const f0 = dot(m, sub(p0, e0)) / ml;
    const fd = dot(m, dir) / ml;
    if (Math.abs(fd) < 1e-18) {
      if (f0 < -slack) return null;
      continue;
    }
    const t = -f0 / fd;
    if (fd > 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1 + 1e-12) return null;
  }
  return [
    [p0[0] + dir[0] * t0, p0[1] + dir[1] * t0, p0[2] + dir[2] * t0],
    [p0[0] + dir[0] * t1, p0[1] + dir[1] * t1, p0[2] + dir[2] * t1],
  ];
}

/** Boolean triangle - triangle test. */
export const triTriHit = (a: readonly V3[], b: readonly V3[]): boolean => triBoxesOverlap(a, b) && triTriSegment(a, b) !== null;
