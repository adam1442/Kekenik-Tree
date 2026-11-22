import { clamp } from '@/core/math';
import type { ModeFrame, PlacementRecord } from './types';

export const TAU = Math.PI * 2;

/** Golden angle in radians (~137.508 deg). */
export const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));

/** Hard upper bound of groups produced by one parent (protects against absurd Internode / Frequency values). */
export const MAX_GROUPS = 50_000;

/** Left / right side of a node from its roll: the half-turn on one side of the parent's normal plane. */
export function sideOfRoll(roll: number): 1 | -1 {
  return Math.sin(roll) >= 0 ? 1 : -1;
}

/** Number of nodes that survive the level of detail and the per-node cap. */
export function scaledCount(frame: ModeFrame, base: number): number {
  const c = Math.round(base * frame.lodKeep);
  return Math.min(frame.maxCount, Math.max(0, c));
}

/** Keeps `t` inside the shared First / Last boundaries. */
export function inBounds(frame: ModeFrame, t: number): number {
  return clamp(t, frame.first, frame.last);
}

export function span(frame: ModeFrame): number {
  return Math.max(0, frame.last - frame.first);
}

export function record(t: number, roll: number, groupIndex: number, side?: 1 | -1): PlacementRecord {
  return { t, roll, side: side ?? sideOfRoll(roll), groupIndex };
}

/** Parity side used by group modes: members of one group alternate, and so do consecutive single-node groups. */
export function paritySide(groupIndex: number, member: number): 1 | -1 {
  return (groupIndex + member) % 2 === 0 ? 1 : -1;
}
