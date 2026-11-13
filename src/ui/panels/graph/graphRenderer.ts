import type { GraphSession } from '@/app/graphSession';
import { GraphModel } from '@/graph/model/graphModel';
import type { GraphAnnotation, GraphEdge, GraphNode } from '@/graph/model/types';
import { hierarchyIn, hierarchyOut } from '@/graph/ports';
import { iconMarkup } from '../../icons/icons';
import { NODE_R, edgeGeometry, wirePath } from './edgeGeometry';
import { adaptiveGridStep, type Pt, type View, type WorldRect } from './viewTransform';

const NS = 'http://www.w3.org/2000/svg';

function s<K extends keyof SVGElementTagNameMap>(tag: K, cls?: string, attrs?: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  if (cls) el.setAttribute('class', cls);
  if (attrs) for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const raf = (cb: () => void): number => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : window.setTimeout(cb, 16));
const caf = (id: number): void => (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame(id) : window.clearTimeout(id));

interface NodeView {
  g: SVGGElement;
  title: SVGTitleElement;
  glyph: SVGGElement;
  label: SVGTextElement;
  badges: SVGGElement;
  glyphKey: string;
}

interface EdgeView {
  g: SVGGElement;
  line: SVGPathElement;
  hit: SVGPathElement;
  dot: SVGCircleElement;
  text: SVGTextElement;
}

interface AnnView {
  g: SVGGElement;
  frame: SVGRectElement;
  head: SVGRectElement | null;
  title: SVGTextElement | null;
  note: HTMLDivElement | null;
  fo: SVGForeignObjectElement | null;
  resize: SVGPathElement;
}

export type Hit =
  | { kind: 'node'; id: string }
  | { kind: 'port'; id: string; side: 'in' | 'out' }
  | { kind: 'edge'; id: string }
  | { kind: 'ann'; id: string; part: 'body' | 'head' | 'resize' }
  | { kind: 'none' };

export type WireState = 'neutral' | 'valid' | 'invalid';

/** Labels longer than this are cut with an ellipsis (e.g. "Little Branc…"). */
const LABEL_MAX = 13;

/**
 * SVG renderer of the graph. One transformed <g> (the "world") holds annotations, edges, nodes and an overlay; pan and
 * zoom only touch the transform attribute. Model changes are applied incrementally (dirty sets flushed once per frame).
 */
export class GraphRenderer {
  readonly svg: SVGSVGElement;
  view: View = { x: 0, y: 0, k: 1 };
  /** Nodes hidden because an ancestor is collapsed. */
  readonly hidden = new Set<string>();

  private readonly world: SVGGElement;
  private readonly annLayer: SVGGElement;
  private readonly edgeLayer: SVGGElement;
  private readonly nodeLayer: SVGGElement;
  private readonly overlay: SVGGElement;
  private readonly infoText: SVGTextElement;
  private readonly wire: SVGPathElement;
  private readonly guideLayer: SVGGElement;
  private readonly cutLine: SVGPolylineElement;
  private model: GraphModel;
  private readonly nodeViews = new Map<string, NodeView>();
  private readonly edgeViews = new Map<string, EdgeView>();
  private readonly annViews = new Map<string, AnnView>();
  private readonly dirtyNodes = new Set<string>();
  private readonly dirtyEdges = new Set<string>();
  private readonly dirtyAnns = new Set<string>();
  private hiddenDirty = true;
  private decoDirty = true;
  private rafId = 0;
  private selected = new Set<string>();
  private selectedEdge: string | null = null;
  private selectedAnn: string | null = null;
  private dropTarget: string | null = null;
  private unsubModel: (() => void)[] = [];
  private readonly unsubSession: (() => void)[] = [];

