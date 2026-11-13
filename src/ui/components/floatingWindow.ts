import { clamp, type Rect } from '@/core/math';
import { h, iconButton } from './dom';
import { icon } from '../icons/icons';

/**
 * FloatingWindow — the ONE floating-window primitive used by floating dock panels, the Curve editor popup,
 * the Export dialog, Edit Mesh etc. Provides: title bar drag, 8-way resize, z-ordering, minimize/maximize/close,
 * constrain-to-container and edge snapping (hold Alt to disable snapping).
 */
export interface TitleButton {
  icon: string;
  title: string;
  onClick: () => void;
}

export interface FloatingWindowOptions {
  title: string;
  /** Positioned container (e.g. `.kt-fw-layer`). */
  container: HTMLElement;
  rect: Rect;
  minSize?: { w: number; h: number };
  resizable?: boolean;
  minimizable?: boolean;
  maximizable?: boolean;
  closable?: boolean;
  modal?: boolean;
  className?: string;
  minimized?: boolean;
  maximized?: boolean;
  extraButtons?: TitleButton[];
  onClose?: () => void;
  onRectChange?: (rect: Rect) => void;
  onStateChange?: (state: { minimized: boolean; maximized: boolean }) => void;
  onFocus?: () => void;
  /** Called while the title bar is dragged (used to show dock drop zones). */
  onDragMove?: (e: PointerEvent) => void;
  /** Return true if the window was consumed (docked); it will then not emit a rect change. */
  onDragEnd?: (e: PointerEvent, moved: boolean) => boolean;
  onTitleDoubleClick?: () => void;
}

const SNAP = 8;
const TITLE_H = 28;
const siblings = new WeakMap<HTMLElement, Set<FloatingWindow>>();
const zCounters = new WeakMap<HTMLElement, number>();

type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

export class FloatingWindow {
  readonly element: HTMLDivElement;
  readonly titlebar: HTMLDivElement;
  readonly body: HTMLDivElement;
  private titleText: HTMLSpanElement;
  private backdrop: HTMLDivElement | null = null;
  private rect: Rect;
  private restoreRect: Rect | null = null;
  private minimizedFlag = false;
  private maximizedFlag = false;
  private disposed = false;

