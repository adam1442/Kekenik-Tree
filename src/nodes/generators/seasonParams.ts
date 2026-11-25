import type { ParamDef } from '@/contracts/params';
import { section } from '../shared/builders';

const season = section('Material', 'Season');

/** Season properties every generator shares: when its transition starts and how fast it runs (Start offset, Time scale). */
export function seasonTimingParams(): ParamDef[] {
  return [
    season.float('seasonStartOffset', 'Start offset', 0, { min: -1, max: 1, softMin: -1, softMax: 1, variance: 0, curve: true }),
    season.float('seasonTimeScale', 'Time scale', 1, { min: 0, max: 10, softMax: 2, variance: 0, curve: true }),
  ];
}

/**
 * Season group of the structure generators (Trunk / Branch / Root): timing + Descendant offset (shifts the node and all
 * its children). Gravity (branches droop while they transition) is offered for Branch only.
 */
export function seasonStructureParams(gravity: boolean): ParamDef[] {
  return [
    ...seasonTimingParams(),
    season.float('seasonDescendantOffset', 'Descendant offset', 0, { min: -1, max: 1, softMin: -1, softMax: 1, variance: 0, curve: false }),
    ...(gravity ? [season.float('seasonGravity', 'Gravity', 0, { min: -1, max: 1, softMin: 0, softMax: 1, curve: true })] : []),
  ];
}