  constructor(
    readonly container: HTMLElement,
    private readonly session: GraphSession,
  ) {
    this.model = session.model;
    this.svg = s('svg', 'kt-graph-svg');
    this.svg.setAttribute('tabindex', '0');
    this.svg.setAttribute('role', 'application');
    this.svg.setAttribute('aria-label', 'Generation node graph');
    this.world = s('g', 'kt-gworld');
    this.annLayer = s('g', 'kt-gl-ann');
    this.edgeLayer = s('g', 'kt-gl-edges');
    this.nodeLayer = s('g', 'kt-gl-nodes');
    this.overlay = s('g', 'kt-gl-overlay');
    this.infoText = s('text', 'kt-ginfo');
    this.wire = s('path', 'kt-gwire');
    this.guideLayer = s('g', 'kt-gguides');
    this.cutLine = s('polyline', 'kt-gcut');
    this.wire.style.display = 'none';
    this.cutLine.style.display = 'none';
    this.overlay.append(this.guideLayer, this.wire, this.cutLine);
    this.world.append(this.annLayer, this.edgeLayer, this.nodeLayer, this.infoText, this.overlay);
    this.svg.append(this.world);
    container.append(this.svg);
    this.unsubSession.push(
      session.events.on('modelSwapped', (m) => this.setModel(m)),
      session.events.on('decorationsChanged', () => this.markDeco()),
      session.events.on('settingsChanged', () => {
        this.applySettings();
        this.markDeco();
      }),
    );
    this.setModel(this.model);
    this.applyView();
  }

  dispose(): void {
    caf(this.rafId);
    this.unsubModel.forEach((u) => u());
    this.unsubSession.forEach((u) => u());
    this.svg.remove();
  }

  // ---- model binding ----------------------------------------------------------------------------------------------

  private setModel(model: GraphModel): void {
    this.unsubModel.forEach((u) => u());
    this.model = model;
    const ev = model.events;
    this.unsubModel = [
      ev.on('nodeAdded', (n) => {
        if (!model.isHierarchyNode(n)) return;
        this.nodeViews.set(n.id, this.createNodeView(n));
        this.dirtyNodes.add(n.id);
        this.hiddenDirty = true;
        this.decoDirty = true;
        this.schedule();
      }),
      ev.on('nodeRemoved', (n) => {
        this.nodeViews.get(n.id)?.g.remove();
        this.nodeViews.delete(n.id);
        this.dirtyNodes.delete(n.id);
        this.hiddenDirty = true;
        this.decoDirty = true;
        this.schedule();
      }),
      ev.on('nodeChanged', ({ node, keys }) => {
        this.dirtyNodes.add(node.id);
        if (keys.includes('x') || keys.includes('y')) {
          for (const e of model.edgesOf(node.id)) this.dirtyEdges.add(e.id);
          this.decoDirty = true;
        }
        if (keys.includes('collapsed')) this.hiddenDirty = true;
        this.schedule();
      }),
      ev.on('edgeAdded', (e) => {
        this.addEdgeView(e);
        this.dirtyNodes.add(e.from.nodeId);
        this.dirtyNodes.add(e.to.nodeId);
        this.hiddenDirty = true;
        this.schedule();
      }),
      ev.on('edgeRemoved', (e) => {
        this.edgeViews.get(e.id)?.g.remove();
        this.edgeViews.delete(e.id);
        this.dirtyEdges.delete(e.id);
        this.dirtyNodes.add(e.from.nodeId);
        this.dirtyNodes.add(e.to.nodeId);
        this.hiddenDirty = true;
        this.schedule();
      }),
      ev.on('annotationAdded', (a) => {
        this.annViews.set(a.id, this.createAnnView(a));
        this.dirtyAnns.add(a.id);
        this.schedule();
      }),
      ev.on('annotationRemoved', (a) => {
        this.annViews.get(a.id)?.g.remove();
        this.annViews.delete(a.id);
        this.schedule();
      }),
      ev.on('annotationChanged', ({ annotation }) => {
        this.dirtyAnns.add(annotation.id);
        this.schedule();
      }),
      ev.on('reset', () => this.rebuild()),
    ];
    this.rebuild();
  }

  /** Throw away all views and rebuild from the model. */
  rebuild(): void {
    this.nodeViews.clear();
    this.edgeViews.clear();
    this.annViews.clear();
    this.annLayer.replaceChildren();
    this.edgeLayer.replaceChildren();
    this.nodeLayer.replaceChildren();
    this.dirtyNodes.clear();
    this.dirtyEdges.clear();
    this.dirtyAnns.clear();
    for (const a of this.model.annotations()) {
      this.annViews.set(a.id, this.createAnnView(a));
      this.dirtyAnns.add(a.id);
    }
    for (const e of this.model.edges()) this.addEdgeView(e);
    for (const n of this.model.nodes()) {
      if (!this.model.isHierarchyNode(n)) continue;
      this.nodeViews.set(n.id, this.createNodeView(n));
      this.dirtyNodes.add(n.id);
    }
    this.hiddenDirty = true;
    this.decoDirty = true;
    this.applySettings();
    this.flush();
    this.setSelected([...this.selected]);
  }

