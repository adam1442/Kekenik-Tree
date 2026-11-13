import type { GraphSnapshot } from './snapshot';

export interface TopoResult {
  /** Dependency order: every node appears after all nodes that feed it. */
  order: string[];
  /** Nodes that could not be ordered because they sit on (or behind) a cycle. */
  cyclic: string[];
}

/**
 * Kahn's algorithm over ALL edges (hierarchy parent -> child and attachment -> generator alike). Ties are broken by
 * snapshot order, so the result is stable for a given snapshot.
 */
export function topologicalOrder(snap: GraphSnapshot): TopoResult {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of snap.nodes) {
    indeg.set(n.id, 0);
    out.set(n.id, []);
  }
  for (const e of snap.edges) {
    indeg.set(e.toNode, (indeg.get(e.toNode) ?? 0) + 1);
    out.get(e.fromNode)?.push(e.toNode);
  }
  const rank = new Map(snap.nodes.map((n, i) => [n.id, i]));
  const ready = snap.nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const order: string[] = [];
  while (ready.length > 0) {
    let best = 0;
    for (let i = 1; i < ready.length; i++) if ((rank.get(ready[i] as string) as number) < (rank.get(ready[best] as string) as number)) best = i;
    const id = ready.splice(best, 1)[0] as string;
    order.push(id);
    for (const to of out.get(id) ?? []) {
      const d = (indeg.get(to) ?? 0) - 1;
      indeg.set(to, d);
      if (d === 0) ready.push(to);
    }
  }
  const done = new Set(order);
  return { order, cyclic: snap.nodes.filter((n) => !done.has(n.id)).map((n) => n.id) };
}

/** Nodes reachable from `start` following edges backwards (inputs, inputs of inputs ...), including `start`. */
export function upstreamOf(snap: GraphSnapshot, start: Iterable<string>): Set<string> {
  const incoming = new Map<string, string[]>();
  for (const e of snap.edges) {
    const list = incoming.get(e.toNode);
    if (list) list.push(e.fromNode);
    else incoming.set(e.toNode, [e.fromNode]);
  }
  const seen = new Set<string>(start);
  const stack = [...seen];
  while (stack.length > 0) {
    for (const p of incoming.get(stack.pop() as string) ?? []) {
      if (!seen.has(p)) {
        seen.add(p);
        stack.push(p);
      }
    }
  }
  return seen;
}
