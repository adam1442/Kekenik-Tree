import { Group, Mesh, MeshBasicMaterial, Vector3, type Object3D } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { AppContext } from '@/app/context';
import { getNumber } from '@/contracts/params';
import { createThickMaterial } from '../thickLines';
import type { Viewport } from '../viewport';
import type { GizmoLayer, Handle } from './gizmoLayer';

const CIRCLE_COLOR = 0xfff03a;
const HANDLE_COLOR = 0xffffff;
const HANDLE_ACTIVE = 0xffb020;
const SEGMENTS = 192;
const SNAP_STEP = 0.5;

/** Segment-pair positions of a circle of radius 1 in the XY plane (or an arc between two angles). */
export function arcPositions(from: number, to: number, segments: number): Float32Array {
  const out = new Float32Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a0 = from + ((to - from) * i) / segments;
    const a1 = from + ((to - from) * (i + 1)) / segments;
    out.set([Math.cos(a0), Math.sin(a0), 0, Math.cos(a1), Math.sin(a1), 0], i * 6);
  }
  return out;
}

/** Radius from a dragged ground point; Shift snaps to `SNAP_STEP` metres. Exported for tests. */
export function radiusFromDrag(world: { x: number; y: number }, center: { x: number; y: number }, snap: boolean): number {
  const r = Math.hypot(world.x - center.x, world.y - center.y);
  const v = snap ? Math.round(r / SNAP_STEP) * SNAP_STEP : r;
  return Math.max(0, Math.round(v * 100) / 100);
}

/**
 * Placement disc of the selected Tree node: a yellow circle on the ground (constant pixel width, softly depth-tested:
 * a faint always-visible pass under a full-strength depth-tested pass) plus a white arc handle on its rim.
 * Dragging the handle writes `radius` with merged undo (one step per drag); Shift snaps; a readout shows the radius.
 */
export class TreePlacementGizmo {
  private readonly root = new Group();
  private readonly circle: LineSegments2;
  private readonly ghost: LineSegments2;
  private readonly arc: LineSegments2;
  private readonly handleObject: Mesh;
  private readonly handleMaterial: MeshBasicMaterial;
  private readonly readout: HTMLDivElement;
  private readonly materials: LineMaterial[] = [];
  private readonly unsubs: (() => void)[] = [];
  private nodeId: string | null = null;
  private radius = 10;
  private center = { x: 0, y: 0 };
  private dragging = false;
  private readonly handleAngle = -Math.PI / 2;

  constructor(
    private readonly app: AppContext,
    private readonly viewport: Viewport,
    private readonly layer: GizmoLayer,
    private readonly surface: HTMLElement,
  ) {
    const unit = arcPositions(0, Math.PI * 2, SEGMENTS);
    const make = (positions: Float32Array, color: number, width: number, opacity: number, depthTest: boolean, order: number): LineSegments2 => {
      const g = new LineSegmentsGeometry();
      g.setPositions(positions);
      const m = createThickMaterial({ color, width, opacity, depthTest });
      this.materials.push(m);
      const l = new LineSegments2(g, m);
      l.frustumCulled = false;
      l.renderOrder = order;
      return l;
    };
    this.circle = make(unit, CIRCLE_COLOR, 2, 1, true, 998);
    this.ghost = make(unit, CIRCLE_COLOR, 2, 0.28, false, 997);
    this.arc = make(arcPositions(-0.16, 0.16, 12), HANDLE_COLOR, 6, 1, false, 1001);
    this.handleObject = layer.createHandleObject(HANDLE_COLOR);
    this.handleMaterial = this.handleObject.material as MeshBasicMaterial;
    this.root.name = 'TreePlacementGizmo';
    this.root.visible = false;
    this.root.add(this.circle, this.ghost, this.arc, this.handleObject);
    layer.group.add(this.root);

    this.readout = document.createElement('div');
    this.readout.className = 'kt-vp-radius-readout';
    this.readout.hidden = true;
    surface.append(this.readout);

    this.unsubs.push(
      this.app.store.select((s) => s.selection, () => this.rebuild()),
      this.app.events.on('graph:changed', () => {
        if (!this.dragging) this.rebuild();
      }),
      viewport.addBeforeRender(() => this.updateReadout()),
    );
    this.rebuild();
  }

  /** Called by the viewport panel when the layer reports a drag start/end (active colour). */
  setActive(object: Object3D | null): void {
    this.handleMaterial.color.setHex(object === this.handleObject ? HANDLE_ACTIVE : HANDLE_COLOR);
  }

  private selectedTree(): string | null {
    const sel = this.app.store.get().selection;
    if (sel.length !== 1) return null;
    const node = this.app.graph.model.getNode(sel[0] as string);
    return node && node.type === 'output.tree' ? node.id : null;
  }

  private place(): void {
    const r = Math.max(0.001, this.radius);
    this.root.position.set(this.center.x, this.center.y, 0.02);
    this.circle.scale.set(r, r, 1);
    this.ghost.scale.set(r, r, 1);
    this.arc.scale.set(r, r, 1);
    this.arc.rotation.z = this.handleAngle;
    this.handleObject.position.set(Math.cos(this.handleAngle) * r, Math.sin(this.handleAngle) * r, 0);
    this.viewport.requestRender();
  }

  rebuild(): void {
    this.nodeId = this.selectedTree();
    this.layer.setHandles('treePlacement', []);
    this.root.visible = this.nodeId !== null;
    this.readout.hidden = this.nodeId === null;
    if (!this.nodeId) return;
    const node = this.app.graph.model.getNode(this.nodeId);
    if (!node) return;
    this.radius = getNumber(node.params, 'radius', 10);
    this.center = { x: getNumber(node.params, 'centerX', 0), y: getNumber(node.params, 'centerY', 0) };
    this.place();
    this.layer.setHandles('treePlacement', [this.handle(this.nodeId)]);
  }

  private handle(nodeId: string): Handle {
    return {
      object: this.handleObject,
      plane: 'ground',
      onDrag: (w, e) => {
        this.dragging = true;
        this.radius = radiusFromDrag(w, this.center, e?.shiftKey === true);
        this.place();
        this.app.graph.setParam(nodeId, 'radius', { value: this.radius }, true);
      },
      onEnd: () => {
        this.app.graph.endGesture();
        this.dragging = false;
        this.viewport.requestRender();
      },
    };
  }

  private updateReadout(): void {
    if (this.readout.hidden) return;
    const v = this.handleObject.getWorldPosition(new Vector3()).project(this.viewport.camera);
    const x = ((v.x + 1) / 2) * this.surface.clientWidth;
    const y = ((1 - v.y) / 2) * this.surface.clientHeight;
    this.readout.style.transform = `translate(${Math.round(x + 14)}px, ${Math.round(y - 10)}px)`;
    this.readout.textContent = `${this.radius.toFixed(2)} m`;
    this.readout.style.visibility = v.z > 1 ? 'hidden' : 'visible';
  }

  dispose(): void {
    this.unsubs.forEach((u) => u());
    this.layer.setHandles('treePlacement', []);
    this.layer.group.remove(this.root);
    for (const l of [this.circle, this.ghost, this.arc]) l.geometry.dispose();
    this.materials.forEach((m) => m.dispose());
    this.handleMaterial.dispose();
    this.readout.remove();
  }
}
