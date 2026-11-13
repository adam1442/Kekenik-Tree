import type { NodeDef } from '@/contracts/nodes';
import { defaultParams, type NodeParams, type ParamState } from '@/contracts/params';
import { portsCompatible, type PortDef } from '@/contracts/ports';
import type { GraphAnnotationJSON, GraphEdgeJSON, GraphJSON, GraphNodeJSON } from '@/contracts/project';
import { EventBus } from '@/core/eventBus';
import { getNodeDef } from '../registry';
import { isHierarchyDef } from '../ports';
import type {
  AnnotationPatch,
  ConnectCheck,
  GraphAnnotation,
  GraphEdge,
  GraphEvents,
  GraphNode,
  NodeDefLookup,
  NodePatch,
  NodePatchKey,
  PortRef,
} from './types';

export interface NodeInit {
  type: string;
  id?: string;
  name?: string;
  x?: number;
  y?: number;
  params?: NodeParams;
}

const NODE_PATCH_KEYS: NodePatchKey[] = ['name', 'x', 'y', 'enabled', 'bypass', 'solo', 'collapsed', 'locked', 'note'];
const ANN_PATCH_KEYS: (keyof AnnotationPatch)[] = ['text', 'x', 'y', 'w', 'h', 'color'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Pure, serialisable, event-emitting graph model.
 *
 * Mutation primitives (`insert*`, `remove*`, `patchNode`, `setParam` ...) are intentionally unchecked and are meant
 * to be driven by Commands (see app/commands/graphCommands.ts) so that every change is undoable. Rules (type
 * compatibility, cycles, capacity) are queried with `canConnect()` BEFORE building a command.
 */
export class GraphModel {
  readonly events = new EventBus<GraphEvents>();
  private readonly nodeMap = new Map<string, GraphNode>();
  private readonly edgeMap = new Map<string, GraphEdge>();
  private readonly annMap = new Map<string, GraphAnnotation>();
  private readonly outEdges = new Map<string, Set<string>>();
  private readonly inEdges = new Map<string, Set<string>>();
  private idCounter = 0;

  constructor(private readonly lookup: NodeDefLookup = getNodeDef) {}

  // ---- identity -------------------------------------------------------------------------------------------------

  /** Next unused id with the given prefix (deterministic: counter based). */
  newId(prefix = 'n'): string {
    let id: string;
    do {
      this.idCounter += 1;
      id = `${prefix}${this.idCounter}`;
    } while (this.nodeMap.has(id) || this.edgeMap.has(id) || this.annMap.has(id));
    return id;
  }

  getDef(typeOrNode: string | GraphNode): NodeDef | undefined {
    return this.lookup(typeof typeOrNode === 'string' ? typeOrNode : typeOrNode.type);
  }

  getPort(ref: PortRef): PortDef | undefined {
    const node = this.nodeMap.get(ref.nodeId);
    return node ? this.getDef(node)?.ports.find((p) => p.id === ref.portId) : undefined;
  }

  // ---- queries --------------------------------------------------------------------------------------------------

  get nodeCount(): number {
    return this.nodeMap.size;
  }

  nodes(): GraphNode[] {
    return [...this.nodeMap.values()];
  }

  edges(): GraphEdge[] {
    return [...this.edgeMap.values()];
  }

  annotations(): GraphAnnotation[] {
    return [...this.annMap.values()];
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodeMap.get(id);
  }

  getEdge(id: string): GraphEdge | undefined {
    return this.edgeMap.get(id);
  }

  getAnnotation(id: string): GraphAnnotation | undefined {
    return this.annMap.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodeMap.has(id);
  }

  /** Does the node take part in the visible hierarchy (has hierarchy ports)? Unknown types count as hierarchy nodes. */
  isHierarchyNode(node: GraphNode): boolean {
    const def = this.getDef(node);
    return def ? isHierarchyDef(def) : true;
  }

  /** Nodes that are not part of the hierarchy: Force / Material / Mesh / Wind ... (listed in the footer). */
  attachmentNodes(): GraphNode[] {
    return this.nodes().filter((n) => !this.isHierarchyNode(n));
  }

  hierarchyNodes(): GraphNode[] {
    return this.nodes().filter((n) => this.isHierarchyNode(n));
  }

  /** Output nodes (e.g. Tree) are the graph root: they cannot be deleted or duplicated. */
  isProtected(node: GraphNode): boolean {
    return this.getDef(node)?.category === 'output';
  }

  edgesOf(nodeId: string): GraphEdge[] {
    return [...this.incoming(nodeId), ...this.outgoing(nodeId)];
  }

  incoming(nodeId: string, portId?: string): GraphEdge[] {
    return this.collect(this.inEdges.get(nodeId), (e) => portId === undefined || e.to.portId === portId);
  }

  outgoing(nodeId: string, portId?: string): GraphEdge[] {
    return this.collect(this.outEdges.get(nodeId), (e) => portId === undefined || e.from.portId === portId);
  }

  private collect(ids: Set<string> | undefined, pred: (e: GraphEdge) => boolean): GraphEdge[] {
    const out: GraphEdge[] = [];
    if (!ids) return out;
    for (const id of ids) {
      const e = this.edgeMap.get(id);
      if (e && pred(e)) out.push(e);
    }
    return out;
  }

  /** Hierarchy parent (source of the incoming hierarchy edge), if any. */
  parentOf(nodeId: string): GraphNode | undefined {
    const e = this.incoming(nodeId).find((x) => x.kind === 'hierarchy');
    return e ? this.nodeMap.get(e.from.nodeId) : undefined;
  }

  parentEdgeOf(nodeId: string): GraphEdge | undefined {
    return this.incoming(nodeId).find((x) => x.kind === 'hierarchy');
  }

  childrenOf(nodeId: string): GraphNode[] {
    const out: GraphNode[] = [];
    for (const e of this.outgoing(nodeId)) {
      const n = e.kind === 'hierarchy' ? this.nodeMap.get(e.to.nodeId) : undefined;
      if (n) out.push(n);
    }
    return out;
  }

  /** All hierarchy descendants (not including the node itself). */
  descendants(nodeId: string): GraphNode[] {
    const seen = new Set<string>([nodeId]);
    const out: GraphNode[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      for (const c of this.childrenOf(id)) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        out.push(c);
        stack.push(c.id);
      }
    }
    return out;
  }

  ancestors(nodeId: string): GraphNode[] {
    const out: GraphNode[] = [];
    const seen = new Set<string>([nodeId]);
    let p = this.parentOf(nodeId);
    while (p && !seen.has(p.id)) {
      out.push(p);
      seen.add(p.id);
      p = this.parentOf(p.id);
    }
    return out;
  }

  /** Hierarchy nodes without a hierarchy parent. */
  roots(): GraphNode[] {
    return this.hierarchyNodes().filter((n) => !this.parentOf(n.id));
  }

  /** Nodes attached (via attachment edges) to `targetId`, optionally restricted to a category. */
  attachedTo(targetId: string, category?: string): GraphNode[] {
    const out: GraphNode[] = [];
    for (const e of this.incoming(targetId)) {
      if (e.kind !== 'attachment') continue;
      const n = this.nodeMap.get(e.from.nodeId);
      if (n && (category === undefined || this.getDef(n)?.category === category)) out.push(n);
    }
    return out;
  }

  /** Targets an attachment node is attached to. */
  attachmentTargets(attachmentId: string): GraphNode[] {
    const out: GraphNode[] = [];
    for (const e of this.outgoing(attachmentId)) {
      const n = e.kind === 'attachment' ? this.nodeMap.get(e.to.nodeId) : undefined;
      if (n) out.push(n);
    }
    return out;
  }

  // ---- validation -----------------------------------------------------------------------------------------------

  /** Is `target` reachable from `start` following edges forward? */
  reachable(start: string, target: string): boolean {
    const seen = new Set<string>([start]);
    const stack = [start];
    while (stack.length > 0) {
      const id = stack.pop() as string;
      if (id === target) return true;
      for (const e of this.outgoing(id)) {
        if (!seen.has(e.to.nodeId)) {
          seen.add(e.to.nodeId);
          stack.push(e.to.nodeId);
        }
      }
    }
    return false;
  }

  /** Full rule check for a prospective edge `from (output) -> to (input)`. */
  canConnect(from: PortRef, to: PortRef): ConnectCheck {
    const fail = (reason: string): ConnectCheck => ({ ok: false, reason, replaced: [] });
    const fromNode = this.nodeMap.get(from.nodeId);
    const toNode = this.nodeMap.get(to.nodeId);
    if (!fromNode || !toNode) return fail('Node not found');
    if (fromNode.id === toNode.id) return fail('A node cannot be connected to itself');
    const fp = this.getPort(from);
    const tp = this.getPort(to);
    if (!fp || !tp) return fail('Unknown port');
    if (fp.direction !== 'out' || tp.direction !== 'in') return fail('Connect an output to an input');
    if (fp.edge !== tp.edge) return fail('Incompatible connection type');
    if (!portsCompatible(fp.kind, tp.kind)) return fail(`Cannot connect ${fp.kind} to ${tp.kind}`);
    if (fromNode.locked || toNode.locked) return fail('Node is locked');
    const dup = this.outgoing(from.nodeId, from.portId).some((e) => e.to.nodeId === to.nodeId && e.to.portId === to.portId);
    if (dup) return fail('Already connected');
    if (this.reachable(to.nodeId, from.nodeId)) return fail('Connection would create a cycle');
    const replaced = new Map<string, GraphEdge>();
    if (!tp.multiple) for (const e of this.incoming(to.nodeId, to.portId)) replaced.set(e.id, e);
    if (!fp.multiple) for (const e of this.outgoing(from.nodeId, from.portId)) replaced.set(e.id, e);
    return { ok: true, replaced: [...replaced.values()] };
  }

  /**
   * Find the first valid port pair joining nodes `a` and `b` (a is tried as the source first).
   * `edge` restricts the family ('hierarchy' | 'attachment'); `directed` = never try b as the source.
   */
  findPortPair(a: string, b: string, edge?: 'hierarchy' | 'attachment', directed = false): { from: PortRef; to: PortRef; check: ConnectCheck } | null {
    const orders: (readonly [string, string])[] = directed ? [[a, b]] : [[a, b], [b, a]];
    for (const [src, dst] of orders) {
      const sd = this.nodeMap.get(src);
      const dd = this.nodeMap.get(dst);
      const sdef = sd && this.getDef(sd);
      const ddef = dd && this.getDef(dd);
      if (!sdef || !ddef) continue;
      for (const op of sdef.ports.filter((p) => p.direction === 'out' && (!edge || p.edge === edge))) {
        for (const ip of ddef.ports.filter((p) => p.direction === 'in' && p.edge === op.edge)) {
          const from = { nodeId: src, portId: op.id };
          const to = { nodeId: dst, portId: ip.id };
          const check = this.canConnect(from, to);
          if (check.ok) return { from, to, check };
        }
      }
    }
    return null;
  }

  // ---- mutation primitives (unchecked; used by commands) ----------------------------------------------------------

  /** Build (but do not insert) a node with defaults taken from its NodeDef. */
  makeNode(init: NodeInit): GraphNode {
    const def = this.lookup(init.type);
    return {
      id: init.id ?? this.newId('n'),
      type: init.type,
      name: init.name ?? def?.label ?? init.type,
      x: init.x ?? 0,
      y: init.y ?? 0,
      enabled: true,
      bypass: false,
      solo: false,
      collapsed: false,
      locked: false,
      note: '',
      params: init.params ?? (def ? defaultParams(def.params) : {}),
    };
  }

  /** Convenience: make + insert (no undo; used by loaders, demo graphs and tests). */
  addNode(init: NodeInit): GraphNode {
    const node = this.makeNode(init);
    this.insertNode(node);
    return node;
  }

  insertNode(node: GraphNode): void {
    if (this.nodeMap.has(node.id)) throw new Error(`Duplicate node id: ${node.id}`);
    this.nodeMap.set(node.id, node);
    this.events.emit('nodeAdded', node);
    this.events.emit('changed', undefined);
  }

  /** Removes the node AND every edge touching it (edges are reported through edgeRemoved first). */
  removeNode(id: string): { node: GraphNode; edges: GraphEdge[] } | undefined {
    const node = this.nodeMap.get(id);
    if (!node) return undefined;
    const edges = this.edgesOf(id);
    for (const e of edges) this.deleteEdge(e.id);
    this.nodeMap.delete(id);
    this.events.emit('nodeRemoved', node);
    this.events.emit('changed', undefined);
    return { node, edges };
  }

  patchNode(id: string, patch: NodePatch): void {
    const node = this.nodeMap.get(id);
    if (!node) return;
    const keys: NodePatchKey[] = [];
    const target = node as unknown as Record<string, unknown>;
    for (const key of NODE_PATCH_KEYS) {
      const next = patch[key];
      if (next !== undefined && target[key] !== next) {
        target[key] = next;
        keys.push(key);
      }
    }
    if (keys.length === 0) return;
    this.events.emit('nodeChanged', { node, keys });
    this.events.emit('changed', undefined);
  }

  setParam(nodeId: string, paramId: string, state: ParamState): void {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    const prev = node.params[paramId];
    node.params[paramId] = state;
    this.events.emit('paramChanged', { nodeId, paramId, state, prev });
    this.events.emit('changed', undefined);
  }

  insertEdge(edge: GraphEdge): void {
    if (this.edgeMap.has(edge.id)) throw new Error(`Duplicate edge id: ${edge.id}`);
    if (!this.nodeMap.has(edge.from.nodeId) || !this.nodeMap.has(edge.to.nodeId)) throw new Error('Edge endpoint missing');
    this.edgeMap.set(edge.id, edge);
    this.link(this.outEdges, edge.from.nodeId, edge.id);
    this.link(this.inEdges, edge.to.nodeId, edge.id);
    this.events.emit('edgeAdded', edge);
    this.events.emit('changed', undefined);
  }

  deleteEdge(id: string): GraphEdge | undefined {
    const edge = this.edgeMap.get(id);
    if (!edge) return undefined;
    this.edgeMap.delete(id);
    this.outEdges.get(edge.from.nodeId)?.delete(id);
    this.inEdges.get(edge.to.nodeId)?.delete(id);
    this.events.emit('edgeRemoved', edge);
    this.events.emit('changed', undefined);
    return edge;
  }

  /** Create an edge object for a validated pair (does not insert it). */
  makeEdge(from: PortRef, to: PortRef, id?: string): GraphEdge {
    const kind = this.getPort(from)?.edge ?? 'hierarchy';
    return { id: id ?? this.newId('e'), kind, from: { ...from }, to: { ...to } };
  }

  insertAnnotation(a: GraphAnnotation): void {
    if (this.annMap.has(a.id)) throw new Error(`Duplicate annotation id: ${a.id}`);
    this.annMap.set(a.id, a);
    this.events.emit('annotationAdded', a);
    this.events.emit('changed', undefined);
  }

  removeAnnotation(id: string): GraphAnnotation | undefined {
    const a = this.annMap.get(id);
    if (!a) return undefined;
    this.annMap.delete(id);
    this.events.emit('annotationRemoved', a);
    this.events.emit('changed', undefined);
    return a;
  }

  patchAnnotation(id: string, patch: AnnotationPatch): void {
    const a = this.annMap.get(id);
    if (!a) return;
    const keys: (keyof AnnotationPatch)[] = [];
    const target = a as unknown as Record<string, unknown>;
    for (const key of ANN_PATCH_KEYS) {
      const next = patch[key];
      if (next !== undefined && target[key] !== next) {
        target[key] = next;
        keys.push(key);
      }
    }
    if (keys.length === 0) return;
    this.events.emit('annotationChanged', { annotation: a, keys });
    this.events.emit('changed', undefined);
  }

  private link(map: Map<string, Set<string>>, nodeId: string, edgeId: string): void {
    let set = map.get(nodeId);
    if (!set) {
      set = new Set();
      map.set(nodeId, set);
    }
    set.add(edgeId);
  }

  // ---- serialisation --------------------------------------------------------------------------------------------

  toJSON(): GraphJSON {
    return {
      nodes: this.nodes().map(
        (n): GraphNodeJSON => ({
          id: n.id,
          type: n.type,
          name: n.name,
          position: { x: n.x, y: n.y },
          enabled: n.enabled,
          params: structuredClone(n.params),
          ...(n.bypass ? { bypass: true } : {}),
          ...(n.solo ? { solo: true } : {}),
          ...(n.collapsed ? { collapsed: true } : {}),
          ...(n.locked ? { locked: true } : {}),
          ...(n.note ? { note: n.note } : {}),
        }),
      ),
      edges: this.edges().map((e): GraphEdgeJSON => ({ id: e.id, kind: e.kind, from: { ...e.from }, to: { ...e.to } })),
      annotations: this.annotations().map((a): GraphAnnotationJSON => ({ ...a })),
    };
  }

  /** Replace the content with `json`. Invalid entries (unknown refs, duplicates, bad shapes) are dropped, never thrown. */
  load(json: unknown): void {
    this.nodeMap.clear();
    this.edgeMap.clear();
    this.annMap.clear();
    this.outEdges.clear();
    this.inEdges.clear();
    this.idCounter = 0;
    const raw = isRecord(json) ? json : {};
    for (const n of Array.isArray(raw.nodes) ? raw.nodes : []) {
      if (!isRecord(n) || typeof n.id !== 'string' || typeof n.type !== 'string' || this.nodeMap.has(n.id)) continue;
      const pos = isRecord(n.position) ? n.position : {};
      const def = this.lookup(n.type);
      const params: NodeParams = def ? defaultParams(def.params) : {};
      if (isRecord(n.params)) {
        for (const [k, v] of Object.entries(n.params)) if (isRecord(v) && 'value' in v) params[k] = v as unknown as ParamState;
      }
      this.nodeMap.set(n.id, {
        id: n.id,
        type: n.type,
        name: typeof n.name === 'string' ? n.name : (def?.label ?? n.type),
        x: typeof pos.x === 'number' ? pos.x : 0,
        y: typeof pos.y === 'number' ? pos.y : 0,
        enabled: n.enabled !== false,
        bypass: n.bypass === true,
        solo: n.solo === true,
        collapsed: n.collapsed === true,
        locked: n.locked === true,
        note: typeof n.note === 'string' ? n.note : '',
        params,
      });
    }
    for (const e of Array.isArray(raw.edges) ? raw.edges : []) {
      if (!isRecord(e) || typeof e.id !== 'string' || this.edgeMap.has(e.id) || !isRecord(e.from) || !isRecord(e.to)) continue;
      const { from, to } = e;
      if (typeof from.nodeId !== 'string' || typeof from.portId !== 'string' || typeof to.nodeId !== 'string' || typeof to.portId !== 'string') continue;
      if (!this.nodeMap.has(from.nodeId) || !this.nodeMap.has(to.nodeId)) continue;
      const edge: GraphEdge = {
        id: e.id,
        kind: e.kind === 'attachment' ? 'attachment' : 'hierarchy',
        from: { nodeId: from.nodeId, portId: from.portId },
        to: { nodeId: to.nodeId, portId: to.portId },
      };
      this.edgeMap.set(edge.id, edge);
      this.link(this.outEdges, edge.from.nodeId, edge.id);
      this.link(this.inEdges, edge.to.nodeId, edge.id);
    }
    for (const a of Array.isArray(raw.annotations) ? raw.annotations : []) {
      if (!isRecord(a) || typeof a.id !== 'string' || this.annMap.has(a.id)) continue;
      const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
      this.annMap.set(a.id, {
        id: a.id,
        kind: a.kind === 'comment' ? 'comment' : 'group',
        text: typeof a.text === 'string' ? a.text : '',
        x: num(a.x, 0),
        y: num(a.y, 0),
        w: Math.max(40, num(a.w, 160)),
        h: Math.max(30, num(a.h, 100)),
        color: typeof a.color === 'string' ? a.color : 'blue',
      });
    }
    this.events.emit('reset', undefined);
    this.events.emit('changed', undefined);
  }

  static fromJSON(json: unknown, lookup: NodeDefLookup = getNodeDef): GraphModel {
    const model = new GraphModel(lookup);
    model.load(json);
    return model;
  }
}
