import type { Rng } from '@/core/rng';

export type PruneKind = 'interior' | 'up' | 'down';
type V3 = readonly [number, number, number];

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** A prune strength stored as a number, or as a legacy boolean (`true` = 1). */
export function pruneStrength(raw: unknown, fallback = 0): number {
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  return typeof raw === 'number' && Number.isFinite(raw) ? clamp01(raw) : fallback;
}

/**
 * Probability that a branch is removed for its orientation. `tangent` is the unit start direction, `origin` the start position
 * (the model axis is the world Z axis). Up / Down weigh by how vertical the start direction is, Interior by how much it points at the axis.
 */
export function directionalPruneChance(kind: PruneKind, strength: number, curve: number, tangent: V3, origin: V3): number {
  const s = clamp01(strength) * Math.max(0, curve);
  if (s <= 0) return 0;
  if (kind === 'up') return tangent[2] > 0.1 ? clamp01(s * clamp01(tangent[2])) : 0;
  if (kind === 'down') return tangent[2] < -0.05 ? clamp01(s * clamp01(-tangent[2])) : 0;
  const horiz = Math.hypot(origin[0], origin[1]);
  if (horiz <= 0.05) return 0;
  const toward = (origin[0] / horiz) * tangent[0] + (origin[1] / horiz) * tangent[1];
  return toward < 0 ? clamp01(s * clamp01(-toward)) : 0;
}

/** General prune: plain probability. */
export function generalPruneChance(strength: number, curve: number): number {
  return clamp01(clamp01(strength) * Math.max(0, curve));
}

/** True when any point (xyz triples) lies below the ground plane at height `groundZ`. */
export function intersectsGround(positions: ArrayLike<number>, count: number, groundZ = 0): boolean {
  for (let i = 0; i < count; i++) if ((positions[i * 3 + 2] as number) < groundZ) return true;
  return false;
}

/** Ground prune: a branch that intersects the ground plane is removed with probability `strength x curve`. */
export function groundPrunes(strength: number, curve: number, intersects: boolean, rng: Rng): boolean {
  if (!intersects) return false;
  const p = generalPruneChance(strength, curve);
  return p >= 1 || (p > 0 && rng.next() < p);
}