  private schedule(): void {
    if (this.rafId !== 0) return;
    this.rafId = raf(() => {
      this.rafId = 0;
      this.flush();
    });
  }

  private diagSignatures = new Map<string, string>();

  private markDeco(): void {
    for (const id of this.nodeViews.keys()) {
      const d = this.session.diagnostics.get(id);
      const sig = d ? `${d.state}|${d.messages.map((m) => m.text).join(';')}|${d.state === 'ok' ? d.ms.toFixed(0) : ''}|${d.triangles}|${d.instances}` : '';
      if (this.diagSignatures.get(id) === sig) continue;
      this.diagSignatures.set(id, sig);
      this.dirtyNodes.add(id);
    }
    this.decoDirty = true;
    for (const id of this.edgeViews.keys()) this.dirtyEdges.add(id);
    this.schedule();
  }

  /** Apply all pending changes synchronously (also used by tests). */
  flush(): void {
    if (this.hiddenDirty) this.computeHidden();
    for (const id of this.dirtyNodes) this.updateNodeView(id);
    this.dirtyNodes.clear();
    for (const id of this.dirtyEdges) this.updateEdgeView(id);
    this.dirtyEdges.clear();
    for (const id of this.dirtyAnns) this.updateAnnView(id);
    this.dirtyAnns.clear();
    if (this.decoDirty) this.updateInfo();
    this.decoDirty = false;
  }

  private applySettings(): void {
    const st = this.session.settings;
    this.container.classList.toggle('show-grid', st.showGrid);
    this.container.classList.toggle('hide-labels', !st.showLabels);
    this.container.classList.toggle('hide-edge-labels', !st.showEdgeLabels);
    this.applyView();
  }

  private computeHidden(): void {
    this.hiddenDirty = false;
    const next = new Set<string>();
    const counts = new Map<string, number>();
    for (const n of this.model.nodes()) {
      if (!n.collapsed || !this.model.isHierarchyNode(n)) continue;
      const desc = this.model.descendants(n.id);
      counts.set(n.id, desc.length);
      for (const d of desc) next.add(d.id);
    }
    this.collapsedCounts = counts;
    const changed = next.size !== this.hidden.size || [...next].some((id) => !this.hidden.has(id));
    this.hidden.clear();
    for (const id of next) this.hidden.add(id);
    if (changed) {
      for (const id of this.nodeViews.keys()) this.dirtyNodes.add(id);
      for (const id of this.edgeViews.keys()) this.dirtyEdges.add(id);
    }
    // Collapsed nodes need their badge refreshed.
    for (const id of counts.keys()) this.dirtyNodes.add(id);
  }

  private collapsedCounts = new Map<string, number>();

  // ---- nodes ------------------------------------------------------------------------------------------------------

  private createNodeView(node: GraphNode): NodeView {
    const def = this.model.getDef(node);
    const g = s('g', 'kt-gn');
    g.setAttribute('data-node', node.id);
    const title = s('title');
    const body = s('circle', 'body', { r: NODE_R });
    const glyph = s('g', 'glyph', { transform: 'translate(-7.2 -7.2) scale(0.6)' });
    const label = s('text', 'label', { y: -NODE_R - 5 });
    const badges = s('g', 'badges');
    g.append(title, body, glyph, label, badges);
    if (def && hierarchyOut(def)) {
      const p = s('circle', 'port out', { cx: 0, cy: -NODE_R, r: 5 });
      p.setAttribute('data-port', 'out');
      g.append(p);
    }
    if (def && hierarchyIn(def)) {
      const p = s('circle', 'port in', { cx: 0, cy: NODE_R, r: 5 });
      p.setAttribute('data-port', 'in');
      g.append(p);
    }
    this.nodeLayer.append(g);
    return { g, title, glyph, label, badges, glyphKey: '' };
  }

