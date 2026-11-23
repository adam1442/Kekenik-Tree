import type { Rng } from '@/core/rng';
import { resolveAreaRect, WHOLE_MAP, type UvAreaLike } from './areas';
import type { TilingStyle, UvRect } from './types';

// ---- ring layout ------------------------------------------------------------------------------------------------------

export interface PatchLayoutInput {
  /** Non-decreasing V per source ring; patch p covers V in [p, p + 1]. */
  v: ArrayLike<number>;
  /** Snap a seam onto an existing ring that is within `tolerance` of the whole V number instead of adding a ring. */
  optimize: boolean;
  tolerance: number;
  /** Seams never fall on rings below this index (the rings of a weld); they move up to it. */
  firstFree: number;
}

export interface PatchLayout {
  /** Rings of the patched branch. */
  count: number;
  /** Source ring of every output ring; `frac` > 0 interpolates toward `src + 1`. */
  src: Int32Array;
  frac: Float32Array;
  /** Patch every ring belongs to. */
  patch: Int32Array;
  /** V inside its patch, 0..1. */
  localV: Float32Array;
  /** 1 = this ring opens a patch: the quad between it and the previous ring is a seam and is not drawn. */
  seamStart: Uint8Array;
  patches: number;
}

interface Seam {
  ring: number;
  frac: number;
  n: number;
}

const EPS = 1e-9;

/**
 * Splits a branch into patches at every whole V number. A seam ring exists twice with the same position (end of one
 * patch with local V 1, start of the next with local V 0), so the vertices along a seam are doubled. A seam either
 * adds a ring (default) or, with Optimize segments, moves onto an existing ring within the tolerance, which avoids two
 * rings very close together.
 */
export function layoutPatches(input: PatchLayoutInput): PatchLayout {
  const { v } = input;
  const R = v.length;
  const seams: Seam[] = [];
  if (R >= 2) {
    const vEnd = v[R - 1] as number;
    const last = Math.max(0, Math.ceil(vEnd - EPS) - 1);
    const firstFree = Math.min(Math.max(1, input.firstFree), R - 1);
    let i = 0;
    for (let n = 1; n <= last; n++) {
      while (i < R - 2 && (v[i + 1] as number) < n - EPS) i++;
      const lo = v[i] as number;
      const hi = v[i + 1] as number;
      let ring = -1;
      let frac = 0;
      if (Math.abs(lo - n) <= EPS) ring = i;
      else if (Math.abs(hi - n) <= EPS) ring = i + 1;
      else if (input.optimize && Math.min(n - lo, hi - n) <= input.tolerance) ring = n - lo <= hi - n ? i : i + 1;
      else frac = hi - lo > EPS ? (n - lo) / (hi - lo) : 0.5;
      if (ring === R - 1) continue;
      // Seams inside the weld move up to its last ring.
      if (ring >= 0 && ring < firstFree) ring = firstFree;
      if (ring < 0 && i + 1 <= firstFree) {
        ring = firstFree;
        frac = 0;
      }
      if (ring === R - 1) continue;
      const seam: Seam = ring >= 0 ? { ring, frac: 0, n } : { ring: i, frac: Math.min(1 - 1e-6, Math.max(1e-6, frac)), n };
      const prev = seams[seams.length - 1];
      if (prev && prev.ring === seam.ring && prev.frac === seam.frac) continue;
      seams.push(seam);
    }
  }

  const cap = R + seams.length * 2;
  const src = new Int32Array(cap);
  const fracOut = new Float32Array(cap);
  const patch = new Int32Array(cap);
  const localV = new Float32Array(cap);
  const seamStart = new Uint8Array(cap);
  let count = 0;
  let current = 0;
  let nStart = 0;
  let cursor = 0;
  const push = (s: number, f: number, p: number, lv: number, start: boolean): void => {
    src[count] = s;
    fracOut[count] = f;
    patch[count] = p;
    localV[count] = Math.min(1, Math.max(0, lv));
    seamStart[count] = start ? 1 : 0;
    count++;
  };
  const openPatch = (s: number, f: number, seam: Seam): void => {
    push(s, f, current, 1, false);
    current++;
    nStart = seam.n;
    push(s, f, current, 0, true);
  };
  for (let i = 0; i < R; i++) {
    const seam = seams[cursor];
    if (seam && seam.ring === i && seam.frac === 0) {
      openPatch(i, 0, seam);
      cursor++;
    } else push(i, 0, current, (v[i] as number) - nStart, false);
    for (let s = seams[cursor]; s && s.ring === i; s = seams[cursor]) {
      openPatch(i, s.frac, s);
      cursor++;
    }
  }
  return { count, src, frac: fracOut, patch, localV, seamStart, patches: current + 1 };
}

