/**
 * Seeded, wrap-around value noise for the branch Displacement tab. Pure functions of (x, y, period, seed):
 * the same input always gives the same value, and a lattice period along x makes the pattern tile exactly,
 * so the U seam of a tube (u = 0 and u = 1) receives the identical value.
 */

/** 32-bit integer hash of a lattice point and a seed -> [0, 1). */
export function hashLattice(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iy | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const quintic = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

const wrap = (i: number, period: number): number => ((i % period) + period) % period;

/**
 * Smooth value noise in [0, 1]. `periodX` (>= 1, integer) is the number of lattice cells along x after which the
 * pattern repeats; y is unbounded.
 */
export function periodicNoise2(x: number, y: number, periodX: number, seed: number): number {
  const p = Math.max(1, Math.round(periodX));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = quintic(x - x0);
  const ty = quintic(y - y0);
  const xa = wrap(x0, p);
  const xb = wrap(x0 + 1, p);
  const a = hashLattice(xa, y0, seed);
  const b = hashLattice(xb, y0, seed);
  const c = hashLattice(xa, y0 + 1, seed);
  const d = hashLattice(xb, y0 + 1, seed);
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/** Three octaves of periodic noise, normalised to [0, 1] (each octave doubles the period). */
export function periodicFbm2(x: number, y: number, periodX: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = 1;
  for (let o = 0; o < 3; o++) {
    sum += amp * periodicNoise2(x * fx, y * fx, periodX * fx, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
  }
  return sum / norm;
}

/** Folds a seed value and a branch id into one noise seed (every branch gets its own pattern). */
export function branchSeed(seed: number, branchId: number): number {
  return Math.imul((seed | 0) ^ 0x5bd1e995, 0x01000193) ^ Math.imul((branchId | 0) + 1, 0x9e3779b1);
}