  private updateNodeView(id: string): void {
    const view = this.nodeViews.get(id);
    const node = this.model.getNode(id);
    if (!view || !node) return;
    const def = this.model.getDef(node);
    const { g } = view;
    g.setAttribute('transform', `translate(${node.x} ${node.y})`);
    g.style.setProperty('--kt-n-color', def?.color ?? 'var(--kt-node-disabled)');
    const hiddenByCollapse = this.hidden.has(id);
    g.classList.toggle('hidden', hiddenByCollapse);
    g.classList.toggle('selected', this.selected.has(id));
    g.classList.toggle('disabled', !node.enabled);
    g.classList.toggle('bypass', node.bypass);
    g.classList.toggle('solo', node.solo);
    g.classList.toggle('locked', node.locked);
    g.classList.toggle('unknown', !def);
    const glyphKey = !node.enabled ? 'nodeSleep' : (def?.icon ?? 'stub');
    if (glyphKey !== view.glyphKey) {
      view.glyphKey = glyphKey;
      view.glyph.innerHTML = iconMarkup(glyphKey) ?? '';
    }
    const name = node.name;
    view.label.textContent = name.length > LABEL_MAX ? `${name.slice(0, LABEL_MAX - 1)}…` : name;

    const notes: string[] = [`${name} — ${def?.label ?? `Unknown type "${node.type}"`}`];
    if (node.note) notes.push(node.note);
    view.badges.replaceChildren();
    const badge = (cls: string, x: number, y: number, content: SVGElement | string): void => {
      const b = s('g', `badge ${cls}`, { transform: `translate(${x} ${y})` });
      b.append(s('circle', undefined, { r: 4.6 }));
      if (typeof content === 'string') {
        const t = s('text', undefined, { y: 2.2 });
        t.textContent = content;
        b.append(t);
      } else b.append(content);
      view.badges.append(b);
    };
    if (node.note) badge('info', -15, -3, 'i');
    if (!def) {
      badge('error', 15, -3, '!');
      notes.push('Unknown node type: its definition is not registered.');
    } else if (hierarchyIn(def) && !this.model.parentOf(id)) {
      badge('warn', 15, -3, '!');
      notes.push('Not connected to a parent: this node is ignored.');
    }
    const diag = this.session.diagnostics.get(id);
    if (diag) {
      const errs = diag.messages.filter((m) => m.level === 'error');
      const warns = diag.messages.filter((m) => m.level === 'warn');
      if (diag.state === 'error' || diag.state === 'blocked' || errs.length > 0) badge('error', 15, -3, '!');
      else if (warns.length > 0) badge('warn', 15, -3, '!');
      for (const m of diag.messages) notes.push(`${m.level === 'error' ? 'Error' : 'Warning'}: ${m.text}`);
      if (diag.state === 'ok') notes.push(`Generated in ${diag.ms.toFixed(1)} ms${diag.instances > 0 ? ` · ${diag.instances.toLocaleString('en-US')} instances` : ''}${diag.triangles > 0 ? ` · ${diag.triangles.toLocaleString('en-US')} tris` : ''}`);
      else if (diag.state === 'cached') notes.push('Cached result');
    }
    if (node.locked) {
      const lock = s('g');
      lock.innerHTML = '<rect x="-2.200" y="-0.200" width="4.400" height="3.600" rx="0.800" fill="currentColor" stroke="none"/><path d="M-1.400 -0.200v-1.200a1.400 1.400 0 0 1 2.800 0v1.200" fill="none" stroke="currentColor" stroke-width="0.900"/>';
      badge('lock', -14, 8, lock);
      notes.push('Locked');
    }
    if (node.solo) {
      badge('solo', 14, 8, 'S');
      notes.push('Solo');
    }
    if (node.collapsed) {
      const n = this.collapsedCounts.get(id) ?? 0;
      const b = s('g', 'badge collapsed', { transform: `translate(0 ${NODE_R + 9})` });
      b.append(s('rect', undefined, { x: -9, y: -5, width: 18, height: 10, rx: 5 }));
      const t = s('text', undefined, { y: 2.600 });
      t.textContent = `+${n}`;
      b.append(t);
      view.badges.append(b);
      notes.push(`Collapsed (${n} hidden)`);
    }
    if (!node.enabled) notes.push('Disabled');
    if (node.bypass) notes.push('Bypassed');
    view.title.textContent = notes.join('\n');
  }