  constructor(private readonly opts: FloatingWindowOptions) {
    this.rect = { ...opts.rect };
    this.titleText = h('span', 'kt-fw-title-text', opts.title);
    const buttons = h('div', 'kt-fw-buttons');
    for (const b of opts.extraButtons ?? []) buttons.append(iconButton(icon(b.icon, 12), b.title, b.onClick, 'kt-fw-btn'));
    if (opts.minimizable !== false) buttons.append(iconButton(icon('minimize', 12), 'Minimize', () => this.setMinimized(!this.minimizedFlag), 'kt-fw-btn'));
    if (opts.maximizable !== false) buttons.append(iconButton(icon('maximize', 12), 'Maximize', () => this.setMaximized(!this.maximizedFlag), 'kt-fw-btn'));
    if (opts.closable !== false) buttons.append(iconButton(icon('close', 12), 'Close', () => this.close(), 'kt-fw-btn'));
    this.titlebar = h('div', 'kt-fw-title', this.titleText, buttons);
    this.body = h('div', 'kt-fw-body');
    this.element = h('div', `kt-fw ${opts.className ?? ''}`.trim(), this.titlebar, this.body);

    if (opts.resizable !== false) {
      for (const edge of EDGES) {
        const grip = h('div', `kt-fw-rs kt-fw-rs-${edge}`);
        grip.addEventListener('pointerdown', (e) => this.beginResize(e, edge));
        this.element.append(grip);
      }
    }
    this.element.addEventListener('pointerdown', () => this.focus(), true);
    this.titlebar.addEventListener('pointerdown', (e) => this.beginMove(e));
    this.titlebar.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('.kt-fw-buttons')) return;
      if (opts.onTitleDoubleClick) opts.onTitleDoubleClick();
      else if (opts.maximizable !== false) this.setMaximized(!this.maximizedFlag);
    });

    if (opts.modal) {
      this.backdrop = h('div', 'kt-fw-backdrop');
      opts.container.append(this.backdrop);
    }
    opts.container.append(this.element);
    let set = siblings.get(opts.container);
    if (!set) {
      set = new Set();
      siblings.set(opts.container, set);
    }
    set.add(this);

    if (opts.maximized) this.setMaximized(true, false);
    if (opts.minimized) this.setMinimized(true, false);
    this.rect = this.constrain(this.rect);
    this.apply();
    this.focus();
  }

  getRect(): Rect {
    return { ...this.rect };
  }

  isMinimized(): boolean {
    return this.minimizedFlag;
  }
  isMaximized(): boolean {
    return this.maximizedFlag;
  }

  setTitle(title: string): void {
    this.titleText.textContent = title;
  }

  setRect(rect: Rect, notify = false): void {
    this.rect = this.constrain(rect);
    this.apply();
    if (notify) this.opts.onRectChange?.(this.getRect());
  }

  /** Re-clamp after the container changed size. */
  refit(): void {
    if (this.maximizedFlag) this.rect = this.fullRect();
    else this.rect = this.constrain(this.rect);
    this.apply();
  }

  focus(): void {
    const c = this.opts.container;
    const z = (zCounters.get(c) ?? 100) + 1;
    zCounters.set(c, z);
    this.element.style.zIndex = String(z);
    if (this.backdrop) this.backdrop.style.zIndex = String(z - 1);
    this.opts.onFocus?.();
  }

  setMinimized(v: boolean, notify = true): void {
    this.minimizedFlag = v;
    this.element.classList.toggle('minimized', v);
    this.apply();
    if (notify) this.opts.onStateChange?.({ minimized: v, maximized: this.maximizedFlag });
  }

  setMaximized(v: boolean, notify = true): void {
    if (v === this.maximizedFlag) return;
    this.maximizedFlag = v;
    if (v) {
      this.restoreRect = { ...this.rect };
      this.rect = this.fullRect();
    } else if (this.restoreRect) {
      this.rect = this.constrain(this.restoreRect);
    }
    this.element.classList.toggle('maximized', v);
    this.apply();
    if (notify) this.opts.onStateChange?.({ minimized: this.minimizedFlag, maximized: v });
  }

  close(): void {
    if (this.opts.onClose) this.opts.onClose();
    else this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    siblings.get(this.opts.container)?.delete(this);
    this.element.remove();
    this.backdrop?.remove();
  }

  // ---- internals ----

  private fullRect(): Rect {
    return { x: 0, y: 0, w: this.opts.container.clientWidth, h: this.opts.container.clientHeight };
  }

  private minSize(): { w: number; h: number } {
    return this.opts.minSize ?? { w: 200, h: 120 };
  }

  private constrain(r: Rect): Rect {
    const cw = this.opts.container.clientWidth;
    const ch = this.opts.container.clientHeight;
    if (cw === 0 || ch === 0) return { ...r };
    const min = this.minSize();
    const w = clamp(r.w, Math.min(min.w, cw), cw);
    const h = clamp(r.h, Math.min(min.h, ch), ch);
    return { x: clamp(r.x, 0, cw - w), y: clamp(r.y, 0, ch - h), w, h };
  }

  private apply(): void {
    const s = this.element.style;
    s.left = `${this.rect.x}px`;
    s.top = `${this.rect.y}px`;
    s.width = `${this.rect.w}px`;
    s.height = this.minimizedFlag ? `${TITLE_H}px` : `${this.rect.h}px`;
  }

  private snapCandidates(axis: 'x' | 'y'): number[] {
    const c = this.opts.container;
    const out = [0, axis === 'x' ? c.clientWidth : c.clientHeight];
    for (const w of siblings.get(c) ?? []) {
      if (w === this || w.minimizedFlag && axis === 'y') continue;
      const r = w.rect;
      if (axis === 'x') out.push(r.x, r.x + r.w);
      else out.push(r.y, r.y + r.h);
    }
    return out;
  }

  private snapEdge(value: number, cands: number[]): number {
    for (const c of cands) if (Math.abs(value - c) < SNAP) return c;
    return value;
  }

  private beginMove(e: PointerEvent): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.kt-fw-buttons') || this.maximizedFlag) return;
    e.preventDefault();
    const start = { ...this.rect };
    const sx = e.clientX;
    const sy = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      let x = start.x + dx;
      let y = start.y + dy;
      if (!ev.altKey) {
        const xs = this.snapCandidates('x');
        const ys = this.snapCandidates('y');
        const left = this.snapEdge(x, xs);
        x = left !== x ? left : this.snapEdge(x + start.w, xs) - start.w;
        const top = this.snapEdge(y, ys);
        y = top !== y ? top : this.snapEdge(y + start.h, ys) - start.h;
      }
      this.rect = this.constrain({ ...start, x, y });
      this.apply();
      this.opts.onDragMove?.(ev);
    };
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const consumed = this.opts.onDragEnd?.(ev, moved) ?? false;
      if (!consumed && moved) this.opts.onRectChange?.(this.getRect());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  private beginResize(e: PointerEvent, edge: Edge): void {
    if (e.button !== 0 || this.maximizedFlag) return;
    e.preventDefault();
    e.stopPropagation();
    this.focus();
    const start = { ...this.rect };
    const sx = e.clientX;
    const sy = e.clientY;
    const min = this.minSize();
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - sx;
      const dy = ev.clientY - sy;
      const snap = !ev.altKey;
      const xs = snap ? this.snapCandidates('x') : [];
      const ys = snap ? this.snapCandidates('y') : [];
      let { x, y, w, h } = start;
      if (edge.includes('e')) w = Math.max(min.w, this.snapEdge(start.x + start.w + dx, xs) - start.x);
      if (edge.includes('s')) h = Math.max(min.h, this.snapEdge(start.y + start.h + dy, ys) - start.y);
      if (edge.includes('w')) {
        const right = start.x + start.w;
        x = Math.min(this.snapEdge(start.x + dx, xs), right - min.w);
        w = right - x;
      }
      if (edge.includes('n')) {
        const bottom = start.y + start.h;
        y = Math.min(this.snapEdge(start.y + dy, ys), bottom - min.h);
        h = bottom - y;
      }
      this.rect = this.constrain({ x, y, w, h });
      this.apply();
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.opts.onRectChange?.(this.getRect());
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
}
