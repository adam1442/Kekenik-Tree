import { clamp } from '@/core/math';
import type { Curve, CurvePoint, EvaluateCurveFn } from './types';

/**
 * Fast, monotonic-x safe Hermite curve evaluation, analytic derivative,
 * numerical integration, deterministic hashing, and cached LUT generation.
 */

const MAX_LUT_CACHE = 512;
const lutCache = new Map<string, Float32Array>();

export interface WrappedCoord {
  x: number;
  /** +1 normal direction, -1 reflected on odd ping-pong cycles, 0 clamped outside range. */
  dSign: -1 | 0 | 1;
}

export function wrapCurveX(curve: Curve, xIn: number): WrappedCoord {
  const pts = curve.points;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last) return { x: xIn, dSign: 0 };
  const xMin = first.x;
  const xMax = last.x;
  const span = xMax - xMin;
  if (span <= 0) return { x: xMin, dSign: 0 };

  if (curve.wrap === 'clamp') {
    if (xIn < xMin) return { x: xMin, dSign: 0 };
    if (xIn > xMax) return { x: xMax, dSign: 0 };
    return { x: xIn, dSign: 1 };
  }

  const rel = (xIn - xMin) / span;
  if (curve.wrap === 'loop' || curve.wrap === 'repeat') {
    const frac = rel - Math.floor(rel);
    return { x: xMin + frac * span, dSign: 1 };
  }

  // pingpong
  const m = ((rel % 2) + 2) % 2;
  if (m <= 1) {
    return { x: xMin + m * span, dSign: 1 };
  }
  return { x: xMin + (2 - m) * span, dSign: -1 };
}

/**
 * Compute Fritsch-Carlson / Catmull-Rom monotone-safe slope at `pts[index]`.
 * Prevents overshoot at local extrema while keeping smooth C1 transitions.
 */
export function computeAutoSlope(pts: readonly CurvePoint[], index: number): number {
  const n = pts.length;
  if (n < 2) return 0;
  const cur = pts[index];
  if (!cur) return 0;

  if (index === 0) {
    const next = pts[1] as CurvePoint;
    const dx = next.x - cur.x;
    return dx > 1e-7 ? (next.y - cur.y) / dx : 0;
  }
  if (index === n - 1) {
    const prev = pts[n - 2] as CurvePoint;
    const dx = cur.x - prev.x;
    return dx > 1e-7 ? (cur.y - prev.y) / dx : 0;
  }

  const prev = pts[index - 1] as CurvePoint;
  const next = pts[index + 1] as CurvePoint;
  const dx0 = cur.x - prev.x;
  const dx1 = next.x - cur.x;
  if (dx0 <= 1e-7 || dx1 <= 1e-7) return 0;

  const s0 = (cur.y - prev.y) / dx0;
  const s1 = (next.y - cur.y) / dx1;

  // Local extremum or flat neighbor -> zero tangent avoids overshoot
  if (s0 * s1 <= 0) return 0;

  // Weighted harmonic mean (Fritsch-Carlson monotonic cubic interpolation)
  const w0 = 2 * dx1 + dx0;
  const w1 = dx1 + 2 * dx0;
  return (w0 + w1) / (w0 / s0 + w1 / s1);
}

function pointSlope(
  pts: readonly CurvePoint[],
  index: number,
  side: 'in' | 'out',
  segSlope: number,
  maxAbsSlope: number,
): number {
  const p = pts[index] as CurvePoint;
  const mode = p.mode;

  if (mode === 'flat') return 0;
  if (mode === 'linear') return segSlope;
  if (mode === 'stepped' || mode === 'constant') return 0;

  const vec = side === 'out' ? p.outTangent : p.inTangent;
  if (mode === 'auto' || mode === 'smooth') {
    // If explicit non-zero tangent slope is stored on the point, honour it; otherwise auto-compute
    if (Math.abs(vec.dx) > 1e-6 && (Math.abs(vec.dy) > 1e-8 || Math.abs(p.inTangent.dy) > 1e-8 || Math.abs(p.outTangent.dy) > 1e-8)) {
      return clamp(vec.dy / vec.dx, -maxAbsSlope, maxAbsSlope);
    }
    return clamp(computeAutoSlope(pts, index), -maxAbsSlope, maxAbsSlope);
  }

  // 'free' | 'aligned' | 'mirrored'
  if (Math.abs(vec.dx) > 1e-6) {
    return clamp(vec.dy / vec.dx, -maxAbsSlope, maxAbsSlope);
  }
  if (Math.abs(vec.dy) > 1e-6) {
    return vec.dy > 0 ? maxAbsSlope : -maxAbsSlope;
  }
  return 0;
}

