import type { AppState, Command } from '@/contracts/app';
import type { NodeDiagnostic } from '@/contracts/engine';
import type { NodeCategory } from '@/contracts/nodes';
import type { ParamState } from '@/contracts/params';
import { EventBus } from '@/core/eventBus';
import type { Store } from '@/core/store';
import { copySubgraph, planPaste, type ClipboardPayload } from '@/graph/model/clipboard';
import { GraphModel } from '@/graph/model/graphModel';
import {
  H_SPACING,
  V_SPACING,
  alignPositions,
  bounds,
  distributePositions,
  findFreeSlot,
  tidyTreeLayout,
  type AlignMode,
  type Point,
} from '@/graph/model/layout';
import type { AnnotationPatch, GraphAnnotation, GraphEdge, GraphNode, NodeDefLookup, NodePatch, PortRef } from '@/graph/model/types';
import { ATTACHMENT_CATEGORIES, isHierarchyDef, matchPorts } from '@/graph/ports';
import { getNodeDef } from '@/graph/registry';
import { loadJSON, saveJSON } from './settings';
import { batch } from './commands/batch';
import {
  PatchAnnotationCommand,
  PatchNodesCommand,
  SetParamCommand,
  addAnnotationCommand,
  addNodesCommand,
  connectCommand,
  removeAnnotationCommand,
  removeEdgesCommand,
  removeNodesCommand,
} from './commands/graphCommands';
import type { UndoStack } from './commands/undoStack';
import type { AppEvents } from './context';

export interface GraphSettings {
  snapToGrid: boolean;
  showGrid: boolean;
  showLabels: boolean;
  showEdgeLabels: boolean;
  gridSize: number;
}

const DEFAULT_SETTINGS: GraphSettings = { snapToGrid: false, showGrid: false, showLabels: true, showEdgeLabels: true, gridSize: 13 };
const SETTINGS_KEY = 'graph.settings';

export interface SessionEvents {
  /** The active document (and therefore the active GraphModel) changed. */
  modelSwapped: GraphModel;
  selectionChanged: string[];
  /** Ask the graph view to fit all nodes / frame the selection. */
  viewRequest: 'fit' | 'frame';
  /** Edge labels or root info changed. */
  decorationsChanged: undefined;
  settingsChanged: GraphSettings;
}

export interface AddNodeOptions {
  x?: number;
  y?: number;
  name?: string;
  /** Use x/y exactly (drop point, context-menu position) instead of searching for a free slot nearby. */
  exact?: boolean;
  /**
   * Connect the new node to this node. `side` = which side of the ANCHOR port is used:
   * 'out' (anchor feeds the new node), 'in' (new node feeds the anchor); omitted = hierarchy children / attachments.
   */
  anchor?: { nodeId: string; portId?: string; side?: 'out' | 'in' };
  select?: boolean;
}

export interface SessionDeps {
  store: Store<AppState>;
  undo: UndoStack;
  appEvents: EventBus<AppEvents>;
  notify(message: string): void;
  lookup?: NodeDefLookup;
  /** Fill a freshly created (empty) document model, e.g. test fixtures. The app loads project files instead. */
  initialGraph?: (model: GraphModel, docId: string) => void;
}

/** Implemented by the graph panel so commands can reach view-specific behaviour (cursor position, inline editing). */
export interface GraphViewHandle {
  openAddNode(): void;
  startRename(nodeId: string): void;
}

export type NodeFlagKey = 'enabled' | 'bypass' | 'solo' | 'collapsed' | 'locked';

/**
 * Application-level facade over the graph: one GraphModel per document, selection, clipboard and every
 * undoable editing operation. UI (graph panel, menus, shortcuts) and other modules (inspector, engine) go through
 * here; the inspector uses `setParam()`.
 */
export class GraphSession {
  readonly events = new EventBus<SessionEvents>();
  settings: GraphSettings;
  /** Set by the graph panel while it is open. */
  view: GraphViewHandle | null = null;
  /** Per-edge instance counts etc. supplied by the engine (edge id -> label). */
  private edgeLabelMap = new Map<string, string>();
  private rootInfoText: string | null = null;
  private diagMap = new Map<string, NodeDiagnostic>();
  private clipboard: ClipboardPayload | null = null;
  private readonly models = new Map<string, GraphModel>();
  private readonly selections = new Map<string, string[]>();
  private readonly unsubs: (() => void)[] = [];
  private docId: string;
  private current: GraphModel;

