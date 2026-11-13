import type { Command } from '@/contracts/app';
import type { ParamState } from '@/contracts/params';
import type { GraphModel } from '@/graph/model/graphModel';
import type { AnnotationPatch, ConnectCheck, GraphAnnotation, GraphEdge, GraphNode, NodePatch, PortRef } from '@/graph/model/types';

/** Every graph mutation is a Command so it is undoable. Commands capture all data they need at creation time. */

export interface KeyedCommand extends Command {
  /** Commands with the same key merge into one history entry (until UndoStack.seal()). */
  readonly mergeKey?: string | undefined;
}

function isKeyed(c: Command): c is KeyedCommand {
  return 'mergeKey' in c;
}

export function addNodesCommand(model: GraphModel, label: string, nodes: GraphNode[], edges: GraphEdge[]): Command {
  return {
    label,
    do(): void {
      for (const n of nodes) model.insertNode(n);
      for (const e of edges) model.insertEdge(e);
    },
    undo(): void {
      for (const e of edges) model.deleteEdge(e.id);
      for (let i = nodes.length - 1; i >= 0; i--) model.removeNode((nodes[i] as GraphNode).id);
    },
  };
}

/** Remove nodes (and their edges). `reconnect` edges are added after removal (used by "delete, keep children"). */
export function removeNodesCommand(model: GraphModel, label: string, ids: string[], reconnect: GraphEdge[] = []): Command {
  const nodes = ids.map((id) => model.getNode(id)).filter((n): n is GraphNode => n !== undefined);
  const set = new Set(nodes.map((n) => n.id));
  const edgeMap = new Map<string, GraphEdge>();
  for (const id of set) for (const e of model.edgesOf(id)) edgeMap.set(e.id, e);
  const edges = [...edgeMap.values()];
  return {
    label,
    do(): void {
      for (const e of edges) model.deleteEdge(e.id);
      for (const n of nodes) model.removeNode(n.id);
      for (const e of reconnect) model.insertEdge(e);
    },
    undo(): void {
      for (const e of reconnect) model.deleteEdge(e.id);
      for (const n of nodes) model.insertNode(n);
      for (const e of edges) model.insertEdge(e);
    },
  };
}

/** Connect `from -> to`; edges listed in `check.replaced` (single-connection ports) are removed first. */
export function connectCommand(model: GraphModel, from: PortRef, to: PortRef, check: ConnectCheck, label?: string): Command {
  const edge = model.makeEdge(from, to);
  const replaced = check.replaced;
  return {
    label: label ?? (replaced.length > 0 ? 'Reparent' : 'Connect'),
    do(): void {
      for (const e of replaced) model.deleteEdge(e.id);
      model.insertEdge(edge);
    },
    undo(): void {
      model.deleteEdge(edge.id);
      for (const e of replaced) model.insertEdge(e);
    },
  };
}

export function removeEdgesCommand(model: GraphModel, edgeIds: string[], label = 'Disconnect'): Command {
  const edges = edgeIds.map((id) => model.getEdge(id)).filter((e): e is GraphEdge => e !== undefined);
  return {
    label,
    do(): void {
      for (const e of edges) model.deleteEdge(e.id);
    },
    undo(): void {
      for (const e of edges) model.insertEdge(e);
    },
  };
}

/** Patch several nodes at once (move, rename, flags). Mergeable when `mergeKey` is given (one drag = one entry). */
export class PatchNodesCommand implements KeyedCommand {
  private next: Map<string, NodePatch>;
  private readonly prev = new Map<string, NodePatch>();

  constructor(
    private readonly model: GraphModel,
    readonly label: string,
    patches: Map<string, NodePatch>,
    readonly mergeKey?: string,
  ) {
    this.next = patches;
    for (const [id, patch] of patches) {
      const node = this.model.getNode(id);
      if (!node) continue;
      const before: Record<string, unknown> = {};
      for (const key of Object.keys(patch) as (keyof NodePatch)[]) before[key] = node[key];
      this.prev.set(id, before as NodePatch);
    }
  }

  do(): void {
    for (const [id, patch] of this.next) this.model.patchNode(id, patch);
  }

  undo(): void {
    for (const [id, patch] of this.prev) this.model.patchNode(id, patch);
  }

  merge(other: Command): boolean {
    if (!this.mergeKey || !isKeyed(other) || other.mergeKey !== this.mergeKey || !(other instanceof PatchNodesCommand)) return false;
    this.next = other.next;
    return true;
  }
}

/** Set one parameter. Mergeable with the same `mergeKey` (slider scrub = one history entry). */
export class SetParamCommand implements KeyedCommand {
  readonly label = 'Set Parameter';
  private current: ParamState;
  private readonly prev: ParamState;

  constructor(
    private readonly model: GraphModel,
    private readonly nodeId: string,
    private readonly paramId: string,
    next: ParamState,
    readonly mergeKey?: string,
  ) {
    const before = model.getNode(nodeId)?.params[paramId];
    this.prev = before ? structuredClone(before) : { value: null };
    this.current = next;
  }

  do(): void {
    this.model.setParam(this.nodeId, this.paramId, structuredClone(this.current));
  }

  undo(): void {
    this.model.setParam(this.nodeId, this.paramId, structuredClone(this.prev));
  }

  merge(other: Command): boolean {
    if (!this.mergeKey || !isKeyed(other) || other.mergeKey !== this.mergeKey || !(other instanceof SetParamCommand)) return false;
    if (other.nodeId !== this.nodeId || other.paramId !== this.paramId) return false;
    this.current = other.current;
    return true;
  }
}

export function addAnnotationCommand(model: GraphModel, annotation: GraphAnnotation): Command {
  return {
    label: annotation.kind === 'group' ? 'Add Group' : 'Add Comment',
    do: () => model.insertAnnotation(annotation),
    undo: () => void model.removeAnnotation(annotation.id),
  };
}

export function removeAnnotationCommand(model: GraphModel, id: string): Command | null {
  const a = model.getAnnotation(id);
  if (!a) return null;
  const copy = { ...a };
  return {
    label: a.kind === 'group' ? 'Delete Group' : 'Delete Comment',
    do: () => void model.removeAnnotation(id),
    undo: () => model.insertAnnotation({ ...copy }),
  };
}

export class PatchAnnotationCommand implements KeyedCommand {
  private next: AnnotationPatch;
  private readonly prev: AnnotationPatch;

  constructor(
    private readonly model: GraphModel,
    private readonly id: string,
    patch: AnnotationPatch,
    readonly label = 'Edit Annotation',
    readonly mergeKey?: string,
  ) {
    this.next = patch;
    const a = model.getAnnotation(id);
    const before: Record<string, unknown> = {};
    if (a) for (const key of Object.keys(patch) as (keyof AnnotationPatch)[]) before[key] = a[key];
    this.prev = before as AnnotationPatch;
  }

  do(): void {
    this.model.patchAnnotation(this.id, this.next);
  }

  undo(): void {
    this.model.patchAnnotation(this.id, this.prev);
  }

  merge(other: Command): boolean {
    if (!this.mergeKey || !isKeyed(other) || other.mergeKey !== this.mergeKey || !(other instanceof PatchAnnotationCommand)) return false;
    this.next = other.next;
    return true;
  }
}
