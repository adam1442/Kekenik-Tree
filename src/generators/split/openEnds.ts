import type { Skeleton } from '@/contracts/skeleton';
import { SPLIT_ATTR, SplitFlag, selectsOpenEnd, type OpenEnd, type OpenEndSelector } from './splitMath';

/** An open end of a skeleton: the free end of a broken branch or of one side of a split. */
export interface SkeletonOpenEnd extends OpenEnd {
  branchId: number;
  /** Global point index of the last point of the branch. */
  pointIndex: number;
  /** Flags of the branch's `splitInfo`. */
  flags: number;
  /** The end is a break (not a split side). */
  broken: boolean;
}

/**
 * Collects the open ends of a skeleton from its `openEnd` / `splitInfo` attributes (written by Break and Skin > Splits): position,
 * radius and direction of the last point of every branch flagged open. Optionally keeps only the ends that `select` takes.
 */
export function collectOpenEnds(sk: Skeleton, select?: OpenEndSelector): SkeletonOpenEnd[] {
  const open = sk.attributes.get('openEnd');
  if (!open || open.length !== sk.count) return [];
  const info = sk.attributes.get(SPLIT_ATTR);
  const out: SkeletonOpenEnd[] = [];
  for (const b of sk.branches) {
    if (b.count < 2 || (open[b.start] as number) <= 0) continue;
    const flags = info && info.length === sk.count ? Math.round(info[b.start] as number) : 0;
    const isSide = (flags & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0;
    const broken = !isSide;
    if (select && !selectsOpenEnd(select, flags, broken)) continue;
    const i = b.start + b.count - 1;
    const dx = sk.direction[i * 3] as number;
    const dy = sk.direction[i * 3 + 1] as number;
    const dz = sk.direction[i * 3 + 2] as number;
    const l = Math.hypot(dx, dy, dz) || 1;
    out.push({
      position: [sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number],
      direction: [dx / l, dy / l, dz / l],
      radius: sk.radius[i] as number,
      side: flags & SplitFlag.Side1 ? 1 : flags & SplitFlag.Side2 ? 2 : 0,
      fat: (flags & SplitFlag.Fat) !== 0,
      branchId: b.id,
      pointIndex: i,
      flags,
      broken,
    });
  }
  return out;
}