  constructor(private readonly deps: SessionDeps) {
    this.settings = this.loadSettings();
    this.docId = deps.store.get().activeDocumentId;
    this.current = this.ensureModel(this.docId);
    deps.undo.setContext(this.docId);
    this.setSelection(deps.store.get().selection.filter((id) => this.current.hasNode(id)));
    this.unsubs.push(deps.store.select((s) => s.activeDocumentId, (id) => this.switchDocument(id)));
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.events.clear();
  }

  get model(): GraphModel {
    return this.current;
  }

  /** Model of any open document (null when unknown). Used for autosave of background documents. */
  modelOf(docId: string): GraphModel | null {
    return this.models.get(docId) ?? null;
  }

  get documentId(): string {
    return this.docId;
  }

  // ---- documents -----------------------------------------------------------------------------------------------

  private ensureModel(docId: string): GraphModel {
    const existing = this.models.get(docId);
    if (existing) return existing;
    const model = new GraphModel(this.deps.lookup ?? getNodeDef);
    this.deps.initialGraph?.(model, docId);
    this.models.set(docId, model);
    this.unsubs.push(
      model.events.on('changed', () => this.deps.appEvents.emit('graph:changed', { docId })),
      model.events.on('nodeRemoved', (n) => {
        if (model === this.current) this.setSelection(this.getSelection().filter((id) => id !== n.id));
      }),
      model.events.on('nodeChanged', ({ node, keys }) => {
        if (model === this.current && keys.includes('name') && this.getSelection().includes(node.id)) this.syncStore();
      }),
    );
    return model;
  }

  private switchDocument(docId: string): void {
    this.selections.set(this.docId, this.getSelection());
    this.docId = docId;
    this.current = this.ensureModel(docId);
    this.deps.undo.setContext(docId);
    this.edgeLabelMap = new Map();
    this.rootInfoText = null;
    this.diagMap = new Map();
    this.setSelection((this.selections.get(docId) ?? []).filter((id) => this.current.hasNode(id)));
    this.events.emit('modelSwapped', this.current);
  }

  /** Replace the active document's graph. Clears its undo history. */
  loadGraph(json: unknown): void {
    this.current.load(json);
    this.deps.undo.clear();
    this.setSelection([]);
    this.events.emit('modelSwapped', this.current);
  }

  /** Forget a closed document (model, selection; its undo history is dropped). The active document cannot be dropped. */
  dropDocument(docId: string): void {
    if (docId === this.docId) return;
    this.models.delete(docId);
    this.selections.delete(docId);
    this.deps.undo.dropContext(docId);
  }

  // ---- settings & decorations ------------------------------------------------------------------------------------

