import type { MeshData } from '@/contracts/mesh';
import type { P2 } from './outline';

/** Plane sections of a triangle mesh (pure). A section is a set of closed (or open) polylines with the interpolated vertex normals. */

export type V3 = readonly [number, number, number];

export interface SectionLoop {
  /** xyz per point. */
  points: number[][];
  /** Unit normals (interpolated from the vertex normals) per point. */
  normals: number[][];
  closed: boolean;
}

export const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot3 = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export function unit3(a: V3, fallback: V3 = [0, 0, 1]): V3 {
  const l = len3(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
}
export const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Orthonormal in-plane basis (u, v) for the plane normal `n`. */
export function planeBasis(n: V3): { u: V3; v: V3 } {
  const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit3(cross3(ref, n), [1, 0, 0]);
  return { u, v: cross3(n, u) };
}

export const toPlane = (p: V3 | number[], o: V3, u: V3, v: V3): P2 => {
  const d: V3 = [(p[0] as number) - o[0], (p[1] as number) - o[1], (p[2] as number) - o[2]];
  return [dot3(d, u), dot3(d, v)];
};

/** Indices of the triangles whose centroid satisfies `keep`. */
export function selectTriangles(mesh: MeshData, keep: (x: number, y: number, z: number) => boolean): Uint32Array {
  const out: number[] = [];
  const pos = mesh.positions;
  const idx = mesh.indices;
  for (let t = 0; t * 3 < idx.length; t++) {
    const a = (idx[t * 3] as number) * 3;
    const b = (idx[t * 3 + 1] as number) * 3;
    const c = (idx[t * 3 + 2] as number) * 3;
    const x = ((pos[a] as number) + (pos[b] as number) + (pos[c] as number)) / 3;
    const y = ((pos[a + 1] as number) + (pos[b + 1] as number) + (pos[c + 1] as number)) / 3;
    const z = ((pos[a + 2] as number) + (pos[b + 2] as number) + (pos[c + 2] as number)) / 3;
    if (keep(x, y, z)) out.push(t);
  }
  return Uint32Array.from(out);
}

/** Distance from a point to the polyline `pts` (xyz triples). */
export function distanceToPolyline(pts: ArrayLike<number>, x: number, y: number, z: number): number {
  const n = Math.floor(pts.length / 3);
  let best = Infinity;
  for (let i = 0; i + 1 < n; i++) {
    const ax = pts[i * 3] as number;
    const ay = pts[i * 3 + 1] as number;
    const az = pts[i * 3 + 2] as number;
    const dx = (pts[i * 3 + 3] as number) - ax;
    const dy = (pts[i * 3 + 4] as number) - ay;
    const dz = (pts[i * 3 + 5] as number) - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - dx * t, y - ay - dy * t, z - az - dz * t));
  }
  if (n === 1) best = Math.hypot(x - (pts[0] as number), y - (pts[1] as number), z - (pts[2] as number));
  return best;
}

interface Crossing {
  p: number[];
  n: number[];
  key: string;
}

/**
 * Intersection of the triangles `tris` with the plane through `origin` with normal `normal`. Vertices on the plane count as being
 * on the positive side. Duplicate vertices (UV seams) produce identical crossings, so the loops close without a weld step.
 */
export function planeSection(mesh: MeshData, tris: ArrayLike<number>, origin: V3, normal: V3): SectionLoop[] {
  const pos = mesh.positions;
  const nor = mesh.normals;
  const idx = mesh.indices;
  const nrm = unit3(normal);
  const dist = (i: number): number => ((pos[i * 3] as number) - origin[0]) * nrm[0] + ((pos[i * 3 + 1] as number) - origin[1]) * nrm[1] + ((pos[i * 3 + 2] as number) - origin[2]) * nrm[2];
  const before = (a: number, b: number): boolean => {
    for (let k = 0; k < 3; k++) {
      const pa = pos[a * 3 + k] as number;
      const pb = pos[b * 3 + k] as number;
      if (pa !== pb) return pa < pb;
    }
    return a <= b;
  };
  const crossAt = (i0: number, i1: number): Crossing => {
    const [a, b] = before(i0, i1) ? [i0, i1] : [i1, i0];
    const da = dist(a);
    const db = dist(b);
    const t = da / (da - db);
    const p = [0, 1, 2].map((k) => (pos[a * 3 + k] as number) + ((pos[b * 3 + k] as number) - (pos[a * 3 + k] as number)) * t);
    const raw = [0, 1, 2].map((k) => (nor[a * 3 + k] as number) + ((nor[b * 3 + k] as number) - (nor[a * 3 + k] as number)) * t);
    const l = Math.hypot(raw[0] as number, raw[1] as number, raw[2] as number) || 1;
    return { p, n: raw.map((x) => x / l), key: `${Math.round((p[0] as number) * 1e7)},${Math.round((p[1] as number) * 1e7)},${Math.round((p[2] as number) * 1e7)}` };
  };

  const ids = new Map<string, number>();
  const pts: Crossing[] = [];
  const idOf = (c: Crossing): number => {
    const hit = ids.get(c.key);
    if (hit !== undefined) return hit;
    ids.set(c.key, pts.length);
    pts.push(c);
    return pts.length - 1;
  };
  const segs: [number, number][] = [];
  for (let k = 0; k < tris.length; k++) {
    const t = tris[k] as number;
    const v = [idx[t * 3] as number, idx[t * 3 + 1] as number, idx[t * 3 + 2] as number];
    const side = v.map((i) => dist(i) >= 0);
    if (side[0] === side[1] && side[1] === side[2]) continue;
    const found: number[] = [];
    for (let e = 0; e < 3; e++) {
      const a = e;
      const b = (e + 1) % 3;
      if (side[a] !== side[b]) found.push(idOf(crossAt(v[a] as number, v[b] as number)));
    }
    if (found.length === 2 && found[0] !== found[1]) segs.push([found[0] as number, found[1] as number]);
  }

  const adj = new Map<number, number[]>();
  segs.forEach((s, si) => {
    for (const e of s) {
      const list = adj.get(e);
      if (list) list.push(si);
      else adj.set(e, [si]);
    }
  });
  const used = new Uint8Array(segs.length);
  const loops: SectionLoop[] = [];
  for (let s0 = 0; s0 < segs.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const seq = [(segs[s0] as [number, number])[0], (segs[s0] as [number, number])[1]];
    for (;;) {
      const tail = seq[seq.length - 1] as number;
      const next = (adj.get(tail) ?? []).find((si) => !used[si]);
      if (next === undefined) break;
      used[next] = 1;
      const s = segs[next] as [number, number];
      seq.push(s[0] === tail ? s[1] : s[0]);
    }
    const closed = seq.length > 2 && seq[0] === seq[seq.length - 1];
    if (closed) seq.pop();
    if (seq.length < 3) continue;
    loops.push({ points: seq.map((i) => (pts[i] as Crossing).p), normals: seq.map((i) => (pts[i] as Crossing).n), closed });
  }
  return loops;
}
