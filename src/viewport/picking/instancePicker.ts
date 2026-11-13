import type { Skeleton } from '@/contracts/skeleton';
import { FLAG_HIDDEN, type InstanceTable } from '@/instances/types';

export type Vec3Tuple = readonly [number, number, number];

export interface PickRay {
  origin: Vec3Tuple;
  /** Unit direction. */
  dir: Vec3Tuple;
}

/** One generator node's instances with the skeleton they index. */
export interface PickSource {
  nodeId: string;
  skeleton: Skeleton;
  table: InstanceTable;
}

export interface PickHit {
  nodeId: string;
  row: number;
  key: number;
  /** Distance along the ray to the closest approach. */
  distance: number;
}

export interface PickOptions {
  /** World size of one screen pixel at distance 1 (2 * tan(fov / 2) / viewportHeight). */
  pixelScale: number;
  /** Click tolerance in pixels around thin branches. */
  tolerancePx?: number;
  isNodeVisible?: (nodeId: string) => boolean;
}

/** Ray vs. box (slab method) with the box grown by `pad`; returns the entry distance or -1. */
export function rayAabb(ray: PickRay, b: Float32Array, o: number, pad: number): number {
  let t0 = 0;
  let t1 = Infinity;
  for (let a = 0; a < 3; a++) {
    const d = ray.dir[a] as number;
    const lo = (b[o + a] as number) - pad;
    const hi = (b[o + 3 + a] as number) + pad;
    const org = ray.origin[a] as number;
    if (Math.abs(d) < 1e-12) {
      if (org < lo || org > hi) return -1;
    } else {
      let ta = (lo - org) / d;
      let tb = (hi - org) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) return -1;
    }
  }
  return t0;
}

/** Closest approach between the ray and the segment a-b: returns [distance between them, ray parameter]. */
export function raySegmentDistance(ray: PickRay, ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number] {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const [dx, dy, dz] = ray.dir;
  const wx = ax - ray.origin[0];
  const wy = ay - ray.origin[1];
  const wz = az - ray.origin[2];
  const a = ux * ux + uy * uy + uz * uz;
  const b = ux * dx + uy * dy + uz * dz;
  const d = ux * wx + uy * wy + uz * wz;
  const e = dx * wx + dy * wy + dz * wz;
  const denom = a - b * b; // |dir| = 1
  let s = denom > 1e-12 ? (b * e - d) / denom : 0;
  s = Math.min(1, Math.max(0, s));
  let t = e + s * b;
  if (t < 0) {
    t = 0;
    s = a > 1e-12 ? Math.min(1, Math.max(0, -d / a)) : 0;
  }
  const px = ax + ux * s;
  const py = ay + uy * s;
  const pz = az + uz * s;
  const qx = ray.origin[0] + dx * t;
  const qy = ray.origin[1] + dy * t;
  const qz = ray.origin[2] + dz * t;
  return [Math.hypot(px - qx, py - qy, pz - qz), t];
}

/**
 * Pick the instance under a ray: a broad phase over the per-instance bounds (typed arrays, no allocation) followed by a
 * refine against the skeleton capsules (segment distance <= radius + pixel tolerance). Hidden instances and nodes that
 * `isNodeVisible` rejects are ignored; the closest hit along the ray wins.
 */