  // ---- edges ------------------------------------------------------------------------------------------------------

  private addEdgeView(e: GraphEdge): void {
    if (e.kind !== 'hierarchy' || this.edgeViews.has(e.id)) return;
    const g = s('g', 'kt-ge');
    g.setAttribute('data-edge', e.id);
    const hit = s('path', 'hit');
    const line = s('path', 'line');
    const dot = s('circle', 'dot', { r: 2.6 });
    const text = s('text', 'count');
    g.append(hit, line, dot, text);
    this.edgeLayer.append(g);
    this.edgeViews.set(e.id, { g, hit, line, dot, text });
    this.dirtyEdges.add(e.id);
  }

  private updateEdgeView(id: string): void {
    const view = this.edgeViews.get(id);
    const e = this.model.getEdge(id);
    if (!view || !e) return;
    const parent = this.model.getNode(e.from.nodeId);
    const child = this.model.getNode(e.to.nodeId);
    if (!parent || !child) return;
    const geo = edgeGeometry(parent, child);
    view.line.setAttribute('d', geo.d);
    view.hit.setAttribute('d', geo.d);
    view.dot.setAttribute('cx', String(geo.mid.x));
    view.dot.setAttribute('cy', String(geo.mid.y));
    view.text.setAttribute('x', String(geo.mid.x + 4));
    view.text.setAttribute('y', String(geo.mid.y + 3));
    view.text.textContent = this.session.edgeLabels.get(id) ?? '';
    view.g.classList.toggle('hidden', this.hidden.has(parent.id) || this.hidden.has(child.id));
    view.g.classList.toggle('selected', this.selectedEdge === id);
    view.g.classList.toggle('disabled', !child.enabled || !parent.enabled);
  }

  private updateInfo(): void {
    const root = this.model.nodes().find((n) => this.model.getDef(n)?.category === 'output');
    if (!root) {
      this.infoText.textContent = '';
      return;
    }
    this.infoText.setAttribute('x', String(root.x - NODE_R - 6));
    this.infoText.setAttribute('y', String(root.y + 3));
    this.infoText.textContent = this.session.rootInfo;
  }

  // ---- annotations ------------------------------------------------------------------------------------------------

  private createAnnView(a: GraphAnnotation): AnnView {
    const g = s('g', `kt-gann ${a.kind}`);
    g.setAttribute('data-ann', a.id);
    const frame = s('rect', 'frame', { rx: 5 });
    const resize = s('path', 'resize');
    resize.setAttribute('data-resize', '1');
    let head: SVGRectElement | null = null;
    let title: SVGTextElement | null = null;
    let note: HTMLDivElement | null = null;
    let fo: SVGForeignObjectElement | null = null;
    g.append(frame);
    if (a.kind === 'group') {
      head = s('rect', 'head', { height: 16, rx: 5 });
      head.setAttribute('data-head', '1');
      title = s('text', 'title', { x: 8, y: 11.500 });
      g.append(head, title);
    } else {
      fo = s('foreignObject');
      note = document.createElement('div');
      note.className = 'kt-gann-text';
      fo.append(note);
      g.append(fo);
    }
    g.append(resize);
    this.annLayer.append(g);
    return { g, frame, head, title, note, fo, resize };
  }

  private updateAnnView(id: string): void {
    const v = this.annViews.get(id);
    const a = this.model.getAnnotation(id);
    if (!v || !a) return;
    v.g.setAttribute('transform', `translate(${a.x} ${a.y})`);
    v.g.setAttribute('class', `kt-gann ${a.kind} c-${a.color}${this.selectedAnn === id ? ' sel' : ''}`);
    v.frame.setAttribute('width', String(a.w));
    v.frame.setAttribute('height', String(a.h));
    v.head?.setAttribute('width', String(a.w));
    if (v.title) v.title.textContent = a.text;
    if (v.fo && v.note) {
      v.fo.setAttribute('width', String(a.w));
      v.fo.setAttribute('height', String(a.h));
      v.note.textContent = a.text;
    }
    v.resize.setAttribute('d', `M${a.w - 11} ${a.h}L${a.w} ${a.h - 11}L${a.w} ${a.h}Z`);
  }

