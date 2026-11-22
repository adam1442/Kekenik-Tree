import { bifurcation } from './bifurcationMode';
import { absolute, density, flood, parentOrigin, proportional } from './countModes';
import { interval, phyllotaxy } from './groupModes';
import { steps } from './stepsMode';
import type { ModeFrame, ModeId, ModeRequest, PlacementRecord } from './types';

export * from './types';
export { GOLDEN_ANGLE_RAD, sideOfRoll, TAU } from './shared';
export { nodesPerGroup } from './groupModes';

const MODE_ALIASES: Readonly<Record<string, ModeId>> = {
  whorled: 'absolute-steps',
};

const KNOWN: ReadonlySet<string> = new Set<ModeId>([
  'absolute',
  'proportional',
  'absolute-steps',
  'proportional-steps',
  'phyllotaxy',
  'interval',
  'bifurcation',
  'flood',
  'parent',
  'density',
  'classic',
]);

/** Maps a stored `mode` value (including values of older versions) to a current mode; unknown values become Absolute. */
export function normalizeMode(raw: string): ModeId {
  const alias = MODE_ALIASES[raw];
  if (alias) return alias;
  return KNOWN.has(raw) ? (raw as ModeId) : 'absolute';
}

/** Modes whose nodes may sit outside First..Last (Parent puts them at the origin of the parent). */
export function ignoresBoundaries(mode: ModeId): boolean {
  return mode === 'parent';
}

/**
 * Pure placement of the children of ONE parent branch. Deterministic: the result depends only on `frame` (incl. its
 * seeded stream) and `request`. Returns records with `t` inside First..Last (Parent: 0).
 */
export function generatePlacements(frame: ModeFrame, request: ModeRequest): PlacementRecord[] {
  if (frame.maxCount <= 0) return [];
  switch (request.mode) {
    case 'absolute':
      return absolute(frame, request);
    case 'proportional':
      return proportional(frame, request);
    case 'density':
      return density(frame, request);
    case 'flood':
      return flood(frame, request);
    case 'parent':
      return parentOrigin(frame, request);
    case 'absolute-steps':
    case 'proportional-steps':
      return steps(frame, request);
    case 'phyllotaxy':
      return phyllotaxy(frame, request);
    case 'interval':
      return interval(frame, request);
    case 'bifurcation':
      return bifurcation(frame, request);
  }
}
