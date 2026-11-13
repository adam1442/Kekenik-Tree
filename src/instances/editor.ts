import type { AppContext } from '@/app/context';
import {
  OVERRIDES_PARAM_ID,
  findOverride,
  overridesParamState,
  readOverrides,
  upsertOverride,
} from './overrides';
import type { InstanceOverride, InstanceRef, InstanceTable, OverrideMode, OverrideScalar, TransformField } from './types';

/**
 * Writes instance overrides through the Command system: every write is one `setParam` on the node's reserved
 * `__overrides` param, so undo / redo, dirty tracking, save / load and engine invalidation come for free. Continuous
 * edits (gizmo drags, slider scrubs) pass `merge = true` and collapse into one undo step until `commit()`.
 */
export class OverrideEditor {
  constructor(private readonly app: AppContext) {}

  list(nodeId: string): InstanceOverride[] {
    const node = this.app.graph.model.getNode(nodeId);
    return node ? readOverrides(node.params) : [];
  }

  get(ref: InstanceRef): InstanceOverride | undefined {
    return findOverride(this.list(ref.nodeId), ref.key);
  }

  table(nodeId: string): InstanceTable | null {
    return this.app.engine.latest?.scene.skeletons.find((s) => s.nodeId === nodeId)?.instances ?? null;
  }

  /** Apply `mutate` to the overrides of all `refs` (grouped per node: one command per node). */
  update(refs: readonly InstanceRef[], mutate: (o: InstanceOverride, ref: InstanceRef) => InstanceOverride, merge = false): void {
    const byNode = new Map<string, InstanceRef[]>();
    for (const r of refs) byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
    for (const [nodeId, list] of byNode) {
      const node = this.app.graph.model.getNode(nodeId);
      if (!node || node.locked) continue;
      const table = this.table(nodeId);
      let overrides = readOverrides(node.params);
      for (const ref of list) {
        const existing = findOverride(overrides, ref.key);
        const base: InstanceOverride = existing ? structuredClone(existing) : { key: ref.key, params: {} };
        if (!base.anchor && table) {
          for (let i = 0; i < table.count; i++) {
            if (table.key[i] === ref.key) {
              base.anchor = { parentKey: table.parentKey[i] as number, index: table.index[i] as number };
              break;
            }
          }
        }
        overrides = upsertOverride(overrides, mutate(base, ref));
      }
      this.app.graph.setParam(nodeId, OVERRIDES_PARAM_ID, overridesParamState(overrides), merge);
    }
  }

  setTransform(refs: readonly InstanceRef[], field: TransformField, value: (ref: InstanceRef) => number, merge: boolean): void {
    this.update(refs, (o, ref) => ({ ...o, transform: { ...o.transform, [field]: value(ref) } }), merge);
  }

  setParam(refs: readonly InstanceRef[], paramId: string, mode: OverrideMode, value: (ref: InstanceRef) => OverrideScalar, merge: boolean): void {
    this.update(refs, (o, ref) => ({ ...o, params: { ...o.params, [paramId]: { mode, value: value(ref) } } }), merge);
  }

  resetParam(refs: readonly InstanceRef[], paramId: string): void {
    this.update(refs, (o) => {
      const params = { ...o.params };
      delete params[paramId];
      return { ...o, params };
    });
    this.commit();
  }

  setFlag(refs: readonly InstanceRef[], flag: 'hidden' | 'pruned', on: boolean): void {
    this.update(refs, (o) => ({ ...o, [flag]: on }));
    this.commit();
  }

  /** Remove every override of the given instances (or of the whole node when `keys` is omitted). */
  clear(nodeId: string, keys?: readonly number[]): void {
    const all = this.list(nodeId);
    const next = keys ? all.filter((o) => !keys.includes(o.key)) : [];
    if (next.length === all.length) return;
    this.app.graph.setParam(nodeId, OVERRIDES_PARAM_ID, overridesParamState(next), false);
    this.commit();
  }

  /** Copy the overrides of `from` onto `targets` (parameters and transform; flags are not copied). */
  copyOverrides(from: InstanceRef, targets: readonly InstanceRef[]): void {
    const src = this.get(from);
    if (!src) return;
    this.update(targets.filter((t) => t.key !== from.key), (o) => {
      const next: InstanceOverride = { ...o, params: structuredClone(src.params) };
      if (src.transform) next.transform = { ...src.transform };
      else delete next.transform;
      return next;
    });
    this.commit();
  }

  /** End of a continuous gesture: the next change starts a new undo step. */
  commit(): void {
    this.app.graph.endGesture();
  }
}
