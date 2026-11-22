import { cross, dot, norm, orthogonalize, rotate, type V3 } from './math3';
import { signedAngleAround } from './leafPlacement';

/**
 * Rib model of the Frond generator (pure, no graph / mesh dependencies).
 *
 * A frond is built from ribs: at every station of the parent spine (the ends of its length segments) a left and a right rib
 * runs perpendicular to the spine, in the frame of the spine. A rib is a polyline of `accuracy + 1` points; point 0 is the
 * spine point itself, so the centre line never detaches. The final mesh (a cutout mesh or the plain ribbon grid) is mapped
 * onto the ribs by (u across, v along).
 *
 * Frame: `tangent` T (base -> tip), `normal` N (face), `side` B = T x N. Side +1 (right) lies along +B, side -1 (left) along -B.
 * Sign conventions of the rib deformation (all in the frame of the spine):
 *   fold  > 0  both sides rotate toward +N about the spine (a V seen from the face), < 0 toward -N
 *   curl  > 0  the outer part of every rib rolls toward +N and then back toward the spine, < 0 toward -N
 *   gravity > 0 pulls every rib point toward the ground (world -Z) by `gravity * halfWidth * x^2` (x = distance fraction),
 *               < 0 lifts it
 */

/** Multipliers of one half of a frond for the deformations that can differ between left and right. */
export interface SideScale {
  fold: number;
  curl: number;
  gravity: number;
}

export const UNIT_SIDE_SCALE: Readonly<SideScale> = { fold: 1, curl: 1, gravity: 1 };

export interface RibSettings {
  /** Half of the frond width (metres) at arc fraction t. */
  halfWidthAt: (t: number) => number;
  /** Fold angle (radians) at t. */
  fold: (t: number) => number;
  /** Curl angle (radians): angle between the centre and the edge of a rib at t. */
  curl: (t: number) => number;
  /** Gravity pull at t (fraction of the half width at the edge). */
  gravity: (t: number) => number;
  /** Roll of the whole frond about the parent spine (radians). */
  roll: number;
  /** Segments per rib (>= 1). */
  accuracy: number;
  /** Desired face direction at the base (made perpendicular to the spine). */
  hint: V3;
  /** Align: blends the face of every station toward `-alignDir` (e.g. the sky for a gravity force). */
  alignAmount: number;
  alignDir: V3 | null;
  /** Left-Right Variance: own Fold / Curl / Gravity multipliers per half (1 = unchanged). */
  sides?: { left: Readonly<SideScale>; right: Readonly<SideScale> };
}

