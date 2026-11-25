/**
 * Smooth "figure-8" outline of one fork ring (pure 2D geometry, no mesh). Replaces the cusp of the former outline (two circle arcs
 * that meet at the pinch points A and B) by a rolling-ball fillet: lobe circle 1, a concave arc of radius `fillet` tangent to both
 * circles, lobe circle 2, and the mirrored arc below. The outline is G1 everywhere and its valley has the curvature radius `fillet`.
 * A narrower waist than the circles allow is made by moving the lobe circles apart (`separation`), which only ever adds area.
 *
 * Coordinates: lobe 1 centre (0, 0), lobe 2 centre (-D, 0), lobe 1 lies at +x, A is the neck point at +y and B the one at -y. Each
 * half (A -> B over lobe 1, B -> A over lobe 2) is resampled at equal arc length with `half + 1` points.
 */

export interface ForkOutlineInput {
  /** Lobe radii (> 0). */
  r1: number;
  r2: number;
  /** Centre distance of the unconstrained outline (>= |r1 - r2|, <= r1 + r2). */
  distance: number;
  /** Fillet radius of the valley (0 = cusp). */
  fillet: number;
  /** Target half height of the neck in absolute units (undefined or too large: keep the natural neck). */
  neckHalf?: number;
  /** 0 .. 1: how much of the move towards `neckHalf` is applied (0 keeps the natural neck; used to start the waist smoothly). */
  neckBlend?: number;
  /** Height of the bark ridge and the width (sigma) of its bump, both absolute. */
  ridgeHeight?: number;
  ridgeWidth?: number;
  /** Elongation along x about the mid point of the centres (1 = none). */
  stretch?: number;
  /** Vertices of one half minus one (the half has `half + 1` points: both pinch points and `half - 1` interior ones). */
  half: number;
}

export interface ForkOutline {
  /** Half 1: A (index 0) -> over lobe 1 -> B (index half). */
  x1: Float64Array;
  y1: Float64Array;
  /** Half 2: B (index 0) -> over lobe 2 -> A (index half). */
  x2: Float64Array;
  y2: Float64Array;
  /** Arc distance of every sample to the nearest pinch point (metres). */
  d1: Float64Array;
  d2: Float64Array;
  /** The centre distance really used (>= the requested one when a narrow waist was asked for) and the neck half height. */
  distance: number;
  neckHalf: number;
}

interface Piece {
  cx: number;
  cy: number;
  r: number;
  a0: number;
  a1: number;
  concave: boolean;
}

const wrapPi = (a: number): number => {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
};

/** Fillet circle centre and neck half height of two lobe circles at distance `d` joined by a fillet `rf`. */
export function forkNeck(d: number, r1: number, r2: number, rf: number): { xf: number; yf: number; hw: number } {
  const dd = Math.max(d, 1e-9 * (r1 + r2));
  const xf = ((r2 + rf) * (r2 + rf) - (r1 + rf) * (r1 + rf) - dd * dd) / (2 * dd);
  const yf = Math.sqrt(Math.max(0, (r1 + rf) * (r1 + rf) - xf * xf));
  return { xf, yf, hw: yf - rf };
}

/** Centre distance (>= `from`) that gives the neck half height `hw`; `from` itself when the natural neck is already narrower. */
export function distanceForNeck(from: number, r1: number, r2: number, rf: number, hw: number): number {
  if (forkNeck(from, r1, r2, rf).hw <= hw) return from;
  let lo = from;
  let hi = r1 + r2 + 2 * rf;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (forkNeck(mid, r1, r2, rf).hw > hw) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

const pieceLength = (p: Piece): number => p.r * Math.abs(p.a1 - p.a0);

/** Point and outward unit normal of a chain of pieces at arc position `s`. */
function walk(pieces: readonly Piece[], s: number): [number, number, number, number] {
  let rest = s;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i] as Piece;
    const len = pieceLength(p);
    if (rest <= len || i === pieces.length - 1) {
      const u = len > 1e-15 ? Math.min(1, Math.max(0, rest / len)) : 0;
      const a = p.a0 + (p.a1 - p.a0) * u;
      const c = Math.cos(a);
      const sn = Math.sin(a);
      const k = p.concave ? -1 : 1;
      return [p.cx + p.r * c, p.cy + p.r * sn, k * c, k * sn];
    }
    rest -= len;
  }
  return [0, 0, 1, 0];
}

