import type { AppContext } from '@/app/context';
import type { ParamDef, ParamState } from '@/contracts/params';
import type { GraphNode } from '@/graph/model/types';
import { OverrideEditor } from '@/instances/editor';
import { applyParamOverrides, resolveOverrides } from '@/instances/overrides';
import type { InstanceOverride, InstanceRef, OverrideScalar } from '@/instances/types';

/**
 * Node-mode view of the Properties inspector: with instances selected, the shown values are the node's params with the
 * instance's overrides applied, edits become `set` overrides of those instances (never touch the procedural params),
 * overridden rows are flagged and can be reset one by one.
 */
export interface NodeModeView {
  nodeId: string;
  refs: InstanceRef[];
  /** The node with the primary instance's overrides applied (what the rows display). */
  effective(node: GraphNode): GraphNode;
  overridden(paramId: string): boolean;
  apply(def: ParamDef, patch: Partial<ParamState>, merge: boolean): void;
  reset(paramId: string): void;
  clearAll(): void;
  overrideCount(): number;
  orphanCount(): number;
  prunedKeys(): number[];
}

export function getNodeModeView(app: AppContext, editor: OverrideEditor): NodeModeView | null {
  const s = app.store.get();
  if (s.editMode !== 'node' || s.instanceSelection.length === 0) return null;
  const sel = app.graph.getSelection();
  if (sel.length !== 1) return null;
  const nodeId = sel[0] as string;
  const refs = s.instanceSelection.filter((r) => r.nodeId === nodeId);
  if (refs.length === 0) return null;
  const primary = refs[refs.length - 1] as InstanceRef;
  const override = (): InstanceOverride | undefined => editor.get(primary);
  return {
    nodeId,
    refs,
    effective(node) {
      const o = override();
      return o && Object.keys(o.params).length > 0 ? { ...node, params: applyParamOverrides(node.params, o.params) } : node;
    },
    overridden: (id) => override()?.params[id] !== undefined,
    apply(def, patch, merge) {
      const v = patch.value;
      if (v === undefined || (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string')) {
        app.notify('Only plain values (numbers, switches, lists of options) can be overridden per instance.');
        return;
      }
      editor.setParam(refs, def.id, 'set', () => v as OverrideScalar, merge);
    },
    reset: (id) => editor.resetParam(refs, id),
    clearAll: () => editor.clear(nodeId, refs.map((r) => r.key)),
    overrideCount: () => editor.list(nodeId).length,
    orphanCount: () => resolveOverrides(editor.table(nodeId), editor.list(nodeId)).orphans.length,
    prunedKeys: () => Array.from(editor.table(nodeId)?.pruned ?? []),
  };
}
