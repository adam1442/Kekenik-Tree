import { withParamHelp } from './paramHelp';
import type { NodeCategory, NodeDef } from '@/contracts/nodes';
import type { NodeParams } from '@/contracts/params';

/**
 * Node registry. New node types are ADDED through registerNode() / by exporting `nodeDefs` from a
 * `src/nodes/<family>/index.ts` module (auto-discovered, see ./discover.ts) - never by editing a switch statement.
 */
const nodes = new Map<string, NodeDef>();

export function registerNode(def: NodeDef): void {
  if (nodes.has(def.type)) throw new Error(`Node type already registered: ${def.type}`);
  const portIds = new Set<string>();
  for (const port of def.ports) {
    if (portIds.has(port.id)) throw new Error(`Duplicate port "${port.id}" on node ${def.type}`);
    portIds.add(port.id);
  }
  const paramIds = new Set<string>();
  for (const p of def.params) {
    if (paramIds.has(p.id)) throw new Error(`Duplicate param "${p.id}" on node ${def.type}`);
    paramIds.add(p.id);
  }
  if (def.version !== undefined && (!Number.isInteger(def.version) || def.version < 1)) throw new Error(`Invalid version on node ${def.type}`);
  nodes.set(def.type, withParamHelp(def));
}

/** Idempotent bulk registration (HMR / repeated bootstraps): types that are already registered are skipped. */
export function registerNodes(defs: readonly NodeDef[]): number {
  let added = 0;
  for (const def of defs) {
    if (nodes.has(def.type)) continue;
    registerNode(def);
    added += 1;
  }
  return added;
}

export function getNodeDef(type: string): NodeDef | undefined {
  return nodes.get(type);
}

export function listNodeDefs(category?: NodeCategory): NodeDef[] {
  const all = [...nodes.values()];
  return category ? all.filter((n) => n.category === category) : all;
}

/** Test helper. */
export function unregisterNode(type: string): void {
  nodes.delete(type);
}

// ---- versioning & migration ------------------------------------------------------------------------------------

export function nodeVersion(type: string): number {
  return nodes.get(type)?.version ?? 1;
}

/**
 * Bring params stored with `fromVersion` of node `type` to the registered version. Unknown types and equal/newer
 * versions are returned untouched (a newer file must not be damaged by an older app).
 */
export function migrateNodeParams(type: string, params: NodeParams, fromVersion: number): NodeParams {
  const def = nodes.get(type);
  if (!def) return params;
  const target = def.version ?? 1;
  if (fromVersion >= target || !def.migrate) return params;
  return def.migrate(params, fromVersion);
}

export { registerDiscoveredNodes } from './discover';
