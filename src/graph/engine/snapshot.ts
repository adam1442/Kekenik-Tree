import type { EdgeKind } from '@/contracts/ports';
import type { NodeParams } from '@/contracts/params';
import { getNodeDef } from '@/graph/registry';
import { isHierarchyDef } from '@/graph/ports';
import type { GraphEdge, GraphNode } from '@/graph/model/types';
import { hashString, stableStringify } from './hash';

/** Immutable view of the graph taken at the start of a run: later edits cannot leak into a running evaluation. */
export interface SnapshotNode {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  bypass: boolean;
  solo: boolean;
  hierarchy: boolean;
  params: NodeParams;
  paramsHash: string;
}

export interface SnapshotEdge {
  id: string;
  kind: EdgeKind;
  fromNode: string;
  fromPort: string;
  toNode: string;
  toPort: string;
}

export interface GraphSnapshot {
  nodes: SnapshotNode[];
  edges: SnapshotEdge[];
}

export interface GraphSource {
  nodes(): GraphNode[];
  edges(): GraphEdge[];
}

/** Keeps the deep-cloned params of unchanged nodes between snapshots (cloning is the expensive part). */
export class ParamSnapshotCache {
  private readonly entries = new Map<string, { hash: string; params: NodeParams }>();

  resolve(id: string, live: NodeParams): { hash: string; params: NodeParams } {
    const json = stableStringify(live);
    const hash = hashString(json);
    const hit = this.entries.get(id);
    if (hit && hit.hash === hash) return hit;
    const entry = { hash, params: structuredClone(live) };
    this.entries.set(id, entry);
    return entry;
  }

  retain(ids: Set<string>): void {
    for (const id of [...this.entries.keys()]) if (!ids.has(id)) this.entries.delete(id);
  }
}

export function snapshotGraph(source: GraphSource, paramCache: ParamSnapshotCache = new ParamSnapshotCache()): GraphSnapshot {
  const nodes: SnapshotNode[] = source.nodes().map((n) => {
    const def = getNodeDef(n.type);
    const p = paramCache.resolve(n.id, n.params);
    return { id: n.id, type: n.type, name: n.name, enabled: n.enabled, bypass: n.bypass, solo: n.solo, hierarchy: def ? isHierarchyDef(def) : false, params: p.params, paramsHash: p.hash };
  });
  paramCache.retain(new Set(nodes.map((n) => n.id)));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: SnapshotEdge[] = source
    .edges()
    .filter((e) => ids.has(e.from.nodeId) && ids.has(e.to.nodeId))
    .map((e) => ({ id: e.id, kind: e.kind, fromNode: e.from.nodeId, fromPort: e.from.portId, toNode: e.to.nodeId, toPort: e.to.portId }));
  return { nodes, edges };
}
