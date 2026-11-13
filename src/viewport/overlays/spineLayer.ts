import { BufferAttribute, BufferGeometry, Color, Group, Points, ShaderMaterial } from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import type { Skeleton } from '@/contracts/skeleton';
import { FLAG_HIDDEN, type InstanceTable } from '@/instances/types';
import { createThickMaterial } from '../thickLines';

export const SPINE_YELLOW = 0xffe21a;
export const SPINE_PINK = 0xff3fd0;
export const SPINE_HOVER = 0xff9be8;
/** Above this many points only branch end points are drawn (keeps huge selections interactive). */
const MAX_POINTS = 80_000;

export interface SpineItem {
  nodeId: string;
  skeleton: Skeleton;
  table: InstanceTable | null;
  /** Instance rows highlighted in pink (selected). */
  selectedRows: ReadonlySet<number>;
  hoverRow: number;
  /** `all`: the node's every spine (yellow); `instances`: only the highlighted rows. */
  scope: 'all' | 'instances';
}

function pointMaterial(color: number, alpha: number, depthTest: boolean): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uSize: { value: 7 }, uColor: { value: new Color(color) }, uAlpha: { value: alpha } },
    vertexShader: 'uniform float uSize; void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = uSize; }',
    fragmentShader:
      'uniform vec3 uColor; uniform float uAlpha; void main() { float d = length(gl_PointCoord - 0.5); if (d > 0.5) discard; gl_FragColor = vec4(uColor, uAlpha * smoothstep(0.5, 0.4, d)); }',
    transparent: true,
    depthTest,
    depthWrite: false,
  });
}

/**
 * Spine curves + control points of the selected generator node(s) / instances. Drawn as thick anti-aliased lines
 * (yellow, pink for selected instances) and round points, in two passes: a depth-tested full-strength pass and a faint
 * always-visible pass ("soft depth fade", disabled when `Spines on top` is off). Lives in the overlay group, so the
 * View mode never changes it.
 */
export class SpineLayer {
  private readonly lineMats: LineMaterial[] = [];
  private readonly pointMats: ShaderMaterial[] = [];
  private readonly objects: (LineSegments2 | Points)[] = [];
  private readonly yellowDepth = this.line(SPINE_YELLOW, 2.4, 1, true);
  private readonly yellowGhost = this.line(SPINE_YELLOW, 2.4, 0.3, false);
  private readonly pinkDepth = this.line(SPINE_PINK, 3.6, 1, true);
  private readonly pinkGhost = this.line(SPINE_PINK, 3.6, 0.55, false);
  private readonly hoverGhost = this.line(SPINE_HOVER, 3, 0.9, false);
  private readonly dotDepth = this.point(SPINE_YELLOW, 1, true);
  private readonly dotGhost = this.point(SPINE_YELLOW, 0.4, false);
  private onTop = true;

  constructor(private readonly group: Group) {}

  private line(color: number, width: number, opacity: number, depthTest: boolean): LineMaterial {
    const m = createThickMaterial({ color, width, opacity, depthTest });
    this.lineMats.push(m);
    return m;
  }

  private point(color: number, alpha: number, depthTest: boolean): ShaderMaterial {
    const m = pointMaterial(color, alpha, depthTest);
    this.pointMats.push(m);
    return m;
  }

  setPixelRatio(ratio: number): void {
    for (const m of this.pointMats) (m.uniforms.uSize as { value: number }).value = 6.5 * ratio;
  }

  /** Rebuild every spine object from `items`. Old objects and their GPU buffers are disposed first. */
  rebuild(items: readonly SpineItem[], onTop: boolean): void {
    this.onTop = onTop;
    this.clear();
    const yellow: number[] = [];
    const pink: number[] = [];
    const hover: number[] = [];
    const dots: number[] = [];
    let pointBudget = MAX_POINTS;
    for (const it of items) {
      const { skeleton: sk, table } = it;
      for (let bi = 0; bi < sk.branches.length; bi++) {
        const row = table ? (table.branchToInstance[bi] ?? -1) : -1;
        if (table && row >= 0 && ((table.flags[row] as number) & FLAG_HIDDEN) !== 0) continue;
        const isSel = row >= 0 && it.selectedRows.has(row);
        const isHover = row >= 0 && row === it.hoverRow;
        if (it.scope === 'instances' && !isSel && !isHover) continue;
        const target = isHover && !isSel ? hover : isSel ? pink : yellow;
        const b = sk.branches[bi]!;
        for (let k = 0; k < b.count - 1; k++) {
          const p = (b.start + k) * 3;
          target.push(sk.position[p]!, sk.position[p + 1]!, sk.position[p + 2]!, sk.position[p + 3]!, sk.position[p + 4]!, sk.position[p + 5]!);
        }
        const step = pointBudget < b.count ? Math.max(1, b.count - 1) : 1;
        for (let k = 0; k < b.count && pointBudget > 0; k += step) {
          const p = (b.start + k) * 3;
          dots.push(sk.position[p]!, sk.position[p + 1]!, sk.position[p + 2]!);
          pointBudget -= 1;
        }
        if (step > 1) {
          const p = (b.start + b.count - 1) * 3;
          dots.push(sk.position[p]!, sk.position[p + 1]!, sk.position[p + 2]!);
        }
      }
    }
    this.addLines(yellow, this.yellowDepth, this.yellowGhost, 996);
    this.addLines(pink, this.pinkDepth, this.pinkGhost, 998);
    this.addLines(hover, null, this.hoverGhost, 999);
    if (dots.length > 0) {
      const geo = new BufferGeometry();
      geo.setAttribute('position', new BufferAttribute(new Float32Array(dots), 3));
      const solid = new Points(geo, this.dotDepth);
      solid.renderOrder = 1000;
      solid.frustumCulled = false;
      this.add(solid);
      if (onTop) {
        const ghost = new Points(geo, this.dotGhost);
        ghost.renderOrder = 999;
        ghost.frustumCulled = false;
        this.add(ghost);
      }
    }
  }

  private addLines(positions: number[], depth: LineMaterial | null, ghost: LineMaterial, order: number): void {
    if (positions.length === 0) return;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(new Float32Array(positions));
    const make = (m: LineMaterial, o: number): void => {
      const l = new LineSegments2(geo, m);
      l.frustumCulled = false;
      l.renderOrder = o;
      this.add(l);
    };
    if (depth) make(depth, order + 1);
    if (this.onTop || !depth) make(ghost, order);
  }

  private add(o: LineSegments2 | Points): void {
    o.userData.isOverlay = true;
    this.group.add(o);
    this.objects.push(o);
  }

  /** Number of live overlay objects (tests / diagnostics). */
  get objectCount(): number {
    return this.objects.length;
  }

  private clear(): void {
    const geos = new Set<BufferGeometry | LineSegmentsGeometry>();
    for (const o of this.objects) {
      o.removeFromParent();
      geos.add(o.geometry);
    }
    geos.forEach((g) => g.dispose());
    this.objects.length = 0;
  }

  dispose(): void {
    this.clear();
    this.lineMats.forEach((m) => m.dispose());
    this.pointMats.forEach((m) => m.dispose());
  }
}
