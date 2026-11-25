import type { Branch, Skeleton } from '@/contracts/skeleton';
import { SPLIT_ATTR, SplitFlag } from '@/generators/split';
import { findSplitLobes, transitionStart } from '@/geometry/splitCrotch';
import type { PreparedParentBranch } from './frames';

/**
 * A split is ONE logical spine for every generator that hangs on it: the parent spine up to the start of the shared
 * transition. The two fused halves are only open ends (Extend parent / Cap continue them), never parents for ordinary children.
 */

/**
 * Radial count of the end ring a consumer must use: a fused half ends in a ring of N / 2 vertices (the other N / 2 belong to the
 * other half), every other end in N. 0 (unknown) stays 0.
 */
export function endRingSides(sides: number, isHalf: boolean): number {
  if (!(sides >= 3)) return 0;
  return isHalf ? Math.max(3, Math.round(sides / 2)) : Math.round(sides);
}

/** Ids of the branches that are one fused half of a split. */
export function splitHalfIds(sk: Skeleton): Set<number> {
  const out = new Set<number>();
  const flags = sk.attributes.get(SPLIT_ATTR);
  if (!flags || flags.length !== sk.count) return out;
  for (const b of sk.branches) {
    if ((Math.round(flags[b.start] as number) & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0) out.add(b.id);
  }
  return out;
}

/** Whether a branch ends in a split (its tip is fused into two halves). */
export function branchIsSplitParent(sk: Skeleton, branch: Branch): boolean {
  const flags = sk.attributes.get(SPLIT_ATTR);
  if (!flags || flags.length !== sk.count) return false;
  return (Math.round(flags[branch.start] as number) & SplitFlag.Parent) !== 0;
}

/** Cuts the prepared parent where the shared transition starts: the true tube, with the transition start as its last point. */
export function truncatePrepared(prep: PreparedParentBranch, keep: number, tail: { pos: readonly [number, number, number]; rad: number }): PreparedParentBranch {
  const n = Math.min(prep.branch.count, Math.max(2, keep));
  const positions = prep.positions.slice(0, n * 3);
  const radii = prep.radii.slice(0, n);
  const ages = prep.ages.slice(0, n);
  const tangents = prep.tangents.slice(0, n * 3);
  const normals = prep.normals.slice(0, n * 3);
  const binormals = prep.binormals.slice(0, n * 3);
  const curvatures = prep.curvatures.slice(0, n);
  const last = n - 1;
  const a = last - 1;
  // Frames of the new last point: the neighbouring frames blended by where the transition start lies on that segment
  const seg = Math.hypot(
    (prep.positions[last * 3] as number) - (prep.positions[a * 3] as number),
    (prep.positions[last * 3 + 1] as number) - (prep.positions[a * 3 + 1] as number),
    (prep.positions[last * 3 + 2] as number) - (prep.positions[a * 3 + 2] as number),
  );
  const cut = Math.hypot(tail.pos[0] - (positions[a * 3] as number), tail.pos[1] - (positions[a * 3 + 1] as number), tail.pos[2] - (positions[a * 3 + 2] as number));
  const f = seg > 1e-12 ? Math.min(1, Math.max(0, cut / seg)) : 1;
  const blend = (arr: Float32Array): void => {
    for (let k = 0; k < 3; k++) arr[last * 3 + k] = (arr[a * 3 + k] as number) * (1 - f) + (arr[last * 3 + k] as number) * f;
    const l = Math.hypot(arr[last * 3] as number, arr[last * 3 + 1] as number, arr[last * 3 + 2] as number) || 1;
    for (let k = 0; k < 3; k++) arr[last * 3 + k] = (arr[last * 3 + k] as number) / l;
  };
  blend(tangents);
  blend(normals);
  blend(binormals);
  positions[last * 3] = tail.pos[0];
  positions[last * 3 + 1] = tail.pos[1];
  positions[last * 3 + 2] = tail.pos[2];
  radii[last] = tail.rad;
  curvatures[last] = 0;

  const t = new Float32Array(n);
  let total = 0;
  for (let k = 1; k < n; k++) {
    total += Math.hypot(
      (positions[k * 3] as number) - (positions[(k - 1) * 3] as number),
      (positions[k * 3 + 1] as number) - (positions[(k - 1) * 3 + 1] as number),
      (positions[k * 3 + 2] as number) - (positions[(k - 1) * 3 + 2] as number),
    );
    t[k] = total;
  }
  if (total > 1e-12) for (let k = 0; k < n; k++) t[k] = (t[k] as number) / total;
  return { ...prep, branch: { ...prep.branch, count: n, length: total }, positions, radii, ages, t, tangents, normals, binormals, curvatures, arcLength: total };
}

/** Per-level view of the parent skeleton's splits: which branches are halves, and the cut of every splitting parent. */
export interface FusedParents {
  /** Branch ids of the fused halves. */
  readonly halves: ReadonlySet<number>;
  /** The prepared parent as the true tube (unchanged when the branch does not split). */
  prepare(branch: Branch, prep: PreparedParentBranch): PreparedParentBranch;
}

export function createFusedParents(sk: Skeleton): FusedParents {
  const halves = splitHalfIds(sk);
  const lobes = halves.size > 0 ? findSplitLobes(sk) : new Map<number, { side1: number; side2: number; keep: number }>();
  const byBranchId = new Map<number, { side1: number; keep: number }>();
  lobes.forEach((v, parentIndex) => {
    const parent = sk.branches[parentIndex];
    if (parent) byBranchId.set(parent.id, v);
  });
  return {
    halves,
    prepare(branch, prep) {
      const hit = byBranchId.get(branch.id);
      const lobe = hit ? sk.branches[hit.side1] : undefined;
      if (!hit || !lobe) return prep;
      return truncatePrepared(prep, hit.keep, transitionStart(sk, branch, lobe, hit.keep));
    },
  };
}
