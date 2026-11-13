import { Raycaster, Vector2, Vector3 } from 'three';
import type { AppContext } from '@/app/context';
import type { SceneModel } from '@/contracts/engine';
import { OverrideEditor } from '@/instances/editor';
import { resolveHandle, type HandleId, type HandleTarget } from '@/instances/mappings';
import { sameInstance, type InstanceRef, type InstanceTransform } from '@/instances/types';
import type { Skeleton } from '@/contracts/skeleton';
import { NodeModeGizmo, type ArcId } from './gizmos/nodeModeGizmo';
import {
  computeInstanceFrame,
  cross,
  lineParamClosestToRay,
  norm,
  planeAngle,
  polylineUClosestToRay,
  rayPlane,
  snap,
  sub,
  wrapAngle,
  type InstanceFrame,
  type V3,
} from './gizmos/nodeModeMath';
import { childInstances, marqueePick, parentInstance, pickInstance, type PickRay, type PickSource } from './picking/instancePicker';
import type { Viewport } from './viewport';

const CLICK_SLOP = 4;
const ARC_HIT_PX = 11;
const SPHERE_HIT_PX = 13;
const DEG = 180 / Math.PI;

interface DragState {
  handle: HandleId;
  primary: InstanceRef;
  refs: InstanceRef[];
  frame: InstanceFrame;
  nodeType: string;
  target: HandleTarget;
  start: Map<number, { transform: InstanceTransform; param: { mode: 'set' | 'offset'; value: number } | null }>;
  angle0: number;
  s0: number;
  u0: number;
  hit0: V3 | null;
  pixel: number;
}

const HANDLE_ORDER: HandleId[] = ['position', 'rotation', 'angle', 'roll', 'length', 'radius', 'bend'];

/**
 * Node mode: click / marquee picking of single instances, hover highlight, keyboard navigation (parent / children /
 * hide / prune) and the orange gizmo that writes `InstanceOverride`s through the OverrideEditor (one undo step per drag).
 */
export class NodeModeController {
  readonly gizmo: NodeModeGizmo;
  readonly editor: OverrideEditor;
  private sources: PickSource[] = [];
  private scene: SceneModel | null = null;
  private active = false;
  private drag: DragState | null = null;
  private click: { x: number; y: number; id: number; shift: boolean; ctrl: boolean } | null = null;
  private marquee: { x0: number; y0: number; el: HTMLDivElement } | null = null;
  private hoverRaf = 0;
  private lastMove: PointerEvent | null = null;
  private readonly ray = new Raycaster();
  private readonly readout: HTMLDivElement;
  private readonly unsubs: (() => void)[] = [];

  constructor(
    private readonly app: AppContext,
    private readonly viewport: Viewport,
    private readonly surface: HTMLElement,
  ) {
    this.editor = new OverrideEditor(app);
    this.gizmo = new NodeModeGizmo(viewport, surface);
    this.readout = document.createElement('div');
    this.readout.className = 'kt-vp-radius-readout kt-vp-node-readout';
    this.readout.hidden = true;
    surface.append(this.readout);
    surface.addEventListener('pointerdown', this.onDown, true);
    surface.addEventListener('pointermove', this.onMove, true);
    surface.addEventListener('pointerup', this.onUp, true);
    surface.addEventListener('pointerleave', this.onLeave);
    document.addEventListener('keydown', this.onKey, true);
    const store = app.store;
    this.unsubs.push(
      store.select((s) => s.editMode, (m) => this.setActive(m === 'node')),
      store.select((s) => s.instanceSelection, () => this.refreshGizmo()),
      store.select((s) => s.selection, (sel) => {
        const cur = store.get().instanceSelection;
        const keep = cur.filter((r) => sel.includes(r.nodeId));
        if (keep.length !== cur.length) this.setSelection(keep, false);
      }),
    );
    this.setActive(store.get().editMode === 'node');
  }

  /** New evaluation result: refresh picking sources and the gizmo frame. */
  setScene(scene: SceneModel | null): void {
    this.scene = scene;
    this.sources = [];
    for (const s of scene?.skeletons ?? []) if (s.instances && s.instances.count > 0) this.sources.push({ nodeId: s.nodeId, skeleton: s.skeleton, table: s.instances });
    const valid = (r: InstanceRef): boolean => this.sources.some((s) => s.nodeId === r.nodeId && this.rowOf(s, r.key) >= 0);
    const cur = this.app.store.get().instanceSelection;
    const keep = this.drag ? cur : cur.filter(valid);
    if (keep.length !== cur.length) this.setSelection(keep, false);
    else this.refreshGizmo();
  }

