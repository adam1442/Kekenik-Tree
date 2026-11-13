import type { GraphEdgeJSON, GraphNodeJSON } from '@/contracts/project';
import { portsCompatible } from '@/contracts/ports';
import { hierarchyIn, hierarchyOut } from '../ports';
import type { GraphModel } from './graphModel';
import type { GraphEdge, GraphNode } from './types';

/** A detached copy of a sub-graph (nodes + the edges between them). JSON-safe. */
export interface ClipboardPayload {
  nodes: GraphNodeJSON[];
  edges: GraphEdgeJSON[];
}

/** Snapshot `ids` (protected/output nodes are skipped). Internal edges are kept, edges to the outside are dropped. */
export function copySubgraph(model: GraphModel, ids: Iterable<string>): ClipboardPayload {
  const set = new Set<string>();
  for (const id of ids) {
    const n = model.getNode(id);
    if (n && !model.isProtected(n)) set.add(id);
  }
  const json = model.toJSON();
  return {
    nodes: json.nodes.filter((n) => set.has(n.id)),
    edges: json.edges.filter((e) => set.has(e.from.nodeId) && set.has(e.to.nodeId)),
  };
}

export interface PastePlan {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** New ids of the top-level pasted nodes (those without an incoming hierarchy edge inside the payload). */
  rootIds: string[];
}

/**
 * Instantiate a payload with fresh ids. `parentId` (optional): top-level nodes are attached below it when the
 * hierarchy ports are compatible. Pure with respect to the model: nothing is inserted (the caller builds a command).
 */
export function planPaste(model: GraphModel, payload: ClipboardPayload, dx: number, dy: number, parentId?: string): PastePlan {
  const idMap = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const src of payload.nodes) {
    const id = model.newId('n');
    idMap.set(src.id, id);
    // Reserve the id by building the node through the model (keeps defaults consistent with the def).
    const node = model.makeNode({ type: src.type, id, name: src.name, x: src.position.x + dx, y: src.position.y + dy, params: structuredClone(src.params) });
    node.enabled = src.enabled;
    node.bypass = src.bypass === true;
    node.solo = src.solo === true;
    node.collapsed = src.collapsed === true;
    node.locked = false;
    node.note = src.note ?? '';
    nodes.push(node);
  }
  const edges: GraphEdge[] = [];
  const hasParentInside = new Set<string>();
  for (const e of payload.edges) {
    const from = idMap.get(e.from.nodeId);
    const to = idMap.get(e.to.nodeId);
    if (!from || !to) continue;
    edges.push({ id: model.newId('e'), kind: e.kind, from: { nodeId: from, portId: e.from.portId }, to: { nodeId: to, portId: e.to.portId } });
    if (e.kind === 'hierarchy') hasParentInside.add(to);
  }
  const rootIds = nodes.filter((n) => model.isHierarchyNode(n) && !hasParentInside.has(n.id)).map((n) => n.id);

  const parent = parentId ? model.getNode(parentId) : undefined;
  const parentDef = parent && model.getDef(parent);
  const parentOut = parentDef && hierarchyOut(parentDef);
  if (parent && parentOut) {
    for (const id of rootIds) {
      const node = nodes.find((n) => n.id === id);
      const def = node && model.getDef(node);
      const inPort = def && hierarchyIn(def);
      if (inPort && portsCompatible(parentOut.kind, inPort.kind)) {
        edges.push({ id: model.newId('e'), kind: 'hierarchy', from: { nodeId: parent.id, portId: parentOut.id }, to: { nodeId: id, portId: inPort.id } });
      }
    }
  }
  return { nodes, edges, rootIds };
}