export interface Ribs {
  /** Number of stations = number of rib pairs. */
  count: number;
  accuracy: number;
  /** Arc length of the spine (metres). */
  length: number;
  /** xyz per station. */
  point: Float32Array;
  tangent: Float32Array;
  normal: Float32Array;
  side: Float32Array;
  /** Arc fraction 0..1 and arc length (metres) per station. */
  t: Float32Array;
  s: Float32Array;
  halfWidth: Float32Array;
  /**
   * Rib polylines: for station i and side index k (0 = left, 1 = right) the `accuracy + 1` points start at
   * `((i * 2 + k) * (accuracy + 1)) * 3`.
   */
  rib: Float32Array;
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Removes coincident points so every length segment has a direction. */
export function cleanPath(path: readonly V3[]): V3[] {
  const out: V3[] = [];
  for (const p of path) if (out.length === 0 || dist(p, out[out.length - 1] as V3) > 1e-7) out.push(p);
  return out;
}

/** Number of ribs a path produces: one per station of the (cleaned) path. */
export const ribCountOf = (path: readonly V3[]): number => cleanPath(path).length;

export function buildRibs(path: readonly V3[], set: RibSettings): Ribs | null {
  const pts = cleanPath(path);
  const n = pts.length;
  if (n < 2) return null;
  const A = Math.max(1, Math.round(set.accuracy));
  const dirs: V3[] = [];
  const s = new Float32Array(n);
  for (let k = 0; k < n - 1; k++) {
    const a = pts[k] as V3;
    const b = pts[k + 1] as V3;
    dirs.push(norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
    s[k + 1] = (s[k] as number) + dist(a, b);
  }
  const length = s[n - 1] as number;
  const T: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = dirs[Math.max(0, k - 1)] as V3;
    const b = dirs[Math.min(n - 2, k)] as V3;
    T.push(norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]], b));
  }
  // Parallel transport of the face normal along the spine.
  const N: V3[] = [orthogonalize(set.hint, T[0] as V3)];
  for (let k = 1; k < n; k++) {
    const t0 = T[k - 1] as V3;
    const t1 = T[k] as V3;
    const axis = cross(t0, t1);
    const sin = Math.hypot(axis[0], axis[1], axis[2]);
    const prev = N[k - 1] as V3;
    if (sin < 1e-9) {
      N.push(orthogonalize(prev, t1));
      continue;
    }
    const angle = Math.atan2(sin, dot(t0, t1));
    N.push(orthogonalize(rotate(prev, [axis[0] / sin, axis[1] / sin, axis[2] / sin], angle), t1));
  }
  const point = new Float32Array(n * 3);
  const tangent = new Float32Array(n * 3);
  const normal = new Float32Array(n * 3);
  const side = new Float32Array(n * 3);
  const t = new Float32Array(n);
  const halfWidth = new Float32Array(n);
  const rib = new Float32Array(n * 2 * (A + 1) * 3);
  const align = set.alignDir && set.alignAmount > 0 ? norm([-set.alignDir[0], -set.alignDir[1], -set.alignDir[2]]) : null;
  for (let i = 0; i < n; i++) {
    const P = pts[i] as V3;
    const Ti = T[i] as V3;
    let Ni = N[i] as V3;
    if (align && Math.abs(dot(align, Ti)) < 0.999) {
      // A face that already lies along the spine direction has no defined target: the transported frame is kept.
      Ni = rotate(Ni, Ti, signedAngleAround(Ni, orthogonalize(align, Ti), Ti) * Math.min(1, set.alignAmount));
    }
    if (set.roll !== 0) Ni = rotate(Ni, Ti, set.roll);
    const Bi = cross(Ti, Ni);
    const ti = length > 1e-12 ? (s[i] as number) / length : 0;
    t[i] = ti;
    const hw = Math.max(0, set.halfWidthAt(ti));
    halfWidth[i] = hw;
    point.set(P, i * 3);
    tangent.set(Ti, i * 3);
    normal.set(Ni, i * 3);
    side.set(Bi, i * 3);
    const foldBase = set.fold(ti);
    const curlBase = set.curl(ti);
    const gravBase = set.gravity(ti);
    for (let k = 0; k < 2; k++) {
      const sigma = k === 0 ? -1 : 1;
      const sc = (k === 0 ? set.sides?.left : set.sides?.right) ?? UNIT_SIDE_SCALE;
      const fold = foldBase * sc.fold;
      const curl = curlBase * sc.curl;
      const grav = gravBase * sc.gravity;
      const cf = Math.cos(fold);
      const sf = Math.sin(fold);
      for (let j = 0; j <= A; j++) {
        const x = j / A;
        const d = x * hw;
        let lat = d;
        let h = 0;
        if (Math.abs(curl) > 1e-6 && hw > 1e-9) {
          const R = hw / curl;
          lat = R * Math.sin(d / R);
          h = R * (1 - Math.cos(d / R));
        }
        const l2 = lat * cf - h * sf;
        const h2 = lat * sf + h * cf;
        const q = ((i * 2 + k) * (A + 1) + j) * 3;
        rib[q] = P[0] + sigma * Bi[0] * l2 + Ni[0] * h2;
        rib[q + 1] = P[1] + sigma * Bi[1] * l2 + Ni[1] * h2;
        rib[q + 2] = P[2] + sigma * Bi[2] * l2 + Ni[2] * h2 - grav * hw * x * x;
      }
    }
  }
  return { count: n, accuracy: A, length, point, tangent, normal, side, t, s, halfWidth, rib };
}

/** Writes the point of station `i` at lateral coordinate `u` (-1 left edge .. 0 spine .. +1 right edge) to `out[o..o+2]`. */
export function sampleRib(r: Ribs, i: number, u: number, out: Float32Array | number[], o: number): void {
  const A = r.accuracy;
  const k = u < 0 ? 0 : 1;
  const x = Math.min(1, Math.abs(u)) * A;
  const j0 = Math.min(A - 1, Math.floor(x));
  const f = x - j0;
  const q = ((i * 2 + k) * (A + 1) + j0) * 3;
  const rb = r.rib;
  out[o] = (rb[q] as number) + ((rb[q + 3] as number) - (rb[q] as number)) * f;
  out[o + 1] = (rb[q + 1] as number) + ((rb[q + 4] as number) - (rb[q + 1] as number)) * f;
  out[o + 2] = (rb[q + 2] as number) + ((rb[q + 5] as number) - (rb[q + 2] as number)) * f;
}

