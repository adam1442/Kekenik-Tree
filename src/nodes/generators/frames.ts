import type { Branch, Skeleton } from '@/contracts/skeleton';
import { clamp } from '@/core/math';

export type Vec3 = [number, number, number];

const EPS = 1e-8;

export function v3Len(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function v3Norm(v: Vec3, fallback: Vec3 = [0, 0, 1]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(l) || l < EPS) return [fallback[0], fallback[1], fallback[2]];
  return [v[0] / l, v[1] / l, v[2] / l];
}

export function v3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function v3Cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function v3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function v3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function v3Scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

export function v3Lerp(a: Vec3, b: Vec3, u: number): Vec3 {
  const t = clamp(u, 0, 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Rodrigues rotation of vector `v` around unit `axis` by `angleRad` radians. */
export function rotateAroundAxis(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  if (Math.abs(angleRad) < EPS) return [v[0], v[1], v[2]];
  const k = v3Norm(axis);
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const kv = v3Cross(k, v);
  const kd = v3Dot(k, v) * (1 - c);
  return [
    v[0] * c + kv[0] * s + k[0] * kd,
    v[1] * c + kv[1] * s + k[1] * kd,
    v[2] * c + kv[2] * s + k[2] * kd,
  ];
}

/** Deterministic unit vector perpendicular to unit `tangent`, smoothly respecting `hint` if non-collinear. */
export function orthonormalNormal(tangent: Vec3, hint?: Vec3): Vec3 {
  const T = v3Norm(tangent);
  if (hint) {
    const d = v3Dot(hint, T);
    const proj: Vec3 = [hint[0] - T[0] * d, hint[1] - T[1] * d, hint[2] - T[2] * d];
    const pl = v3Len(proj);
    if (Number.isFinite(pl) && pl > 1e-4) {
      return [proj[0] / pl, proj[1] / pl, proj[2] / pl];
    }
  }
  const ref: Vec3 = Math.abs(T[0]) < 0.85 ? [1, 0, 0] : [0, 1, 0];
  return v3Norm(v3Cross(T, ref), [1, 0, 0]);
}

/**
 * Double-reflection method (Wang et al., 2008) for one step of a Rotation-Minimizing Frame.
 * Transports normal `n0` (orthogonal to `t0` at `p0`) to `p1` with tangent `t1` without axial twist.
 */
export function advanceRMF(p0: Vec3, t0: Vec3, n0: Vec3, p1: Vec3, t1: Vec3): Vec3 {
  const v1 = v3Sub(p1, p0);
  const c1 = v3Dot(v1, v1);
  if (c1 < EPS * EPS) {
    return orthonormalNormal(t1, n0);
  }
  const rScale = (2 / c1) * v3Dot(v1, n0);
  const rL: Vec3 = [n0[0] - rScale * v1[0], n0[1] - rScale * v1[1], n0[2] - rScale * v1[2]];
  const tScale = (2 / c1) * v3Dot(v1, t0);
  const tL: Vec3 = [t0[0] - tScale * v1[0], t0[1] - tScale * v1[1], t0[2] - tScale * v1[2]];

  const v2 = v3Sub(t1, tL);
  const c2 = v3Dot(v2, v2);
  if (c2 < EPS * EPS) {
    return orthonormalNormal(t1, rL);
  }
  const nScale = (2 / c2) * v3Dot(v2, rL);
  const n1: Vec3 = [rL[0] - nScale * v2[0], rL[1] - nScale * v2[1], rL[2] - nScale * v2[2]];
  return orthonormalNormal(t1, n1);
}

export interface PolylineFrames {
  /** Smoothed unit tangents (count * 3). */
  tangents: Float32Array;
  /** Rotation-minimizing unit normals (count * 3), already including optional axial twist. */
  normals: Float32Array;
  /** Unit binormals T x N (count * 3). */
  binormals: Float32Array;
  /** Normalized arc-length parameter 0..1 per point (count). */
  t: Float32Array;
  /** Total polyline arc length in metres. */
  arcLength: number;
}

/**
 * Compute arc-length parameter `t`, central-difference unit tangents, and torsion-free RMF frames
 * along a polyline `positions` of `count` points (`count * 3` floats).
 */
export function computePolylineRMF(
  positions: ArrayLike<number>,
  count: number,
  initialNormalHint?: Vec3,
  twistRadAt?: (u: number) => number,
): PolylineFrames {
  const tangents = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const binormals = new Float32Array(count * 3);
  const t = new Float32Array(count);

  if (count === 0) return { tangents, normals, binormals, t, arcLength: 0 };

  const cum = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const dx = (positions[i * 3] as number) - (positions[(i - 1) * 3] as number);
    const dy = (positions[i * 3 + 1] as number) - (positions[(i - 1) * 3 + 1] as number);
    const dz = (positions[i * 3 + 2] as number) - (positions[(i - 1) * 3 + 2] as number);
    cum[i] = (cum[i - 1] as number) + Math.hypot(dx, dy, dz);
  }
  const arcLength = cum[count - 1] as number;
  for (let i = 0; i < count; i++) {
    t[i] = arcLength > EPS ? (cum[i] as number) / arcLength : count > 1 ? i / (count - 1) : 0;
  }

  for (let i = 0; i < count; i++) {
    const prev = Math.max(0, i - 1);
    const next = Math.min(count - 1, i + 1);
    const dx = (positions[next * 3] as number) - (positions[prev * 3] as number);
    const dy = (positions[next * 3 + 1] as number) - (positions[prev * 3 + 1] as number);
    const dz = (positions[next * 3 + 2] as number) - (positions[prev * 3 + 2] as number);
    const tn = v3Norm([dx, dy, dz], [0, 0, 1]);
    tangents[i * 3] = tn[0];
    tangents[i * 3 + 1] = tn[1];
    tangents[i * 3 + 2] = tn[2];
  }

  const t0: Vec3 = [tangents[0] as number, tangents[1] as number, tangents[2] as number];
  let rmfN = orthonormalNormal(t0, initialNormalHint);

  for (let i = 0; i < count; i++) {
    const ti: Vec3 = [tangents[i * 3] as number, tangents[i * 3 + 1] as number, tangents[i * 3 + 2] as number];
    if (i > 0) {
      const pPrev: Vec3 = [
        positions[(i - 1) * 3] as number,
        positions[(i - 1) * 3 + 1] as number,
        positions[(i - 1) * 3 + 2] as number,
      ];
      const pCur: Vec3 = [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
      const tPrev: Vec3 = [
        tangents[(i - 1) * 3] as number,
        tangents[(i - 1) * 3 + 1] as number,
        tangents[(i - 1) * 3 + 2] as number,
      ];
      rmfN = advanceRMF(pPrev, tPrev, rmfN, pCur, ti);
    }
    const twist = twistRadAt ? twistRadAt(t[i] as number) : 0;
    const twistedN = twist !== 0 ? orthonormalNormal(ti, rotateAroundAxis(rmfN, ti, twist)) : rmfN;
    const bi = v3Norm(v3Cross(ti, twistedN), [0, 1, 0]);
    normals[i * 3] = twistedN[0];
    normals[i * 3 + 1] = twistedN[1];
    normals[i * 3 + 2] = twistedN[2];
    binormals[i * 3] = bi[0];
    binormals[i * 3 + 1] = bi[1];
    binormals[i * 3 + 2] = bi[2];
  }

  return { tangents, normals, binormals, t, arcLength };
}

export interface Frame3 {
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
}

export interface ChildFrameOptions {
  /** Azimuth around parent tangent in radians. */
  azimuthRad: number;
  /** Growth / start angle away from parent tangent in radians (0 = along parent, pi/2 = perpendicular). */
  spreadRad: number;
  /** Additional pitch bend toward world +Z/-Z in radians. */
  pitchRad?: number;
  /** Rotates the bend axis around radial normal before applying spread (Start roll). */
  startRollRad?: number;
  /** Axial roll of the child frame around its own tangent in radians. */
  rollRad?: number;
  /** 0..1 interpolation steering child normal toward world +Z (Alignment). */
  alignment?: number;
}

/**
 * Builds a twist-minimizing initial frame for a child branch growing off `(parentT, parentN, parentB)`.
 * Avoids world-axis gimbal flips by rotating the parent frame symmetrically around the bend axis.
 */
export function buildChildInitialFrame(parentFrame: Frame3, opts: ChildFrameOptions): Frame3 {
  const { tangent: pT, normal: pN, binormal: pB } = parentFrame;
  const ca = Math.cos(opts.azimuthRad);
  const sa = Math.sin(opts.azimuthRad);

  // Radial outward direction in parent cross-section plane
  const radial = v3Norm([
    pN[0] * ca + pB[0] * sa,
    pN[1] * ca + pB[1] * sa,
    pN[2] * ca + pB[2] * sa,
  ]);
  // Circumferential axis perpendicular to pT and radial
  let bendAxis = v3Norm(v3Cross(pT, radial), pB);
  if (opts.startRollRad) {
    bendAxis = rotateAroundAxis(bendAxis, radial, opts.startRollRad);
  }

  // Rotate parent tangent & radial together around bendAxis by spread angle (minimal rotation!)
  let cT = v3Norm(rotateAroundAxis(pT, bendAxis, opts.spreadRad), radial);
  let cN = orthonormalNormal(cT, rotateAroundAxis(radial, bendAxis, opts.spreadRad));

  if (opts.pitchRad && Math.abs(opts.pitchRad) > EPS) {
    const worldZ: Vec3 = [0, 0, 1];
    const pitchAxis = v3Cross(cT, worldZ);
    if (v3Len(pitchAxis) > 1e-4) {
      const axis = v3Norm(pitchAxis);
      // Positive pitch tilts toward world +Z
      cT = v3Norm(rotateAroundAxis(cT, axis, -opts.pitchRad), cT);
      cN = orthonormalNormal(cT, rotateAroundAxis(cN, axis, -opts.pitchRad));
    }
  }

  // Alignment: align child "up" normal toward world +Z when requested
  const align = clamp(opts.alignment ?? 0, 0, 1);
  if (align > EPS) {
    const upProj = orthonormalNormal(cT, [0, 0, 1]);
    cN = orthonormalNormal(cT, v3Lerp(cN, upProj, align));
  }

  if (opts.rollRad && Math.abs(opts.rollRad) > EPS) {
    cN = orthonormalNormal(cT, rotateAroundAxis(cN, cT, opts.rollRad));
  }

  const cB = v3Norm(v3Cross(cT, cN), [0, 1, 0]);
  return { tangent: cT, normal: cN, binormal: cB };
}

export interface PreparedParentBranch {
  branch: Branch;
  positions: Float32Array;
  radii: Float32Array;
  ages: Float32Array;
  t: Float32Array;
  tangents: Float32Array;
  normals: Float32Array;
  binormals: Float32Array;
  /** Local turning angle in radians per vertex (0 at endpoints), used by Bifurcation & Favor splits. */
  curvatures: Float32Array;
  arcLength: number;
}

export interface ParentSample {
  position: Vec3;
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
  radius: number;
  age: number;
  /** Clamped normalized parent parameter 0..1. */
  u: number;
  /** Global point index in the parent `Skeleton` nearest to `u`. */
  parentPoint: number;
  /** Local turning curvature at `u` in radians. */
  curvature: number;
}

/**
 * Precompute continuous coordinates, RMF frames, and curvature along one parent `Branch`.
 * Reuses any RMF normals already stored on `skeleton.attributes` by the upstream generator.
 */
export function prepareParentBranch(skeleton: Skeleton, branch: Branch): PreparedParentBranch {
  const n = branch.count;
  const positions = new Float32Array(n * 3);
  const radii = new Float32Array(n);
  const ages = new Float32Array(n);
  const curvatures = new Float32Array(n);

  for (let k = 0; k < n; k++) {
    const gi = branch.start + k;
    positions[k * 3] = skeleton.position[gi * 3] as number;
    positions[k * 3 + 1] = skeleton.position[gi * 3 + 1] as number;
    positions[k * 3 + 2] = skeleton.position[gi * 3 + 2] as number;
    radii[k] = skeleton.radius[gi] as number;
    ages[k] = skeleton.age[gi] as number;
  }

  const attrNx = skeleton.attributes.get('rmfNormalX');
  const attrNy = skeleton.attributes.get('rmfNormalY');
  const attrNz = skeleton.attributes.get('rmfNormalZ');
  const hasStoredRMF =
    attrNx !== undefined &&
    attrNy !== undefined &&
    attrNz !== undefined &&
    attrNx.length === skeleton.count;

  let tangents: Float32Array;
  let normals: Float32Array;
  let binormals: Float32Array;
  let t: Float32Array;
  let arcLength: number;

  if (hasStoredRMF && n >= 2) {
    tangents = new Float32Array(n * 3);
    normals = new Float32Array(n * 3);
    binormals = new Float32Array(n * 3);
    t = new Float32Array(n);
    arcLength = branch.length;
    for (let k = 0; k < n; k++) {
      const gi = branch.start + k;
      const tk = v3Norm([
        skeleton.tangent[gi * 3] as number,
        skeleton.tangent[gi * 3 + 1] as number,
        skeleton.tangent[gi * 3 + 2] as number,
      ]);
      const nk = orthonormalNormal(tk, [attrNx[gi] as number, attrNy[gi] as number, attrNz[gi] as number]);
      const bk = v3Norm(v3Cross(tk, nk));
      tangents[k * 3] = tk[0];
      tangents[k * 3 + 1] = tk[1];
      tangents[k * 3 + 2] = tk[2];
      normals[k * 3] = nk[0];
      normals[k * 3 + 1] = nk[1];
      normals[k * 3 + 2] = nk[2];
      binormals[k * 3] = bk[0];
      binormals[k * 3 + 1] = bk[1];
      binormals[k * 3 + 2] = bk[2];
      t[k] = n > 1 ? (skeleton.t[gi] as number) : 0;
    }
  } else {
    const computed = computePolylineRMF(positions, n);
    tangents = computed.tangents;
    normals = computed.normals;
    binormals = computed.binormals;
    t = computed.t;
    arcLength = computed.arcLength;
  }

  for (let k = 1; k < n - 1; k++) {
    const dx1 = (positions[k * 3] as number) - (positions[(k - 1) * 3] as number);
    const dy1 = (positions[k * 3 + 1] as number) - (positions[(k - 1) * 3 + 1] as number);
    const dz1 = (positions[k * 3 + 2] as number) - (positions[(k - 1) * 3 + 2] as number);
    const dx2 = (positions[(k + 1) * 3] as number) - (positions[k * 3] as number);
    const dy2 = (positions[(k + 1) * 3 + 1] as number) - (positions[k * 3 + 1] as number);
    const dz2 = (positions[(k + 1) * 3 + 2] as number) - (positions[k * 3 + 2] as number);
    const s1 = v3Norm([dx1, dy1, dz1]);
    const s2 = v3Norm([dx2, dy2, dz2]);
    curvatures[k] = Math.acos(clamp(v3Dot(s1, s2), -1, 1));
  }

  return { branch, positions, radii, ages, t, tangents, normals, binormals, curvatures, arcLength };
}

/** Continuously interpolate position, RMF frame, radius, and nearest vertex index at `u` in [0, 1]. */
export function sampleParentBranch(prep: PreparedParentBranch, rawU: number): ParentSample {
  const n = prep.branch.count;
  const u = clamp(Number.isFinite(rawU) ? rawU : 0, 0, 1);
  if (n === 0) {
    return {
      position: [0, 0, 0],
      tangent: [0, 0, 1],
      normal: [1, 0, 0],
      binormal: [0, 1, 0],
      radius: 0.01,
      age: 0,
      u,
      parentPoint: -1,
      curvature: 0,
    };
  }
  if (n === 1) {
    return {
      position: [prep.positions[0] as number, prep.positions[1] as number, prep.positions[2] as number],
      tangent: [prep.tangents[0] as number, prep.tangents[1] as number, prep.tangents[2] as number],
      normal: [prep.normals[0] as number, prep.normals[1] as number, prep.normals[2] as number],
      binormal: [prep.binormals[0] as number, prep.binormals[1] as number, prep.binormals[2] as number],
      radius: prep.radii[0] as number,
      age: prep.ages[0] as number,
      u,
      parentPoint: prep.branch.start,
      curvature: 0,
    };
  }

  // Binary search in monotonic prep.t
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((prep.t[mid] as number) <= u) lo = mid;
    else hi = mid;
  }
  const t0 = prep.t[lo] as number;
  const t1 = prep.t[hi] as number;
  const alpha = t1 > t0 + EPS ? clamp((u - t0) / (t1 - t0), 0, 1) : 0;

  const p0: Vec3 = [prep.positions[lo * 3] as number, prep.positions[lo * 3 + 1] as number, prep.positions[lo * 3 + 2] as number];
  const p1: Vec3 = [prep.positions[hi * 3] as number, prep.positions[hi * 3 + 1] as number, prep.positions[hi * 3 + 2] as number];
  const T0: Vec3 = [prep.tangents[lo * 3] as number, prep.tangents[lo * 3 + 1] as number, prep.tangents[lo * 3 + 2] as number];
  const T1: Vec3 = [prep.tangents[hi * 3] as number, prep.tangents[hi * 3 + 1] as number, prep.tangents[hi * 3 + 2] as number];
  const N0: Vec3 = [prep.normals[lo * 3] as number, prep.normals[lo * 3 + 1] as number, prep.normals[lo * 3 + 2] as number];
  const N1: Vec3 = [prep.normals[hi * 3] as number, prep.normals[hi * 3 + 1] as number, prep.normals[hi * 3 + 2] as number];

  const position = v3Lerp(p0, p1, alpha);
  const tangent = v3Norm(v3Lerp(T0, T1, alpha), T0);
  const normal = orthonormalNormal(tangent, v3Lerp(N0, N1, alpha));
  const binormal = v3Norm(v3Cross(tangent, normal));
  const radius = Math.max(1e-5, (prep.radii[lo] as number) * (1 - alpha) + (prep.radii[hi] as number) * alpha);
  const age = (prep.ages[lo] as number) * (1 - alpha) + (prep.ages[hi] as number) * alpha;
  const curvature = (prep.curvatures[lo] as number) * (1 - alpha) + (prep.curvatures[hi] as number) * alpha;
  const nearestPoint = prep.branch.start + (alpha < 0.5 ? lo : hi);

  return { position, tangent, normal, binormal, radius, age, u, parentPoint: nearestPoint, curvature };
}

export interface CurvaturePeak {
  u: number;
  curvature: number;
  azimuthRad: number;
}

/**
 * Detect natural bend peaks on `prep` within `[first, last]` for Bifurcation mode.
 * Returns peaks sorted by `u`, oriented toward the outside of the bend.
 */
export function findCurvaturePeaks(
  prep: PreparedParentBranch,
  first: number,
  last: number,
  thresholdRad: number,
  minSpacingU: number,
): CurvaturePeak[] {
  const n = prep.branch.count;
  if (n < 3) return [];
  const candidates: CurvaturePeak[] = [];

  for (let k = 1; k < n - 1; k++) {
    const uk = prep.t[k] as number;
    if (uk < first || uk > last) continue;
    const c = prep.curvatures[k] as number;
    if (c < thresholdRad) continue;
    const prevC = prep.curvatures[k - 1] as number;
    const nextC = prep.curvatures[k + 1] as number;
    if (c >= prevC && c >= nextC) {
      // Compute outer-bend direction in local (N, B) plane so child splits naturally opposite the turn
      const dx1 = (prep.positions[k * 3] as number) - (prep.positions[(k - 1) * 3] as number);
      const dy1 = (prep.positions[k * 3 + 1] as number) - (prep.positions[(k - 1) * 3 + 1] as number);
      const dz1 = (prep.positions[k * 3 + 2] as number) - (prep.positions[(k - 1) * 3 + 2] as number);
      const dx2 = (prep.positions[(k + 1) * 3] as number) - (prep.positions[k * 3] as number);
      const dy2 = (prep.positions[(k + 1) * 3 + 1] as number) - (prep.positions[k * 3 + 1] as number);
      const dz2 = (prep.positions[(k + 1) * 3 + 2] as number) - (prep.positions[k * 3 + 2] as number);
      const s1 = v3Norm([dx1, dy1, dz1]);
      const s2 = v3Norm([dx2, dy2, dz2]);
      // s1 - s2 points toward the outside of the bend!
      const outer = v3Sub(s1, s2);
      const nk: Vec3 = [prep.normals[k * 3] as number, prep.normals[k * 3 + 1] as number, prep.normals[k * 3 + 2] as number];
      const bk: Vec3 = [prep.binormals[k * 3] as number, prep.binormals[k * 3 + 1] as number, prep.binormals[k * 3 + 2] as number];
      const azimuthRad = Math.atan2(v3Dot(outer, bk), v3Dot(outer, nk));
      candidates.push({ u: uk, curvature: c, azimuthRad });
    }
  }

  // Greedy non-maximum suppression with minSpacingU
  candidates.sort((a, b) => b.curvature - a.curvature);
  const accepted: CurvaturePeak[] = [];
  for (const cand of candidates) {
    if (accepted.every((ex) => Math.abs(ex.u - cand.u) >= minSpacingU)) {
      accepted.push(cand);
    }
  }
  accepted.sort((a, b) => a.u - b.u);
  return accepted;
}

/**
 * Select `<= targetSegments + 1` vertex indices from a dense polyline of `denseCount` points,
 * sampling uniformly first and then adaptively simplifying collinear segments below `optimizationRad`.
 */
export function selectAdaptiveSampleIndices(
  positions: ArrayLike<number>,
  denseCount: number,
  targetSegments: number,
  optimizationRad: number,
): Int32Array {
  if (denseCount <= 2 || targetSegments <= 1) {
    return Int32Array.from(denseCount >= 2 ? [0, denseCount - 1] : [0]);
  }
  const segs = Math.min(denseCount - 1, Math.max(1, Math.round(targetSegments)));

  // Step 1: initial curvature-weighted / uniform candidate set of size segs + 1
  const initial: number[] = [0];
  for (let s = 1; s < segs; s++) {
    const idx = Math.round((s / segs) * (denseCount - 1));
    if (idx > (initial[initial.length - 1] as number) && idx < denseCount - 1) {
      initial.push(idx);
    }
  }
  initial.push(denseCount - 1);

  if (optimizationRad <= 1e-5 || initial.length <= 2) {
    return Int32Array.from(initial);
  }

  // Step 2: curvature-aware pruning — drop interior indices whose bend angle < optimizationRad
  const kept: number[] = [initial[0] as number];
  for (let m = 1; m < initial.length - 1; m++) {
    const iPrev = kept[kept.length - 1] as number;
    const iCur = initial[m] as number;
    const iNext = initial[m + 1] as number;
    const a = v3Norm([
      (positions[iCur * 3] as number) - (positions[iPrev * 3] as number),
      (positions[iCur * 3 + 1] as number) - (positions[iPrev * 3 + 1] as number),
      (positions[iCur * 3 + 2] as number) - (positions[iPrev * 3 + 2] as number),
    ]);
    const b = v3Norm([
      (positions[iNext * 3] as number) - (positions[iCur * 3] as number),
      (positions[iNext * 3 + 1] as number) - (positions[iCur * 3 + 1] as number),
      (positions[iNext * 3 + 2] as number) - (positions[iCur * 3 + 2] as number),
    ]);
    const angle = Math.acos(clamp(v3Dot(a, b), -1, 1));
    if (angle >= optimizationRad) {
      kept.push(iCur);
    }
  }
  kept.push(initial[initial.length - 1] as number);
  return Int32Array.from(kept);
}
