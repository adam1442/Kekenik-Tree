import { BoxGeometry, type BufferGeometry, Group, Mesh, PlaneGeometry, SphereGeometry, Vector3, type Object3D } from 'three';
import { ThickSegment, createThickMaterial, createWireOverlay } from '../thickLines';
import type { AppContext } from '@/app/context';
import { readVec3 } from '@/forces/fields';
import type { NodeParams } from '@/contracts/params';
import type { Viewport } from '../viewport';
import type { GizmoLayer, Handle } from './gizmoLayer';

const COLOR = 0x9a86e8;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Node types that own a gizmo. */
export const FORCE_GIZMO_TYPES = new Set(['force.gravity', 'force.directional', 'force.phototropism', 'force.point', 'force.vortex', 'force.curl', 'force.pullToAxis', 'force.groundAvoid', 'utility.collision']);

/**
 * Editable 3D gizmos for the selected force nodes (arrows for directions / axes, spheres for positions and ranges).
 * Dragging writes the parameter through `graph.setParam(..., merge = true)` so a whole drag is ONE undo step, and
 * `graph.endGesture()` seals it.
 */
export class ForceGizmos {
  private readonly root = new Group();
  private readonly disposables: { dispose(): void }[] = [];
  private readonly unsubs: (() => void)[] = [];
  private dragging = false;

  constructor(
    private readonly app: AppContext,
    private readonly viewport: Viewport,
    private readonly layer: GizmoLayer,
  ) {
    this.root.name = 'ForceGizmos';
    layer.group.add(this.root);
    this.unsubs.push(
      app.store.select((s) => s.selection, () => this.rebuild()),
      app.events.on('graph:changed', () => {
        if (!this.dragging) this.rebuild();
      }),
    );
    this.rebuild();
  }

  private track<T extends { dispose(): void }>(d: T): T {
    this.disposables.push(d);
    return d;
  }

  private line(color = COLOR): { line: Object3D; set(a: Vector3, b: Vector3): void } {
    const seg = new ThickSegment(this.track(createThickMaterial({ color, width: 2, opacity: 0.9, depthTest: false })));
    this.track(seg.lines.geometry);
    seg.lines.renderOrder = 1001;
    return { line: seg.lines, set: (a, b) => seg.set(a.x, a.y, a.z, b.x, b.y, b.z) };
  }

  private wire(geometry: BufferGeometry): Mesh {
    const m = createWireOverlay(this.track(geometry), this.track(createThickMaterial({ color: COLOR, width: 1, opacity: 0.35, depthTest: false })));
    m.renderOrder = 1000;
    return m;
  }

  private write(nodeId: string, id: string, value: number | number[]): void {
    this.dragging = true;
    this.app.graph.setParam(nodeId, id, { value }, true);
  }

  private end(): void {
    this.app.graph.endGesture();
    this.dragging = false;
    this.viewport.requestRender();
  }

  /** Position handle writing a vec3 param. */
  private positionHandle(group: Object3D, nodeId: string, id: string, pos: Vector3, onMove: () => void): Handle {
    const o = this.layer.createHandleObject();
    o.position.copy(pos);
    group.add(o);
    return {
      object: o,
      onDrag: (w) => {
        o.position.copy(w);
        pos.copy(w);
        this.write(nodeId, id, [round(w.x), round(w.y), round(w.z)]);
        onMove();
      },
      onEnd: () => this.end(),
    };
  }

  /** Arrow from `origin()` with a tip handle writing a unit direction to a vec3 param. */
  private arrow(group: Object3D, nodeId: string, id: string, origin: () => Vector3, dir: Vector3, length: number, draggable = true): Handle | null {
    const l = this.line();
    group.add(l.line);
    const tip = this.layer.createHandleObject(0xd0c4ff);
    group.add(tip);
    const redraw = (): void => {
      const o = origin();
      const end = o.clone().addScaledVector(dir, length);
      l.set(o, end);
      tip.position.copy(end);
    };
    redraw();
    if (!draggable) return null;
    return {
      object: tip,
      onDrag: (w) => {
        const d = w.clone().sub(origin());
        if (d.lengthSq() < 1e-8) return;
        dir.copy(d.normalize());
        this.write(nodeId, id, [round(dir.x), round(dir.y), round(dir.z)]);
        redraw();
      },
      onEnd: () => this.end(),
    };
  }

