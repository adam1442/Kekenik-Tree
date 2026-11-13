import { uid } from '@/core/id';
import { clamp, type Rect } from '@/core/math';
import { h, iconButton } from '../components/dom';
import { FloatingWindow } from '../components/floatingWindow';
import { showMenu, type MenuItem } from '../components/menu';
import { icon } from '../icons/icons';
import {
  collectGroups,
  detachPanel,
  findGroup,
  findGroupById,
  findParent,
  insertIntoGroup,
  isPanelOpen,
  newGroup,
  splitGroup,
} from './layoutOps';
import { getPanelDef, type PanelContext, type PanelInstance } from './panelRegistry';
import type { DockGroup, DockLayout, DockNode, DockSplit, DropZone, FloatingPanel } from './types';

interface Instance {
  host: HTMLElement;
  inst: PanelInstance;
}

interface DropTarget {
  /** null = the dock area is empty and the panel becomes the root group. */
  groupId: string | null;
  zone: DropZone | 'tabs';
  index?: number;
  /** Preview rectangle in viewport (client) coordinates. */
  rect: Rect;
  /** Dropping here would change nothing. */
  noop?: boolean;
}

const EDGE = 0.25;

/**
 * DockManager — renders a DockLayout as nested splits + tab groups, hosts floating panels, and handles
 * drag & drop docking, splitters, maximize/collapse. Panel DOM hosts are created once per panel and only
 * re-parented, so panel state (WebGL contexts, scroll state in model, etc.) survives every layout change.
 */
export class DockManager {
  readonly element: HTMLDivElement;
  private readonly treeEl: HTMLDivElement;
  private readonly floatLayer: HTMLDivElement;
  private readonly preview: HTMLDivElement;
  private layout: DockLayout;
  private readonly instances = new Map<string, Instance>();
  private readonly windows = new Map<string, FloatingWindow>();
  private readonly groupEls = new Map<string, HTMLElement>();
  private hoverGroup: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly resizeObserver: ResizeObserver;

  constructor(layout: DockLayout) {
    this.layout = structuredClone(layout);
    this.treeEl = h('div', 'kt-dock-tree');
    this.floatLayer = h('div', 'kt-fw-layer');
    this.element = h('div', 'kt-dock', this.treeEl, this.floatLayer);
    this.preview = h('div', 'kt-drop-preview');
    this.preview.style.display = 'none';
    document.body.append(this.preview);
    this.element.addEventListener('pointerleave', () => {
      this.hoverGroup = null;
    });
    this.resizeObserver = new ResizeObserver(() => this.windows.forEach((w) => w.refit()));
    this.resizeObserver.observe(this.element);
    this.render();
  }

  // ---------------------------------------------------------------- public API

  /** Deep copy of the current layout (safe to serialise). */
  getLayout(): DockLayout {
    return structuredClone(this.layout);
  }

  setLayout(layout: DockLayout): void {
    this.layout = structuredClone(layout);
    this.render();
    this.emitChange();
  }

  onDidChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isOpen(panelId: string): boolean {
    return isPanelOpen(this.layout, panelId);
  }

  isFloating(panelId: string): boolean {
    return this.layout.floating.some((f) => f.panelId === panelId);
  }

  openPanel(panelId: string): void {
    const def = getPanelDef(panelId);
    if (!def) return;
    const l = this.layout;
    const group = findGroup(l, panelId);
    if (group) {
      group.active = panelId;
      group.collapsed = false;
      this.render();
      this.emitChange();
      return;
    }
    const fp = l.floating.find((f) => f.panelId === panelId);
    if (fp) {
      fp.minimized = false;
      const win = this.windows.get(panelId);
      win?.setMinimized(false, false);
      win?.focus();
      this.emitChange();
      return;
    }
    if (def.defaultDock === 'float') this.floatPanel(panelId);
    else {
      this.placeDefault(panelId);
      this.render();
      this.emitChange();
    }
  }

  closePanel(panelId: string): void {
    if (getPanelDef(panelId)?.closable === false) return;
    detachPanel(this.layout, panelId);
    this.render();
    this.emitChange();
  }