// ---- material / area choice -----------------------------------------------------------------------------------------

/** One row of a Branch / Extension material list. */
export interface PatchRow {
  /** Material id, Material Set id, `inherited` or '' (none). */
  material: string;
  weight: number;
  /** `whole`, `any` or a UV Area id. */
  uvArea: string;
  placement: 'anywhere' | 'first';
}

export interface PatchDeps {
  /** Concrete material id of a row value (sets pick a member with `rng`, `inherited` follows the parent). */
  resolveMaterial(ref: string, rng: Rng): string;
  areas: readonly UvAreaLike[];
}

export interface PatchChoice {
  /** Material of every patch (a single entry in Tiling style). */
  materials: string[];
  /** UV Area rectangle of every patch. */
  rects: UvRect[];
}

function pickIndex(weights: readonly number[], r: number): number {
  let total = 0;
  for (const w of weights) total += Math.max(0, w);
  if (total <= 0) return 0;
  let acc = 0;
  let last = 0;
  for (let k = 0; k < weights.length; k++) {
    const w = Math.max(0, weights[k] as number);
    if (w <= 0) continue;
    last = k;
    acc += w / total;
    if (r < acc) return k;
  }
  return last;
}

const eligible = (rows: readonly PatchRow[], patch: number): PatchRow[] => {
  const list = rows.filter((r) => r.placement === 'anywhere' || patch === 0);
  return list.length > 0 ? list : [...rows];
};

/**
 * Chooses the material (and UV Area) of every patch of one branch.
 * - `tiling`: one weighted row for the whole branch, whole map.
 * - `patch-one`: one material (rows grouped by material, weighted by their summed weights) for the whole branch; every
 *   patch picks one of that material's rows (its UV Area).
 * - `patch-all`: every patch picks any row by weight.
 * Rows with Placement `first` only compete for the first patch. Fixed number of draws for fixed inputs: deterministic.
 */
export function choosePatches(mode: TilingStyle, rows: readonly PatchRow[], patchCount: number, rng: Rng, deps: PatchDeps): PatchChoice {
  const list = rows.length > 0 ? rows : [{ material: '', weight: 1, uvArea: 'whole', placement: 'anywhere' as const }];
  if (mode === 'tiling') {
    const row = list[pickIndex(list.map((r) => r.weight), rng.next())] as PatchRow;
    return { materials: [deps.resolveMaterial(row.material, rng)], rects: [WHOLE_MAP] };
  }
  const count = Math.max(1, Math.round(patchCount));
  const materials: string[] = [];
  const rects: UvRect[] = [];
  if (mode === 'patch-one') {
    const keys = [...new Set(list.map((r) => r.material))];
    const sums = keys.map((k) => list.filter((r) => r.material === k).reduce((a, r) => a + Math.max(0, r.weight), 0));
    const key = keys[pickIndex(sums, rng.next())] as string;
    const group = list.filter((r) => r.material === key);
    const material = deps.resolveMaterial(key, rng);
    for (let p = 0; p < count; p++) {
      const pool = eligible(group, p);
      const row = pool[pickIndex(pool.map((r) => r.weight), rng.next())] as PatchRow;
      materials.push(material);
      rects.push(resolveAreaRect(row.uvArea, material, deps.areas, rng));
    }
    return { materials, rects };
  }
  for (let p = 0; p < count; p++) {
    const pool = eligible(list, p);
    const row = pool[pickIndex(pool.map((r) => r.weight), rng.next())] as PatchRow;
    const material = deps.resolveMaterial(row.material, rng);
    materials.push(material);
    rects.push(resolveAreaRect(row.uvArea, material, deps.areas, rng));
  }
  return { materials, rects };
}
