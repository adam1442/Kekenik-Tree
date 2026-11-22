import type { Rng } from '@/core/rng';
import { orthonormalNormal, rotateAroundAxis, v3Cross, v3Dot, v3Norm, type Vec3 } from '@/nodes/generators/frames';

/** Start angle on the 0..1 scale: 0 = parent direction, 0.5 = perpendicular, 1 = opposite to the parent. */
export function startAngleFromUnit(unit: number): number {
  return Math.PI * Math.max(0, Math.min(1, unit));
}

/** Start angle stored in degrees (inspector unit): 0 = parent direction, 90 = perpendicular, 180 = opposite. */
export function startAngleFromDegrees(deg: number): number {
  return startAngleFromUnit(deg / 180);
}

/** Angle (radians) between `from` and `to` around `axis` (signed, right-hand rule). */
function signedAngle(from: Vec3, to: Vec3, axis: Vec3): number {
  return Math.atan2(v3Dot(axis, v3Cross(from, to)), v3Dot(from, to));
}

/**
 * Alignment: blends a random "up" (the normal rotated by `randomRollRad` around the tangent) with the world up. 0 keeps the random
 * up, 1 puts the branch top exactly towards world +Z (as far as the tangent allows).
 */
export function alignedNormal(tangent: Vec3, normal: Vec3, alignment: number, randomRollRad: number, worldUp: Vec3 = [0, 0, 1]): Vec3 {
  const t = v3Norm(tangent);
  const rolled = orthonormalNormal(t, rotateAroundAxis(normal, t, randomRollRad));
  const a = Math.max(0, Math.min(1, alignment));
  if (a <= 1e-6) return rolled;
  const target = orthonormalNormal(t, worldUp);
  const proj = v3Dot(worldUp, t);
  // The tangent is (nearly) parallel to the world up: there is no preferred top, keep the random one.
  if (Math.abs(proj) > 0.9999) return rolled;
  return orthonormalNormal(t, rotateAroundAxis(rolled, t, signedAngle(rolled, target, t) * a));
}

/**
 * Random roll of a branch's "up". With Unify the roll is drawn once per group (nodes opposite each other on the parent share it),
 * otherwise per node. Returns an angle in [0, 2 PI).
 */
export function randomUpRoll(groupRng: Rng, nodeRng: Rng, unify: boolean): number {
  return (unify ? groupRng : nodeRng).next() * Math.PI * 2;
}

/**
 * Start roll for a node. With Unify the nodes on opposite sides of the parent (`side` +1 / -1) mirror each other so the
 * pair keeps a common orientation.
 */
export function unifiedStartRoll(startRollDeg: number, side: number, unify: boolean): number {
  return unify && side < 0 ? -startRollDeg : startRollDeg;
}
