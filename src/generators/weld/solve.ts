import { weldSegmentCount } from '@/generators/spine/segmentMath';
import type { ParentSurface } from './surface';

/** The child's centre line as the mesher sees it: per sample position, radius, ring frame and arc length from the base. */
export interface ChildPath {
  count: number;
  /** `count * 3`. */
  pos: ArrayLike<number>;
  rad: ArrayLike<number>;
  /** Unit ring normal N per sample (`count * 3`), perpendicular to the tangent. */
  nrm: ArrayLike<number>;
  /** Unit tangent per sample (`count * 3`). */
  tan: ArrayLike<number>;
  /** Arc length of every sample from the first one (`s[0] = 0`, ascending). */
  s: ArrayLike<number>;
}

export interface WeldSettings {
  /** Columns (radial segments) of a ring. */
  sides: number;
  /** Segments of the fused part (rings = segments + 1). */
  segments: number;
  /** Length of the weld part beyond the surface, in metres. */
  offset: number;
  /** Extra widening of the base: fraction of the child radius added at the parent skin. */
  spread: number;
  /** Additional widening on the side that faces the parent tip / base. */
  upper: number;
  lower: number;
  /** sqrt(aspect) of the cross-section (1 = round). */
  aspect?: number;
  /** Section radius multiplier at a ring angle and arc length (ridges, lobes...). */
  section?: (angle: number, s: number) => number;
  /** Only decide success / failure (no vertices). */
  analyzeOnly?: boolean;
}

export type WeldFailure = 'parent' | 'degenerate' | 'inside' | 'noExit' | 'short' | 'cap' | 'inverted';

export interface WeldResult {
  ok: boolean;
  failure: WeldFailure | null;
  /** Rings (`segments + 1`); 0 when the weld failed or was only analysed. */
  rings: number;
  sides: number;
  /** `rings * sides * 3`: vertices from the parent skin (ring 0) out to the plain child circle (last ring). */
  positions: Float32Array;
  /** Unit radial direction of every vertex around the child axis. */
  dirs: Float32Array;
  /** Outward normal of the parent skin at every vertex. */
  parentNormals: Float32Array;
  /** Arc length along the child of every vertex (for the V coordinate). */
  vs: Float32Array;
  /** Mean arc length of every ring. */
  ringS: Float32Array;
  /** Weight of the parent normal per ring (1 on the skin, 0 at the last ring). */
  blend: Float32Array;
  /** Arc length range of the weld part. */
  sStart: number;
  sEnd: number;
}

/** Segments the fused part has at Weld scalar 1. */
export const WELD_NATURAL_SEGMENTS = 4;
/** Widening never exceeds this fraction of the parent radius (the base must stay inside the parent). */
const MAX_BASE_FRACTION = 0.95;
const MARCH_STEPS = 48;
const BACKOFF_STEPS = 16;
const MAX_REFINE = 40;
/** Refinement stops when the column point is this close to the skin, relative to the parent radius. */
const SKIN_TOLERANCE = 1e-7;
const EMPTY = new Float32Array(0);

const smoothstep = (f: number): number => f * f * (3 - 2 * f);

/** Rings of the weld part for a Weld scalar. */
export function weldRingCount(weldScalar: number): number {
  return weldSegmentCount(WELD_NATURAL_SEGMENTS, weldScalar) + 1;
}

function failed(failure: WeldFailure, sides: number): WeldResult {
  return {
    ok: false,
    failure,
    rings: 0,
    sides,
    positions: EMPTY,
    dirs: EMPTY,
    parentNormals: EMPTY,
    vs: EMPTY,
    ringS: EMPTY,
    blend: EMPTY,
    sStart: 0,
    sEnd: 0,
  };
}

/** Evaluates the child centre line (linear between samples, linear extrapolation beyond the ends) with its ring frame. */
export class ChildPathEvaluator {
  px = 0;
  py = 0;
  pz = 0;
  r = 0;
  nx = 0;
  ny = 0;
  nz = 0;
  bx = 0;
  by = 0;
  bz = 0;
  tx = 0;
  ty = 0;
  tz = 0;

  constructor(private readonly path: ChildPath) {}

