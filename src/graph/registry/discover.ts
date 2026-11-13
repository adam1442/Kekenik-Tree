import type { NodeDef } from '@/contracts/nodes';
import { registerNodes } from './index';

interface NodeModule {
  nodeDefs?: NodeDef[];
}

/** Every `src/nodes/**\/index.ts` is a plugin: it exports `nodeDefs: NodeDef[]`. */
const modules = import.meta.glob<NodeModule>('/src/nodes/**/index.ts', { eager: true });

/** Register all discovered node definitions (idempotent). Returns how many were newly added. */
export function registerDiscoveredNodes(): number {
  let added = 0;
  for (const mod of Object.values(modules)) if (Array.isArray(mod.nodeDefs)) added += registerNodes(mod.nodeDefs);
  return added;
}