function findSegmentIndex(pts: readonly CurvePoint[], x: number): number {
  const n = pts.length;
  if (n <= 8) {
    let i = 0;
    while (i < n - 2 && (pts[i + 1] as CurvePoint).x <= x) i++;
    return i;
  }
  let lo = 0;
  let hi = n - 2;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const x0 = (pts[mid] as CurvePoint).x;
    const x1 = (pts[mid + 1] as CurvePoint).x;
    if (x < x0) hi = mid - 1;
    else if (x >= x1 && mid < n - 2) lo = mid + 1;
    else return mid;
  }
  return clamp(lo, 0, n - 2);
}

/**
 * Evaluate a Curve at `xIn` using monotonic-x safe cubic Hermite interpolation.
 */
export const evaluateCurve: EvaluateCurveFn = (curve, xIn) => {
  const pts = curve.points;
  const n = pts.length;
  if (n === 0) return 0;
  const first = pts[0] as CurvePoint;
  if (n === 1) return first.y;
  const last = pts[n - 1] as CurvePoint;

  const { x } = wrapCurveX(curve, xIn);
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;

  const i = findSegmentIndex(pts, x);
  const a = pts[i] as CurvePoint;
  const b = pts[i + 1] as CurvePoint;
  const dx = b.x - a.x;
  if (dx <= 1e-9) return b.y;

  if (a.mode === 'stepped' || a.mode === 'constant') {
    return a.y;
  }

  const t = (x - a.x) / dx;
  if (
    (a.mode === 'linear' && b.mode === 'linear') ||
    (a.mode === 'linear' && a.outTangent.dy === 0 && b.inTangent.dy === 0 && b.mode !== 'flat' && b.mode !== 'auto' && b.mode !== 'smooth' && b.mode !== 'free' && b.mode !== 'aligned' && b.mode !== 'mirrored')
  ) {
    return a.y + (b.y - a.y) * t;
  }

  const segSlope = (b.y - a.y) / dx;
  const ySpan = Math.max(1, Math.abs(curve.yRange[1] - curve.yRange[0]), Math.abs(b.y - a.y));
  const maxAbsSlope = (ySpan / dx) * 32;

  const s0 = pointSlope(pts, i, 'out', segSlope, maxAbsSlope);
  const s1 = pointSlope(pts, i + 1, 'in', segSlope, maxAbsSlope);

  const m0 = s0 * dx;
  const m1 = s1 * dx;
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * a.y +
    (t3 - 2 * t2 + t) * m0 +
    (-2 * t3 + 3 * t2) * b.y +
    (t3 - t2) * m1
  );
};

/**
 * Analytic derivative dy/dx of the curve at `xIn`.
 */
export function curveDerivative(curve: Curve, xIn: number): number {
  const pts = curve.points;
  const n = pts.length;
  if (n < 2) return 0;
  const first = pts[0] as CurvePoint;
  const last = pts[n - 1] as CurvePoint;

  const { x, dSign } = wrapCurveX(curve, xIn);
  if (dSign === 0) return 0;

  const xClamped = clamp(x, first.x, last.x);
  const i = findSegmentIndex(pts, xClamped);
  const a = pts[i] as CurvePoint;
  const b = pts[i + 1] as CurvePoint;
  const dx = b.x - a.x;
  if (dx <= 1e-9) return 0;
  if (a.mode === 'stepped' || a.mode === 'constant') return 0;

  const segSlope = (b.y - a.y) / dx;
  if (a.mode === 'linear' && b.mode === 'linear') {
    return segSlope * dSign;
  }

  const t = clamp((xClamped - a.x) / dx, 0, 1);
  const ySpan = Math.max(1, Math.abs(curve.yRange[1] - curve.yRange[0]), Math.abs(b.y - a.y));
  const maxAbsSlope = (ySpan / dx) * 32;
  const s0 = pointSlope(pts, i, 'out', segSlope, maxAbsSlope);
  const s1 = pointSlope(pts, i + 1, 'in', segSlope, maxAbsSlope);

  const m0 = s0 * dx;
  const m1 = s1 * dx;
  const t2 = t * t;
  const dyDt =
    (6 * t2 - 6 * t) * a.y +
    (3 * t2 - 4 * t + 1) * m0 +
    (-6 * t2 + 6 * t) * b.y +
    (3 * t2 - 2 * t) * m1;

  return (dyDt / dx) * dSign;
}

