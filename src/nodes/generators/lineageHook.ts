import type { NodeDef, NodeOutputs } from '@/contracts/nodes';
import type { StructureData } from '@/contracts/ports';
import { emptySkeleton } from '@/contracts/skeleton';
import { buildLineage } from '@/geometry/lineage';

/** Output port that carries the generated skeleton. */
const CHILDREN = 'children';

function attachLineage(inputs: Parameters<NodeDef['evaluate']>[1], out: NodeOutputs): NodeOutputs {
  const own = out[CHILDREN];
  if (!own || own.kind !== 'Structure' || own.value.skeleton.branches.length === 0) return out;
  const pv = inputs.parent?.[0];
  const parent: StructureData | null = pv && pv.kind === 'Structure' ? pv.value : null;
  const lineage = buildLineage(own.value.skeleton, parent ? parent.skeleton : emptySkeleton(), parent?.lineage);
  return { ...out, [CHILDREN]: { kind: 'Structure', value: { ...own.value, lineage } } };
}

/**
 * Adds the ancestor chains (`StructureData.lineage`) to the skeleton a generator produces, so descendants (Leaf anchors
 * Global / Deep / Intermediate / Local) can look up where their ancestors start.
 */
export const withLineage =
  (fn: NodeDef['evaluate']): NodeDef['evaluate'] =>
  (ctx, inputs, params) => {
    const r = fn(ctx, inputs, params);
    return r instanceof Promise ? r.then((o) => attachLineage(inputs, o)) : attachLineage(inputs, r);
  };
