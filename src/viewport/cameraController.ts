import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { clamp } from '@/core/math';
import { getNavScheme, resolveNavMode } from './navScheme';

interface CamState {
  az: number;
  el: number;
  dist: number;
  target: Vector3;
}

/**
 * Orbit / pan / zoom camera for a Z-up world with smooth damping.
 * LMB orbit · MMB or Shift+LMB pan · RMB drag dolly · wheel zoom.
 * Input changes the *goal* state; update(dt) eases the camera toward it.
 */
export class CameraController {
  private goal: CamState = this.defaults();
  private cur: CamState = this.defaults();
  private mode: 'orbit' | 'pan' | 'dolly' | null = null;
  private lastX = 0;
  private lastY = 0;
  private readonly cleanups: (() => void)[] = [];

  constructor(
    private readonly camera: PerspectiveCamera,
    dom: HTMLElement,
    private readonly onChange: () => void,
  ) {
    camera.up.set(0, 0, 1);
    this.applyToCamera();

    const down = (e: PointerEvent): void => {
      const mode = resolveNavMode(getNavScheme(), e);
      if (!mode) return;
      this.mode = mode;
      e.preventDefault();
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      dom.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent): void => {
      if (!this.mode) return;
      const dx = e.clientX - this.lastX;
      const dy = e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      if (this.mode === 'orbit') {
        this.goal.az -= dx * 0.006;
        this.goal.el = clamp(this.goal.el + dy * 0.006, -1.5, 1.5);
      } else if (this.mode === 'pan') {
        const scale = (2 * this.goal.dist * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, dom.clientHeight);
        const right = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        const up = new Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
        this.goal.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale);
      } else {
        this.goal.dist = clamp(this.goal.dist * Math.exp(dy * 0.01), 0.3, 1500);
      }
      this.onChange();
    };
    const up = (e: PointerEvent): void => {
      if (!this.mode) return;
      this.mode = null;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    };
    const wheel = (e: WheelEvent): void => {
      e.preventDefault();
      this.goal.dist = clamp(this.goal.dist * Math.exp(e.deltaY * 0.0012), 0.3, 1500);
      this.onChange();
    };
    const ctx = (e: Event): void => e.preventDefault();
    dom.addEventListener('pointerdown', down);
    dom.addEventListener('pointermove', move);
    dom.addEventListener('pointerup', up);
    dom.addEventListener('pointercancel', up);
    dom.addEventListener('wheel', wheel, { passive: false });
    dom.addEventListener('contextmenu', ctx);
    this.cleanups.push(() => {
      dom.removeEventListener('pointerdown', down);
      dom.removeEventListener('pointermove', move);
      dom.removeEventListener('pointerup', up);
      dom.removeEventListener('pointercancel', up);
      dom.removeEventListener('wheel', wheel);
      dom.removeEventListener('contextmenu', ctx);
    });
  }

  private defaults(): CamState {
    return { az: -1.05, el: 0.22, dist: 34, target: new Vector3(0, 0, 6) };
  }

  get distance(): number {
    return this.cur.dist;
  }
  get azimuth(): number {
    return this.cur.az;
  }

  /** Frame a bounding box. */
  frame(box: Box3, snap = false): void {
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    this.goal.target.copy(center);
    this.goal.dist = clamp((radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.05, 1, 1500);
    if (snap) this.snap();
    this.onChange();
  }

  reset(frameBox?: Box3): void {
    const d = this.defaults();
    this.goal = d;
    if (frameBox) this.frame(frameBox);
    this.onChange();
  }

  snap(): void {
    this.cur = { ...this.goal, target: this.goal.target.clone() };
    this.applyToCamera();
  }

  /** Ease toward the goal. Returns true while still moving. */
  update(dt: number): boolean {
    const k = 1 - Math.exp(-dt * 16);
    const g = this.goal;
    const c = this.cur;
    c.az += (g.az - c.az) * k;
    c.el += (g.el - c.el) * k;
    c.dist += (g.dist - c.dist) * k;
    c.target.lerp(g.target, k);
    const moving =
      Math.abs(g.az - c.az) > 1e-4 ||
      Math.abs(g.el - c.el) > 1e-4 ||
      Math.abs(g.dist - c.dist) > 1e-3 * g.dist ||
      g.target.distanceToSquared(c.target) > 1e-6;
    if (!moving) {
      c.az = g.az;
      c.el = g.el;
      c.dist = g.dist;
      c.target.copy(g.target);
    }
    this.applyToCamera();
    return moving;
  }

  private applyToCamera(): void {
    const { az, el, dist, target } = this.cur;
    const ce = Math.cos(el);
    this.camera.position.set(target.x + dist * ce * Math.cos(az), target.y + dist * ce * Math.sin(az), target.z + dist * Math.sin(el));
    this.camera.lookAt(target);
    this.camera.updateMatrixWorld();
  }

  dispose(): void {
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
  }
}