/**
 * Definite integral of `curve` from `x0` to `x1` using composite Simpson's rule.
 * Defaults to `curve.xRange[0] .. curve.xRange[1]`.
 */
export function curveIntegral(
  curve: Curve,
  x0 = curve.xRange[0],
  x1 = curve.xRange[1],
  steps = 64,
): number {
  if (x0 === x1) return 0;
  const sign = x1 >= x0 ? 1 : -1;
  const a = Math.min(x0, x1);
  const b = Math.max(x0, x1);
  const n = Math.max(2, steps % 2 === 0 ? steps : steps + 1);
  const h = (b - a) / n;
  let sum = evaluateCurve(curve, a) + evaluateCurve(curve, b);
  for (let i = 1; i < n; i++) {
    const x = a + i * h;
    sum += evaluateCurve(curve, x) * (i % 2 === 1 ? 4 : 2);
  }
  return sign * ((h / 3) * sum);
}

function fnvMixInt(hash: number, v: number): number {
  let h = hash ^ (v & 0xff);
  h = Math.imul(h, 0x01000193);
  h ^= (v >>> 8) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (v >>> 16) & 0xff;
  h = Math.imul(h, 0x01000193);
  h ^= (v >>> 24) & 0xff;
  return Math.imul(h, 0x01000193) >>> 0;
}

function fnvMixFloat(hash: number, f: number): number {
  if (!Number.isFinite(f) || f === 0) return fnvMixInt(hash, 0);
  const q = Math.round(f * 1e6);
  return fnvMixInt(hash, q | 0);
}

function fnvMixStr(hash: number, s: string): number {
  let h = hash;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic 32-bit unsigned FNV-1a hash of a Curve.
 */
export function curveHashNumber(curve: Curve): number {
  let h = 0x811c9dc5;
  h = fnvMixFloat(h, curve.xRange[0]);
  h = fnvMixFloat(h, curve.xRange[1]);
  h = fnvMixFloat(h, curve.yRange[0]);
  h = fnvMixFloat(h, curve.yRange[1]);
  h = fnvMixStr(h, curve.wrap);
  if (curve.valueMode) h = fnvMixStr(h, curve.valueMode);
  if (curve.level !== undefined) h = fnvMixInt(h, curve.level);
  h = fnvMixInt(h, curve.points.length);
  for (const p of curve.points) {
    h = fnvMixFloat(h, p.x);
    h = fnvMixFloat(h, p.y);
    h = fnvMixFloat(h, p.inTangent.dx);
    h = fnvMixFloat(h, p.inTangent.dy);
    h = fnvMixFloat(h, p.outTangent.dx);
    h = fnvMixFloat(h, p.outTangent.dy);
    h = fnvMixStr(h, p.mode);
    if (p.weight !== undefined) h = fnvMixFloat(h, p.weight);
  }
  return h >>> 0;
}

/**
 * Deterministic 8-char hex hash of a Curve (used for LUT caching and dirty checks).
 */
export function curveHash(curve: Curve): string {
  return curveHashNumber(curve).toString(16).padStart(8, '0');
}

/**
 * Build (or fetch from LRU cache) a uniform lookup table (`Float32Array`) of `samples`
 * (typically 256 or 512) over `curve.xRange`.
 */
export function curveToLUT(curve: Curve, samples = 256): Float32Array {
  const count = Math.max(2, Math.floor(samples));
  const key = `${curveHash(curve)}:${count}`;
  const cached = lutCache.get(key);
  if (cached) {
    // Refresh LRU order
    lutCache.delete(key);
    lutCache.set(key, cached);
    return cached;
  }

  const lut = new Float32Array(count);
  const [x0, x1] = curve.xRange;
  const span = x1 - x0;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    lut[i] = evaluateCurve(curve, x0 + t * span);
  }

  if (lutCache.size >= MAX_LUT_CACHE) {
    const oldest = lutCache.keys().next().value;
    if (oldest !== undefined) lutCache.delete(oldest);
  }
  lutCache.set(key, lut);
  return lut;
}

/**
 * Fast linear interpolation from a pre-computed curve LUT for normalized `u` in [0, 1].
 */
export function sampleCurveLUT(lut: Float32Array, u: number): number {
  const n = lut.length;
  if (n === 0) return 0;
  if (n === 1) return lut[0] as number;
  const t = clamp(u, 0, 1) * (n - 1);
  const i = Math.min(n - 2, Math.floor(t));
  const frac = t - i;
  const a = lut[i] as number;
  const b = lut[i + 1] as number;
  return a + (b - a) * frac;
}

export function clearCurveLUTCache(): void {
  lutCache.clear();
}
