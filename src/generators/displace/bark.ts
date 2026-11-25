import { hashLattice, periodicNoise2 } from './noise';

/**
 * Procedural bark relief (Displacement > Source = Bark). The pattern is a pure function of
 *  - `u`: 0..1 around the branch (periodic: the U seam gets identical values),
 *  - `s`: metres along the lineage (continues through weld rings, split halves and extensions),
 *  - the circumference (so feature sizes are in metres and independent of UV tiling / ring count),
 *  - a per-lineage seed.
 * Heights are 0..1 (1 = top of a ridge / plate, 0 = bottom of a crevice).
 */

export type BarkStyle = 'furrowed' | 'plated' | 'fibrous' | 'lenticel' | 'rings' | 'scaly';

export const BARK_STYLES: readonly BarkStyle[] = ['furrowed', 'plated', 'fibrous', 'lenticel', 'rings', 'scaly'];

export interface BarkMaturity {
  /** 0 = every branch gets the same depth, 1 = depth follows the radius fully. */
  amount: number;
  /** Radius (m) up to which the bark is smooth. */
  rMin: number;
  /** Radius (m) from which the bark has its full depth. */
  rMax: number;
  /** Depth multiplier along the branch (0 base .. 1 tip, 256-entry lookup table); null = 1. */
  curve: Float32Array | null;
}

export interface BarkSpec {
  style: BarkStyle;
  /** Relief (peak to valley) as a fraction of the local radius; 0 = off. */
  depth: number;
  /** Feature size in metres. */
  scale: number;
  /** Feature length along the spine relative to its width. */
  stretch: number;
  /** Domain warp strength (0 = straight features). */
  warp: number;
  /** Crevice profile remap (256-entry table); null = linear. */
  crevice: Float32Array | null;
  maturity: BarkMaturity;
  seed: number;
  /** Per-branch cap of the vertices that auto-subdivision may create. */
  maxVertices: number;
}

/** Vertex inputs the bark pattern needs. */
export interface BarkInput {
  /** 0..1 around the branch. */
  u: number;
  /** Metres along the lineage. */
  s: number;
  /** Circumference of the thickest ring of the branch (metres). */
  circumference: number;
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const smooth01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const wrap = (i: number, period: number): number => ((i % period) + period) % period;

/** Lookup in a 256-entry 0..1 table (linear interpolation, input clamped). */
export function lookup01(lut: Float32Array | null, x: number): number {
  const c = clamp01(x);
  if (!lut) return c;
  const f = c * (lut.length - 1);
  const i = Math.min(lut.length - 2, Math.floor(f));
  const a = lut[i] as number;
  return clamp01(a + ((lut[i + 1] as number) - a) * (f - i));
}

/**
 * Crevice profile as a Sharpness-style lookup table. 0.5 = linear (null); above 0.5 the crevices get narrower and
 * V-shaped (the tops widen), below 0.5 the bottoms become flat plateaus.
 */
export function creviceLut(crevice: number): Float32Array | null {
  const c = clamp01(crevice);
  if (Math.abs(c - 0.5) < 1e-3) return null;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const h = i / 255;
    if (c > 0.5) lut[i] = Math.pow(h, 1 / (1 + (c - 0.5) * 4));
    else {
      const t = (0.5 - c) * 0.8;
      lut[i] = smooth01((h - t) / (1 - t));
    }
  }
  return lut;
}

/** Periodic noise of the lattice with `cells` cells around: `u` is 0..1, the result tiles at u = 1. */
const pn = (u: number, y: number, cells: number, seed: number): number => {
  const c = Math.max(1, Math.round(cells));
  return periodicNoise2(u * c, y, c, seed);
};

const cellsFor = (circ: number, size: number): number => Math.max(1, Math.round(circ / Math.max(1e-4, size)));