  togglePanel(panelId: string): void {
    if (this.isOpen(panelId)) this.closePanel(panelId);
    else this.openPanel(panelId);
  }

  floatPanel(panelId: string, rect?: Rect): void {
    const l = this.layout;
    if (l.floating.some((f) => f.panelId === panelId)) return;
    const def = getPanelDef(panelId);
    const size = def?.floatSize ?? { w: 380, h: 460 };
    const group = findGroup(l, panelId);
    const gEl = group ? this.groupEls.get(group.id) : undefined;
    const base = this.element.getBoundingClientRect();
    let r: Rect = { x: 60 + l.floating.length * 24, y: 60 + l.floating.length * 24, w: size.w, h: size.h };
    if (gEl) {
      const gr = gEl.getBoundingClientRect();
      r = { x: gr.left - base.left + 24, y: gr.top - base.top + 24, w: size.w, h: size.h };
    }
    const home = detachPanel(l, panelId) ?? undefined;
    const fp: FloatingPanel = { id: uid('fp'), panelId, rect: rect ?? r, minimized: false, maximized: false };
    if (home) fp.home = home;
    l.floating.push(fp);
    this.render();
    this.emitChange();
  }

  dockPanel(panelId: string): void {
    const l = this.layout;
    const idx = l.floating.findIndex((f) => f.panelId === panelId);
    if (idx < 0) return;
    const [fp] = l.floating.splice(idx, 1) as [FloatingPanel];
    const home = fp.home ? findGroupById(l, fp.home.groupId) : null;
    if (home) insertIntoGroup(home, panelId, fp.home?.index);
    else this.placeDefault(panelId);
    this.render();
    this.emitChange();
  }

  toggleFloat(panelId: string): void {
    if (this.isFloating(panelId)) this.dockPanel(panelId);
    else this.floatPanel(panelId);
  }

  /** Maximize/restore a dock group (default: the hovered group, else the viewport's). */
  toggleMaximize(groupId?: string): void {
    const l = this.layout;
    const id = groupId ?? this.hoverGroup ?? findGroup(l, 'viewport')?.id;
    if (!id || !findGroupById(l, id)) return;
    l.maximizedGroup = l.maximizedGroup === id ? null : id;
    this.render();
    this.emitChange();
  }

  toggleCollapse(groupId: string): void {
    const g = findGroupById(this.layout, groupId);
    if (!g) return;
    g.collapsed = !g.collapsed;
    this.render();
    this.emitChange();
  }

  showPanelMenu(panelId: string, at: { x: number; y: number } | HTMLElement): void {
    const l = this.layout;
    const def = getPanelDef(panelId);
    const floating = this.isFloating(panelId);
    const group = findGroup(l, panelId);
    const win = this.windows.get(panelId);
    const maximized = floating ? (win?.isMaximized() ?? false) : group ? l.maximizedGroup === group.id : false;
    const canCollapse = !!group && findParent(l.root, group).parent?.dir === 'column';
    const items: MenuItem[] = [
      { label: floating ? 'Dock' : 'Float', run: () => this.toggleFloat(panelId) },
      {
        label: maximized ? 'Restore' : 'Maximize',
        shortcut: 'Shift+Space',
        run: () => {
          if (floating) win?.setMaximized(!maximized);
          else if (group) this.toggleMaximize(group.id);
        },
      },
      {
        label: group?.collapsed ? 'Expand' : 'Collapse',
        disabled: !canCollapse,
        run: () => group && this.toggleCollapse(group.id),
      },
      { separator: true },
      { label: 'Close', disabled: def?.closable === false, run: () => this.closePanel(panelId) },
    ];
    showMenu(items, at);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.windows.forEach((w) => w.dispose());
    this.windows.clear();
    this.instances.forEach((i) => i.inst.dispose?.());
    this.instances.clear();
    this.preview.remove();
    this.listeners.clear();
    this.element.remove();
  }

  // ---------------------------------------------------------------- rendering

  private emitChange(): void {
    for (const fn of [...this.listeners]) fn();
  }