  private loadSettings(): GraphSettings {
    const raw = loadJSON(SETTINGS_KEY);
    const out = { ...DEFAULT_SETTINGS };
    if (typeof raw === 'object' && raw !== null) {
      const r = raw as Record<string, unknown>;
      for (const k of ['snapToGrid', 'showGrid', 'showLabels', 'showEdgeLabels'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean;
      if (typeof r.gridSize === 'number' && r.gridSize >= 4 && r.gridSize <= 100) out.gridSize = r.gridSize;
    }
    return out;
  }

  updateSettings(patch: Partial<GraphSettings>): void {
    this.settings = { ...this.settings, ...patch };
    saveJSON(SETTINGS_KEY, this.settings);
    this.events.emit('settingsChanged', this.settings);
  }

  get edgeLabels(): ReadonlyMap<string, string> {
    return this.edgeLabelMap;
  }

  /** Engine hook: label per edge id (e.g. instance counts "2,188"). */
  setEdgeLabels(labels: Map<string, string>): void {
    this.edgeLabelMap = labels;
    this.events.emit('decorationsChanged', undefined);
  }

  get diagnostics(): ReadonlyMap<string, NodeDiagnostic> {
    return this.diagMap;
  }

  /** Engine hook: per-node evaluation state (error / warning badges, timing tooltips). */
  setDiagnostics(map: Map<string, NodeDiagnostic>): void {
    this.diagMap = map;
    this.events.emit('decorationsChanged', undefined);
  }

  get rootInfo(): string {
    return this.rootInfoText ?? `Nodes ${this.current.hierarchyNodes().length}`;
  }

  /** Engine hook: text shown next to the root node (e.g. "Nodes 47,075"). null = graph node count. */
  setRootInfo(text: string | null): void {
    this.rootInfoText = text;
    this.events.emit('decorationsChanged', undefined);
  }

  // ---- selection -------------------------------------------------------------------------------------------------

  getSelection(): string[] {
    return this.deps.store.get().selection;
  }

  setSelection(ids: string[]): void {
    const unique = [...new Set(ids)].filter((id) => this.current.hasNode(id));
    const prev = this.getSelection();
    const same = prev.length === unique.length && prev.every((id, i) => id === unique[i]);
    this.syncStore(unique);
    if (!same) this.events.emit('selectionChanged', unique);
  }

  private syncStore(ids: string[] = this.getSelection()): void {
    const names = ids.map((id) => this.current.getNode(id)?.name ?? '');
    const label = ids.length === 0 ? '' : ids.length === 1 ? (names[0] ?? '') : `${ids.length} nodes`;
    this.deps.store.set({ selection: ids, selectionLabel: label });
  }

  select(ids: string[], mode: 'set' | 'add' | 'toggle' = 'set'): void {
    const cur = this.getSelection();
    if (mode === 'set') this.setSelection(ids);
    else if (mode === 'add') this.setSelection([...cur, ...ids]);
    else {
      const set = new Set(cur);
      for (const id of ids) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      this.setSelection([...set]);
    }
  }

  clearSelection(): void {
    this.setSelection([]);
  }

  selectAll(): void {
    this.setSelection(this.current.hierarchyNodes().map((n) => n.id));
  }

  selectChildren(): void {
    const ids = this.getSelection().flatMap((id) => this.current.childrenOf(id).map((n) => n.id));
    if (ids.length > 0) this.setSelection(ids);
  }

  selectSubtree(): void {
    const sel = this.getSelection();
    this.setSelection([...sel, ...sel.flatMap((id) => this.current.descendants(id).map((n) => n.id))]);
  }

  selectParent(): void {
    const ids = this.getSelection()
      .map((id) => this.current.parentOf(id)?.id)
      .filter((id): id is string => id !== undefined);
    if (ids.length > 0) this.setSelection(ids);
  }

  requestView(kind: 'fit' | 'frame'): void {
    this.events.emit('viewRequest', kind);
  }

  // ---- undo plumbing ---------------------------------------------------------------------------------------------

  exec(cmd: Command): void {
    this.deps.undo.execute(cmd);
  }

  /** End of a continuous gesture (drag, scrub): the next change starts a new history entry. */
  endGesture(): void {
    this.deps.undo.seal();
  }

  private notify(msg: string): void {
    this.deps.notify(msg);
  }

  // ---- parameters (used by the Properties inspector) -------------------------------------------------------------

  /** Set (part of) a parameter state. `merge` collapses consecutive calls on the same param into one undo step. */
  setParam(nodeId: string, paramId: string, patch: Partial<ParamState>, merge = false): void {
    const node = this.current.getNode(nodeId);
    if (!node) return;
    const prev = node.params[paramId] ?? { value: null };
    const next: ParamState = { ...structuredClone(prev), ...structuredClone(patch) };
    this.exec(new SetParamCommand(this.current, nodeId, paramId, next, merge ? `param:${nodeId}:${paramId}` : undefined));
  }

  // ---- node creation / deletion ----------------------------------------------------------------------------------

  /** Can another node of this type be added? (e.g. only one output/Tree node). */
  canAdd(type: string): boolean {
    const def = getNodeDef(type);
    if (!def) return false;
    return !(def.category === 'output' && this.current.nodes().some((n) => n.type === type));
  }

  addNode(type: string, opts: AddNodeOptions = {}): GraphNode | null {
    const model = this.current;
    const def = getNodeDef(type);
    if (!def) return null;
    if (!this.canAdd(type)) {
      this.notify(`Only one ${def.label} node is allowed.`);
      return null;
    }
    const node = model.makeNode({ type, name: opts.name });
    const hier = isHierarchyDef(def);
    let edge: GraphEdge | null = null;
    let replaced: GraphEdge[] = [];
    let anchorNode: GraphNode | undefined;
    let newIsSource = false;

    const anchor = opts.anchor;
    anchorNode = anchor ? model.getNode(anchor.nodeId) : undefined;
    const adef = anchorNode && model.getDef(anchorNode);
    if (anchor && anchorNode && adef && !anchorNode.locked) {
      let ports: ReturnType<typeof matchPorts>;
      if (anchor.side === 'out') ports = matchPorts(adef, def, undefined, anchor.portId);
      else if (anchor.side === 'in') {
        ports = matchPorts(def, adef, undefined, undefined, anchor.portId);
        newIsSource = true;
      } else if (hier) ports = matchPorts(adef, def, 'hierarchy');
      else {
        ports = matchPorts(def, adef, 'attachment');
        newIsSource = true;
      }
      if (ports) {
        const anchorPort = newIsSource ? ports.in : ports.out;
        if (!anchorPort.multiple) replaced = newIsSource ? model.incoming(anchor.nodeId, ports.in.id) : model.outgoing(anchor.nodeId, ports.out.id);
        edge = {
          id: model.newId('e'),
          kind: ports.out.edge,
          from: newIsSource ? { nodeId: node.id, portId: ports.out.id } : { nodeId: anchor.nodeId, portId: ports.out.id },
          to: newIsSource ? { nodeId: anchor.nodeId, portId: ports.in.id } : { nodeId: node.id, portId: ports.in.id },
        };
      } else if (opts.x === undefined) {
        anchorNode = undefined;
      }
    }

    if (hier) {
      let x = opts.x ?? anchorNode?.x ?? 0;
      let y = opts.y ?? (anchorNode ? anchorNode.y + (newIsSource ? V_SPACING : -V_SPACING) : 0);
      if (!opts.exact) {
        const free = findFreeSlot(model.hierarchyNodes().map((n) => ({ x: n.x, y: n.y })), x, y);
        x = free.x;
        y = free.y;
      }
      node.x = this.snap(x, opts.exact === true);
      node.y = this.snap(y, opts.exact === true);
    }

    const link = edge;
    const cmd: Command = {
      label: `Add ${def.label}`,
      do(): void {
        for (const e of replaced) model.deleteEdge(e.id);
        model.insertNode(node);
        if (link) model.insertEdge(link);
      },
      undo(): void {
        if (link) model.deleteEdge(link.id);
        model.removeNode(node.id);
        for (const e of replaced) model.insertEdge(e);
      },
    };
    this.exec(cmd);
    if (opts.select !== false) this.setSelection([node.id]);
    return node;
  }

  private snap(v: number, explicit: boolean): number {
    const s = this.settings;
    return explicit && s.snapToGrid ? Math.round(v / s.gridSize) * s.gridSize : v;
  }

  /** Ids to act on for copy/cut/duplicate/delete: the selection plus all hierarchy descendants. */
  expandWithDescendants(ids: string[]): string[] {
    const set = new Set(ids);
    for (const id of ids) for (const d of this.current.descendants(id)) set.add(d.id);
    return [...set];
  }

  /**
   * Delete the selection (with its sub-trees). With `keepChildren`, children of deleted nodes are re-attached to the
   * nearest surviving ancestor instead ("dissolve").
   */
  deleteSelection(keepChildren = false): void {
    const model = this.current;
    const targets = this.getSelection()
      .map((id) => model.getNode(id))
      .filter((n): n is GraphNode => n !== undefined && !model.isProtected(n) && !n.locked);
    if (targets.length === 0) {
      if (this.getSelection().length > 0) this.notify('The selected nodes are protected or locked.');
      return;
    }
    const removed = new Set<string>(keepChildren ? targets.map((n) => n.id) : this.expandWithDescendants(targets.map((n) => n.id)));
    const reconnect: GraphEdge[] = [];
    if (keepChildren) {
      for (const n of targets) {
        let up = model.parentEdgeOf(n.id);
        let guard = 0;
        while (up && removed.has(up.from.nodeId) && guard++ < 1000) up = model.parentEdgeOf(up.from.nodeId);
        if (!up) continue;
        for (const child of model.outgoing(n.id).filter((e) => e.kind === 'hierarchy' && !removed.has(e.to.nodeId))) {
          reconnect.push({ id: model.newId('e'), kind: 'hierarchy', from: { ...up.from }, to: { ...child.to } });
        }
      }
    }
    const label = removed.size > 1 ? `Delete ${removed.size} Nodes` : `Delete ${targets[0]?.name ?? 'Node'}`;
    this.exec(removeNodesCommand(model, label, [...removed], reconnect));
  }

  // ---- edges ----------------------------------------------------------------------------------------------------

  connect(from: PortRef, to: PortRef): boolean {
    const check = this.current.canConnect(from, to);
    if (!check.ok) {
      this.notify(check.reason ?? 'Cannot connect.');
      return false;
    }
    this.exec(connectCommand(this.current, from, to, check));
    return true;
  }

  /** Attach `childId` below `parentId` (replacing its previous parent). */
  reparent(childId: string, parentId: string): boolean {
    const pair = this.current.findPortPair(parentId, childId, 'hierarchy', true);
    if (!pair) {
      this.notify('These nodes cannot be connected.');
      return false;
    }
    this.exec(connectCommand(this.current, pair.from, pair.to, pair.check, 'Reparent'));
    return true;
  }

  /**
   * Re-attach `childId` (with its whole sub-tree) below `parentId`, moving the sub-tree next to the new parent.
   * One undo step.
   */
  reparentAndPlace(childId: string, parentId: string): boolean {
    const model = this.current;
    const pair = model.findPortPair(parentId, childId, 'hierarchy', true);
    const parent = model.getNode(parentId);
    const child = model.getNode(childId);
    if (!pair || !parent || !child) {
      this.notify('These nodes cannot be connected.');
      return false;
    }
    const subtree = [child, ...model.descendants(childId)];
    const inside = new Set(subtree.map((n) => n.id));
    const occupied = model.hierarchyNodes().filter((n) => !inside.has(n.id)).map((n) => ({ x: n.x, y: n.y }));
    const slot = findFreeSlot(occupied, parent.x, parent.y - V_SPACING);
    const dx = slot.x - child.x;
    const dy = slot.y - child.y;
    const patches = new Map<string, NodePatch>(subtree.filter((n) => !n.locked).map((n) => [n.id, { x: n.x + dx, y: n.y + dy }]));
    this.exec(batch('Reparent', [connectCommand(model, pair.from, pair.to, pair.check, 'Reparent'), new PatchNodesCommand(model, 'Move', patches)]));
    return true;
  }

  /** Attach a Force / Material / Mesh / Wind node to a generator. */
  attach(attachmentId: string, targetId: string): boolean {
    const pair = this.current.findPortPair(attachmentId, targetId, 'attachment', true);
    if (!pair) {
      this.notify('This node cannot be attached there.');
      return false;
    }
    this.exec(connectCommand(this.current, pair.from, pair.to, pair.check, 'Attach'));
    return true;
  }

  detach(attachmentId: string, targetId: string): void {
    const ids = this.current.outgoing(attachmentId).filter((e) => e.to.nodeId === targetId && e.kind === 'attachment').map((e) => e.id);
    if (ids.length > 0) this.exec(removeEdgesCommand(this.current, ids, 'Detach'));
  }

  removeEdges(ids: string[]): void {
    if (ids.length > 0) this.exec(removeEdgesCommand(this.current, ids));
  }

  // ---- node state ----------------------------------------------------------------------------------------------

  rename(id: string, name: string): void {
    const node = this.current.getNode(id);
    const clean = name.trim();
    if (!node || node.locked || clean === '' || clean === node.name) return;
    this.exec(new PatchNodesCommand(this.current, 'Rename', new Map([[id, { name: clean }]])));
  }

  setNote(id: string, note: string): void {
    const node = this.current.getNode(id);
    if (node && node.note !== note) this.exec(new PatchNodesCommand(this.current, 'Edit Note', new Map([[id, { note }]])));
  }

  /** Toggle a flag on the given nodes (default: selection). `value` omitted = invert based on the first node. */
  setFlag(flag: NodeFlagKey, value?: boolean, ids: string[] = this.getSelection()): void {
    const nodes = ids.map((id) => this.current.getNode(id)).filter((n): n is GraphNode => n !== undefined && (flag === 'locked' || !n.locked));
    const first = nodes[0];
    if (!first) return;
    const next = value ?? !first[flag];
    const patches = new Map<string, NodePatch>(nodes.filter((n) => n[flag] !== next).map((n) => [n.id, { [flag]: next }]));
    if (patches.size === 0) return;
    const labels: Record<NodeFlagKey, string> = {
      enabled: next ? 'Enable' : 'Disable',
      bypass: next ? 'Bypass' : 'Remove Bypass',
      solo: next ? 'Solo' : 'Unsolo',
      collapsed: next ? 'Collapse' : 'Expand',
      locked: next ? 'Lock' : 'Unlock',
    };
    this.exec(new PatchNodesCommand(this.current, labels[flag], patches));
  }

  // ---- movement & layout -----------------------------------------------------------------------------------------

  /** Live position update while dragging (no history entry). Finish with commitMove(). */
  moveLive(positions: Map<string, Point>): void {
    for (const [id, p] of positions) this.current.patchNode(id, { x: p.x, y: p.y });
  }

  /** Turn a finished live drag into ONE undoable command. `start` = positions when the drag began. */
  commitMove(start: Map<string, Point>, label = 'Move'): void {
    const end = new Map<string, NodePatch>();
    for (const [id, s] of start) {
      const n = this.current.getNode(id);
      if (n && (n.x !== s.x || n.y !== s.y)) end.set(id, { x: n.x, y: n.y });
    }
    if (end.size === 0) return;
    for (const [id, s] of start) this.current.patchNode(id, { x: s.x, y: s.y });
    this.exec(new PatchNodesCommand(this.current, label, end));
  }

  /** Nudge the selection by (dx, dy) world units (arrow keys). Consecutive nudges merge into one entry. */
  nudgeSelection(dx: number, dy: number): void {
    const patches = new Map<string, NodePatch>();
    for (const id of this.getSelection()) {
      const n = this.current.getNode(id);
      if (n && !n.locked && this.current.isHierarchyNode(n)) patches.set(id, { x: n.x + dx, y: n.y + dy });
    }
    if (patches.size > 0) this.exec(new PatchNodesCommand(this.current, 'Nudge', patches, 'nudge'));
  }

  /** Tidy-tree layout of the whole graph (`scope: 'all'`) or of the selected sub-trees. */
  autoLayout(scope: 'all' | 'selection' = 'all'): void {
    const model = this.current;
    const patches = new Map<string, NodePatch>();
    const layoutGroup = (rootIds: string[]): void => {
      const ids = new Set<string>(rootIds);
      for (const r of rootIds) for (const d of model.descendants(r)) ids.add(d.id);
      const nodes = [...ids].map((id) => model.getNode(id)).filter((n): n is GraphNode => n !== undefined && model.isHierarchyNode(n));
      const links = model.edges().filter((e) => e.kind === 'hierarchy' && ids.has(e.from.nodeId) && ids.has(e.to.nodeId)).map((e) => ({ parent: e.from.nodeId, child: e.to.nodeId }));
      const result = tidyTreeLayout(nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })), links, H_SPACING, V_SPACING);
      for (const [id, p] of result) {
        const n = model.getNode(id);
        if (n && !n.locked && (n.x !== p.x || n.y !== p.y)) patches.set(id, { x: p.x, y: p.y });
      }
    };
    if (scope === 'all') layoutGroup(model.hierarchyNodes().map((n) => n.id));
    else {
      const sel = new Set(this.getSelection());
      const tops = [...sel].filter((id) => !model.ancestors(id).some((a) => sel.has(a.id)));
      for (const t of tops) layoutGroup([t]);
    }
    if (patches.size === 0) return;
    this.exec(new PatchNodesCommand(model, scope === 'all' ? 'Auto Layout' : 'Layout Selection', patches));
    this.requestView('fit');
  }

  alignSelection(mode: AlignMode): void {
    const items = this.movableSelection();
    if (items.length < 2) return;
    this.applyPositions(alignPositions(items, mode), 'Align');
  }

  distributeSelection(axis: 'x' | 'y'): void {
    const items = this.movableSelection();
    if (items.length < 3) return;
    this.applyPositions(distributePositions(items, axis), 'Distribute');
  }

  private movableSelection(): { id: string; x: number; y: number }[] {
    return this.getSelection()
      .map((id) => this.current.getNode(id))
      .filter((n): n is GraphNode => n !== undefined && !n.locked && this.current.isHierarchyNode(n))
      .map((n) => ({ id: n.id, x: n.x, y: n.y }));
  }

  private applyPositions(positions: Map<string, Point>, label: string): void {
    const patches = new Map<string, NodePatch>();
    for (const [id, p] of positions) {
      const n = this.current.getNode(id);
      if (n && (n.x !== p.x || n.y !== p.y)) patches.set(id, { x: p.x, y: p.y });
    }
    if (patches.size > 0) this.exec(new PatchNodesCommand(this.current, label, patches));
  }

  // ---- clipboard --------------------------------------------------------------------------------------------------

  /** Detached copy of the selection and its sub-trees. null when nothing copyable is selected. */
  exportSelection(): ClipboardPayload | null {
    const payload = copySubgraph(this.current, this.expandWithDescendants(this.getSelection()));
    return payload.nodes.length > 0 ? payload : null;
  }

  /** Paste a sub-graph below the single selected node (or free-floating) as one undo step. */
  importSubgraph(payload: ClipboardPayload, label = 'Import Template'): void {
    const sel = this.getSelection();
    this.pasteInto(payload, sel.length === 1 ? sel[0] : undefined, undefined, label);
  }

  hasClipboard(): boolean {
    return this.clipboard !== null && this.clipboard.nodes.length > 0;
  }

  copy(): boolean {
    const ids = this.expandWithDescendants(this.getSelection());
    const payload = copySubgraph(this.current, ids);
    if (payload.nodes.length === 0) return false;
    this.clipboard = payload;
    this.notify(`Copied ${payload.nodes.length} node${payload.nodes.length > 1 ? 's' : ''}.`);
    return true;
  }

  cut(): void {
    if (this.copy()) this.deleteSelection(false);
  }

  /** Paste below the single selected node (or free-floating). `at` = world point for the centre of the pasted group. */
  paste(at?: Point): void {
    if (!this.clipboard) return;
    const sel = this.getSelection();
    const parent = sel.length === 1 ? sel[0] : undefined;
    this.pasteInto(this.clipboard, parent, at);
  }

  /** Duplicate the selection (with sub-trees) as siblings: the copy is attached to the same parent. */
  duplicate(): void {
    const model = this.current;
    const ids = this.expandWithDescendants(this.getSelection());
    const payload = copySubgraph(model, ids);
    if (payload.nodes.length === 0) return;
    const inside = new Set(payload.nodes.map((n) => n.id));
    const tops = payload.nodes.filter((n) => !model.parentOf(n.id) || !inside.has(model.parentOf(n.id)?.id ?? ''));
    const parentIds = new Set(tops.map((n) => model.parentOf(n.id)?.id));
    const parent = tops.length === 1 && parentIds.size === 1 ? model.parentOf((tops[0] as { id: string }).id)?.id : undefined;
    this.pasteInto(payload, parent, undefined, 'Duplicate');
  }

  private pasteInto(payload: ClipboardPayload, parentId: string | undefined, at: Point | undefined, label = 'Paste'): void {
    const model = this.current;
    const pts = payload.nodes.filter((n) => model.getDef(n.type) && isHierarchyDef(model.getDef(n.type) as NonNullable<ReturnType<GraphModel['getDef']>>)).map((n) => ({ x: n.position.x, y: n.position.y }));
    let dx = 0;
    let dy = 0;
    if (pts.length > 0) {
      const b = bounds(pts);
      const parent = parentId ? model.getNode(parentId) : undefined;
      if (at) {
        dx = at.x - (b.minX + b.maxX) / 2;
        dy = at.y - (b.minY + b.maxY) / 2;
      } else if (parent) {
        dx = parent.x - (b.minX + b.maxX) / 2;
        dy = parent.y - V_SPACING - b.maxY;
      } else {
        dx = H_SPACING / 2;
        dy = V_SPACING / 2;
      }
      const occupied = model.hierarchyNodes().map((n) => ({ x: n.x, y: n.y }));
      for (let i = 0; i < 60 && pts.some((p) => occupied.some((o) => Math.hypot(o.x - (p.x + dx), o.y - (p.y + dy)) < 30)); i++) dx += H_SPACING;
    }
    const plan = planPaste(model, payload, dx, dy, parentId);
    if (plan.nodes.length === 0) return;
    this.exec(addNodesCommand(model, `${label} ${plan.nodes.length > 1 ? `${plan.nodes.length} Nodes` : (plan.nodes[0]?.name ?? 'Node')}`, plan.nodes, plan.edges));
    this.setSelection(plan.nodes.map((n) => n.id));
  }

  // ---- annotations ------------------------------------------------------------------------------------------------

  /** Group box around the selected nodes (or an empty one at `at`). */
  addGroup(at?: Point): GraphAnnotation {
    const model = this.current;
    const nodes = this.getSelection().map((id) => model.getNode(id)).filter((n): n is GraphNode => n !== undefined && model.isHierarchyNode(n));
    let rect = { x: (at?.x ?? 0) - 90, y: (at?.y ?? 0) - 60, w: 180, h: 120 };
    if (nodes.length > 0) {
      const b = bounds(nodes.map((n) => ({ x: n.x, y: n.y })));
      rect = { x: b.minX - 34, y: b.minY - 40, w: b.maxX - b.minX + 68, h: b.maxY - b.minY + 78 };
    }
    const annotation: GraphAnnotation = { id: model.newId('g'), kind: 'group', text: 'Group', color: 'blue', ...rect };
    this.exec(addAnnotationCommand(model, annotation));
    return annotation;
  }

  addComment(at: Point): GraphAnnotation {
    const annotation: GraphAnnotation = { id: this.current.newId('c'), kind: 'comment', text: 'Comment', color: 'yellow', x: at.x, y: at.y, w: 150, h: 70 };
    this.exec(addAnnotationCommand(this.current, annotation));
    return annotation;
  }

  patchAnnotation(id: string, patch: AnnotationPatch, mergeKey?: string, label?: string): void {
    this.exec(new PatchAnnotationCommand(this.current, id, patch, label, mergeKey));
  }

  /**
   * Finish a live drag/resize of an annotation (and the nodes it carried) as ONE undo step.
   * `startRect`/`startNodes` are the values when the gesture began; current model values are the result.
   */
  commitAnnotationEdit(id: string, startRect: { x: number; y: number; w: number; h: number }, startNodes: Map<string, Point>, label: string): void {
    const model = this.current;
    const a = model.getAnnotation(id);
    if (!a) return;
    const endRect = { x: a.x, y: a.y, w: a.w, h: a.h };
    const endNodes = new Map<string, NodePatch>();
    for (const [nid, p] of startNodes) {
      const n = model.getNode(nid);
      if (n && (n.x !== p.x || n.y !== p.y)) endNodes.set(nid, { x: n.x, y: n.y });
    }
    const rectChanged = (Object.keys(endRect) as (keyof typeof endRect)[]).some((k) => endRect[k] !== startRect[k]);
    if (!rectChanged && endNodes.size === 0) return;
    model.patchAnnotation(id, startRect);
    for (const [nid, p] of startNodes) model.patchNode(nid, { x: p.x, y: p.y });
    const cmds: Command[] = [new PatchAnnotationCommand(model, id, endRect, label)];
    if (endNodes.size > 0) cmds.push(new PatchNodesCommand(model, 'Move', endNodes));
    this.exec(batch(label, cmds));
  }

  removeAnnotation(id: string): void {
    const cmd = removeAnnotationCommand(this.current, id);
    if (cmd) this.exec(cmd);
  }

  /** Several graph edits as one history entry. */
  transaction(label: string, commands: Command[]): void {
    this.exec(batch(label, commands));
  }

  // ---- footer summary ---------------------------------------------------------------------------------------------

  /** Attachment nodes grouped by category (footer counters). Forces count only the selection's, when there is one. */
  attachmentSummary(): { category: NodeCategory; nodes: GraphNode[]; count: number }[] {
    const model = this.current;
    const all = model.attachmentNodes();
    const sel = this.getSelection().filter((id) => model.getNode(id) && model.isHierarchyNode(model.getNode(id) as GraphNode));
    return ATTACHMENT_CATEGORIES.map((category) => {
      const nodes = all.filter((n) => model.getDef(n)?.category === category);
      let count = nodes.length;
      if (category === 'force' && sel.length > 0) count = nodes.filter((n) => model.attachmentTargets(n.id).some((t) => sel.includes(t.id))).length;
      return { category, nodes, count };
    });
  }
}