function furrowed(spec: BarkSpec, u: number, s: number, circ: number, seed: number): number {
  const cx = cellsFor(circ, spec.scale);
  const len = spec.scale * Math.max(0.1, spec.stretch);
  const wx = (pn(u, s / (len * 2), Math.max(1, Math.round(cx / 2)), seed + 11) - 0.5) * 2 * spec.warp;
  const wy = (pn(u, s / (len * 2) + 5.3, Math.max(1, Math.round(cx / 2)), seed + 13) - 0.5) * 2 * spec.warp;
  const x = u * cx + wx;
  const y = s / len + wy;
  const n1 = periodicNoise2(x, y, cx, seed);
  const n2 = periodicNoise2(x * 2 + 0.3, y * 2.1, cx * 2, seed + 101);
  // |2n - 1| has a sharp V at the zero crossing (the crevice) and smooth, wide tops.
  return 0.72 * Math.abs(2 * n1 - 1) + 0.28 * Math.abs(2 * n2 - 1);
}

function plated(spec: BarkSpec, u: number, s: number, circ: number, seed: number): number {
  const cx = cellsFor(circ, spec.scale);
  const len = spec.scale * Math.max(0.1, spec.stretch);
  const wx = (pn(u, s / (len * 2), Math.max(1, Math.round(cx / 2)), seed + 11) - 0.5) * spec.warp * 0.8;
  const wy = (pn(u, s / (len * 2) + 5.3, Math.max(1, Math.round(cx / 2)), seed + 13) - 0.5) * spec.warp * 0.8;
  const x = u * cx + wx;
  const y = s / len + wy;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = ix + dx;
      const gy = iy + dy;
      const wx0 = wrap(gx, cx);
      const px = gx + 0.15 + 0.7 * hashLattice(wx0, gy, seed + 31);
      const py = gy + 0.15 + 0.7 * hashLattice(wx0, gy, seed + 77);
      const d = Math.hypot(x - px, y - py);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  }
  const edge = f2 - f1;
  // Blocky plates with slightly rounded tops, separated by a crack network.
  return smooth01(edge / 0.5) * (1 - 0.18 * Math.min(1, f1));
}

function fibrous(spec: BarkSpec, u: number, s: number, circ: number, seed: number): number {
  const cx = cellsFor(circ, spec.scale);
  const cf = cx * 3;
  const len = spec.scale * Math.max(0.1, spec.stretch) * 2;
  const drift = (pn(u, s / (len * 1.5), Math.max(1, Math.round(cx / 2)), seed + 5) - 0.5) * spec.warp * 3;
  const x = u * cf + drift;
  const y = s / len;
  const fibre = periodicNoise2(x, y, cf, seed);
  const clump = periodicNoise2(x / 3, y * 0.5, cx, seed + 9);
  return 0.7 * fibre + 0.3 * Math.abs(2 * clump - 1);
}

function lenticel(spec: BarkSpec, u: number, s: number, circ: number, seed: number): number {
  // Cells are `scale` tall and `scale x stretch` wide: slits and peeling bands run around the trunk.
  const cl = cellsFor(circ, spec.scale * Math.max(0.2, spec.stretch));
  const x = u * cl;
  const y = s / spec.scale;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const wi = wrap(ix, cl);
  let slit = 0;
  if (hashLattice(wi, iy, seed) > 0.58) {
    const cx0 = ix + 0.25 + 0.5 * hashLattice(wi, iy, seed + 1);
    const cy0 = iy + 0.3 + 0.4 * hashLattice(wi, iy, seed + 2);
    const half = 0.12 + 0.1 * hashLattice(wi, iy, seed + 3);
    const dx = (x - cx0) / half;
    const dy = (y - cy0) / 0.1;
    slit = smooth01(1 - (dx * dx + dy * dy));
  }
  const bands = pn(u, s / (spec.scale * 3), cellsFor(circ, spec.scale * 8), seed + 3);
  const peel = smooth01((bands - 0.55) / 0.25) * (0.15 + 0.2 * clamp01(spec.warp));
  return (1 - 0.85 * slit) * (1 - peel);
}