  at(s: number): void {
    const p = this.path;
    const n = p.count;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((p.s[mid] as number) <= s) lo = mid;
      else hi = mid;
    }
    const s0 = p.s[lo] as number;
    const span = (p.s[hi] as number) - s0;
    const f = span > 1e-12 ? (s - s0) / span : 0;
    const fc = f < 0 ? 0 : f > 1 ? 1 : f;
    const a = lo * 3;
    const b = hi * 3;
    this.px = (p.pos[a] as number) + ((p.pos[b] as number) - (p.pos[a] as number)) * f;
    this.py = (p.pos[a + 1] as number) + ((p.pos[b + 1] as number) - (p.pos[a + 1] as number)) * f;
    this.pz = (p.pos[a + 2] as number) + ((p.pos[b + 2] as number) - (p.pos[a + 2] as number)) * f;
    this.r = (p.rad[lo] as number) + ((p.rad[hi] as number) - (p.rad[lo] as number)) * fc;
    let tx = (p.tan[a] as number) + ((p.tan[b] as number) - (p.tan[a] as number)) * fc;
    let ty = (p.tan[a + 1] as number) + ((p.tan[b + 1] as number) - (p.tan[a + 1] as number)) * fc;
    let tz = (p.tan[a + 2] as number) + ((p.tan[b + 2] as number) - (p.tan[a + 2] as number)) * fc;
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    let nx = (p.nrm[a] as number) + ((p.nrm[b] as number) - (p.nrm[a] as number)) * fc;
    let ny = (p.nrm[a + 1] as number) + ((p.nrm[b + 1] as number) - (p.nrm[a + 1] as number)) * fc;
    let nz = (p.nrm[a + 2] as number) + ((p.nrm[b + 2] as number) - (p.nrm[a + 2] as number)) * fc;
    const d = nx * tx + ny * ty + nz * tz;
    nx -= tx * d;
    ny -= ty * d;
    nz -= tz * d;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    this.nx = nx;
    this.ny = ny;
    this.nz = nz;
    this.tx = tx;
    this.ty = ty;
    this.tz = tz;
    this.bx = ty * nz - tz * ny;
    this.by = tz * nx - tx * nz;
    this.bz = tx * ny - ty * nx;
  }
}

/**
 * Welds the base of a child tube into its parent. For every column of the child's cross-section the line (curve) it
 * follows is traced from inside the parent until it leaves the parent skin; that point is ring 0, so the base ring is a
 * closed loop lying on the parent's surface (no gap at any angle). The following rings blend from that loop to the plain
 * child circle `offset` metres beyond the last skin crossing, while the widening (Spread) fades out.
 *
 * Failure (`ok = false`): the parent is degenerate, the child base is wider than the parent (a vertex starts outside),
 * a column never leaves the parent along the child ("ray miss"), the weld part is longer than the child, the weld ends on a
 * cap of the parent, or the base ring is inverted.
 */
