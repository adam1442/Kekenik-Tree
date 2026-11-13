import type { ParamValue } from '@/contracts/params';
import { GraphModel } from '@/graph/model/graphModel';
import { H_SPACING, tidyTreeLayout } from '@/graph/model/layout';

export interface NodeSpec {
  id: string;
  type: string;
  name?: string;
  parent: string | null;
  params?: Record<string, ParamValue | { value: ParamValue; variance?: number }>;
}

/** Build a graph from a flat spec list (parents before children). Registry must be populated by the caller. */
export function buildGraph(specs: NodeSpec[]): GraphModel {
  const model = new GraphModel();
  for (const s of specs) {
    const node = model.addNode({ id: s.id, type: s.type, ...(s.name ? { name: s.name } : {}) });
    for (const [pid, raw] of Object.entries(s.params ?? {})) {
      const cur = node.params[pid];
      if (!cur) throw new Error(`Unknown param ${s.type}.${pid}`);
      const isObj = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'value' in raw;
      node.params[pid] = isObj ? { ...cur, ...(raw as { value: ParamValue; variance?: number }) } : { ...cur, value: raw as ParamValue };
    }
  }
  for (const s of specs) {
    if (!s.parent) continue;
    const pair = model.findPortPair(s.parent, s.id, 'hierarchy');
    if (!pair) throw new Error(`Cannot connect ${s.parent} -> ${s.id}`);
    model.insertEdge(model.makeEdge(pair.from, pair.to, `e-${s.parent}-${s.id}`));
  }
  const links = specs.filter((s) => s.parent).map((s) => ({ parent: s.parent as string, child: s.id }));
  for (const [id, p] of tidyTreeLayout(specs.map((s) => ({ id: s.id, x: 0, y: 0 })), links, H_SPACING)) model.patchNode(id, { x: p.x, y: p.y });
  return model;
}