function rings(spec: BarkSpec, u: number, s: number, circ: number, seed: number): number {
  const irregular = (pn(u, s / (spec.scale * 5), cellsFor(circ, spec.scale * 3), seed) - 0.5) * spec.warp * 0.6;
  const y = s / spec.scale + irregular;
  const c = 0.5 + 0.5 * Math.cos(2 * Math.PI * y);
  const amp = 0.85 + 0.15 * pn(u, y * 0.37, cellsFor(circ, spec.scale * 2), seed + 2);
  return Math.pow(c, 1.5) * amp;
}

function scaly(spec: BarkSpec, u: number, s: number, circ: number, seed: number): number {
  const cx = Math.max(2, 2 * Math.round(circ / Math.max(1e-4, spec.scale) / 2));
  const rowH = spec.scale * Math.sqrt(Math.max(0.1, spec.stretch));
  const wob = (pn(u, s / (rowH * 3), Math.max(1, Math.round(cx / 3)), seed + 4) - 0.5) * spec.warp * 0.4;
  const y = s / rowH + wob;
  const row = Math.floor(y);
  const fy = y - row;
  const xs = u * cx + (wrap(row, 2) === 1 ? 0.5 : 0);
  const col = Math.floor(xs);
  const fx = xs - col;
  const rnd = hashLattice(wrap(col, cx), row, seed);
  const lateral = Math.pow(Math.sin(Math.PI * fx), 0.6);
  // Each scale rises toward its free edge (overlapping shingles) and drops to the next row.
  return (0.35 + 0.65 * Math.pow(fy, 1.2)) * (0.85 + 0.15 * rnd) * (0.35 + 0.65 * lateral);
}

const STYLE_FN: Record<BarkStyle, (spec: BarkSpec, u: number, s: number, circ: number, seed: number) => number> = {
  furrowed,
  plated,
  fibrous,
  lenticel,
  rings,
  scaly,
};

/** Bark height 0..1 (after the crevice profile) of one surface point; `seed` already includes the lineage. */
export function barkHeight(spec: BarkSpec, v: BarkInput, seed: number): number {
  const h = clamp01(STYLE_FN[spec.style](spec, v.u, v.s, Math.max(1e-4, v.circumference), seed));
  return lookup01(spec.crevice, h);
}

/** Depth multiplier of the branch maturity: radius smoothstep between rMin and rMax, times the curve along the branch. */
export function barkMaturityFactor(m: BarkMaturity, radius: number, t: number): number {
  const span = Math.max(1e-6, m.rMax - m.rMin);
  const byRadius = smooth01((radius - m.rMin) / span);
  const amount = clamp01(m.amount);
  const mult = 1 - amount + amount * byRadius;
  return m.curve ? mult * lookup01(m.curve, t) : mult;
}

/**
 * Feature sizes that auto-subdivision must resolve (>= 4 vertices across the narrowest one):
 * `around` and `along` are the vertex spacings in metres.
 */
export function barkSpacing(spec: BarkSpec): { around: number; along: number } {
  const s = spec.scale;
  const st = Math.max(0.1, spec.stretch);
  let across = s * 0.5;
  let along = s * st * 0.5;
  if (spec.style === 'fibrous') across = s / 3;
  else if (spec.style === 'lenticel') {
    across = s * 0.2;
    along = s * 0.2;
  } else if (spec.style === 'rings') {
    along = s * 0.25;
    across = s * 2;
  } else if (spec.style === 'scaly') along = s * Math.sqrt(st) * 0.5;
  if (spec.style === 'plated') across = s * 0.25;
  return { around: Math.max(1e-3, across / 4), along: Math.max(1e-3, along / 4) };
}

/** Rings x sides of a branch for the given spacings. */
export function barkGrid(length: number, rMax: number, around: number, along: number, minSides: number, maxSides: number, maxRings: number): { rings: number; sides: number } {
  const rings = Math.min(maxRings, Math.max(2, Math.ceil(length / Math.max(1e-4, along))));
  const sides = Math.min(maxSides, Math.max(minSides, Math.ceil((2 * Math.PI * rMax) / Math.max(1e-4, around))));
  return { rings, sides };
}
