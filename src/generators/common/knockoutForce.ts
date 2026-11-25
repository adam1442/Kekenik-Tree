import type { ForceDef } from '@/contracts/material';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';

/** A Knockout force attached to a generator: nodes growing towards `direction` are removed. */
export interface KnockoutForce {
  /** Unit vector. */
  direction: readonly [number, number, number];
  /** 0..1: the share of directions that are removed (0 = none, 0.5 = a hemisphere, 1 = all). */
  sensitivity: number;
}

export const KNOCKOUT_FORCE_TYPE = 'knockout';

function dirOf(params: NodeParams): [number, number, number] {
  const v = params.direction?.value;
  const x = Array.isArray(v) ? Number(v[0]) : 0;
  const y = Array.isArray(v) ? Number(v[1]) : 0;
  const z = Array.isArray(v) ? Number(v[2]) : -1;
  const l = Math.hypot(x, y, z);
  return l > 1e-9 && Number.isFinite(l) ? [x / l, y / l, z / l] : [0, 0, -1];
}

/** The active Knockout forces among the attached forces. */
export function readKnockoutForces(forces: readonly ForceDef[]): KnockoutForce[] {
  const out: KnockoutForce[] = [];
  for (const f of forces) {
    if (f.type !== KNOCKOUT_FORCE_TYPE || !f.enabled || !getBool(f.params, 'active', true)) continue;
    const s = Math.min(1, Math.max(0, getNumber(f.params, 'strength', 1) * getNumber(f.params, 'influence', 1)));
    if (s > 0) out.push({ direction: dirOf(f.params), sensitivity: s });
  }
  return out;
}

/**
 * True when a node growing along the unit vector `growth` is removed: its angle to the arrow is within
 * `acos(1 - 2 * sensitivity)` (deterministic, no random draw).
 */
export function knockedOutByForce(forces: readonly KnockoutForce[], growth: readonly [number, number, number]): boolean {
  for (const f of forces) {
    const dot = growth[0] * f.direction[0] + growth[1] * f.direction[1] + growth[2] * f.direction[2];
    if (f.sensitivity >= 1 || dot > 1 - 2 * f.sensitivity) return true;
  }
  return false;
}