export function pickInstance(sources: readonly PickSource[], ray: PickRay, opts: PickOptions): PickHit | null {
  const tol = opts.tolerancePx ?? 6;
  let best: PickHit | null = null;
  let bestScore = Infinity;
  for (const src of sources) {
    if (opts.isNodeVisible && !opts.isNodeVisible(src.nodeId)) continue;
    const { table, skeleton: sk } = src;
    for (let i = 0; i < table.count; i++) {
      if (((table.flags[i] as number) & FLAG_HIDDEN) !== 0) continue;
      const cx = ((table.bounds[i * 6] as number) + (table.bounds[i * 6 + 3] as number)) / 2 - ray.origin[0];
      const cy = ((table.bounds[i * 6 + 1] as number) + (table.bounds[i * 6 + 4] as number)) / 2 - ray.origin[1];
      const cz = ((table.bounds[i * 6 + 2] as number) + (table.bounds[i * 6 + 5] as number)) / 2 - ray.origin[2];
      const depth = Math.max(0.01, cx * ray.dir[0] + cy * ray.dir[1] + cz * ray.dir[2]);
      const pad = opts.pixelScale * depth * tol;
      if (rayAabb(ray, table.bounds, i * 6, pad) < 0) continue;
      const first = table.branchStart[i] as number;
      for (let bi = first; bi < first + (table.branchCount[i] as number); bi++) {
        const br = sk.branches[bi];
        if (!br) continue;
        for (let k = 0; k < br.count - 1; k++) {
          const p = (br.start + k) * 3;
          const q = p + 3;
          const [dist, t] = raySegmentDistance(
            ray,
            sk.position[p] as number,
            sk.position[p + 1] as number,
            sk.position[p + 2] as number,
            sk.position[q] as number,
            sk.position[q + 1] as number,
            sk.position[q + 2] as number,
          );
          const radius = Math.max(sk.radius[br.start + k] as number, sk.radius[br.start + k + 1] as number);
          const allowed = radius + opts.pixelScale * Math.max(0.01, t) * tol;
          if (dist > allowed) continue;
          // Prefer the nearest surface; break ties toward the instance whose axis is closer to the ray.
          const score = t + dist * 0.5;
          if (score < bestScore) {
            bestScore = score;
            best = { nodeId: src.nodeId, row: i, key: table.key[i] as number, distance: t };
          }
        }
      }
    }
  }
  return best;
}

export interface MarqueeRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Instances whose first point, last point or bounds centre project inside `rect` (screen pixels). */
export function marqueePick(
  sources: readonly PickSource[],
  project: (x: number, y: number, z: number) => [number, number] | null,
  rect: MarqueeRect,
  isNodeVisible?: (nodeId: string) => boolean,
): { nodeId: string; row: number; key: number }[] {
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);
  const inside = (p: [number, number] | null): boolean => p !== null && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const out: { nodeId: string; row: number; key: number }[] = [];
  for (const src of sources) {
    if (isNodeVisible && !isNodeVisible(src.nodeId)) continue;
    const { table, skeleton: sk } = src;
    for (let i = 0; i < table.count; i++) {
      if (((table.flags[i] as number) & FLAG_HIDDEN) !== 0) continue;
      const s = table.pointStart[i] as number;
      const e = s + (table.pointCount[i] as number) - 1;
      const b = table.bounds;
      const samples: [number, number, number][] = [
        [sk.position[s * 3] as number, sk.position[s * 3 + 1] as number, sk.position[s * 3 + 2] as number],
        [sk.position[e * 3] as number, sk.position[e * 3 + 1] as number, sk.position[e * 3 + 2] as number],
        [((b[i * 6] as number) + (b[i * 6 + 3] as number)) / 2, ((b[i * 6 + 1] as number) + (b[i * 6 + 4] as number)) / 2, ((b[i * 6 + 2] as number) + (b[i * 6 + 5] as number)) / 2],
      ];
      if (samples.some((p) => inside(project(p[0], p[1], p[2])))) out.push({ nodeId: src.nodeId, row: i, key: table.key[i] as number });
    }
  }
  return out;
}

/** Instance rows that are children of (`nodeId`, `row`) in the given sources. */
export function childInstances(sources: readonly PickSource[], parentKey: number): { nodeId: string; row: number; key: number }[] {
  const out: { nodeId: string; row: number; key: number }[] = [];
  for (const src of sources) {
    for (let i = 0; i < src.table.count; i++) {
      if (src.table.parentKey[i] === parentKey) out.push({ nodeId: src.nodeId, row: i, key: src.table.key[i] as number });
    }
  }
  return out;
}

/** The parent instance of (`nodeId`, `row`): searched by key in every other source's table. */
export function parentInstance(sources: readonly PickSource[], nodeId: string, row: number): { nodeId: string; row: number; key: number } | null {
  const own = sources.find((s) => s.nodeId === nodeId);
  if (!own) return null;
  const pk = own.table.parentKey[row] as number;
  if (own.table.parentInstance[row]! >= 0 && own.table.parentBranch[row]! >= 0) {
    for (const src of sources) {
      if (src.nodeId === nodeId) continue;
      for (let i = 0; i < src.table.count; i++) if (src.table.key[i] === pk) return { nodeId: src.nodeId, row: i, key: pk };
    }
  }
  // Sub-levels of one Branch node: the parent is an instance of the same node.
  for (let i = 0; i < own.table.count; i++) if (own.table.key[i] === pk) return { nodeId, row: i, key: pk };
  return null;
}
