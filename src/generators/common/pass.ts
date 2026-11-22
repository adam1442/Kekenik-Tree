import { getNumber, type NodeParams } from '@/contracts/params';

/** Pass number of a generator: an integer of at least 1. */
export function readPass(params: NodeParams): number {
  return Math.max(1, Math.round(getNumber(params, 'pass', 1)));
}

export interface PassNode {
  id: string;
  pass: number;
  /** Hierarchy parent (null for the root). */
  parentId: string | null;
}

/**
 * Pass validation: a node's pass may not be lower than the pass of any of its ancestors. Returns an error text for
 * every node that breaks the rule (the engine shows it as an error badge on the node).
 */
export function validatePasses(nodes: readonly PassNode[]): Map<string, string> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const errors = new Map<string, string>();
  for (const n of nodes) {
    let worst = 0;
    const seen = new Set<string>([n.id]);
    for (let p = n.parentId ? byId.get(n.parentId) : undefined; p && !seen.has(p.id); p = p.parentId ? byId.get(p.parentId) : undefined) {
      seen.add(p.id);
      worst = Math.max(worst, p.pass);
    }
    if (n.pass < worst) errors.set(n.id, `Pass ${n.pass} is lower than the pass of an ancestor (${worst}). A node cannot compute before its ancestors.`);
  }
  return errors;
}
