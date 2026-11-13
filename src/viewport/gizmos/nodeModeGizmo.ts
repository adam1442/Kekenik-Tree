import { Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { HandleId } from '@/instances/mappings';
import { createThickMaterial, ThickSegment } from '../thickLines';
import type { Viewport } from '../viewport';
import { add, cross, norm, planeBasis, scale, sub, type InstanceFrame, type V3 } from './nodeModeMath';

export const GIZMO_ORANGE = 0xffa91f;
export const GIZMO_KNOB = 0xffc94d;
const ARC_PX = { rotation: 74, angle: 104, roll: 30 } as const;
const ARC_SPAN = { rotation: 0.78, angle: 0.62, roll: 0.9 } as const;
const ROLL_OFFSET_PX = 54;
const SEGMENTS = 20;

export type ArcId = 'rotation' | 'angle' | 'roll';

interface ArcDef {
  id: ArcId;
  /** Local (pixel) centre of the arc relative to the instance origin. */
  center: V3;
  u: V3;
  v: V3;
  radius: number;
  /** Current handle angle in the (u, v) plane and half span of the drawn arc. */
  at: number;
  span: number;
}

/** Local-space (pixel) arc points: `center + r (cos a u + sin a v)`. */
function arcPoint(a: ArcDef, ang: number): V3 {
  return add(a.center, add(scale(a.u, Math.cos(ang) * a.radius), scale(a.v, Math.sin(ang) * a.radius)));
}

function arcPositions(a: ArcDef, from: number, to: number): Float32Array {
  const out = new Float32Array(SEGMENTS * 6);
  for (let i = 0; i < SEGMENTS; i++) {
    const p = arcPoint(a, from + ((to - from) * i) / SEGMENTS);
    const q = arcPoint(a, from + ((to - from) * (i + 1)) / SEGMENTS);
    out.set([...p, ...q], i * 6);
  }
  return out;
}

/**
 * The orange on-screen gizmo of Node mode: thick arcs for rotation / start angle / roll, a base disc (position along
 * parent), a tip disc (length) and a bend knob. Everything is built in pixel units and scaled by the world size of one
 * pixel at the instance, so it keeps a constant screen size. Arcs are drawn twice (depth-tested + faint ghost) so they
 * stay readable behind geometry.
 */
export class NodeModeGizmo {
  readonly group = new Group();
  private readonly mats: LineMaterial[] = [];
  private readonly sphereMats: MeshBasicMaterial[] = [];
  private readonly sphereGeo = new SphereGeometry(1, 18, 12);
  private readonly arcObjects: LineSegments2[] = [];
  private readonly shaft: ThickSegment;
  private readonly parentLine: ThickSegment;
  private readonly base: Mesh;
  private readonly tip: Mesh;
  private readonly bend: Mesh;
  private frame: InstanceFrame | null = null;
  private arcs: ArcDef[] = [];
  private enabled = new Set<HandleId>();
  private active: HandleId | null = null;
  private hovered: HandleId | null = null;
  private pixel = 0.01;
  private readonly unhook: () => void;

  constructor(private readonly viewport: Viewport, private readonly surface: HTMLElement) {
    this.group.name = 'NodeModeGizmo';
    this.group.visible = false;
    this.group.renderOrder = 1100;
    const shaftMat = this.mat(0xffe21a, 2.6, 0.95, false);
    this.shaft = new ThickSegment(shaftMat);
    this.parentLine = new ThickSegment(this.mat(0xffe21a, 1.6, 0.5, false));
    for (const s of [this.shaft, this.parentLine]) {
      s.lines.renderOrder = 1101;
      this.group.add(s.lines);
    }
    this.base = this.sphere(GIZMO_ORANGE);
    this.tip = this.sphere(0xffe21a);
    this.bend = this.sphere(GIZMO_KNOB);
    this.group.add(this.base, this.tip, this.bend);
    viewport.scene.add(this.group);
    this.unhook = viewport.addBeforeRender(() => this.layout());
  }

  private mat(color: number, width: number, opacity: number, depthTest: boolean): LineMaterial {
    const m = createThickMaterial({ color, width, opacity, depthTest });
    this.mats.push(m);
    return m;
  }

  private sphere(color: number): Mesh {
    const m = new MeshBasicMaterial({ color, depthTest: false, transparent: true });
    this.sphereMats.push(m);
    const mesh = new Mesh(this.sphereGeo, m);
    mesh.renderOrder = 1103;
    return mesh;
  }

  /** Show the gizmo for `frame` with the handles the node type maps (others stay hidden). */
  setTarget(frame: InstanceFrame | null, enabled: ReadonlySet<HandleId>): void {
    this.frame = frame;
    this.enabled = new Set(enabled);
    this.clearArcs();
    this.group.visible = frame !== null;
    if (!frame) {
      this.viewport.requestRender();
      return;
    }
    const rot = planeBasis(frame.parentAxis, frame.branchDir);
    const defs: ArcDef[] = [];
    if (enabled.has('rotation')) defs.push({ id: 'rotation', center: [0, 0, 0], u: rot.u, v: rot.v, radius: ARC_PX.rotation, at: 0, span: ARC_SPAN.rotation });
    if (enabled.has('angle')) {
      const normal = norm(cross(frame.parentAxis, frame.branchDir), rot.v);
      const u = frame.parentAxis;
      const v = norm(cross(normal, u));
      defs.push({ id: 'angle', center: [0, 0, 0], u, v, radius: ARC_PX.angle, at: (frame.spreadDeg * Math.PI) / 180, span: ARC_SPAN.angle });
    }
    if (enabled.has('roll')) {
      const b = planeBasis(frame.branchDir, rot.u);
      defs.push({ id: 'roll', center: scale(frame.branchDir, ROLL_OFFSET_PX), u: b.u, v: b.v, radius: ARC_PX.roll, at: 0, span: ARC_SPAN.roll });
    }
    this.arcs = defs;
    for (const a of defs) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(arcPositions(a, a.at - a.span, a.at + a.span));
      this.addArc(geo, this.mat(GIZMO_ORANGE, 9, 1, true), 1105);
      this.addArc(geo, this.mat(GIZMO_ORANGE, 9, 0.32, false), 1104);
      const knob = new LineSegmentsGeometry();
      knob.setPositions(arcPositions(a, a.at - 0.09, a.at + 0.09).slice(0, 6 * 6));
      this.addArc(knob, this.mat(GIZMO_KNOB, 12, 1, false), 1106);
    }
    this.base.visible = enabled.has('position');
    this.bend.visible = enabled.has('bend');
    this.tip.visible = enabled.has('length');
    this.viewport.requestRender();
  }

  private addArc(geo: LineSegmentsGeometry, m: LineMaterial, order: number): void {
    const l = new LineSegments2(geo, m);
    l.frustumCulled = false;
    l.renderOrder = order;
    this.group.add(l);
    this.arcObjects.push(l);
  }

  private clearArcs(): void {
    const geos = new Set<LineSegmentsGeometry>();
    for (const l of this.arcObjects) {
      l.removeFromParent();
      geos.add(l.geometry);
    }
    geos.forEach((g) => g.dispose());
    this.arcObjects.length = 0;
    this.arcs = [];
  }

  setActive(h: HandleId | null): void {
    this.active = h;
    this.paint();
  }

  setHover(h: HandleId | null): void {
    if (h === this.hovered) return;
    this.hovered = h;
    this.paint();
  }

  private paint(): void {
    const hot = (id: HandleId): number => (id === this.active ? 0xffffff : id === this.hovered ? 0xfff0b0 : id === 'bend' ? GIZMO_KNOB : id === 'length' ? 0xffe21a : GIZMO_ORANGE);
    (this.base.material as MeshBasicMaterial).color.setHex(hot('position'));
    (this.tip.material as MeshBasicMaterial).color.setHex(hot('length'));
    (this.bend.material as MeshBasicMaterial).color.setHex(hot('bend'));
    this.viewport.requestRender();
  }

  /** World size of one CSS pixel at the instance origin. */
  get pixelSize(): number {
    return this.pixel;
  }

  get target(): InstanceFrame | null {
    return this.frame;
  }

  /** Keep the constant screen size and place the pixel-space shaft / discs. */
  private layout(): void {
    const f = this.frame;
    if (!f) return;
    const cam = this.viewport.camera;
    const dist = cam.position.distanceTo(new Vector3(...f.origin));
    this.pixel = Math.max(1e-5, (2 * Math.tan((cam.fov * Math.PI) / 360) * dist) / Math.max(1, this.surface.clientHeight));
    this.group.position.set(...f.origin);
    this.group.scale.setScalar(this.pixel);
    const tip = scale(sub(f.tip, f.origin), 1 / this.pixel);
    const mid = scale(sub(f.mid, f.origin), 1 / this.pixel);
    this.shaft.set(0, 0, 0, tip[0], tip[1], tip[2]);
    this.tip.position.set(...tip);
    this.bend.position.set(...mid);
    this.base.scale.setScalar(9);
    this.tip.scale.setScalar(6.5);
    this.bend.scale.setScalar(5.5);
    const axis = scale(f.parentAxis, 120);
    this.parentLine.set(-axis[0] * 0.4, -axis[1] * 0.4, -axis[2] * 0.4, axis[0], axis[1], axis[2]);
    this.parentLine.lines.visible = !f.rootLevel || this.enabled.has('angle');
  }

  /** World-space polyline of an arc (for hit testing). */
  arcWorld(id: ArcId, samples = 28): V3[] {
    const f = this.frame;
    const a = this.arcs.find((x) => x.id === id);
    if (!f || !a) return [];
    const out: V3[] = [];
    for (let i = 0; i <= samples; i++) {
      const p = arcPoint(a, a.at - a.span + ((a.span * 2) * i) / samples);
      out.push(add(f.origin, scale(p, this.pixel)));
    }
    return out;
  }

  /** World centre + basis of an arc (drag maths). */
  arcFrame(id: ArcId): { center: V3; u: V3; v: V3 } | null {
    const f = this.frame;
    const a = this.arcs.find((x) => x.id === id);
    if (!f || !a) return null;
    return { center: add(f.origin, scale(a.center, this.pixel)), u: a.u, v: a.v };
  }

  /** World positions of the sphere handles. */
  handlePoints(): Partial<Record<HandleId, V3>> {
    const f = this.frame;
    if (!f) return {};
    const out: Partial<Record<HandleId, V3>> = {};
    if (this.enabled.has('position')) out.position = f.origin;
    if (this.enabled.has('length')) out.length = f.tip;
    if (this.enabled.has('bend')) out.bend = f.mid;
    return out;
  }

  dispose(): void {
    this.unhook();
    this.clearArcs();
    this.shaft.dispose();
    this.parentLine.dispose();
    this.mats.forEach((m) => m.dispose());
    this.sphereMats.forEach((m) => m.dispose());
    this.sphereGeo.dispose();
    this.group.removeFromParent();
  }
}
