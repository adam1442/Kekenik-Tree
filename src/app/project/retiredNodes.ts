import type { GraphEdgeJSON, GraphJSON } from '@/contracts/project';

/** Node types that no longer exist; projects that still contain them are loaded without them. */
export const RETIRED_NODE_TYPES: ReadonlySet<string> = new Set(['generator.decoration']);

/**
 * Removes the nodes of retired types from a saved graph. Every edge that left a removed node is re-attached to whatever fed
 * it (so children of a retired generator stay connected to its parent); edges that cannot be re-attached are dropped.
 */
export function removeRetiredNodes(graph: GraphJSON): GraphJSON {
  const gone = new Set(graph.nodes.filter((n) => RETIRED_NODE_TYPES.has(n.type)).map((n) => n.id));
  if (gone.size === 0) return graph;
  const feederOf = (nodeId: string, kind: GraphEdgeJSON['kind']): GraphEdgeJSON | undefined => graph.edges.find((f) => f.to.nodeId === nodeId && f.kind === kind);
  const edges: GraphEdgeJSON[] = [];
  for (const e of graph.edges) {
    if (gone.has(e.to.nodeId)) continue;
    if (!gone.has(e.from.nodeId)) {
      edges.push(e);
      continue;
    }
    // Walk up through removed nodes to the first surviving feeder (bounded: a cycle cannot loop forever).
    let from = e.from;
    for (let hops = 0; hops <= gone.size && gone.has(from.nodeId); hops++) {
      const feeder = feederOf(from.nodeId, e.kind);
      if (!feeder) break;
      from = feeder.from;
    }
    if (!gone.has(from.nodeId)) edges.push({ ...e, id: `${e.id}~up`, from });
  }
  return { ...graph, nodes: graph.nodes.filter((n) => !gone.has(n.id)), edges };
}