  getSources(): readonly PickSource[] {
    return this.sources;
  }

  private rowOf(src: PickSource, key: number): number {
    for (let i = 0; i < src.table.count; i++) if (src.table.key[i] === key) return i;
    return -1;
  }

  private setActive(on: boolean): void {
    this.active = on;
    this.surface.classList.toggle('kt-vp-node-mode', on);
    if (!on) {
      this.app.store.set({ instanceHover: null });
      this.gizmo.setTarget(null, new Set());
      this.readout.hidden = true;
    } else this.refreshGizmo();
  }

  // ---- visibility / selection --------------------------------------------------------------------------------------

  private isVisible = (nodeId: string): boolean => {
    const n = this.app.graph.model.getNode(nodeId);
    return n !== undefined && n.enabled && !n.bypass;
  };

  setSelection(refs: InstanceRef[], syncGraph = true): void {
    this.app.store.set({ instanceSelection: refs });
    if (syncGraph && refs.length > 0) this.app.graph.setSelection([...new Set(refs.map((r) => r.nodeId))]);
  }

  private apply(hits: InstanceRef[], mode: 'set' | 'add' | 'toggle'): void {
    const cur = this.app.store.get().instanceSelection;
    let next: InstanceRef[];
    if (mode === 'set') next = hits;
    else if (mode === 'add') next = [...cur, ...hits.filter((h) => !cur.some((c) => sameInstance(c, h)))];
    else {
      next = [...cur];
      for (const h of hits) {
        const i = next.findIndex((c) => sameInstance(c, h));
        if (i >= 0) next.splice(i, 1);
        else next.push(h);
      }
    }
    this.setSelection(next);
  }

  // ---- camera ray helpers ------------------------------------------------------------------------------------------

