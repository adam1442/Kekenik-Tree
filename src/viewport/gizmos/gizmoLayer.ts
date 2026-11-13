import { Group, Mesh, MeshBasicMaterial, Object3D, Plane, Raycaster, SphereGeometry, Vector2, Vector3, type PerspectiveCamera } from 'three';
import type { Viewport } from '../viewport';

/** A draggable handle: `object` is hit-tested, `onDrag` receives the new world position of the handle. */
export interface Handle {
  object: Object3D;
  /** Plane the drag happens on: facing the camera (default) or the ground. */
  plane?: 'camera' | 'ground';
  onDrag(world: Vector3, event?: PointerEvent): void;
  onEnd(): void;
}

const HANDLE_PIXELS = 11;

/**
 * Interactive overlay layer of the viewport (force / wind gizmos). Handles are screen-constant spheres drawn on top;
 * dragging one stops the camera controller from seeing the pointer.
 */
export class GizmoLayer {
  readonly group = new Group();
  private readonly owners = new Map<string, Handle[]>();
  private readonly ray = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly plane = new Plane();
  private drag: { handle: Handle; offset: Vector3; id: number } | null = null;
  /** Notified with the dragged handle's object when a drag starts and with `null` when it ends (hover / active colours). */
  onActiveChange: ((object: Object3D | null) => void) | null = null;
  private readonly unhook: () => void;
  private readonly handleMaterial = new MeshBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true });
  private readonly handleGeometry = new SphereGeometry(1, 14, 10);

  constructor(
    private readonly viewport: Viewport,
    private readonly surface: HTMLElement,
  ) {
    this.group.name = 'Gizmos';
    this.group.renderOrder = 1000;
    viewport.scene.add(this.group);
    surface.addEventListener('pointerdown', this.onDown, true);
    surface.addEventListener('pointermove', this.onMove, true);
    surface.addEventListener('pointerup', this.onUp, true);
    this.unhook = viewport.addBeforeRender(() => this.rescale());
  }

  get dragging(): boolean {
    return this.drag !== null;
  }

  /** Create a screen-constant handle sphere (add it to a piece's group, then return it inside a `Handle`). */
  createHandleObject(color = 0xffb020): Mesh {
    const m = new Mesh(this.handleGeometry, color === 0xffb020 ? this.handleMaterial : new MeshBasicMaterial({ color, depthTest: false, transparent: true }));
    m.renderOrder = 1002;
    m.userData.screenConstant = true;
    return m;
  }

  /** Register the handles of one gizmo owner (replaces its previous list). */
  setHandles(owner: string, handles: Handle[]): void {
    if (handles.length === 0) this.owners.delete(owner);
    else this.owners.set(owner, handles);
    this.viewport.requestRender();
  }

  private get handles(): Handle[] {
    return [...this.owners.values()].flat();
  }

  private rescale(): void {
    const cam = this.viewport.camera;
    const h = Math.max(1, this.surface.clientHeight);
    const k = (2 * Math.tan((cam.fov * Math.PI) / 360) * HANDLE_PIXELS) / h;
    const p = new Vector3();
    this.group.traverse((o) => {
      if (o.userData.screenConstant !== true) return;
      o.getWorldPosition(p);
      o.scale.setScalar(Math.max(1e-4, p.distanceTo(cam.position) * k));
    });
  }

  private setRay(e: PointerEvent): void {
    const r = this.surface.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.viewport.camera as PerspectiveCamera);
  }

  private pick(): Handle | null {
    this.group.updateWorldMatrix(true, true);
    let best: Handle | null = null;
    let dist = Infinity;
    for (const h of this.handles) {
      const hit = this.ray.intersectObject(h.object, true)[0];
      if (hit && hit.distance < dist) {
        dist = hit.distance;
        best = h;
      }
    }
    return best;
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.handles.length === 0) return;
    this.setRay(e);
    const handle = this.pick();
    if (!handle) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const pos = handle.object.getWorldPosition(new Vector3());
    const normal = handle.plane === 'ground' ? new Vector3(0, 0, 1) : this.viewport.camera.getWorldDirection(new Vector3());
    this.plane.setFromNormalAndCoplanarPoint(normal, pos);
    const hit = new Vector3();
    if (this.ray.ray.intersectPlane(this.plane, hit) === null) return;
    this.drag = { handle, offset: hit.sub(pos), id: e.pointerId };
    this.surface.setPointerCapture(e.pointerId);
    this.onActiveChange?.(handle.object);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (!this.drag) {
      if (e.buttons !== 0 || this.handles.length === 0) return;
      this.setRay(e);
      this.surface.style.cursor = this.pick() ? 'pointer' : '';
      return;
    }
    e.stopImmediatePropagation();
    this.setRay(e);
    const hit = new Vector3();
    if (this.ray.ray.intersectPlane(this.plane, hit) === null) return;
    this.drag.handle.onDrag(hit.sub(this.drag.offset), e);
    this.viewport.requestRender();
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    e.stopImmediatePropagation();
    if (this.surface.hasPointerCapture(this.drag.id)) this.surface.releasePointerCapture(this.drag.id);
    const h = this.drag.handle;
    this.drag = null;
    h.onEnd();
    this.onActiveChange?.(null);
    this.viewport.requestRender();
  };

  dispose(): void {
    this.unhook();
    this.surface.removeEventListener('pointerdown', this.onDown, true);
    this.surface.removeEventListener('pointermove', this.onMove, true);
    this.surface.removeEventListener('pointerup', this.onUp, true);
    this.viewport.scene.remove(this.group);
    this.handleMaterial.dispose();
    this.handleGeometry.dispose();
    this.group.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh && m.geometry !== this.handleGeometry) m.geometry.dispose();
    });
  }
}
