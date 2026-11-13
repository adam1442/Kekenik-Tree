import type { AppContext } from '@/app/context';
import type { AddNodeOptions } from '@/app/graphSession';
import { matchesShortcut, parseShortcut } from '@/app/shortcuts';
import type { NodeDef } from '@/contracts/nodes';
import type { ConnectCheck, PortRef } from '@/graph/model/types';
import { hierarchyIn, hierarchyOut, matchPorts } from '@/graph/ports';
import { listNodeDefs } from '@/graph/registry';
import { h } from '../../components/dom';
import { closeActiveMenu, showMenu } from '../../components/menu';
import { showAddNodePopup } from './addNodePopup';
import { curveCrossesPolyline, sampleBezier } from './edgeGeometry';
import { GraphRenderer, type Hit, type WireState } from './graphRenderer';
import {
  actionsMenu,
  annotationContextMenu,
  canvasContextMenu,
  compatibleDefs,
  edgeContextMenu,
  nodeContextMenu,
  settingsMenu,
  type MenuHost,
} from './graphMenus';
import { fitView, lerpView, screenToWorld, zoomAt, type Pt, type View } from './viewTransform';

type Mode =
  | { t: 'idle' }
  | { t: 'pan'; start: Pt; view: View }
  | { t: 'rmb'; start: Pt; view: View; panned: boolean; hit: Hit }
  | { t: 'cut'; points: Pt[] }
  | { t: 'marquee'; start: Pt; startWorld: Pt; kind: 'set' | 'add' | 'toggle'; base: string[]; moved: boolean }
  | { t: 'nodes'; id: string; ids: string[]; startWorld: Pt; start: Map<string, Pt>; startClient: Pt; moved: boolean; toggleOnUp: boolean; additive: boolean }
  | { t: 'ann'; id: string; resize: boolean; startWorld: Pt; rect: { x: number; y: number; w: number; h: number }; nodes: Map<string, Pt>; moved: boolean }
  | { t: 'connect'; anchor: PortRef; side: 'in' | 'out'; edge: 'hierarchy' | 'attachment'; startClient: Pt; target: string | null; check: { from: PortRef; to: PortRef; res: ConnectCheck } | null };

const DRAG_THRESHOLD = 3;
const SNAP_PX = 6;
const CONNECT_SNAP_PX = 26;

function isTextTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}

/**
 * Interactive graph canvas: pan/zoom, selection, node dragging with snapping, port-to-port connecting,
 * reparenting, cut-lines, annotations, context menus, inline renaming and the keyboard.
 * All edits go through GraphSession (undoable); this class only handles gestures.
 */
export class GraphCanvas implements MenuHost {
  readonly el: HTMLElement;
  readonly renderer: GraphRenderer;
  private mode: Mode = { t: 'idle' };
  private spaceDown = false;
  private readonly marquee: HTMLElement;
  private readonly tip: HTMLElement;
  private readonly pointers = new Map<number, Pt>();
  private pinch: { dist: number; center: Pt; view: View } | null = null;
  private lastClient: Pt | null = null;
  private animId = 0;
  private fitted = false;
  private editor: HTMLElement | null = null;
  private readonly disposers: (() => void)[] = [];
  private lastRmb: { hit: Hit; panned: boolean } | null = null;

  constructor(readonly app: AppContext) {
    this.el = h('div', 'kt-graph-canvas');
    this.renderer = new GraphRenderer(this.el, app.graph);
    this.marquee = h('div', 'kt-gmarquee');
    this.marquee.style.display = 'none';
    this.tip = h('div', 'kt-gtip');
    this.tip.style.display = 'none';
    this.el.append(this.marquee, this.tip);

    const svg = this.renderer.svg;
    const on = <K extends keyof GlobalEventHandlersEventMap>(type: K, fn: (e: GlobalEventHandlersEventMap[K]) => void, opts?: AddEventListenerOptions): void => {
      svg.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => svg.removeEventListener(type, fn as EventListener, opts));
    };
    on('pointerdown', (e) => this.onDown(e));
    on('wheel', (e) => this.onWheel(e), { passive: false });
    on('dblclick', (e) => this.onDblClick(e));
    on('contextmenu', (e) => this.onContext(e));
    on('keydown', (e) => this.onKey(e));
    on('keyup', (e) => this.onKeyUp(e));
    on('pointermove', (e) => {
      this.lastClient = { x: e.clientX, y: e.clientY };
    });
    on('pointerenter', () => {
      const a = document.activeElement;
      if (!isTextTarget(a)) svg.focus({ preventScroll: true });
    });
    on('pointerleave', () => this.hideTip());
    on('blur', () => {
      this.spaceDown = false;
      this.el.classList.remove('space');
    });

    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(this.el);
    this.disposers.push(() => ro.disconnect());