/** Station interval of arc fraction `v`: the point lies between station `i` and `i + 1` at fraction `f`. */
export function locateStation(r: Ribs, v: number): { i: number; f: number } {
  const n = r.count;
  const vv = Math.min(1, Math.max(0, v));
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((r.t[mid] as number) <= vv) lo = mid;
    else hi = mid;
  }
  const span = (r.t[hi] as number) - (r.t[lo] as number);
  return { i: lo, f: span > 1e-12 ? Math.min(1, Math.max(0, (vv - (r.t[lo] as number)) / span)) : 0 };
}

const SCRATCH_A: number[] = [0, 0, 0];
const SCRATCH_B: number[] = [0, 0, 0];

/** Maps (u across -1..1, v along 0..1) onto the ribs: position into `out[o..]`, interpolated face normal into `nOut[no..]`. */
export function mapToRibs(r: Ribs, u: number, v: number, out: Float32Array | number[], o: number, nOut?: Float32Array | number[], no = 0): void {
  const { i, f } = locateStation(r, v);
  const j = Math.min(r.count - 1, i + 1);
  sampleRib(r, i, u, SCRATCH_A, 0);
  sampleRib(r, j, u, SCRATCH_B, 0);
  for (let c = 0; c < 3; c++) out[o + c] = (SCRATCH_A[c] as number) + ((SCRATCH_B[c] as number) - (SCRATCH_A[c] as number)) * f;
  if (nOut) {
    const nx = (r.normal[i * 3] as number) * (1 - f) + (r.normal[j * 3] as number) * f;
    const ny = (r.normal[i * 3 + 1] as number) * (1 - f) + (r.normal[j * 3 + 1] as number) * f;
    const nz = (r.normal[i * 3 + 2] as number) * (1 - f) + (r.normal[j * 3 + 2] as number) * f;
    const l = Math.hypot(nx, ny, nz) || 1;
    nOut[no] = nx / l;
    nOut[no + 1] = ny / l;
    nOut[no + 2] = nz / l;
  }
}

/** Vertex columns across a ribbon: `absolute` + `relative` per metre of parent length, forced even (a vertex row on the centre line). */
export function ribbonColumns(absolute: number, relative: number, parentLength: number): number {
  const w = Math.max(1, Math.round(absolute) + Math.round(Math.max(0, relative) * Math.max(0, parentLength)));
  return Math.min(64, w + (w % 2));
}

export interface ForceBend {
  /** Pull toward world -Z (+) / +Z (-) per arc fraction. */
  gravity: (t: number) => number;
  /** Pull toward +Z (+) / -Z (-) per arc fraction. */
  upDown: (t: number) => number;
  /** Pull toward the direction of the base segment (+) / away from it (-) per arc fraction. */
  ancestor: (t: number) => number;
}

/**
 * Bends a spine polyline with the frond's own forces. Segment lengths are preserved and the base point stays fixed, so
 * the frond keeps the length of its parent spine. Each segment's direction is steered by the strength at its middle.
 */
export function bendPath(path: readonly V3[], f: ForceBend): V3[] {
  const pts = cleanPath(path);
  const n = pts.length;
  if (n < 2) return pts;
  const lens: number[] = [];
  const dirs: V3[] = [];
  let total = 0;
  for (let k = 0; k < n - 1; k++) {
    const a = pts[k] as V3;
    const b = pts[k + 1] as V3;
    const l = dist(a, b);
    lens.push(l);
    dirs.push(norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]));
    total += l;
  }
  const base = dirs[0] as V3;
  const out: V3[] = [pts[0] as V3];
  let acc = 0;
  for (let k = 0; k < n - 1; k++) {
    const len = lens[k] as number;
    const tm = total > 1e-12 ? (acc + len * 0.5) / total : 0;
    acc += len;
    const d = dirs[k] as V3;
    const an = f.ancestor(tm);
    const dz = f.upDown(tm) - f.gravity(tm);
    const dd = norm([d[0] + base[0] * an, d[1] + base[1] * an, d[2] + base[2] * an + dz], d);
    const p = out[k] as V3;
    out.push([p[0] + dd[0] * len, p[1] + dd[1] * len, p[2] + dd[2] * len]);
  }
  return out;
}

/** Direction (unit) the enabled Gravity / Up-Down forces push toward on average, or null when they cancel out. */
export function netForceDirection(gravity: number, upDown: number): V3 | null {
  const z = upDown - gravity;
  return Math.abs(z) < 1e-9 ? null : [0, 0, Math.sign(z)];
}