  private ensureInstance(panelId: string): Instance | null {
    const existing = this.instances.get(panelId);
    if (existing) return existing;
    const def = getPanelDef(panelId);
    if (!def) return null;
    const host = h('div', 'kt-panel-host');
    host.dataset.panel = panelId;
    const ctx: PanelContext = {
      panelId,
      startDrag: (e) => this.beginDrag(panelId, e),
      showMenu: (e) => {
        e.preventDefault();
        this.showPanelMenu(panelId, { x: e.clientX, y: e.clientY });
      },
      toggleFloat: () => this.toggleFloat(panelId),
      toggleMaximize: () => {
        const win = this.windows.get(panelId);
        if (win) win.setMaximized(!win.isMaximized());
        else this.toggleMaximize(findGroup(this.layout, panelId)?.id);
      },
      isFloating: () => this.isFloating(panelId),
    };
    const created: Instance = { host, inst: {} };
    this.instances.set(panelId, created);
    created.inst = def.component(host, ctx) ?? {};
    return created;
  }

  private render(): void {
    this.groupEls.clear();
    this.treeEl.replaceChildren();
    if (this.layout.root) this.treeEl.append(this.buildNode(this.layout.root));
    else this.treeEl.append(h('div', 'kt-dock-empty', 'No docked panels — drop a panel here'));
    const max = this.layout.maximizedGroup;
    if (max) this.groupEls.get(max)?.classList.add('kt-maximized');
    this.syncFloating();
    for (const [id, ins] of [...this.instances]) {
      if (isPanelOpen(this.layout, id)) continue;
      ins.inst.dispose?.();
      ins.host.remove();
      this.instances.delete(id);
    }
  }

  private buildNode(node: DockNode): HTMLElement {
    if (node.kind === 'group') return this.buildGroup(node);
    const el = h('div', `kt-split kt-split-${node.dir}`);
    const childEls: HTMLElement[] = [];
    node.children.forEach((child, i) => {
      const ce = this.buildNode(child);
      const collapsed = child.kind === 'group' && child.collapsed === true && node.dir === 'column';
      ce.style.flex = collapsed ? '0 0 auto' : `${node.sizes[i] ?? 1} 1 0px`;
      childEls.push(ce);
      if (i > 0) el.append(this.buildSplitter(node, i - 1, childEls));
      el.append(ce);
    });
    return el;
  }

