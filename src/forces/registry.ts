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
