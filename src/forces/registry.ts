import { SEASON_LIGHT_FORCE, SEASON_WIND_FORCE } from '@/seasons';
import type { ForceTypeDef } from './types';

const types = new Map<string, ForceTypeDef>();

/** Register a force type (extension point: new force nodes only need `registerForceType` + a NodeDef). */
export function registerForceType(def: ForceTypeDef): void {
  types.set(def.type, def);
}

export function getForceType(type: string): ForceTypeDef | undefined {
  return types.get(type);
}

export function listForceTypes(): ForceTypeDef[] {
  return [...types.values()];
}

/**
 * Season forces do not bend geometry (the solver ignores them); generators read them for the season: a Season light
 * makes leaves that grow towards its arrow change sooner, a Season wind sweeps dropped leaves along its arrow.
 */
export interface SeasonForceTypeDef {
  type: string;
  role: 'light' | 'wind';
}

const seasonTypes = new Map<string, SeasonForceTypeDef>();

export function registerSeasonForceType(def: SeasonForceTypeDef): void {
  seasonTypes.set(def.type, def);
}

export function getSeasonForceType(type: string): SeasonForceTypeDef | undefined {
  return seasonTypes.get(type);
}

registerSeasonForceType({ type: SEASON_LIGHT_FORCE, role: 'light' });
registerSeasonForceType({ type: SEASON_WIND_FORCE, role: 'wind' });
