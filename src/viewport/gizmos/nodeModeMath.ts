import type { Skeleton } from '@/contracts/skeleton';
import type { InstanceTable } from '@/instances/types';
import type { PickRay } from '../picking/instancePicker';

export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3, fallback: V3 = [0, 0, 1]): V3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : fallback;
};

/** Any unit vector perpendicular to `v`. */
export function perpendicular(v: V3): V3 {
  const helper: V3 = Math.abs(v[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  return norm(cross(v, helper), [1, 0, 0]);
}

/** Wrap an angle difference to [-PI, PI] so continuous drags never jump at the +-180 degree seam. */
export function wrapAngle(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** Angle of `p` around `center` in the plane spanned by the unit vectors `u`, `v`. */
export function planeAngle(p: V3, center: V3, u: V3, v: V3): number {
  const d = sub(p, center);
  return Math.atan2(dot(d, v), dot(d, u));
}

/** Ray / plane intersection; null when parallel or behind the origin. */
export function rayPlane(ray: PickRay, point: V3, normal: V3): V3 | null {
  const d: V3 = [ray.dir[0], ray.dir[1], ray.dir[2]];
  const denom = dot(normal, d);
  if (Math.abs(denom) < 1e-9) return null;
  const t = dot(normal, sub(point, [ray.origin[0], ray.origin[1], ray.origin[2]])) / denom;
  if (t < 0) return null;
  return add([ray.origin[0], ray.origin[1], ray.origin[2]], scale(d, t));
}

/** Parameter `s` (metres from `p` along unit `dir`) of the point on the line closest to the ray. */
export function lineParamClosestToRay(ray: PickRay, p: V3, dir: V3): number {
  const d: V3 = [ray.dir[0], ray.dir[1], ray.dir[2]];
  const w = sub(p, [ray.origin[0], ray.origin[1], ray.origin[2]]);
  const b = dot(dir, d);
  const dd = dot(dir, w);
  const e = dot(d, w);
  const denom = 1 - b * b;
  if (denom < 1e-9) return 0;
  return (b * e - dd) / denom;
}

/** Normalised arc-length position (0..1 along the branch) of the polyline point closest to the ray. */
export function polylineUClosestToRay(ray: PickRay, sk: Skeleton, branchIndex: number): number {
  const b = sk.branches[branchIndex];
  if (!b || b.count < 2) return 0;
  let best = Infinity;
  let bestU = 0;
  for (let k = 0; k < b.count - 1; k++) {
    const i = b.start + k;
    const a: V3 = [sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!];
    const c: V3 = [sk.position[i * 3 + 3]!, sk.position[i * 3 + 4]!, sk.position[i * 3 + 5]!];
    const seg = sub(c, a);
    const segLen = len(seg);
    if (segLen < 1e-9) continue;
    const dir = scale(seg, 1 / segLen);
    const s = closestSegParam(ray, a, dir, segLen);
    const p = add(a, scale(dir, s));
    const o: V3 = [ray.origin[0], ray.origin[1], ray.origin[2]];
    const w = sub(p, o);
    const t = Math.max(0, dot(w, [ray.dir[0], ray.dir[1], ray.dir[2]]));
    const q = add(o, scale([ray.dir[0], ray.dir[1], ray.dir[2]], t));
    const dist = len(sub(p, q));
    if (dist < best) {
      best = dist;
      const t0 = sk.t[i] as number;
      const t1 = sk.t[i + 1] as number;
      bestU = t0 + (t1 - t0) * (s / segLen);
    }
  }
  return Math.min(1, Math.max(0, bestU));
}

function closestSegParam(ray: PickRay, a: V3, dir: V3, segLen: number): number {
  return Math.min(segLen, Math.max(0, lineParamClosestToRay(ray, a, dir)));
}

/** Geometry the gizmo is built from (all world space, metres). */
export interface InstanceFrame {
  origin: V3;
  tip: V3;
  mid: V3;
  /** Unit direction of the first segment of the branch. */
  branchDir: V3;
  /** Unit tangent of the parent spine at the attachment (world up for first generation). */
  parentAxis: V3;
  /** Angle between parent axis and branch (degrees). */
  spreadDeg: number;
  /** Chord length origin -> tip. */
  length: number;
  rootLevel: boolean;
  /** Branch index (in the parent's skeleton) the instance grows from, -1 for first generation. */
  parentBranch: number;
  /** Index into `parentCandidates` of the skeleton the attachment point belongs to (-1 = none). */
  parentCandidate: number;
}

/**
 * Frame of one instance. `parentCandidates` are the skeletons the branch's `parentPoint` may index (the parent node's
 * skeleton, or the node's own skeleton for sub-levels of a Branch node); the one whose point lies nearest the branch
 * origin is used.
 */
export function computeInstanceFrame(sk: Skeleton, table: InstanceTable, row: number, parentCandidates: readonly Skeleton[]): InstanceFrame | null {
  const bi = table.branchStart[row] as number;
  const b = sk.branches[bi];
  if (!b || b.count < 2) return null;
  const pt = (i: number): V3 => [sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!];
  const origin = pt(b.start);
  const tip = pt(b.start + b.count - 1);
  const mid = pt(b.start + Math.min(b.count - 1, Math.max(1, Math.round((b.count - 1) * 0.55))));
  const branchDir = norm(sub(pt(b.start + 1), origin));
  let parentAxis: V3 = [0, 0, 1];
  let parentCandidate = -1;
  const rootLevel = b.parentPoint < 0;
  if (!rootLevel) {
    let bestD = Infinity;
    for (const [ci, cand] of parentCandidates.entries()) {
      const pp = b.parentPoint;
      if (pp < 0 || pp >= cand.count) continue;
      const q: V3 = [cand.position[pp * 3]!, cand.position[pp * 3 + 1]!, cand.position[pp * 3 + 2]!];
      const d = len(sub(q, origin));
      if (d < bestD) {
        bestD = d;
        parentCandidate = ci;
        parentAxis = norm([cand.tangent[pp * 3]!, cand.tangent[pp * 3 + 1]!, cand.tangent[pp * 3 + 2]!]);
      }
    }
  }
  const spreadDeg = (Math.acos(Math.min(1, Math.max(-1, dot(parentAxis, branchDir)))) * 180) / Math.PI;
  return { origin, tip, mid, branchDir, parentAxis, spreadDeg, length: len(sub(tip, origin)), rootLevel, parentBranch: table.parentBranch[row] as number, parentCandidate };
}

/** Orthonormal basis (u, v) of the plane perpendicular to `axis`, with `u` along the projection of `ref`. */
export function planeBasis(axis: V3, ref: V3): { u: V3; v: V3 } {
  const proj = sub(ref, scale(axis, dot(ref, axis)));
  const u = len(proj) > 1e-6 ? norm(proj) : perpendicular(axis);
  return { u, v: norm(cross(axis, u)) };
}

/** Snap `v` to multiples of `step` when `on`. */
export function snap(v: number, step: number, on: boolean): number {
  return on ? Math.round(v / step) * step : v;
}
