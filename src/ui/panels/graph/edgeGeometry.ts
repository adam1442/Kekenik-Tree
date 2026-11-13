import type { Pt } from './viewTransform';

/** Radius of a round node in world units. */
export const NODE_R = 12;

export interface EdgeGeometry {
  d: string;
  /** Control points: [p0, c1, c2, p1]. */
  pts: [Pt, Pt, Pt, Pt];
  mid: Pt;
}

/**
 * Hierarchy edge from the parent's top port to the child's bottom port (children grow upwards).
 * Cubic curve with vertical tangents at both ends.
 */
export function edgeGeometry(parent: Pt, child: Pt): EdgeGeometry {
  const p0 = { x: parent.x, y: parent.y - NODE_R };
  const p1 = { x: child.x, y: child.y + NODE_R };
  const off = Math.max(Math.abs(p1.y - p0.y) * 0.5, 12);
  const c1 = { x: p0.x, y: p0.y - off };
  const c2 = { x: p1.x, y: p1.y + off };
  return {
    d: `M${p0.x} ${p0.y}C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p1.x} ${p1.y}`,
    pts: [p0, c1, c2, p1],
    mid: { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 },
  };
}

export function bezierPoint(pts: readonly [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const [a, b, c, d] = pts;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return { x: w0 * a.x + w1 * b.x + w2 * c.x + w3 * d.x, y: w0 * a.y + w1 * b.y + w2 * c.y + w3 * d.y };
}

export function sampleBezier(pts: readonly [Pt, Pt, Pt, Pt], n = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(bezierPoint(pts, i / n));
  return out;
}

function cross(o: Pt, a: Pt, b: Pt): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

export function segmentsIntersect(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Does the polyline `line` cross the sampled curve? */
export function curveCrossesPolyline(curve: readonly Pt[], line: readonly Pt[]): boolean {
  for (let i = 0; i < curve.length - 1; i++) {
    for (let j = 0; j < line.length - 1; j++) {
      if (segmentsIntersect(curve[i] as Pt, curve[i + 1] as Pt, line[j] as Pt, line[j + 1] as Pt)) return true;
    }
  }
  return false;
}

/** Wire while connecting: same curve shape from a fixed port to a free end. `fromTop` = anchor is an output (top) port. */
export function wirePath(anchor: Pt, end: Pt, anchorIsOutput: boolean): string {
  const a = { x: anchor.x, y: anchor.y };
  const dir = anchorIsOutput ? -1 : 1;
  const off = Math.max(Math.abs(end.y - a.y) * 0.5, 18);
  return `M${a.x} ${a.y}C${a.x} ${a.y + dir * off} ${end.x} ${end.y - dir * off} ${end.x} ${end.y}`;
}
