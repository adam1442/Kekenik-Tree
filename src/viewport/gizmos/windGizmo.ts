import { ConeGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { ThickSegment, createThickMaterial } from '../thickLines';
import { getWindSystem, type WindSystem } from '../wind/windSystem';
import type { GizmoLayer, Handle } from './gizmoLayer';

/**
 * Wind arrow in the viewport: shows the wind direction next to the plant; drag the tip handle on the ground plane to
 * rotate it (`onDirection` receives degrees). Visible only while the wind preview is enabled and `showArrow` is on.
 */
export class WindGizmo {
  private readonly root = new Group();
  private readonly shaft: ThickSegment;
  private readonly head: Mesh;
  private readonly tip: Mesh;
  private readonly unsub: () => void;
  private radius = 3;

  constructor(
    private readonly layer: GizmoLayer,
    private readonly wind: WindSystem = getWindSystem(),
    private readonly onDirection: (deg: number) => void,
  ) {
    this.shaft = new ThickSegment(createThickMaterial({ color: 0x5aa0d6, width: 2.5, depthTest: false }));
    this.shaft.lines.renderOrder = 1001;
    this.head = new Mesh(new ConeGeometry(0.5, 1.4, 14), new MeshBasicMaterial({ color: 0x5aa0d6, depthTest: false, transparent: true }));
    this.head.renderOrder = 1001;
    this.tip = layer.createHandleObject(0x8fd0ff);
    this.root.add(this.shaft.lines, this.head, this.tip);
    this.root.name = 'WindGizmo';
    layer.group.add(this.root);
    this.unsub = wind.onChange(() => this.sync());
    layer.setHandles('wind', [this.handle()]);
    this.sync();
  }

  /** Radius (m) of the arrow around the plant centre; set from the tree bounds. */
  setRadius(r: number): void {
    this.radius = Math.max(1, r);
    this.sync();
  }

  /** Handle registered with the layer (the layer owns hit-testing for all gizmos). */
  private handle(): Handle {
    return {
      object: this.tip,
      plane: 'ground',
      onDrag: (w) => {
        const deg = ((Math.atan2(w.y, w.x) * 180) / Math.PI + 360) % 360;
        this.onDirection(Math.round(deg * 10) / 10);
      },
      onEnd: () => undefined,
    };
  }

  private sync(): void {
    const p = this.wind.params;
    const visible = p.enabled && this.wind.state.showArrow;
    this.root.visible = visible;
    if (!visible) return;
    const a = (p.directionDeg * Math.PI) / 180;
    const dir = new Vector3(Math.cos(a), Math.sin(a), 0);
    const len = Math.max(1.2, this.radius * 0.6);
    const start = dir.clone().multiplyScalar(-len * 0.5).add(new Vector3(0, 0, 0.15));
    const end = dir.clone().multiplyScalar(len * 0.5).add(new Vector3(0, 0, 0.15));
    this.shaft.set(start.x, start.y, start.z, end.x, end.y, end.z);
    const hs = Math.max(0.12, len * 0.05);
    this.head.scale.setScalar(hs);
    this.head.position.copy(end);
    this.head.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir);
    this.tip.position.copy(end).addScaledVector(dir, hs * 1.4);
  }

  dispose(): void {
    this.unsub();
    this.layer.setHandles('wind', []);
    this.layer.group.remove(this.root);
    this.shaft.dispose();
    (this.shaft.lines.material as LineMaterial).dispose();
    this.head.geometry.dispose();
    (this.head.material as MeshBasicMaterial).dispose();
  }
}
