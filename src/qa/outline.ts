/** 2D closed-polygon helpers for the cross-section metrics (pure). A polygon is a list of points; the last point connects to the first. */

export type P2 = readonly [number, number];

export function signedArea(p: readonly P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x0, y0] = p[i] as P2;
    const [x1, y1] = p[(i + 1) % p.length] as P2;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

export const polygonArea = (p: readonly P2[]): number => Math.abs(signedArea(p));

export function perimeter(p: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as P2;
    const b = p[(i + 1) % p.length] as P2;
    s += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return s;
}

/** Isoperimetric circularity 4 pi A / P^2: 1 for a circle, smaller for anything else. */
export function isoperimetric(p: readonly P2[]): number {
  const per = perimeter(p);
  return per > 0 ? (4 * Math.PI * polygonArea(p)) / (per * per) : 0;
}

export function centroidOfPoints(p: readonly P2[]): P2 {
  let x = 0;
  let y = 0;
  for (const q of p) {
    x += q[0];
    y += q[1];
  }
  const n = Math.max(1, p.length);
  return [x / n, y / n];
}

export function pointInPolygon(p: readonly P2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i] as P2;
    const [xj, yj] = p[j] as P2;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when no two non-adjacent edges of the closed polygon cross. */
export function isSimplePolygon(p: readonly P2[]): boolean {
  const n = p.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(p[i] as P2, p[(i + 1) % n] as P2, p[j] as P2, p[(j + 1) % n] as P2)) return false;
    }
  }
  return true;
}

/** True when an edge of `a` crosses an edge of `b`. */
export function polygonsCross(a: readonly P2[], b: readonly P2[]): boolean {
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i] as P2, a[(i + 1) % a.length] as P2, b[j] as P2, b[(j + 1) % b.length] as P2)) return true;
    }
  }
  return false;
}

/** `n` points spaced evenly along the arc length of the closed polygon. */
export function resampleClosed(p: readonly P2[], n: number): P2[] {
  const per = perimeter(p);
  if (p.length < 2 || per <= 0) return [...p];
  const out: P2[] = [];
  let seg = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (k / n) * per;
    for (;;) {
      const a = p[seg] as P2;
      const b = p[(seg + 1) % p.length] as P2;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + l >= target || seg >= p.length - 1) {
        const f = l > 0 ? Math.min(1, Math.max(0, (target - acc) / l)) : 0;
        out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
        break;
      }
      acc += l;
      seg++;
    }
  }
  return out;
}

export interface CircleFit {
  cx: number;
  cy: number;
  radius: number;
  /** Mean distance of the points from the fitted centre. */
  meanRadius: number;
  /** RMS of (distance - fitted radius) divided by the mean radius: 0 for a perfect circle. */
  deviation: number;
}

/** Algebraic (Kasa) least-squares circle through the points; null for fewer than 3 points or a degenerate set. */
export function fitCircle(pts: readonly P2[]): CircleFit | null {
  const n = pts.length;
  if (n < 3) return null;
  const c = centroidOfPoints(pts);
  let suu = 0;
  let suv = 0;
  let svv = 0;
  let suuu = 0;
  let svvv = 0;
  let suvv = 0;
  let svuu = 0;
  for (const q of pts) {
    const u = q[0] - c[0];
    const v = q[1] - c[1];
    suu += u * u;
    suv += u * v;
    svv += v * v;
    suuu += u * u * u;
    svvv += v * v * v;
    suvv += u * v * v;
    svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-18) return null;
  const r1 = 0.5 * (suuu + suvv);
  const r2 = 0.5 * (svvv + svuu);
  const uc = (r1 * svv - r2 * suv) / det;
  const vc = (suu * r2 - suv * r1) / det;
  const cx = c[0] + uc;
  const cy = c[1] + vc;
  let m = 0;
  const d: number[] = [];
  for (const q of pts) {
    const r = Math.hypot(q[0] - cx, q[1] - cy);
    d.push(r);
    m += r;
  }
  m /= n;
  let s = 0;
  for (const r of d) s += (r - m) * (r - m);
  return { cx, cy, radius: m, meanRadius: m, deviation: m > 0 ? Math.sqrt(s / n) / m : 0 };
}

/**
 * Length of the part of the line `o + t d` that lies inside the polygon and contains `t = 0` (0 when `o` is outside).
 * `d` must be a unit vector.
 */
export function chordThrough(p: readonly P2[], o: P2, d: P2): number {
  const ts: number[] = [];
  const side = (q: P2): number => d[0] * (q[1] - o[1]) - d[1] * (q[0] - o[0]);
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as P2;
    const b = p[(i + 1) % p.length] as P2;
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0 === sb >= 0) continue;
    const f = sa / (sa - sb);
    ts.push((a[0] + (b[0] - a[0]) * f - o[0]) * d[0] + (a[1] + (b[1] - a[1]) * f - o[1]) * d[1]);
  }
  ts.sort((x, y) => x - y);
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const lo = ts[i] as number;
    const hi = ts[i + 1] as number;
    if (lo <= 0 && hi >= 0) return hi - lo;
  }
  return 0;
}

/** Smallest local radius of curvature over the concave (valley) corners of the polygon; null when the outline is convex. */
export function valleyRadius(p: readonly P2[], minTurn = 0.02): number | null {
  const ccw = signedArea(p) >= 0;
  // drop collinear points so chord crossings of a smooth tube do not count as corners
  const q: P2[] = [];
  const n = p.length;
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n] as P2;
    const b = p[i] as P2;
    const c = p[(i + 1) % n] as P2;
    const turn = Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
    if (Math.abs(turn) > 1e-3) q.push(b);
  }
  let best: number | null = null;
  const m = q.length;
  for (let i = 0; i < m; i++) {
    const a = q[(i + m - 1) % m] as P2;
    const b = q[i] as P2;
    const c = q[(i + 1) % m] as P2;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const turn = Math.atan2(cross, (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
    const concave = ccw ? turn < -minTurn : turn > minTurn;
    if (!concave) continue;
    const la = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lb = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const r = (la + lb) / 2 / Math.abs(turn);
    if (best === null || r < best) best = r;
  }
  return best;
}
