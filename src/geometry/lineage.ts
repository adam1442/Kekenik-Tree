import type { Lineage } from '@/contracts/ports';
import type { Skeleton } from '@/contracts/skeleton';
import type { V3 } from './math3';

/** Chain of ancestor base positions of branch `branchIndex` of `sk` (highest first, own base last). */
export function chainOf(lineage: Lineage | undefined, sk: Skeleton, branchIndex: number): V3[] {
  const out: V3[] = [];
  if (lineage && branchIndex >= 0 && branchIndex + 1 < lineage.offset.length) {
    const a = lineage.offset[branchIndex] as number;
    const b = lineage.offset[branchIndex + 1] as number;
    for (let i = a; i < b; i++) out.push([lineage.points[i * 3] as number, lineage.points[i * 3 + 1] as number, lineage.points[i * 3 + 2] as number]);
    if (out.length > 0) return out;
  }
  const br = sk.branches[branchIndex];
  if (br) out.push([sk.position[br.start * 3] as number, sk.position[br.start * 3 + 1] as number, sk.position[br.start * 3 + 2] as number]);
  return out;
}

function baseDistance(sk: Skeleton, branchIndex: number, point: number, p: V3): number {
  const br = sk.branches[branchIndex];
  if (!br || point < br.start || point >= br.start + br.count) return Infinity;
  return Math.hypot((sk.position[point * 3] as number) - p[0], (sk.position[point * 3 + 1] as number) - p[1], (sk.position[point * 3 + 2] as number) - p[2]);
}

/**
 * Lineage of `skeleton` (the output of a generator) given the generator's input skeleton and its lineage. A branch's
 * parent is resolved in the input skeleton, or inside `skeleton` itself (sub-levels of one Branch node); when both
 * match, the one whose point lies closer to the branch's base wins.
 */
export function buildLineage(skeleton: Skeleton, parent: Skeleton, parentLineage: Lineage | undefined): Lineage {
  const n = skeleton.branches.length;
  const offset = new Int32Array(n + 1);
  const pIndex = new Map<number, number>();
  parent.branches.forEach((b, i) => pIndex.set(b.id, i));
  const sIndex = new Map<number, number>();
  skeleton.branches.forEach((b, i) => sIndex.set(b.id, i));
  const pts: number[] = [];
  for (let bi = 0; bi < n; bi++) {
    const b = skeleton.branches[bi]!;
    const base: V3 = [skeleton.position[b.start * 3] as number, skeleton.position[b.start * 3 + 1] as number, skeleton.position[b.start * 3 + 2] as number];
    const pi = b.parentBranch >= 0 ? pIndex.get(b.parentBranch) : undefined;
    const si = b.parentBranch >= 0 ? sIndex.get(b.parentBranch) : undefined;
    const inSelf = si !== undefined && si < bi;
    const dP = pi !== undefined ? baseDistance(parent, pi, b.parentPoint, base) : Infinity;
    const dS = inSelf ? baseDistance(skeleton, si, b.parentPoint, base) : Infinity;
    if (dS < dP && si !== undefined) {
      for (let i = offset[si] as number; i < (offset[si + 1] as number); i++) pts.push(pts[i * 3] as number, pts[i * 3 + 1] as number, pts[i * 3 + 2] as number);
    } else if (pi !== undefined) {
      for (const c of chainOf(parentLineage, parent, pi)) pts.push(c[0], c[1], c[2]);
    }
    pts.push(base[0], base[1], base[2]);
    offset[bi + 1] = pts.length / 3;
  }
  return { offset, points: Float32Array.from(pts) };
}