  private buildSplitter(node: DockSplit, i: number, childEls: HTMLElement[]): HTMLElement {
    const horiz = node.dir === 'row';
    const sp = h('div', `kt-splitter kt-splitter-${node.dir}`);
    const apply = (): void => {
      (childEls[i] as HTMLElement).style.flex = `${node.sizes[i]} 1 0px`;
      (childEls[i + 1] as HTMLElement).style.flex = `${node.sizes[i + 1]} 1 0px`;
    };
    const minOf = (el: HTMLElement): number => {
      const cs = getComputedStyle(el);
      return parseFloat(horiz ? cs.minWidth : cs.minHeight) || 60;
    };
    sp.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const a = childEls[i] as HTMLElement;
      const b = childEls[i + 1] as HTMLElement;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const sizeA = horiz ? ra.width : ra.height;
      const total = sizeA + (horiz ? rb.width : rb.height);
      const frac = (node.sizes[i] ?? 0) + (node.sizes[i + 1] ?? 0);
      const minA = minOf(a);
      const minB = minOf(b);
      const start = horiz ? e.clientX : e.clientY;
      sp.classList.add('active');
      document.body.classList.add(horiz ? 'kt-resizing-col' : 'kt-resizing-row');
      const move = (ev: PointerEvent): void => {
        const d = (horiz ? ev.clientX : ev.clientY) - start;
        const na = clamp(sizeA + d, minA, Math.max(minA, total - minB));
        node.sizes[i] = (na / total) * frac;
        node.sizes[i + 1] = frac - (node.sizes[i] as number);
        apply();
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        sp.classList.remove('active');
        document.body.classList.remove('kt-resizing-col', 'kt-resizing-row');
        this.emitChange();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    sp.addEventListener('dblclick', () => {
      const frac = (node.sizes[i] ?? 0) + (node.sizes[i + 1] ?? 0);
      node.sizes[i] = frac / 2;
      node.sizes[i + 1] = frac / 2;
      apply();
      this.emitChange();
    });
    return sp;
  }

  private buildGroup(group: DockGroup): HTMLElement {
    const el = h('div', 'kt-group');
    el.dataset.group = group.id;
    this.groupEls.set(group.id, el);
    const activeDef = getPanelDef(group.active);
    el.style.minWidth = `${activeDef?.minSize?.w ?? 160}px`;
    el.style.minHeight = `${group.collapsed ? 0 : (activeDef?.minSize?.h ?? 80)}px`;
    if (group.collapsed) el.classList.add('collapsed');
    el.addEventListener('pointerenter', () => {
      this.hoverGroup = group.id;
    });
    const headerless = group.panels.length === 1 && activeDef?.headerless === true;
    if (!headerless) el.append(this.buildHeader(group));
    const body = h('div', 'kt-group-body');
    for (const pid of group.panels) {
      const ins = this.ensureInstance(pid);
      if (!ins) continue;
      ins.host.hidden = pid !== group.active;
      body.append(ins.host);
    }
    el.append(body);
    return el;
  }

  private buildHeader(group: DockGroup): HTMLElement {
    const tabs = h('div', 'kt-tabs');
    for (const pid of group.panels) {
      const def = getPanelDef(pid);
      if (!def) continue;
      const tab = h('div', `kt-tab${pid === group.active ? ' active' : ''}`, h('span', 'kt-tab-label', def.title));
      tab.dataset.panel = pid;
      tab.title = def.title;
      tab.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        this.activate(group, pid);
        this.beginDrag(pid, e);
      });
      tab.addEventListener('dblclick', () => this.toggleFloat(pid));
      tabs.append(tab);
    }
    const actions = h('div', 'kt-header-actions');
    const activeId = (): string => group.active;
    if (group.panels.length > 1) {
      actions.append(
        iconButton(icon('menu', 14), 'Panel menu', (e) => {
          this.showPanelMenu(activeId(), e.currentTarget as HTMLElement);
        }),
      );
    }
    actions.append(iconButton(icon('float', 14), 'Float', () => this.floatPanel(activeId())));
    if (getPanelDef(group.active)?.closable !== false) {
      actions.append(iconButton(icon('close', 14), 'Close', () => this.closePanel(activeId())));
    }
    actions.addEventListener('pointerdown', (e) => e.stopPropagation());
    const header = h('div', 'kt-group-header', tabs, actions);
    header.addEventListener('pointerdown', (e) => {
      if (e.button === 0 && (e.target === header || e.target === tabs)) this.beginDrag(activeId(), e);
    });
    header.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.showPanelMenu(activeId(), { x: e.clientX, y: e.clientY });
    });
    return header;
  }

  private activate(group: DockGroup, panelId: string): void {
    if (group.active === panelId) return;
    group.active = panelId;
    const el = this.groupEls.get(group.id);
    if (!el) return;
    el.querySelectorAll<HTMLElement>('.kt-tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === panelId));
    for (const pid of group.panels) {
      const ins = this.instances.get(pid);
      if (ins) ins.host.hidden = pid !== panelId;
    }
    this.instances.get(panelId)?.inst.onShow?.();
    this.emitChange();
  }

  // ---------------------------------------------------------------- floating

  private syncFloating(): void {
    const live = new Set(this.layout.floating.map((f) => f.panelId));
    for (const [pid, win] of [...this.windows]) {
      if (live.has(pid)) continue;
      win.dispose();
      this.windows.delete(pid);
    }
    for (const fp of this.layout.floating) {
      const ins = this.ensureInstance(fp.panelId);
      if (!ins) continue;
      let win = this.windows.get(fp.panelId);
      if (!win) {
        win = this.createWindow(fp);
        this.windows.set(fp.panelId, win);
      }
      if (ins.host.parentElement !== win.body) {
        ins.host.hidden = false;
        win.body.append(ins.host);
      }
    }
  }

  private createWindow(fp: FloatingPanel): FloatingWindow {
    const pid = fp.panelId;
    const def = getPanelDef(pid);
    const cur = (): FloatingPanel | undefined => this.layout.floating.find((f) => f.panelId === pid);
    return new FloatingWindow({
      title: def?.title ?? pid,
      container: this.floatLayer,
      rect: fp.rect,
      minSize: def?.minSize ?? { w: 220, h: 120 },
      minimized: fp.minimized,
      maximized: fp.maximized,
      className: 'kt-fw-panel',
      extraButtons: [{ icon: 'dock', title: 'Dock', onClick: () => this.dockPanel(pid) }],
      onClose: () => (def?.closable === false ? this.dockPanel(pid) : this.closePanel(pid)),
      onRectChange: (r) => {
        const c = cur();
        if (!c) return;
        c.rect = r;
        this.emitChange();
      },
      onStateChange: (s) => {
        const c = cur();
        if (!c) return;
        c.minimized = s.minimized;
        c.maximized = s.maximized;
        this.emitChange();
      },
      onDragMove: (e) => this.showPreview(e.altKey ? null : this.hitTest(e.clientX, e.clientY, true, pid)),
      onDragEnd: (e, moved) => {
        this.showPreview(null);
        if (!moved || e.altKey) return false;
        const t = this.hitTest(e.clientX, e.clientY, true, pid);
        if (!t || t.noop) return false;
        this.dropPanel(pid, t);
        return true;
      },
      onTitleDoubleClick: () => this.dockPanel(pid),
    });
  }

  // ---------------------------------------------------------------- placement

  private placeDefault(panelId: string): void {
    const l = this.layout;
    const groups = collectGroups(l.root);
    if (groups.length === 0) {
      l.root = newGroup([panelId]);
      return;
    }
    const viewport = groups.find((g) => g.panels.includes('viewport')) ?? (groups[0] as DockGroup);
    switch (getPanelDef(panelId)?.defaultDock ?? 'center') {
      case 'left':
        insertIntoGroup(groups[0] as DockGroup, panelId);
        break;
      case 'right':
        insertIntoGroup(groups[groups.length - 1] as DockGroup, panelId);
        break;
      case 'bottom':
        splitGroup(l, panelId, viewport, 'bottom');
        break;
      default:
        insertIntoGroup(viewport, panelId);
    }
  }

  // ---------------------------------------------------------------- drag & drop

  private beginDrag(panelId: string, e: PointerEvent): void {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragging = false;
    let ghost: HTMLElement | null = null;
    const title = getPanelDef(panelId)?.title ?? panelId;

    const cleanup = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key, true);
      ghost?.remove();
      document.body.classList.remove('kt-dragging');
      this.showPreview(null);
    };
    const move = (ev: PointerEvent): void => {
      if (!dragging) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        dragging = true;
        ghost = h('div', 'kt-drag-ghost', title);
        document.body.append(ghost);
        document.body.classList.add('kt-dragging');
      }
      if (ghost) ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`;
      this.showPreview(ev.altKey ? null : this.hitTest(ev.clientX, ev.clientY, false, panelId));
    };
    const up = (ev: PointerEvent): void => {
      const wasDragging = dragging;
      cleanup();
      if (!wasDragging) return;
      const target = ev.altKey ? null : this.hitTest(ev.clientX, ev.clientY, false, panelId);
      if (target) {
        this.dropPanel(panelId, target);
        return;
      }
      const size = getPanelDef(panelId)?.floatSize ?? { w: 380, h: 460 };
      const base = this.element.getBoundingClientRect();
      this.floatPanel(panelId, { x: ev.clientX - base.left - size.w / 2, y: ev.clientY - base.top - 14, ...size });
    };
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') {
        dragging = false;
        cleanup();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key, true);
  }

  private showPreview(target: DropTarget | null): void {
    const p = this.preview;
    if (!target) {
      p.style.display = 'none';
      return;
    }
    p.style.display = 'block';
    p.classList.toggle('noop', target.noop === true);
    p.style.left = `${target.rect.x}px`;
    p.style.top = `${target.rect.y}px`;
    p.style.width = `${target.rect.w}px`;
    p.style.height = `${target.rect.h}px`;
  }

  /**
   * Resolve the drop target under the pointer.
   * `strict` (floating-window drags) shrinks the centre zone so windows can be placed freely over the dock.
   */
  private hitTest(x: number, y: number, strict: boolean, panelId: string): DropTarget | null {
    const l = this.layout;
    if (!l.root) {
      const r = this.treeEl.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      return { groupId: null, zone: 'center', rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
    }
    for (const [gid, el] of this.groupEls) {
      if (l.maximizedGroup && gid !== l.maximizedGroup) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
      const group = findGroupById(l, gid);
      if (!group) return null;
      return this.zoneFor(group, el, r, x, y, strict, panelId);
    }
    return null;
  }

  private zoneFor(group: DockGroup, el: HTMLElement, r: DOMRect, x: number, y: number, strict: boolean, panelId: string): DropTarget | null {
    const own = group.panels.includes(panelId);
    const header = el.querySelector<HTMLElement>('.kt-group-header');
    if (header) {
      const hr = header.getBoundingClientRect();
      if (y <= hr.bottom) {
        const tabEls = [...header.querySelectorAll<HTMLElement>('.kt-tab')];
        let index = 0;
        tabEls.forEach((t) => {
          const tr = t.getBoundingClientRect();
          if (x > tr.left + tr.width / 2) index += 1;
        });
        return { groupId: group.id, zone: 'tabs', index, rect: { x: hr.left, y: hr.top, w: hr.width, h: hr.height } };
      }
    }
    const rx = (x - r.left) / r.width;
    const ry = (y - r.top) / r.height;
    const dists: [number, Exclude<DropZone, 'center'>][] = [
      [rx, 'left'],
      [1 - rx, 'right'],
      [ry, 'top'],
      [1 - ry, 'bottom'],
    ];
    dists.sort((a, b) => a[0] - b[0]);
    const [dist, side] = dists[0] as [number, Exclude<DropZone, 'center'>];
    const full: Rect = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (dist < EDGE) {
      const rect: Rect =
        side === 'left'
          ? { ...full, w: full.w / 2 }
          : side === 'right'
            ? { ...full, x: full.x + full.w / 2, w: full.w / 2 }
            : side === 'top'
              ? { ...full, h: full.h / 2 }
              : { ...full, y: full.y + full.h / 2, h: full.h / 2 };
      return { groupId: group.id, zone: side, rect, noop: own && group.panels.length === 1 };
    }
    const centred = !strict || (Math.abs(rx - 0.5) < 0.17 && Math.abs(ry - 0.5) < 0.17);
    if (!centred) return null;
    return { groupId: group.id, zone: 'center', rect: full, noop: own };
  }

  private dropPanel(panelId: string, t: DropTarget): void {
    if (t.noop) return;
    const l = this.layout;
    if (t.groupId === null) {
      detachPanel(l, panelId);
      l.root = newGroup([panelId]);
    } else {
      const target = findGroupById(l, t.groupId);
      if (!target) return;
      const src = findGroup(l, panelId);
      if (src === target && (t.zone === 'tabs' || t.zone === 'center')) {
        const from = target.panels.indexOf(panelId);
        let idx = t.zone === 'tabs' ? (t.index ?? target.panels.length) : target.panels.length;
        target.panels.splice(from, 1);
        if (from < idx) idx -= 1;
        target.panels.splice(idx, 0, panelId);
        target.active = panelId;
      } else {
        detachPanel(l, panelId);
        if (t.zone === 'tabs') insertIntoGroup(target, panelId, t.index);
        else if (t.zone === 'center') insertIntoGroup(target, panelId);
        else splitGroup(l, panelId, target, t.zone);
      }
    }
    this.render();
    this.emitChange();
  }
}