  // ---- view -------------------------------------------------------------------------------------------------------

  setView(v: View): void {
    this.view = v;
    this.applyView();
  }

  private applyView(): void {
    const { x, y, k } = this.view;
    this.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`);
    this.container.classList.toggle('lod-far', k < 0.5);
    this.container.classList.toggle('lod-near', k > 1.6);
    const step = adaptiveGridStep(k, this.session.settings.gridSize) * k;
    const st = this.container.style;
    st.setProperty('--kt-grid', `${step}px`);
    st.setProperty('--kt-grid-major', `${step * 5}px`);
    st.setProperty('--kt-grid-x', `${x}px`);
    st.setProperty('--kt-grid-y', `${y}px`);
  }

  clientToWorld(clientX: number, clientY: number): Pt {
    const r = this.svg.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.k, y: (clientY - r.top - this.view.y) / this.view.k };
  }

  clientToLocal(clientX: number, clientY: number): Pt {
    const r = this.svg.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  get size(): { w: number; h: number } {
    const r = this.svg.getBoundingClientRect();
    return { w: r.width || this.container.clientWidth || 400, h: r.height || this.container.clientHeight || 300 };
  }

  visibleNodes(): GraphNode[] {
    return this.model.hierarchyNodes().filter((n) => !this.hidden.has(n.id));
  }

  /** World-space bounds of the given nodes (default: everything visible, including annotations). */
  bounds(ids?: string[]): WorldRect | null {
    const nodes = ids ? ids.map((id) => this.model.getNode(id)).filter((n): n is GraphNode => n !== undefined && !this.hidden.has(n.id) && this.model.isHierarchyNode(n)) : this.visibleNodes();
    if (nodes.length === 0) return null;
    const r: WorldRect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const n of nodes) {
      r.minX = Math.min(r.minX, n.x - NODE_R - 14);
      r.maxX = Math.max(r.maxX, n.x + NODE_R + 14);
      r.minY = Math.min(r.minY, n.y - NODE_R - 16);
      r.maxY = Math.max(r.maxY, n.y + NODE_R + 6);
    }
    if (!ids) {
      for (const a of this.model.annotations()) {
        r.minX = Math.min(r.minX, a.x);
        r.minY = Math.min(r.minY, a.y);
        r.maxX = Math.max(r.maxX, a.x + a.w);
        r.maxY = Math.max(r.maxY, a.y + a.h);
      }
    }
    return r;
  }

  portPosition(nodeId: string, side: 'in' | 'out'): Pt | null {
    const n = this.model.getNode(nodeId);
    return n ? { x: n.x, y: side === 'out' ? n.y - NODE_R : n.y + NODE_R } : null;
  }

  // ---- hit testing -------------------------------------------------------------------------------------------------

  hit(target: EventTarget | null): Hit {
    const el = target instanceof Element ? target : null;
    if (!el) return { kind: 'none' };
    const portEl = el.closest('[data-port]');
    const nodeEl = el.closest('[data-node]');
    if (nodeEl) {
      const id = nodeEl.getAttribute('data-node') ?? '';
      if (portEl) return { kind: 'port', id, side: portEl.getAttribute('data-port') === 'out' ? 'out' : 'in' };
      return { kind: 'node', id };
    }
    const edgeEl = el.closest('[data-edge]');
    if (edgeEl) return { kind: 'edge', id: edgeEl.getAttribute('data-edge') ?? '' };
    const annEl = el.closest('[data-ann]');
    if (annEl) {
      const part = el.closest('[data-resize]') ? 'resize' : el.closest('[data-head]') ? 'head' : 'body';
      return { kind: 'ann', id: annEl.getAttribute('data-ann') ?? '', part };
    }
    return { kind: 'none' };
  }

  /** Node whose circle contains the screen point (ignores hidden nodes). */
  nodeAtClient(clientX: number, clientY: number, exclude?: Set<string>): string | null {
    const w = this.clientToWorld(clientX, clientY);
    let best: string | null = null;
    let bestD = Infinity;
    for (const n of this.visibleNodes()) {
      if (exclude?.has(n.id)) continue;
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d < bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best !== null && bestD <= NODE_R + 4 / this.view.k ? best : null;
  }

  /** Nearest visible node within `radiusPx` screen pixels. */
  nearestNode(clientX: number, clientY: number, radiusPx: number, exclude?: Set<string>): string | null {
    const w = this.clientToWorld(clientX, clientY);
    let best: string | null = null;
    let bestD = radiusPx / this.view.k;
    for (const n of this.visibleNodes()) {
      if (exclude?.has(n.id)) continue;
      const d = Math.hypot(n.x - w.x, n.y - w.y);
      if (d <= bestD) {
        bestD = d;
        best = n.id;
      }
    }
    return best;
  }

  /** Sampled edges for cut-line tests: edge id -> control points. */
  edgeControlPoints(): { id: string; pts: ReturnType<typeof edgeGeometry>['pts'] }[] {
    const out: { id: string; pts: ReturnType<typeof edgeGeometry>['pts'] }[] = [];
    for (const e of this.model.edges()) {
      if (!this.edgeViews.has(e.id) || this.edgeViews.get(e.id)?.g.classList.contains('hidden')) continue;
      const a = this.model.getNode(e.from.nodeId);
      const b = this.model.getNode(e.to.nodeId);
      if (a && b) out.push({ id: e.id, pts: edgeGeometry(a, b).pts });
    }
    return out;
  }

  // ---- selection / overlay ----------------------------------------------------------------------------------------

  setSelected(ids: string[]): void {
    const next = new Set(ids);
    for (const id of new Set([...this.selected, ...next])) {
      if (this.selected.has(id) !== next.has(id)) this.nodeViews.get(id)?.g.classList.toggle('selected', next.has(id));
    }
    this.selected = next;
    for (const id of next) this.nodeViews.get(id)?.g.classList.add('selected');
  }

  setSelectedEdge(id: string | null): void {
    const prev = this.selectedEdge;
    this.selectedEdge = id;
    if (prev) this.edgeViews.get(prev)?.g.classList.remove('selected');
    if (id) this.edgeViews.get(id)?.g.classList.add('selected');
  }

  setSelectedAnn(id: string | null): void {
    const prev = this.selectedAnn;
    this.selectedAnn = id;
    if (prev) this.dirtyAnns.add(prev);
    if (id) this.dirtyAnns.add(id);
    this.schedule();
  }

  get annSelection(): string | null {
    return this.selectedAnn;
  }

  get edgeSelection(): string | null {
    return this.selectedEdge;
  }

  setLinking(on: boolean): void {
    this.container.classList.toggle('linking', on);
  }

  showWire(anchor: Pt, end: Pt, anchorIsOutput: boolean, state: WireState): void {
    this.wire.style.display = '';
    this.wire.setAttribute('d', wirePath(anchor, end, anchorIsOutput));
    this.wire.setAttribute('class', `kt-gwire ${state}`);
  }

  hideWire(): void {
    this.wire.style.display = 'none';
  }

  setDropTarget(id: string | null, state: 'ok' | 'bad' = 'ok'): void {
    if (this.dropTarget && this.dropTarget !== id) this.nodeViews.get(this.dropTarget)?.g.classList.remove('drop-ok', 'drop-bad');
    this.dropTarget = id;
    if (id) {
      const g = this.nodeViews.get(id)?.g;
      g?.classList.remove('drop-ok', 'drop-bad');
      g?.classList.add(state === 'ok' ? 'drop-ok' : 'drop-bad');
    }
  }

  setGuides(xs: number[], ys: number[]): void {
    this.guideLayer.replaceChildren();
    const big = 100000;
    for (const x of xs) this.guideLayer.append(s('line', 'guide', { x1: x, y1: -big, x2: x, y2: big }));
    for (const y of ys) this.guideLayer.append(s('line', 'guide', { x1: -big, y1: y, x2: big, y2: y }));
  }

  showCutLine(points: Pt[]): void {
    this.cutLine.style.display = points.length > 1 ? '' : 'none';
    this.cutLine.setAttribute('points', points.map((p) => `${p.x},${p.y}`).join(' '));
  }

  nodeScreenRect(id: string): DOMRect | null {
    return this.nodeViews.get(id)?.g.getBoundingClientRect() ?? null;
  }

  annScreenRect(id: string): DOMRect | null {
    return this.annViews.get(id)?.g.getBoundingClientRect() ?? null;
  }
}
