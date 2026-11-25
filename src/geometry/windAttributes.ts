import type { Branch, Skeleton } from '@/contracts/skeleton';
import { SPINE_ORIGIN_ATTR, SpineOrigin } from '@/generators/split/lineage';
import { hash01 } from './math3';

/**
 * Wind channels. Per skeleton point the generators store five attributes
 * (`wind0`, `wind1`, `wind2`, `windPhase`, `windPhase1`) in `Skeleton.attributes`:
 *  - wind0 = trunk-level sway weight, wind1 = first branch level, wind2 = second level / leaves (all 0..1),
 *  - windPhase = per-branch phase 0..1 of the level-2 / leaf terms (derived from the parent's phase so a branch and its twigs stay coherent),
 *  - windPhase1 = phase 0..1 of the level-1 ancestor, used by the level-1 (branch sway) terms. A branch of level <= 1 creates its own
 *    (`(1 - v) * parentPhase + v * hash`, v = `windPhaseVariance`, default 0.5 = the old single phase); a deeper branch, every split half,
 *    extension and every foliage item copies it unchanged from the attach point. Constant per level, never interpolated, so a child's base
 *    moves exactly like the parent point it grows from.
 *
 * Regular children: a branch's own level is `min(generation, 2)`; its weight grows with `t^1.5` (stiff base, free tip) and the
 * weights of the levels above are inherited from the parent point it grows from. Phase = half the parent's phase + a per-branch hash.
 *
 * Continuations (the two halves of a split, `SpineOrigin.SplitHalf`, and extensions that prolong an open end,
 * `SpineOrigin.Extension`) are the same limb as the point they attach to, so they inherit the COMPLETE vector (w0, w1, w2) and the
 * phase exactly, keep the wind level of the host (not their generation) and let that level grow from the inherited value:
 * `w[L](t) = a + (1 - a) * t^1.5` (equal to the host at t = 0, never decreasing, never above 1). The host is read from the
 * skeleton's own output when it lives in the same skeleton (halves, virtual-split extensions, flagged with {@link WIND_HOST_ATTR};
 * every branch of a Trunk) and from `parent` otherwise. Branches are processed parents first.
 */
export const WIND_ATTRIBUTES = ['wind0', 'wind1', 'wind2', 'windPhase', 'windPhase1'] as const;

/**
 * (w0, w1, w2, phase, phase1) of one attach point / item. The fifth element is optional so 4-element data (old callers, imported
 * meshes) keeps working; read it with `wind[4] ?? wind[3]`.
 */
export type WindTuple = [number, number, number, number, number?];

/** Level-1 phase of a {@link WindTuple} (falls back to the leaf-level phase). */
export const windPhase1OfTuple = (w: readonly (number | undefined)[]): number => (w[4] ?? w[3]) as number;

/** Per-branch flag (value 1 on every point): the branch grows from a branch of the SAME skeleton (`parentBranch` is a local id). */
export const WIND_HOST_ATTR = 'windHost';

