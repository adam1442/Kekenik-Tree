import type { Skeleton } from '@/contracts/skeleton';
import { hash01 } from './math3';

/**
 * Wind channels. Per skeleton point the generators store four attributes
 * (`wind0`, `wind1`, `wind2`, `windPhase`) in `Skeleton.attributes`:
 *  - wind0 = trunk-level sway weight, wind1 = first branch level, wind2 = second level / leaves (all 0..1),
 *  - windPhase = per-branch phase 0..1 (derived from the parent's phase so a branch and its twigs stay coherent).
 * A branch's own level is `min(generation, 2)`; its weight grows with `t^1.5` (stiff base, free tip) and the weights
 * of the levels above are inherited from the parent point it grows from.
 */
export const WIND_ATTRIBUTES = ['wind0', 'wind1', 'wind2', 'windPhase'] as const;

export function computeSkeletonWind(sk: Skeleton, parent: Skeleton | null, seed = 0): Float32Array[] {
  const n = sk.count;
  const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)] as [
    Float32Array,
    Float32Array,
    Float32Array,
    Float32Array,
  ];
  const pw = parent
    ? WIND_ATTRIBUTES.map((k) => parent.attributes.get(k) ?? null)
    : [null, null, null, null];
  for (const b of sk.branches) {
    const level = Math.min(b.generation, 2);
    const attach = b.parentPoint;
    const inherit = [0, 0, 0, 0];
    if (attach >= 0) {
      for (let c = 0; c < 4; c++) {
        const arr = pw[c];
        inherit[c] = arr && attach < arr.length ? (arr[attach] as number) : c < 3 && c < level ? 1 : 0;
      }
    }
    const phase = (inherit[3] as number) * 0.5 + hash01(b.id * 7 + 1, seed) * 0.5 + (attach >= 0 ? 0 : hash01(seed, 3) * 0.2);
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      const t = sk.t[i] as number;
      const own = Math.pow(Math.max(0, Math.min(1, t)), 1.5);
      const w: [number, number, number] = [inherit[0] as number, inherit[1] as number, inherit[2] as number];
      if (b.generation >= 2) w[2] = w[2] + own * (1 - w[2]);
      else w[level] = own;
      for (let c = level + 1; c < 3; c++) w[c] = 0;
      out[0][i] = w[0];
      out[1][i] = w[1];
      out[2][i] = w[2];
      out[3][i] = phase - Math.floor(phase);
    }
  }
  return out;
}

/** Compute and attach the wind channels to `sk` (idempotent). */
export function attachSkeletonWind(sk: Skeleton, parent: Skeleton | null, seed = 0): void {
  if (sk.count === 0 || sk.attributes.has('wind0')) return;
  const w = computeSkeletonWind(sk, parent, seed);
  WIND_ATTRIBUTES.forEach((k, i) => sk.attributes.set(k, w[i] as Float32Array));
}

/** Give `sk` all-zero wind channels (static geometry such as roots). Overwrites existing channels. */
export function markSkeletonWindStatic(sk: Skeleton): void {
  for (const k of WIND_ATTRIBUTES) sk.attributes.set(k, new Float32Array(sk.count));
}