    const g = app.graph;
    this.disposers.push(
      g.events.on('selectionChanged', (ids) => {
        this.renderer.setSelected(ids);
        if (ids.length > 0) {
          this.renderer.setSelectedEdge(null);
          this.renderer.setSelectedAnn(null);
        }
      }),
      g.events.on('viewRequest', (kind) => (kind === 'fit' ? this.fit() : this.frameSelection())),
      g.events.on('modelSwapped', () => {
        this.renderer.setSelected(g.getSelection());
        this.renderer.setSelectedEdge(null);
        this.renderer.setSelectedAnn(null);
        this.fit(false);
      }),
    );
    this.renderer.setSelected(g.getSelection());
  }

  dispose(): void {
    cancelAnimationFrame(this.animId);
    this.closeEditor();
    this.disposers.forEach((d) => d());
    this.renderer.dispose();
    this.el.remove();
  }

  // ---- view -------------------------------------------------------------------------------------------------------

  private onResize(): void {
    const { w, h: hh } = this.renderer.size;
    if (!this.fitted && w > 40 && hh > 40) {
      this.fitted = true;
      this.fit(false);
    }
  }

  private cancelAnim(): void {
    cancelAnimationFrame(this.animId);
    this.animId = 0;
  }

  private animateTo(target: View, animate: boolean): void {
    this.cancelAnim();
    if (!animate) {
      this.renderer.setView(target);
      return;
    }
    const from = this.renderer.view;
    const t0 = performance.now();
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / 200);
      const eased = 1 - Math.pow(1 - t, 3);
      this.renderer.setView(lerpView(from, target, eased));
      this.animId = t < 1 ? requestAnimationFrame(step) : 0;
    };
    this.animId = requestAnimationFrame(step);
  }

  fit(animate = true): void {
    this.renderer.flush();
    const rect = this.renderer.bounds();
    const { w, h: hh } = this.renderer.size;
    this.animateTo(rect ? fitView(rect, w, hh, 36, 1.4) : { x: w / 2, y: hh / 2, k: 1 }, animate);
  }

  frameSelection(): void {
    const rect = this.renderer.bounds(this.app.graph.getSelection());
    if (!rect) {
      this.fit();
      return;
    }
    const { w, h: hh } = this.renderer.size;
    this.animateTo(fitView(rect, w, hh, 90, 1.6), true);
  }

  /** Pan (not zoom) so that a node is visible. */
  private ensureVisible(id: string): void {
    const n = this.app.graph.model.getNode(id);
    if (!n) return;
    const v = this.renderer.view;
    const { w, h: hh } = this.renderer.size;
    const sx = n.x * v.k + v.x;
    const sy = n.y * v.k + v.y;
    const m = 40;
    if (sx < m || sy < m || sx > w - m || sy > hh - m) this.animateTo({ k: v.k, x: w / 2 - n.x * v.k, y: hh / 2 - n.y * v.k }, true);
  }

  private viewCenterWorld(): Pt {
    const { w, h: hh } = this.renderer.size;
    return screenToWorld(this.renderer.view, w / 2, hh / 2);
  }

  // ---- pointer ----------------------------------------------------------------------------------------------------

  private local(e: { clientX: number; clientY: number }): Pt {
    return this.renderer.clientToLocal(e.clientX, e.clientY);
  }

  private onDown(e: PointerEvent): void {
    this.cancelAnim();
    this.closeEditor();
    const local = this.local(e);
    this.pointers.set(e.pointerId, local);
    this.renderer.svg.focus({ preventScroll: true });
    if (e.pointerType === 'touch' && this.pointers.size === 2) {
      this.beginPinch();
      this.attachWindow();
      return;
    }
    if (this.mode.t !== 'idle') return;
    const hit = this.renderer.hit(e.target);
    const g = this.app.graph;

    if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
      e.preventDefault();
      this.mode = { t: 'pan', start: local, view: this.renderer.view };
      this.el.classList.add('panning');
      this.attachWindow();
      return;
    }
    if (e.button === 2) {
      this.lastRmb = { hit, panned: false };
      if (e.ctrlKey || e.metaKey) {
        this.mode = { t: 'cut', points: [this.renderer.clientToWorld(e.clientX, e.clientY)] };
        this.el.classList.add('cutting');
      } else {
        this.mode = { t: 'rmb', start: local, view: this.renderer.view, panned: false, hit };
      }
      this.attachWindow();
      return;
    }
    if (e.button !== 0) return;

    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const world = this.renderer.clientToWorld(e.clientX, e.clientY);
    switch (hit.kind) {
      case 'port':
        this.beginConnect(e, hit.id, hit.side);
        break;
      case 'node':
        this.beginNodeDrag(e, hit.id, additive, world);
        break;
      case 'edge':
        if (e.altKey) g.removeEdges([hit.id]);
        else {
          g.clearSelection();
          this.renderer.setSelectedAnn(null);
          this.renderer.setSelectedEdge(hit.id);
        }
        break;
      case 'ann':
        this.beginAnnDrag(hit.id, hit.part === 'resize', world);
        break;
      default:
        this.renderer.setSelectedEdge(null);
        this.renderer.setSelectedAnn(null);
        this.mode = { t: 'marquee', start: local, startWorld: world, kind: e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set', base: g.getSelection(), moved: false };
        this.attachWindow();
    }
  }

  private attachWindow(): void {
    if (this.windowBound) return;
    this.windowBound = true;
    window.addEventListener('pointermove', this.winMove);
    window.addEventListener('pointerup', this.winUp);
    window.addEventListener('pointercancel', this.winUp);
  }

  private detachWindow(): void {
    this.windowBound = false;
    window.removeEventListener('pointermove', this.winMove);
    window.removeEventListener('pointerup', this.winUp);
    window.removeEventListener('pointercancel', this.winUp);
  }

  private windowBound = false;
  private readonly winMove = (e: PointerEvent): void => this.onMove(e);
  private readonly winUp = (e: PointerEvent): void => this.onUp(e);

  private beginPinch(): void {
    const pts = [...this.pointers.values()];
    const [a, b] = pts as [Pt, Pt];
    this.cancelMode();
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: this.renderer.view };
  }

  private onMove(e: PointerEvent): void {
    const local = this.local(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, local);
    this.lastClient = { x: e.clientX, y: e.clientY };
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()] as [Pt, Pt];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = zoomAt(this.pinch.view, this.pinch.center.x, this.pinch.center.y, dist / this.pinch.dist);
      this.renderer.setView({ k: z.k, x: z.x + (center.x - this.pinch.center.x), y: z.y + (center.y - this.pinch.center.y) });
      return;
    }
    const m = this.mode;
    switch (m.t) {
      case 'pan':
        this.renderer.setView({ k: m.view.k, x: m.view.x + local.x - m.start.x, y: m.view.y + local.y - m.start.y });
        break;
      case 'rmb':
        if (!m.panned && Math.hypot(local.x - m.start.x, local.y - m.start.y) > 4) {
          m.panned = true;
          if (this.lastRmb) this.lastRmb.panned = true;
          this.el.classList.add('panning');
        }
        if (m.panned) this.renderer.setView({ k: m.view.k, x: m.view.x + local.x - m.start.x, y: m.view.y + local.y - m.start.y });
        break;
      case 'cut': {
        m.points.push(this.renderer.clientToWorld(e.clientX, e.clientY));
        this.renderer.showCutLine(m.points);
        break;
      }
      case 'marquee':
        this.moveMarquee(m, local);
        break;
      case 'nodes':
        this.moveNodes(m, e);
        break;
      case 'ann':
        this.moveAnn(m, e);
        break;
      case 'connect':
        this.moveConnect(m, e);
        break;
      default:
    }
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0) this.detachWindow();
      return;
    }
    const m = this.mode;
    this.mode = { t: 'idle' };
    this.el.classList.remove('panning', 'cutting');
    const g = this.app.graph;
    switch (m.t) {
      case 'marquee':
        this.marquee.style.display = 'none';
        if (!m.moved && m.kind === 'set') g.clearSelection();
        break;
      case 'nodes':
        this.finishNodes(m, e);
        break;
      case 'ann':
        this.renderer.setGuides([], []);
        g.commitAnnotationEdit(m.id, m.rect, m.nodes, m.resize ? 'Resize' : 'Move Annotation');
        break;
      case 'connect':
        this.finishConnect(m, e);
        break;
      case 'cut': {
        this.renderer.showCutLine([]);
        if (m.points.length > 1) {
          const ids = this.renderer.edgeControlPoints().filter((c) => curveCrossesPolyline(sampleBezier(c.pts, 20), m.points)).map((c) => c.id);
          g.removeEdges(ids);
        }
        break;
      }
      default:
    }
    if (m.t !== 'rmb') this.lastRmb = null;
    this.detachWindow();
  }

  /** Abort the running gesture (Escape): restores node positions. */
  private cancelMode(): void {
    const m = this.mode;
    const g = this.app.graph;
    this.mode = { t: 'idle' };
    this.el.classList.remove('panning', 'cutting');
    this.marquee.style.display = 'none';
    this.renderer.hideWire();
    this.renderer.setDropTarget(null);
    this.renderer.setLinking(false);
    this.renderer.setGuides([], []);
    this.renderer.showCutLine([]);
    this.hideTip();
    if (m.t === 'nodes') g.moveLive(m.start);
    if (m.t === 'ann') {
      g.model.patchAnnotation(m.id, m.rect);
      g.moveLive(m.nodes);
    }
    this.detachWindow();
  }

  // ---- marquee ----------------------------------------------------------------------------------------------------

  private moveMarquee(m: Extract<Mode, { t: 'marquee' }>, local: Pt): void {
    if (!m.moved && Math.hypot(local.x - m.start.x, local.y - m.start.y) < DRAG_THRESHOLD) return;
    m.moved = true;
    const x0 = Math.min(m.start.x, local.x);
    const y0 = Math.min(m.start.y, local.y);
    const x1 = Math.max(m.start.x, local.x);
    const y1 = Math.max(m.start.y, local.y);
    Object.assign(this.marquee.style, { display: 'block', left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    const v = this.renderer.view;
    const inside = this.renderer.visibleNodes().filter((n) => {
      const sx = n.x * v.k + v.x;
      const sy = n.y * v.k + v.y;
      return sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
    }).map((n) => n.id);
    const g = this.app.graph;
    if (m.kind === 'set') g.setSelection(inside);
    else if (m.kind === 'add') g.setSelection([...m.base, ...inside]);
    else {
      const set = new Set(m.base);
      for (const id of inside) {
        if (set.has(id)) set.delete(id);
        else set.add(id);
      }
      g.setSelection([...set]);
    }
  }

  // ---- node dragging ------------------------------------------------------------------------------------------------

  private beginNodeDrag(e: PointerEvent, id: string, additive: boolean, world: Pt): void {
    const g = this.app.graph;
    this.renderer.setSelectedEdge(null);
    this.renderer.setSelectedAnn(null);
    let toggleOnUp = false;
    if (!g.getSelection().includes(id)) g.select([id], additive ? 'add' : 'set');
    else if (additive) toggleOnUp = true;
    const model = g.model;
    const ids = g.getSelection().filter((sid) => {
      const n = model.getNode(sid);
      return n !== undefined && !n.locked && model.isHierarchyNode(n);
    });
    const start = new Map<string, Pt>();
    for (const sid of ids) {
      const n = model.getNode(sid);
      if (n) start.set(sid, { x: n.x, y: n.y });
    }
    this.mode = { t: 'nodes', id, ids, startWorld: world, start, startClient: { x: e.clientX, y: e.clientY }, moved: false, toggleOnUp, additive };
    this.attachWindow();
  }

  /** Nodes that must not receive a reparent drop: the dragged ones and the primary's whole branch. */
  private reparentExclusions(m: Extract<Mode, { t: 'nodes' }>): Set<string> {
    const ex = new Set(m.ids);
    for (const d of this.app.graph.model.descendants(m.id)) ex.add(d.id);
    ex.add(m.id);
    return ex;
  }

  private moveNodes(m: Extract<Mode, { t: 'nodes' }>, e: PointerEvent): void {
    if (!m.moved && Math.hypot(e.clientX - m.startClient.x, e.clientY - m.startClient.y) < DRAG_THRESHOLD) return;
    if (!m.start.has(m.id)) return; // locked: selection only
    m.moved = true;
    const g = this.app.graph;
    const world = this.renderer.clientToWorld(e.clientX, e.clientY);
    const prim = m.start.get(m.id) as Pt;
    let dx = world.x - m.startWorld.x;
    let dy = world.y - m.startWorld.y;
    let nx = prim.x + dx;
    let ny = prim.y + dy;
    const guideX: number[] = [];
    const guideY: number[] = [];
    if (!e.shiftKey) {
      if (g.settings.snapToGrid) {
        const gs = g.settings.gridSize;
        nx = Math.round(nx / gs) * gs;
        ny = Math.round(ny / gs) * gs;
      } else {
        const thr = SNAP_PX / this.renderer.view.k;
        let bx = thr;
        let by = thr;
        for (const n of this.renderer.visibleNodes()) {
          if (m.start.has(n.id)) continue;
          if (Math.abs(n.x - nx) < bx) {
            bx = Math.abs(n.x - nx);
            guideX[0] = n.x;
          }
          if (Math.abs(n.y - ny) < by) {
            by = Math.abs(n.y - ny);
            guideY[0] = n.y;
          }
        }
        if (guideX.length > 0) nx = guideX[0] as number;
        if (guideY.length > 0) ny = guideY[0] as number;
      }
    }
    dx = nx - prim.x;
    dy = ny - prim.y;
    this.renderer.setGuides(guideX, guideY);
    const positions = new Map<string, Pt>();
    for (const [id, p] of m.start) positions.set(id, { x: p.x + dx, y: p.y + dy });
    g.moveLive(positions);

    if (e.altKey) {
      const target = this.renderer.nodeAtClient(e.clientX, e.clientY, this.reparentExclusions(m));
      if (target) {
        const ok = g.model.findPortPair(target, m.id, 'hierarchy', true) !== null;
        this.renderer.setDropTarget(target, ok ? 'ok' : 'bad');
      } else this.renderer.setDropTarget(null);
    } else this.renderer.setDropTarget(null);
  }

  private finishNodes(m: Extract<Mode, { t: 'nodes' }>, e: PointerEvent): void {
    const g = this.app.graph;
    this.renderer.setGuides([], []);
    this.renderer.setDropTarget(null);
    if (!m.moved) {
      if (m.toggleOnUp) g.select([m.id], 'toggle');
      else if (!m.additive && g.getSelection().length > 1) g.select([m.id]);
      return;
    }
    if (e.altKey) {
      const target = this.renderer.nodeAtClient(e.clientX, e.clientY, this.reparentExclusions(m));
      if (target && g.model.findPortPair(target, m.id, 'hierarchy', true)) {
        g.moveLive(m.start);
        g.reparentAndPlace(m.id, target);
        return;
      }
    }
    g.commitMove(m.start);
  }

  // ---- annotations ------------------------------------------------------------------------------------------------

  private beginAnnDrag(id: string, resize: boolean, world: Pt): void {
    const g = this.app.graph;
    const a = g.model.getAnnotation(id);
    if (!a) return;
    g.clearSelection();
    this.renderer.setSelectedEdge(null);
    this.renderer.setSelectedAnn(id);
    const nodes = new Map<string, Pt>();
    if (!resize && a.kind === 'group') {
      for (const n of g.model.hierarchyNodes()) {
        if (!n.locked && n.x >= a.x && n.x <= a.x + a.w && n.y >= a.y && n.y <= a.y + a.h) nodes.set(n.id, { x: n.x, y: n.y });
      }
    }
    this.mode = { t: 'ann', id, resize, startWorld: world, rect: { x: a.x, y: a.y, w: a.w, h: a.h }, nodes, moved: false };
    this.attachWindow();
  }

  private moveAnn(m: Extract<Mode, { t: 'ann' }>, e: PointerEvent): void {
    const g = this.app.graph;
    const world = this.renderer.clientToWorld(e.clientX, e.clientY);
    const dx = world.x - m.startWorld.x;
    const dy = world.y - m.startWorld.y;
    if (!m.moved && Math.hypot(dx, dy) * this.renderer.view.k < DRAG_THRESHOLD) return;
    m.moved = true;
    if (m.resize) g.model.patchAnnotation(m.id, { w: Math.max(60, m.rect.w + dx), h: Math.max(40, m.rect.h + dy) });
    else {
      g.model.patchAnnotation(m.id, { x: m.rect.x + dx, y: m.rect.y + dy });
      const pos = new Map<string, Pt>();
      for (const [id, p] of m.nodes) pos.set(id, { x: p.x + dx, y: p.y + dy });
      g.moveLive(pos);
    }
  }

  // ---- connecting -------------------------------------------------------------------------------------------------

  private beginConnect(e: PointerEvent, nodeId: string, side: 'in' | 'out'): void {
    const model = this.app.graph.model;
    const node = model.getNode(nodeId);
    const def = node && model.getDef(node);
    const port = def && (side === 'out' ? hierarchyOut(def) : hierarchyIn(def));
    if (!port) return;
    this.app.graph.select([nodeId]);
    this.renderer.setLinking(true);
    this.mode = { t: 'connect', anchor: { nodeId, portId: port.id }, side, edge: port.edge, startClient: { x: e.clientX, y: e.clientY }, target: null, check: null };
    this.attachWindow();
  }

  /** Resolve (and validate) a connection between the anchor port and any compatible port on `targetId`. */
  private resolve(m: Extract<Mode, { t: 'connect' }>, targetId: string): { from: PortRef; to: PortRef; res: ConnectCheck } {
    const model = this.app.graph.model;
    const a = model.getNode(m.anchor.nodeId);
    const t = model.getNode(targetId);
    const adef = a && model.getDef(a);
    const tdef = t && model.getDef(t);
    const bad = (reason: string): { from: PortRef; to: PortRef; res: ConnectCheck } => ({ from: m.anchor, to: m.anchor, res: { ok: false, reason, replaced: [] } });
    if (!adef || !tdef) return bad('Unknown node type');
    const ports = m.side === 'out' ? matchPorts(adef, tdef, m.edge, m.anchor.portId) : matchPorts(tdef, adef, m.edge, undefined, m.anchor.portId);
    if (!ports) return bad('These nodes cannot be connected');
    const from: PortRef = m.side === 'out' ? m.anchor : { nodeId: targetId, portId: ports.out.id };
    const to: PortRef = m.side === 'out' ? { nodeId: targetId, portId: ports.in.id } : m.anchor;
    return { from, to, res: model.canConnect(from, to) };
  }

  private moveConnect(m: Extract<Mode, { t: 'connect' }>, e: PointerEvent): void {
    const r = this.renderer;
    const anchorPos = r.portPosition(m.anchor.nodeId, m.side) as Pt;
    const exclude = new Set([m.anchor.nodeId]);
    const target = r.nodeAtClient(e.clientX, e.clientY, exclude) ?? r.nearestNode(e.clientX, e.clientY, CONNECT_SNAP_PX, exclude);
    let end = r.clientToWorld(e.clientX, e.clientY);
    let state: WireState = 'neutral';
    m.target = target;
    m.check = null;
    if (target) {
      const c = this.resolve(m, target);
      m.check = c;
      state = c.res.ok ? 'valid' : 'invalid';
      r.setDropTarget(target, c.res.ok ? 'ok' : 'bad');
      if (c.res.ok) end = r.portPosition(target, m.side === 'out' ? 'in' : 'out') ?? end;
      this.showTip(e, c.res.ok ? (c.res.replaced.length > 0 ? 'Reparent' : 'Connect') : (c.res.reason ?? ''));
    } else {
      r.setDropTarget(null);
      this.hideTip();
    }
    r.showWire(anchorPos, end, m.side === 'out', state);
  }

  private finishConnect(m: Extract<Mode, { t: 'connect' }>, e: PointerEvent): void {
    const r = this.renderer;
    const g = this.app.graph;
    r.hideWire();
    r.setDropTarget(null);
    r.setLinking(false);
    this.hideTip();
    if (m.check) {
      if (m.check.res.ok) {
        g.connect(m.check.from, m.check.to);
        const other = m.side === 'out' ? m.check.to.nodeId : m.check.from.nodeId;
        this.ensureVisible(other);
      } else this.app.notify(m.check.res.reason ?? 'Cannot connect.');
      return;
    }
    if (Math.hypot(e.clientX - m.startClient.x, e.clientY - m.startClient.y) < 10) return;
    // Dropped on empty space: offer the node types that fit this port.
    const model = g.model;
    const a = model.getNode(m.anchor.nodeId);
    const adef = a && model.getDef(a);
    if (!adef) return;
    const defs = listNodeDefs().filter((d) => {
      if (!g.canAdd(d.type)) return false;
      return (m.side === 'out' ? matchPorts(adef, d, m.edge, m.anchor.portId) : matchPorts(d, adef, m.edge, undefined, m.anchor.portId)) !== null;
    });
    if (defs.length === 0) return;
    const world = r.clientToWorld(e.clientX, e.clientY);
    this.popup(defs, { x: e.clientX, y: e.clientY }, { nodeId: m.anchor.nodeId, portId: m.anchor.portId, side: m.side }, world);
  }

  // ---- tooltip ----------------------------------------------------------------------------------------------------

  private showTip(e: PointerEvent, text: string): void {
    if (!text) {
      this.hideTip();
      return;
    }
    const p = this.local(e);
    this.tip.textContent = text;
    this.tip.style.display = 'block';
    this.tip.style.left = `${p.x + 14}px`;
    this.tip.style.top = `${p.y + 14}px`;
  }

  private hideTip(): void {
    this.tip.style.display = 'none';
  }

  // ---- wheel / dblclick / context ------------------------------------------------------------------------------------

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.cancelAnim();
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const factor = Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0016));
    const p = this.local(e);
    const v = zoomAt(this.renderer.view, p.x, p.y, factor);
    this.renderer.setView(v);
  }

  private onDblClick(e: MouseEvent): void {
    const hit = this.renderer.hit(e.target);
    if (hit.kind === 'node' || hit.kind === 'port') this.startRename(hit.id);
    else if (hit.kind === 'ann') this.startEditAnnotation(hit.id);
    else if (hit.kind === 'none') this.openAddNode({ x: e.clientX, y: e.clientY }, undefined, this.renderer.clientToWorld(e.clientX, e.clientY));
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    if (this.lastRmb?.panned) {
      this.lastRmb = null;
      return;
    }
    const hit = this.lastRmb?.hit ?? this.renderer.hit(e.target);
    this.lastRmb = null;
    const screen = { x: e.clientX, y: e.clientY };
    const world = this.renderer.clientToWorld(e.clientX, e.clientY);
    const g = this.app.graph;
    let items;
    if (hit.kind === 'node' || hit.kind === 'port') items = nodeContextMenu(this, hit.id, screen);
    else if (hit.kind === 'edge') {
      g.clearSelection();
      this.renderer.setSelectedEdge(hit.id);
      items = edgeContextMenu(this, hit.id);
    } else if (hit.kind === 'ann') items = annotationContextMenu(this, hit.id);
    else items = canvasContextMenu(this, screen, world);
    if (items.length > 0) showMenu(items, screen);
  }

  // ---- add / rename -----------------------------------------------------------------------------------------------

  private popup(defs: NodeDef[], screen: Pt, anchor: AddNodeOptions['anchor'] | undefined, world: Pt | undefined, exact = world !== undefined): void {
    showAddNodePopup({
      x: screen.x,
      y: screen.y,
      defs,
      onPick: (def) => {
        const node = this.app.graph.addNode(def.type, {
          anchor,
          x: world?.x ?? (anchor ? undefined : this.viewCenterWorld().x),
          y: world?.y ?? (anchor ? undefined : this.viewCenterWorld().y),
          exact: exact && world !== undefined,
        });
        if (node) this.ensureVisible(node.id);
        this.renderer.svg.focus({ preventScroll: true });
      },
      onClose: () => this.renderer.svg.focus({ preventScroll: true }),
    });
  }

  openAddNode(screen?: Pt, anchor?: AddNodeOptions['anchor'], world?: Pt): void {
    const g = this.app.graph;
    const rect = this.el.getBoundingClientRect();
    const at = screen ?? this.lastClient ?? { x: rect.left + rect.width / 2 - 100, y: rect.top + 40 };
    let useAnchor = anchor;
    if (!useAnchor && !world) {
      const sel = g.getSelection();
      const only = sel.length === 1 ? sel[0] : undefined;
      if (only && g.model.getNode(only) && g.model.isHierarchyNode(g.model.getNode(only) as NonNullable<ReturnType<typeof g.model.getNode>>)) useAnchor = { nodeId: only };
    }
    let defs: NodeDef[];
    if (useAnchor && !useAnchor.side) {
      defs = compatibleDefs(this.app, useAnchor.nodeId);
      if (defs.length === 0) {
        useAnchor = undefined;
        defs = compatibleDefs(this.app);
      }
    } else if (useAnchor?.side) {
      const model = g.model;
      const a = model.getNode(useAnchor.nodeId);
      const adef = a && model.getDef(a);
      const side = useAnchor.side;
      const pid = useAnchor.portId;
      defs = listNodeDefs().filter((d) => g.canAdd(d.type) && !!adef && (side === 'out' ? matchPorts(adef, d, undefined, pid) : matchPorts(d, adef, undefined, undefined, pid)) !== null);
    } else defs = compatibleDefs(this.app);
    this.popup(defs, at, useAnchor, world);
  }

  startRename(nodeId: string): void {
    const g = this.app.graph;
    const node = g.model.getNode(nodeId);
    const rect = this.renderer.nodeScreenRect(nodeId);
    if (!node || !rect || node.locked) return;
    const box = this.el.getBoundingClientRect();
    const input = h('input', 'kt-field kt-grename');
    input.value = node.name;
    input.setAttribute('aria-label', 'Node name');
    input.style.left = `${rect.left - box.left + rect.width / 2 - 70}px`;
    input.style.top = `${rect.top - box.top - 4}px`;
    this.openEditor(input, (v) => g.rename(nodeId, v));
  }

  startEditAnnotation(annId: string): void {
    const g = this.app.graph;
    const a = g.model.getAnnotation(annId);
    const rect = this.renderer.annScreenRect(annId);
    if (!a || !rect) return;
    const box = this.el.getBoundingClientRect();
    const multi = a.kind === 'comment';
    const input = multi ? h('textarea', 'kt-field kt-grename multi') : h('input', 'kt-field kt-grename');
    input.value = a.text;
    input.style.left = `${rect.left - box.left}px`;
    input.style.top = `${rect.top - box.top}px`;
    input.style.width = `${Math.max(120, rect.width)}px`;
    if (multi) input.style.height = `${Math.max(60, rect.height)}px`;
    this.openEditor(input, (v) => {
      if (v !== a.text) g.patchAnnotation(annId, { text: v }, undefined, 'Edit Text');
    }, multi);
  }

  private openEditor(input: HTMLInputElement | HTMLTextAreaElement, commit: (value: string) => void, multiline = false): void {
    this.closeEditor();
    this.editor = input;
    let done = false;
    const finish = (apply: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value;
      this.closeEditor();
      if (apply) commit(value);
      this.renderer.svg.focus({ preventScroll: true });
    };
    input.addEventListener('keydown', (ev: Event) => {
      const e = ev as KeyboardEvent;
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.append(input);
    input.focus();
    input.select();
  }

  private closeEditor(): void {
    const ed = this.editor;
    this.editor = null;
    ed?.remove();
  }

  // ---- keyboard ---------------------------------------------------------------------------------------------------

  private onKey(e: KeyboardEvent): void {
    if (isTextTarget(e.target)) return;
    const g = this.app.graph;
    const stop = (): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey) {
      this.spaceDown = true;
      this.el.classList.add('space');
      stop();
      return;
    }
    if (e.key === 'Escape') {
      if (this.mode.t !== 'idle') this.cancelMode();
      else if (this.renderer.edgeSelection || this.renderer.annSelection) {
        this.renderer.setSelectedEdge(null);
        this.renderer.setSelectedAnn(null);
      } else g.clearSelection();
      closeActiveMenu();
      stop();
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && g.getSelection().length === 0) {
      const edge = this.renderer.edgeSelection;
      const ann = this.renderer.annSelection;
      if (edge) {
        this.renderer.setSelectedEdge(null);
        g.removeEdges([edge]);
        stop();
        return;
      }
      if (ann) {
        this.renderer.setSelectedAnn(null);
        g.removeAnnotation(ann);
        stop();
        return;
      }
    }
    if (e.key.startsWith('Arrow') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const step = g.settings.snapToGrid ? g.settings.gridSize : e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      g.nudgeSelection(dx, dy);
      stop();
      return;
    }
    if (e.key === 'Home' && !e.ctrlKey && !e.metaKey) {
      this.fit();
      stop();
      return;
    }
    for (const cmd of this.app.commands.list()) {
      if (cmd.scope !== 'graph' || !cmd.shortcut) continue;
      if (matchesShortcut(e, parseShortcut(cmd.shortcut))) {
        if (cmd.enabled?.() ?? true) cmd.run();
        stop();
        return;
      }
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    if (e.key === ' ') {
      this.spaceDown = false;
      this.el.classList.remove('space');
    }
    if (e.key.startsWith('Arrow')) this.app.graph.endGesture();
  }

  // ---- toolbar helpers ----------------------------------------------------------------------------------------------

  showActionsMenu(anchor: HTMLElement): void {
    showMenu(actionsMenu(this), anchor);
  }

  showSettingsMenu(anchor: HTMLElement): void {
    showMenu(settingsMenu(this), anchor);
  }
}