  rebuild(): void {
    if (this.dragging) return;
    this.layer.setHandles('forces', []);
    for (const c of [...this.root.children]) this.root.remove(c);
    this.disposables.splice(0).forEach((d) => d.dispose());
    const model = this.app.graph.model;
    const bounds = this.viewport.getBounds();
    const size = bounds.isEmpty() ? new Vector3(2, 2, 4) : bounds.getSize(new Vector3());
    const height = Math.max(1, size.z);
    const anchor = new Vector3(0, 0, height * 0.55);
    const len = Math.max(1, height * 0.3);
    const handles: Handle[] = [];
    for (const id of this.app.store.get().selection) {
      const node = model.getNode(id);
      if (!node || !FORCE_GIZMO_TYPES.has(node.type)) continue;
      const p: NodeParams = node.params;
      const g = new Group();
      this.root.add(g);
      const push = (h: Handle | null): void => {
        if (h) handles.push(h);
      };
      const vec = (key: string, fb: [number, number, number]): Vector3 => new Vector3(...readVec3(p, key, fb));
      switch (node.type) {
        case 'force.gravity':
          this.arrow(g, id, 'none', () => anchor, new Vector3(0, 0, -1), len, false);
          break;
        case 'force.directional':
          push(this.arrow(g, id, 'direction', () => anchor, vec('direction', [1, 0, 0]).normalize(), len));
          break;
        case 'force.phototropism':
          push(this.arrow(g, id, 'lightDirection', () => anchor, vec('lightDirection', [0.4, 0.2, 1]).normalize(), len));
          break;
        case 'force.curl':
          push(this.arrow(g, id, 'axis', () => anchor, vec('axis', [0, 0, 1]).normalize(), len));
          break;
        case 'force.point': {
          const pos = vec('position', [0, 0, 5]);
          const shape = typeof p.shape?.value === 'string' ? p.shape.value : 'point';
          const range = this.wire(new SphereGeometry(1, 20, 12));
          g.add(range);
          const radius = Math.max(0.01, Number(p.radius?.value ?? 5));
          range.scale.setScalar(radius);
          range.position.copy(pos);
          const move = (): void => {
            range.position.copy(pos);
          };
          push(this.positionHandle(g, id, 'position', pos, move));
          if (shape === 'axis') push(this.arrow(g, id, 'axis', () => pos, vec('axis', [0, 0, 1]).normalize(), Math.max(len, radius)));
          const rh = this.layer.createHandleObject(0xd0c4ff);
          g.add(rh);
          rh.position.copy(pos).add(new Vector3(radius, 0, 0));
          push({
            object: rh,
            onDrag: (w) => {
              const r = Math.max(0.01, w.distanceTo(pos));
              range.scale.setScalar(r);
              rh.position.copy(pos).add(new Vector3(r, 0, 0));
              this.write(id, 'radius', round(r));
            },
            onEnd: () => this.end(),
          });
          break;
        }
        case 'force.vortex': {
          const c = vec('center', [0, 0, 0]);
          push(this.positionHandle(g, id, 'center', c, () => undefined));
          push(this.arrow(g, id, 'axis', () => c, vec('axis', [0, 0, 1]).normalize(), len));
          break;
        }
        case 'force.pullToAxis': {
          const c = vec('position', [0, 0, 0]);
          push(this.positionHandle(g, id, 'position', c, () => undefined));
          push(this.arrow(g, id, 'axis', () => c, vec('axis', [0, 0, 1]).normalize(), len * 1.5));
          break;
        }
        case 'force.groundAvoid': {
          const plane = this.wire(new PlaneGeometry(height * 2, height * 2, 8, 8));
          plane.position.set(0, 0, Number(p.groundLevel?.value ?? 0));
          g.add(plane);
          break;
        }
        case 'utility.collision': {
          const c = vec('position', [0, 0, 2]);
          const sz = vec('size', [1, 1, 1]);
          const shape = typeof p.shape?.value === 'string' ? p.shape.value : 'sphere';
          const vol = this.wire(shape === 'box' ? new BoxGeometry(sz.x, sz.y, sz.z) : shape === 'plane' ? new PlaneGeometry(height * 2, height * 2, 8, 8) : new SphereGeometry(Math.max(0.01, sz.x * 0.5), 20, 12));
          vol.position.copy(c);
          g.add(vol);
          push(this.positionHandle(g, id, 'position', c, () => {
            vol.position.copy(c);
          }));
          break;
        }
        default:
          break;
      }
    }
    this.layer.setHandles('forces', handles);
    this.viewport.requestRender();
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.layer.setHandles('forces', []);
    this.layer.group.remove(this.root);
    this.disposables.splice(0).forEach((d) => d.dispose());
  }
}
