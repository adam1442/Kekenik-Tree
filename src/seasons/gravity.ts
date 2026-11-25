import { getNumber, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { applyForces } from '@/forces';
import { seasonGravityForce, seasonNodeValue } from './index';

export { seasonNodeValue };

/** Season gravity of a branch generator (reference strength per unit of `seasonGravity`). */
const GRAVITY_GAIN = 2;

/**
 * Season > Gravity: the finished skeleton droops by `seasonGravity` x transition value (through the same cantilever
 * solver as the Gravity force, so lengths are preserved). Does nothing at transition 0, gravity 0 or without a Tree.
 */
export function applySeasonGravity(skeleton: Skeleton, params: NodeParams, transition: number | undefined, seed: number): void {
  const gravity = getNumber(params, 'seasonGravity', 0);
  if (skeleton.count === 0 || transition === undefined || !(transition > 0) || gravity === 0) return;
  applyForces(skeleton, [seasonGravityForce('season-gravity', gravity * transition * GRAVITY_GAIN)], { rng: new Rng(seed || 1).fork('seasonGravity') });
}