  private rayOf(e: { clientX: number; clientY: number }): PickRay {
    const r = this.surface.getBoundingClientRect();
    this.ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.viewport.camera);
    const { origin, direction } = this.ray.ray;
    return { origin: [origin.x, origin.y, origin.z], dir: [direction.x, direction.y, direction.z] };
  }

  private pixelScale(): number {
    return (2 * Math.tan((this.viewport.camera.fov * Math.PI) / 360)) / Math.max(1, this.surface.clientHeight);
  }

  private toScreen(p: V3): [number, number] | null {
    const v = new Vector3(...p).project(this.viewport.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [((v.x + 1) / 2) * this.surface.clientWidth, ((1 - v.y) / 2) * this.surface.clientHeight];
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.surface.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // ---- gizmo ------------------------------------------------------------------------------------------------------

  private primary(): InstanceRef | null {
    const sel = this.app.store.get().instanceSelection;
    return sel.length > 0 ? (sel[sel.length - 1] as InstanceRef) : null;
  }

  private parentSkeleton(nodeId: string): Skeleton | null {
    const edge = this.app.graph.model.edges().find((e) => e.kind === 'hierarchy' && e.to.nodeId === nodeId);
    return edge ? (this.scene?.skeletons.find((s) => s.nodeId === edge.from.nodeId)?.skeleton ?? null) : null;
  }

  private frameOf(ref: InstanceRef): { frame: InstanceFrame; nodeType: string } | null {
    const src = this.sources.find((s) => s.nodeId === ref.nodeId);
    const node = this.app.graph.model.getNode(ref.nodeId);
    if (!src || !node) return null;
    const row = this.rowOf(src, ref.key);
    if (row < 0) return null;
    const parent = this.parentSkeleton(ref.nodeId);
    const frame = computeInstanceFrame(src.skeleton, src.table, row, parent ? [parent, src.skeleton] : [src.skeleton]);
    return frame ? { frame, nodeType: node.type } : null;
  }

  private enabledHandles(frame: InstanceFrame, nodeType: string): Set<HandleId> {
    const out = new Set<HandleId>();
    for (const h of HANDLE_ORDER) {
      if (h === 'radius') continue; // radius is edited from the Properties panel (Radius override)
      if (resolveHandle(nodeType, h, { rootLevel: frame.rootLevel })) out.add(h);
    }
    if (frame.parentCandidate !== 0) out.delete('position');
    return out;
  }

  refreshGizmo(): void {
    if (!this.active || this.drag) {
      if (this.drag) this.relayoutDuringDrag();
      else this.gizmo.setTarget(null, new Set());
      return;
    }
    const p = this.primary();
    const f = p ? this.frameOf(p) : null;
    this.gizmo.setTarget(f ? f.frame : null, f ? this.enabledHandles(f.frame, f.nodeType) : new Set());
  }

  private relayoutDuringDrag(): void {
    const d = this.drag;
    if (!d) return;
    const f = this.frameOf(d.primary);
    if (f) this.gizmo.setTarget(f.frame, this.enabledHandles(f.frame, f.nodeType));
  }

  private hitHandle(e: PointerEvent): HandleId | null {
    const f = this.gizmo.target;
    if (!f || !this.active) return null;
    const [mx, my] = this.local(e);
    let best: HandleId | null = null;
    let bestD = Infinity;
    for (const [id, p] of Object.entries(this.gizmo.handlePoints()) as [HandleId, V3][]) {
      const s = this.toScreen(p);
      if (!s) continue;
      const d = Math.hypot(s[0] - mx, s[1] - my) - 4;
      if (d < SPHERE_HIT_PX && d < bestD) {
        best = id;
        bestD = d;
      }
    }
    for (const id of ['rotation', 'angle', 'roll'] as ArcId[]) {
      const pts = this.gizmo.arcWorld(id).map((p) => this.toScreen(p));
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (!a || !b) continue;
        const d = segDistance(mx, my, a, b);
        if (d < ARC_HIT_PX && d < bestD) {
          best = id;
          bestD = d;
        }
      }
    }
    return best;
  }

  private beginDrag(handle: HandleId, e: PointerEvent): boolean {
    const primary = this.primary();
    const info = primary ? this.frameOf(primary) : null;
    if (!primary || !info) return false;
    const target = resolveHandle(info.nodeType, handle, { rootLevel: info.frame.rootLevel });
    if (!target) return false;
    const refs = this.app.store.get().instanceSelection.filter((r) => r.nodeId === primary.nodeId);
    const start = new Map<number, DragState['start'] extends Map<number, infer V> ? V : never>();
    for (const r of refs) {
      const o = this.editor.get(r);
      const pr = target.kind === 'param' ? o?.params[target.id] : undefined;
      start.set(r.key, {
        transform: { ...o?.transform },
        param: pr && typeof pr.value === 'number' && pr.mode !== 'scale' ? { mode: pr.mode, value: pr.value } : null,
      });
    }
    const ray = this.rayOf(e);
    const f = info.frame;
    const d: DragState = { handle, primary, refs, frame: f, nodeType: info.nodeType, target, start, angle0: 0, s0: 1, u0: 0, hit0: null, pixel: this.gizmo.pixelSize };
    if (handle === 'rotation' || handle === 'angle' || handle === 'roll') {
      const af = this.gizmo.arcFrame(handle);
      const axis = handle === 'rotation' ? f.parentAxis : handle === 'roll' ? f.branchDir : norm(cross(f.parentAxis, f.branchDir));
      const hit = af ? rayPlane(ray, af.center, axis) : null;
      if (!af || !hit) return false;
      d.angle0 = planeAngle(hit, af.center, af.u, af.v);
      d.hit0 = hit;
    } else if (handle === 'length') {
      d.s0 = Math.max(1e-4, lineParamClosestToRay(ray, f.origin, norm(sub(f.tip, f.origin))));
    } else if (handle === 'position') {
      const ps = this.parentSkeleton(primary.nodeId);
      if (!ps || f.parentBranch < 0) return false;
      d.u0 = polylineUClosestToRay(ray, ps, f.parentBranch);
    } else if (handle === 'bend') {
      const cam = this.viewport.camera.getWorldDirection(new Vector3());
      d.hit0 = rayPlane(ray, f.mid, [cam.x, cam.y, cam.z]);
      if (!d.hit0) return false;
    }
    this.drag = d;
    this.gizmo.setActive(handle);
    return true;
  }

  private dragTo(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    const ray = this.rayOf(e);
    const f = d.frame;
    const shift = e.shiftKey;
    let text = '';
    const writeTransform = (field: keyof InstanceTransform, value: (start: InstanceTransform) => number): void => {
      this.editor.setTransform(d.refs, field, (r) => value(d.start.get(r.key)?.transform ?? {}), true);
    };
    const writeParam = (id: string, delta: number): void => {
      this.editor.setParam(
        d.refs,
        id,
        d.start.get(d.primary.key)?.param?.mode === 'set' ? 'set' : 'offset',
        (r) => (d.start.get(r.key)?.param?.value ?? 0) + delta,
        true,
      );
    };
    if (d.handle === 'rotation' || d.handle === 'angle' || d.handle === 'roll') {
      const af = this.gizmo.arcFrame(d.handle);
      const axis = d.handle === 'rotation' ? f.parentAxis : d.handle === 'roll' ? f.branchDir : norm(cross(f.parentAxis, f.branchDir));
      const hit = af ? rayPlane(ray, af.center, axis) : null;
      if (!af || !hit) return;
      const delta = snap(wrapAngle(planeAngle(hit, af.center, af.u, af.v) - d.angle0) * DEG, 5, shift);
      if (d.target.kind === 'transform') {
        const field = d.target.field;
        writeTransform(field, (s) => (s[field] ?? 0) + delta);
      } else writeParam(d.target.id, delta);
      text = `${d.handle === 'rotation' ? 'Rotation' : d.handle === 'roll' ? 'Roll' : 'Angle'} ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}°`;
    } else if (d.handle === 'length' && d.target.kind === 'transform') {
      const s = Math.max(1e-4, lineParamClosestToRay(ray, f.origin, norm(sub(f.tip, f.origin))));
      const ratio = snap(s / d.s0, 0.05, shift);
      const field = d.target.field;
      writeTransform(field, (st) => Math.min(20, Math.max(0.03, (st[field] ?? 1) * ratio)));
      text = `Length ×${ratio.toFixed(2)}`;
    } else if (d.handle === 'position' && d.target.kind === 'transform') {
      const ps = this.parentSkeleton(d.primary.nodeId);
      if (!ps) return;
      const du = snap(polylineUClosestToRay(ray, ps, f.parentBranch) - d.u0, 0.02, shift);
      const field = d.target.field;
      writeTransform(field, (st) => Math.min(1, Math.max(-1, (st[field] ?? 0) + du)));
      text = `Position ${du >= 0 ? '+' : ''}${du.toFixed(3)}`;
    } else if (d.handle === 'bend' && d.target.kind === 'param') {
      const cam = this.viewport.camera.getWorldDirection(new Vector3());
      const hit = rayPlane(ray, f.mid, [cam.x, cam.y, cam.z]);
      if (!hit || !d.hit0) return;
      const dz = hit[2] - d.hit0[2];
      const delta = snap(((d.target.perUnit ?? 1) * dz) / Math.max(0.05, f.length), 0.05, shift);
      writeParam(d.target.id, delta);
      text = `${d.target.id} ${delta >= 0 ? '+' : ''}${delta.toFixed(2)}`;
    }
    const [x, y] = this.local(e);
    this.readout.hidden = false;
    this.readout.textContent = text;
    this.readout.style.left = `${x + 16}px`;
    this.readout.style.top = `${y + 12}px`;
    this.viewport.requestRender();
  }

  private endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.editor.commit();
    this.gizmo.setActive(null);
    this.readout.hidden = true;
    this.refreshGizmo();
  }

  // ---- pointer events ----------------------------------------------------------------------------------------------

  private readonly onDown = (e: PointerEvent): void => {
    if (!this.active || e.button !== 0) return;
    const handle = this.hitHandle(e);
    if (handle && this.beginDrag(handle, e)) {
      e.stopImmediatePropagation();
      e.preventDefault();
      this.surface.setPointerCapture(e.pointerId);
      return;
    }
    if (e.altKey) {
      e.stopImmediatePropagation();
      e.preventDefault();
      const [x, y] = this.local(e);
      const el = document.createElement('div');
      el.className = 'kt-vp-marquee';
      this.surface.append(el);
      this.marquee = { x0: x, y0: y, el };
      this.surface.setPointerCapture(e.pointerId);
      return;
    }
    this.click = { x: e.clientX, y: e.clientY, id: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.active) return;
    if (this.drag) {
      e.stopImmediatePropagation();
      this.dragTo(e);
      return;
    }
    if (this.marquee) {
      e.stopImmediatePropagation();
      const [x, y] = this.local(e);
      const m = this.marquee;
      Object.assign(m.el.style, { left: `${Math.min(m.x0, x)}px`, top: `${Math.min(m.y0, y)}px`, width: `${Math.abs(x - m.x0)}px`, height: `${Math.abs(y - m.y0)}px` });
      return;
    }
    if (this.click && Math.hypot(e.clientX - this.click.x, e.clientY - this.click.y) > CLICK_SLOP) this.click = null;
    if (e.buttons === 0) {
      this.lastMove = e;
      if (this.hoverRaf === 0) this.hoverRaf = requestAnimationFrame(() => this.updateHover());
    }
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.active) return;
    if (this.drag) {
      e.stopImmediatePropagation();
      if (this.surface.hasPointerCapture(e.pointerId)) this.surface.releasePointerCapture(e.pointerId);
      this.endDrag();
      return;
    }
    if (this.marquee) {
      e.stopImmediatePropagation();
      const m = this.marquee;
      const [x, y] = this.local(e);
      m.el.remove();
      this.marquee = null;
      if (this.surface.hasPointerCapture(e.pointerId)) this.surface.releasePointerCapture(e.pointerId);
      const hits = marqueePick(this.sources, (px, py, pz) => this.toScreen([px, py, pz]), { x0: m.x0, y0: m.y0, x1: x, y1: y }, this.isVisible);
      this.apply(hits.map((h) => ({ nodeId: h.nodeId, key: h.key })), e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'toggle' : 'set');
      return;
    }
    const c = this.click;
    this.click = null;
    if (!c || c.id !== e.pointerId || Math.hypot(e.clientX - c.x, e.clientY - c.y) > CLICK_SLOP) return;
    const hit = pickInstance(this.sources, this.rayOf(e), { pixelScale: this.pixelScale(), isNodeVisible: this.isVisible });
    if (!hit) {
      if (!c.shift && !c.ctrl) this.setSelection([]);
      return;
    }
    this.apply([{ nodeId: hit.nodeId, key: hit.key }], c.ctrl ? 'toggle' : c.shift ? 'add' : 'set');
  };

  private readonly onLeave = (): void => {
    if (this.active && !this.drag) this.app.store.set({ instanceHover: null });
  };

  private updateHover(): void {
    this.hoverRaf = 0;
    const e = this.lastMove;
    if (!e || !this.active || this.drag || this.marquee) return;
    const handle = this.hitHandle(e);
    this.gizmo.setHover(handle);
    this.surface.style.cursor = handle ? 'pointer' : '';
    const hit = handle ? null : pickInstance(this.sources, this.rayOf(e), { pixelScale: this.pixelScale(), isNodeVisible: this.isVisible });
    const next: InstanceRef | null = hit ? { nodeId: hit.nodeId, key: hit.key } : null;
    const cur = this.app.store.get().instanceHover;
    if ((cur === null) !== (next === null) || (cur && next && !sameInstance(cur, next))) this.app.store.set({ instanceHover: next });
  }

  // ---- keyboard ----------------------------------------------------------------------------------------------------

  private readonly onKey = (e: KeyboardEvent): void => {
    if (!this.active || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const sel = this.app.store.get().instanceSelection;
    if (sel.length === 0) return;
    const eat = (): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    switch (e.key) {
      case 'Escape':
        eat();
        this.setSelection([], false);
        break;
      case 'ArrowUp': {
        eat();
        const parents: InstanceRef[] = [];
        for (const r of sel) {
          const src = this.sources.find((s) => s.nodeId === r.nodeId);
          const p = src ? parentInstance(this.sources, r.nodeId, this.rowOf(src, r.key)) : null;
          if (p) parents.push({ nodeId: p.nodeId, key: p.key });
        }
        if (parents.length > 0) this.setSelection(parents);
        break;
      }
      case 'ArrowDown': {
        eat();
        const kids = sel.flatMap((r) => childInstances(this.sources, r.key)).map((c) => ({ nodeId: c.nodeId, key: c.key }));
        if (kids.length > 0) this.setSelection(kids);
        break;
      }
      case 'h':
      case 'H':
        eat();
        this.editor.setFlag(sel, 'hidden', !sel.every((r) => this.editor.get(r)?.hidden === true));
        break;
      case 'Delete':
      case 'Backspace':
        eat();
        this.editor.setFlag(sel, 'pruned', true);
        this.setSelection([], false);
        break;
      default:
    }
  };

  dispose(): void {
    this.surface.removeEventListener('pointerdown', this.onDown, true);
    this.surface.removeEventListener('pointermove', this.onMove, true);
    this.surface.removeEventListener('pointerup', this.onUp, true);
    this.surface.removeEventListener('pointerleave', this.onLeave);
    document.removeEventListener('keydown', this.onKey, true);
    cancelAnimationFrame(this.hoverRaf);
    this.unsubs.forEach((u) => u());
    this.marquee?.el.remove();
    this.readout.remove();
    this.gizmo.dispose();
  }
}

function segDistance(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;
  return Math.hypot(px - (a[0] + dx * t), py - (a[1] + dy * t));
}