export function computeSkeletonWind(sk: Skeleton, parent: Skeleton | null, seed = 0, phaseVariance = 0.5): Float32Array[] {
  const n = sk.count;
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)] as [
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
  ];
  const variance = Math.max(0, Math.min(1, phaseVariance));
  const pw = parent
    ? WIND_ATTRIBUTES.map((k) => parent.attributes.get(k) ?? null)
    : [null, null, null, null, null];
  const byId = new Map<number, Branch>();
  for (const b of sk.branches) byId.set(b.id, b);
  const parentById = new Map<number, Branch>();
  if (parent) for (const b of parent.branches) parentById.set(b.id, b);
  const hostFlag = sk.attributes.get(WIND_HOST_ATTR);
  const originAttr = sk.attributes.get(SPINE_ORIGIN_ATTR);
  /** 0 = pending, 1 = in progress, 2 = done */
  const state = new Map<number, number>();

  const process = (b: Branch): void => {
    if (state.get(b.id) === 2) return;
    state.set(b.id, 1);
    const origin = originAttr ? Math.round(originAttr[b.start] as number) : 0;
    const continuation = origin === SpineOrigin.SplitHalf || origin === SpineOrigin.Extension;
    const attach = b.parentPoint;
    // Host inside this skeleton: flagged, or any continuation of a skeleton without an upstream generator (Trunk)
    let host: Branch | undefined;
    if (attach >= 0 && b.parentBranch >= 0) {
      const cand = byId.get(b.parentBranch);
      const flagged = hostFlag !== undefined && (hostFlag[b.start] as number) > 0;
      if (cand && cand.id !== b.id && (flagged || (parent === null && continuation))) {
        if (state.get(cand.id) === undefined) process(cand);
        if (state.get(cand.id) === 2 && attach >= cand.start && attach < cand.start + cand.count) host = cand;
      }
    }
    const level = Math.min(b.generation, 2);
    let hostLevel = level;
    const inherit = [0, 0, 0, 0, 0];
    if (host) {
      hostLevel = Math.min(host.generation, 2);
      for (let c = 0; c < 5; c++) inherit[c] = (out[c] as Float32Array)[attach] as number;
    } else if (attach >= 0) {
      const hb = parentById.get(b.parentBranch);
      if (continuation) hostLevel = Math.min(hb ? hb.generation : Math.max(0, b.generation - 1), 2);
      const fillLevel = continuation ? hostLevel : level;
      for (let c = 0; c < 5; c++) {
        const arr = pw[c];
        inherit[c] = arr && attach < arr.length ? (arr[attach] as number) : c < 3 && c < fillLevel ? 1 : 0;
      }
      // A parent without the level-1 channel (older data): its single phase was the level-1 phase
      if (!pw[4]) inherit[4] = inherit[3] as number;
    }
    const exactContinuation = continuation && attach >= 0;
    const rootOffset = attach >= 0 ? 0 : hash01(seed, 3) * 0.2;
    const hash = hash01(b.id * 7 + 1, seed);
    const phase = exactContinuation ? (inherit[3] as number) : (inherit[3] as number) * 0.5 + hash * 0.5 + rootOffset;
    // Level-1 phase: continuations copy it; level <= 1 creates its own; deeper branches take the attach point's
    let phase1: number;
    if (exactContinuation) phase1 = inherit[4] as number;
    else if (level <= 1 || attach < 0) phase1 = (inherit[3] as number) * (1 - variance) + hash * variance + rootOffset;
    else phase1 = inherit[4] as number;
    const phase1Frac = phase1 - Math.floor(phase1);
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      const t = sk.t[i] as number;
      const own = Math.pow(Math.max(0, Math.min(1, t)), 1.5);
      const w: [number, number, number] = [inherit[0] as number, inherit[1] as number, inherit[2] as number];
      if (exactContinuation) {
        w[hostLevel] = w[hostLevel] + own * (1 - w[hostLevel]);
      } else {
        if (b.generation >= 2) w[2] = w[2] + own * (1 - w[2]);
        else w[level] = own;
        for (let c = level + 1; c < 3; c++) w[c] = 0;
      }
      out[0][i] = w[0];
      out[1][i] = w[1];
      out[2][i] = w[2];
      out[3][i] = phase - Math.floor(phase);
      out[4][i] = phase1Frac;
    }
    state.set(b.id, 2);
  };
  for (const b of sk.branches) process(b);
  return out;
}

/** Compute and attach the wind channels to `sk` (idempotent). */
export function attachSkeletonWind(sk: Skeleton, parent: Skeleton | null, seed = 0, phaseVariance = 0.5): void {
  if (sk.count === 0 || sk.attributes.has('wind0')) return;
  const w = computeSkeletonWind(sk, parent, seed, phaseVariance);
  WIND_ATTRIBUTES.forEach((k, i) => sk.attributes.set(k, w[i] as Float32Array));
}

/** Give `sk` all-zero wind channels (static geometry such as roots). Overwrites existing channels. */
export function markSkeletonWindStatic(sk: Skeleton): void {
  for (const k of WIND_ATTRIBUTES) sk.attributes.set(k, new Float32Array(sk.count));
}