export function buildForkOutline(input: ForkOutlineInput): ForkOutline {
  const { r1, r2, half } = input;
  const rf = Math.max(0, input.fillet);
  const rMin = Math.min(r1, r2);
  let D = Math.max(input.distance, 1.05 * Math.abs(r1 - r2), 1e-9 * (r1 + r2));
  if (input.neckHalf !== undefined && input.neckHalf > 0) {
    const wanted = distanceForNeck(D, r1, r2, rf, Math.max(input.neckHalf, 0.02 * rMin));
    D += (wanted - D) * Math.min(1, Math.max(0, input.neckBlend ?? 1));
  }
  const { xf, yf, hw } = forkNeck(D, r1, r2, rf);

  const top1 = Math.atan2(yf, xf);
  const top2 = Math.atan2(yf, xf + D);
  // Fillet arcs: from the neck point (straight below the fillet centre) to the tangent point on each lobe circle.
  const d1 = rf > 1e-12 ? wrapPi(Math.atan2(-yf, -xf) + Math.PI / 2) : 0;
  const d2 = rf > 1e-12 ? wrapPi(Math.atan2(-yf, -D - xf) + Math.PI / 2) : 0;
  const lobe1: Piece[] = [
    { cx: xf, cy: yf, r: rf, a0: -Math.PI / 2, a1: -Math.PI / 2 + d1, concave: true },
    { cx: 0, cy: 0, r: r1, a0: top1, a1: -top1, concave: false },
    { cx: xf, cy: -yf, r: rf, a0: Math.PI / 2 - d1, a1: Math.PI / 2, concave: true },
  ];
  const lobe2: Piece[] = [
    { cx: xf, cy: -yf, r: rf, a0: Math.PI / 2, a1: Math.PI / 2 - d2, concave: true },
    { cx: -D, cy: 0, r: r2, a0: -top2, a1: top2 - 2 * Math.PI, concave: false },
    { cx: xf, cy: yf, r: rf, a0: -Math.PI / 2 + d2, a1: -Math.PI / 2, concave: true },
  ];
  const chain = (pieces: Piece[]): Piece[] => pieces.filter((p) => pieceLength(p) > 1e-12);
  const c1 = chain(lobe1);
  const c2 = chain(lobe2);
  const L1 = c1.reduce((s, p) => s + pieceLength(p), 0);
  const L2 = c2.reduce((s, p) => s + pieceLength(p), 0);

  const M = half + 1;
  const out: ForkOutline = {
    x1: new Float64Array(M), y1: new Float64Array(M), x2: new Float64Array(M), y2: new Float64Array(M),
    d1: new Float64Array(M), d2: new Float64Array(M), distance: D, neckHalf: hw,
  };
  const ridgeH = Math.max(0, input.ridgeHeight ?? 0);
  const sigma = Math.max(1e-9, input.ridgeWidth ?? rMin * 0.25);
  const sx = input.stretch ?? 1;
  const mid = -D / 2;
  const fill = (chainPieces: Piece[], total: number, xs: Float64Array, ys: Float64Array, ds: Float64Array): void => {
    for (let i = 0; i < M; i++) {
      const s = (total * i) / (M - 1);
      const [px, py, nx, ny] = walk(chainPieces, s);
      const d = Math.min(s, total - s);
      const lift = ridgeH > 0 ? ridgeH * Math.exp(-((d / sigma) * (d / sigma))) : 0;
      xs[i] = mid + (px + nx * lift - mid) * sx;
      ys[i] = py + ny * lift;
      ds[i] = d;
    }
  };
  fill(c1, L1, out.x1, out.y1, out.d1);
  fill(c2, L2, out.x2, out.y2, out.d2);
  return out;
}

/** Area of a fork outline (shoelace over both halves, A -> B over lobe 1, B -> A over lobe 2). */
export function forkOutlineArea(o: ForkOutline): number {
  let sum = 0;
  const run = (xs: Float64Array, ys: Float64Array): void => {
    for (let i = 0; i + 1 < xs.length; i++) sum += (xs[i] as number) * (ys[i + 1] as number) - (xs[i + 1] as number) * (ys[i] as number);
  };
  run(o.x1, o.y1);
  run(o.x2, o.y2);
  return Math.abs(sum) / 2;
}