export function solveWeld(path: ChildPath, surface: ParentSurface, st: WeldSettings): WeldResult {
  const V = Math.max(3, Math.round(st.sides));
  const segments = Math.max(1, Math.round(st.segments));
  const n = path.count;
  if (n < 2 || !(surface.radius > 1e-6) || !Number.isFinite(surface.radius)) return failed('parent', V);
  const ltot = path.s[n - 1] as number;
  const r0 = path.rad[0] as number;
  if (!(ltot > 1e-9) || !(r0 > 1e-6)) return failed('degenerate', V);

  const sqrtA = Math.max(0.05, st.aspect ?? 1);
  const maxAspect = Math.max(sqrtA, 1 / sqrtA);
  const section = st.section;
  const ev = new ChildPathEvaluator(path);

  // --- widening of the base per column (upper = towards the parent tip, lower = towards its base)
  ev.at(0);
  const angle = new Float64Array(V);
  const cosA = new Float64Array(V);
  const sinA = new Float64Array(V);
  const mult0 = new Float64Array(V);
  const cap = Math.max(1, (MAX_BASE_FRACTION * surface.radius) / (r0 * maxAspect));
  const ax = surface.axis;
  for (let j = 0; j < V; j++) {
    const a = (2 * Math.PI * j) / V;
    angle[j] = a;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    cosA[j] = c * sqrtA;
    sinA[j] = sn / sqrtA;
    const k = (ev.nx * c + ev.bx * sn) * ax[0] + (ev.ny * c + ev.by * sn) * ax[1] + (ev.nz * c + ev.bz * sn) * ax[2];
    const widen = Math.max(0, st.spread) + Math.max(0, st.upper) * Math.max(0, k) + Math.max(0, st.lower) * Math.max(0, -k);
    mult0[j] = Math.min(cap, 1 + widen);
  }

  // Point of column j at arc length s with radius multiplier m (written to `q`).
  const q: [number, number, number] = [0, 0, 0];
  const column = (j: number, s: number, m: number): void => {
    ev.at(s);
    const c = cosA[j] as number;
    const sn = sinA[j] as number;
    const k = ev.r * m * (section ? section(angle[j] as number, s) : 1);
    q[0] = ev.px + (ev.nx * c + ev.bx * sn) * k;
    q[1] = ev.py + (ev.ny * c + ev.by * sn) * k;
    q[2] = ev.pz + (ev.nz * c + ev.bz * sn) * k;
  };
  const g = (j: number, s: number, m: number): number => {
    column(j, s, m);
    return surface.signedDistance(q[0], q[1], q[2]);
  };

  // --- ring 0: where every column leaves the parent skin
  const sj = new Float64Array(V);
  const step = ltot / MARCH_STEPS;
  // How far a base that starts outside the parent may be extended backwards.
  const backoff = 3 * (surface.radius + r0 * maxAspect * 2);
  let sMax = -Infinity;
  let sMin = Infinity;
  for (let j = 0; j < V; j++) {
    const m = mult0[j] as number;
    // Start inside the parent. A base the generator pushed out of the parent (it starts on or beyond the skin) is
    // extended backwards along its first tangent until it is buried again; the weld then starts where that
    // extension crosses the skin.
    let lo = 0;
    if (!(g(j, 0, m) < 0)) {
      lo = Number.NaN;
      for (let k = 1; k <= BACKOFF_STEPS; k++) {
        const s = -(k * backoff) / BACKOFF_STEPS;
        if (g(j, s, m) < 0) {
          lo = s;
          break;
        }
      }
      if (Number.isNaN(lo)) return failed('inside', V);
    }
    let hi = Number.NaN;
    let ghi = 0;
    let glo = g(j, lo, m);
    for (let i = 1; i <= MARCH_STEPS; i++) {
      const s = lo + i * step;
      const gs = g(j, s, m);
      if (gs >= 0) {
        hi = s;
        ghi = gs;
        break;
      }
      lo = s;
      glo = gs;
    }
    if (Number.isNaN(hi)) return failed('noExit', V);
    // Illinois (bracketed false position): converges in a handful of evaluations, never leaves the bracket.
    let side = 0;
    const tol = SKIN_TOLERANCE * surface.radius;
    for (let it = 0; it < MAX_REFINE && hi - lo > 1e-12; it++) {
      const mid = ghi - glo > 1e-18 ? (lo * ghi - hi * glo) / (ghi - glo) : 0.5 * (lo + hi);
      const gm = g(j, mid, m);
      if (Math.abs(gm) < tol) {
        lo = mid;
        hi = mid;
        break;
      }
      if (gm >= 0) {
        hi = mid;
        ghi = gm;
        if (side === 1) glo *= 0.5;
        side = 1;
      } else {
        lo = mid;
        glo = gm;
        if (side === -1) ghi *= 0.5;
        side = -1;
      }
    }
    const s = 0.5 * (lo + hi);
    sj[j] = s;
    if (s > sMax) sMax = s;
    if (s < sMin) sMin = s;
  }
  const offset = Math.max(st.offset, 0.05 * r0);
  const sEnd = sMax + offset;
  if (!(sEnd <= ltot * 0.97)) return failed('short', V);

  // Ring 0 must lie on the side of the parent, be a proper loop and not be inverted.
  let area = 0;
  ev.at(0);
  const n0x = ev.nx;
  const n0y = ev.ny;
  const n0z = ev.nz;
  const b0x = ev.bx;
  const b0y = ev.by;
  const b0z = ev.bz;
  const p0x = ev.px;
  const p0y = ev.py;
  const p0z = ev.pz;
  let prevU = 0;
  let prevV = 0;
  let firstU = 0;
  let firstV = 0;
  for (let j = 0; j < V; j++) {
    column(j, sj[j] as number, mult0[j] as number);
    if (surface.nearEnd(q[0], q[1], q[2])) return failed('cap', V);
    const dx = q[0] - p0x;
    const dy = q[1] - p0y;
    const dz = q[2] - p0z;
    const u = dx * n0x + dy * n0y + dz * n0z;
    const v = dx * b0x + dy * b0y + dz * b0z;
    if (j === 0) {
      firstU = u;
      firstV = v;
    } else {
      area += prevU * v - prevV * u;
    }
    prevU = u;
    prevV = v;
  }
  area = 0.5 * (area + (prevU * firstV - prevV * firstU));
  const idealArea = 0.5 * V * r0 * r0 * Math.sin((2 * Math.PI) / V);
  if (!(area > 0.2 * idealArea)) return failed('inverted', V);

  if (st.analyzeOnly) return { ...failed('degenerate', V), ok: true, failure: null, sStart: sMin, sEnd };

  // --- rings 0..segments: blend from the skin loop to the plain child circle
  const rings = segments + 1;
  const positions = new Float32Array(rings * V * 3);
  const dirs = new Float32Array(rings * V * 3);
  const parentNormals = new Float32Array(rings * V * 3);
  const vs = new Float32Array(rings * V);
  const ringS = new Float32Array(rings);
  const blend = new Float32Array(rings);
  for (let i = 0; i < rings; i++) {
    const f = i / segments;
    const fall = 1 - smoothstep(f);
    blend[i] = fall;
    let sum = 0;
    for (let j = 0; j < V; j++) {
      const s0 = sj[j] as number;
      const s = s0 + f * (sEnd - s0);
      const m = 1 + ((mult0[j] as number) - 1) * fall;
      column(j, s, m);
      const o = (i * V + j) * 3;
      positions[o] = q[0];
      positions[o + 1] = q[1];
      positions[o + 2] = q[2];
      const c = cosA[j] as number;
      const sn = sinA[j] as number;
      const dx = ev.nx * c + ev.bx * sn;
      const dy = ev.ny * c + ev.by * sn;
      const dz = ev.nz * c + ev.bz * sn;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dirs[o] = dx / dl;
      dirs[o + 1] = dy / dl;
      dirs[o + 2] = dz / dl;
      surface.normal(q[0], q[1], q[2], parentNormals, o);
      vs[i * V + j] = s;
      sum += s;
    }
    ringS[i] = sum / V;
  }
  return { ok: true, failure: null, rings, sides: V, positions, dirs, parentNormals, vs, ringS, blend, sStart: sMin, sEnd };
}
