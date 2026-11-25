/** Small numeric helpers shared by the QA metrics (pure, no DOM). */

export interface Summary {
  count: number;
  mean: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}

export const EMPTY_SUMMARY: Summary = { count: 0, mean: 0, p50: 0, p95: 0, min: 0, max: 0 };

/** Linear-interpolated percentile (`q` in 0..1) of an ascending sorted array. */
export function percentileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const x = Math.min(1, Math.max(0, q)) * (n - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = sorted[i] as number;
  const b = sorted[Math.min(n - 1, i + 1)] as number;
  return a + (b - a) * f;
}

export function summarize(values: ArrayLike<number>): Summary {
  const n = values.length;
  if (n === 0) return EMPTY_SUMMARY;
  const sorted = Float64Array.from(values as ArrayLike<number>).sort();
  let sum = 0;
  for (let i = 0; i < n; i++) sum += sorted[i] as number;
  return { count: n, mean: sum / n, p50: percentileSorted(sorted, 0.5), p95: percentileSorted(sorted, 0.95), min: sorted[0] as number, max: sorted[n - 1] as number };
}

export function mean(values: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i] as number;
  return values.length === 0 ? 0 : s / values.length;
}

export function rms(values: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < values.length; i++) s += (values[i] as number) * (values[i] as number);
  return values.length === 0 ? 0 : Math.sqrt(s / values.length);
}

/** Solves the square system `a x = b` (Gaussian elimination, partial pivoting); null when singular. */
export function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[p] as number[])[c] as number)) p = r;
    const pivot = (m[p] as number[])[c] as number;
    if (Math.abs(pivot) < 1e-14) return null;
    [m[c], m[p]] = [m[p] as number[], m[c] as number[]];
    for (let r = c + 1; r < n; r++) {
      const f = ((m[r] as number[])[c] as number) / ((m[c] as number[])[c] as number);
      for (let k = c; k <= n; k++) (m[r] as number[])[k] = ((m[r] as number[])[k] as number) - f * ((m[c] as number[])[k] as number);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = (m[r] as number[])[n] as number;
    for (let k = r + 1; k < n; k++) s -= ((m[r] as number[])[k] as number) * (x[k] as number);
    x[r] = s / ((m[r] as number[])[r] as number);
  }
  return x;
}

/**
 * Residuals of `y(x)` against its least-squares polynomial of `degree` (the "smoothed taper"). x is normalised internally.
 * Falls back to the mean when there are too few samples.
 */
export function polynomialResiduals(xs: ArrayLike<number>, ys: ArrayLike<number>, degree = 3): number[] {
  const n = ys.length;
  if (n === 0) return [];
  const d = Math.min(degree, n - 1);
  if (d <= 0) {
    const m = mean(ys);
    return Array.from(ys as ArrayLike<number>, (y) => y - m);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, xs[i] as number);
    hi = Math.max(hi, xs[i] as number);
  }
  const span = Math.max(1e-12, hi - lo);
  const t = (i: number): number => (((xs[i] as number) - lo) / span) * 2 - 1;
  const ata: number[][] = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
  const atb = new Array<number>(d + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const ti = t(i);
    const pw = [1];
    for (let k = 1; k <= 2 * d; k++) pw.push((pw[k - 1] as number) * ti);
    for (let r = 0; r <= d; r++) {
      atb[r] = (atb[r] as number) + (pw[r] as number) * (ys[i] as number);
      for (let c = 0; c <= d; c++) (ata[r] as number[])[c] = ((ata[r] as number[])[c] as number) + (pw[r + c] as number);
    }
  }
  const coef = solveLinear(ata, atb);
  if (!coef) {
    const m = mean(ys);
    return Array.from(ys as ArrayLike<number>, (y) => y - m);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const ti = t(i);
    let fit = 0;
    let p = 1;
    for (let k = 0; k <= d; k++) {
      fit += (coef[k] as number) * p;
      p *= ti;
    }
    out.push((ys[i] as number) - fit);
  }
  return out;
}
