import type { Skeleton } from '@/contracts/skeleton';
import { UV_TILES_ATTR, UV_UOFFSET_ATTR } from '@/generators/uv/types';
import { SPLIT_ATTR, SplitFlag, selectsOpenEnd, type OpenEnd, type OpenEndFrame, type OpenEndSelector, type Vec3 } from './splitMath';

/** An open end of a skeleton: the free end of a broken branch or of one side of a split. */
export interface SkeletonOpenEnd extends OpenEnd {
  branchId: number;
  /** Global point index of the last point of the branch. */
  pointIndex: number;
  /** Flags of the branch's `splitInfo`. */
  flags: number;
  /** The end is a break (not a split side). */
  broken: boolean;
  /** Radial count of the branch that ends here (0 = not stored): a cap / extension uses it so its first ring matches the end ring. */
  radialSides: number;
}

/**
 * Collects the open ends of a skeleton from its `openEnd` / `splitInfo` attributes (written by Break and Skin > Splits): position,
 * radius and direction of the last point of every branch flagged open. Optionally keeps only the ends that `select` takes.
 */
export function collectOpenEnds(sk: Skeleton, select?: OpenEndSelector): SkeletonOpenEnd[] {
  const open = sk.attributes.get('openEnd');
  if (!open || open.length !== sk.count) return [];
  const info = sk.attributes.get(SPLIT_ATTR);
  const nx = sk.attributes.get('rmfNormalX');
  const ny = sk.attributes.get('rmfNormalY');
  const nz = sk.attributes.get('rmfNormalZ');
  const sides = sk.attributes.get('radialSides');
  const tiles = sk.attributes.get(UV_TILES_ATTR);
  const uOff = sk.attributes.get(UV_UOFFSET_ATTR);
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
    // Frame around the direction from the branch's transported normal; U tiling and start of the end as the parent's mesher wrote them
    const frame = nx && ny && nz && nx.length === sk.count ? endFrame([dx / l, dy / l, dz / l], [nx[i] as number, ny[i] as number, nz[i] as number]) : undefined;
    const hasUv = tiles !== undefined && tiles.length === sk.count && (tiles[i] as number) > 0;
    out.push({
      position: [sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number],
      direction: [dx / l, dy / l, dz / l],
      radius: sk.radius[i] as number,
      side: flags & SplitFlag.Side1 ? 1 : flags & SplitFlag.Side2 ? 2 : 0,
      fat: (flags & SplitFlag.Fat) !== 0,
      ...(isSide ? { kind: (flags & SplitFlag.Fat) !== 0 ? ('fat' as const) : ('skinny' as const) } : {}),
      branchId: b.id,
      pointIndex: i,
      flags,
      broken,
      radialSides: sides && sides.length === sk.count ? Math.round(sides[b.start] as number) : 0,
      ...(frame ? { frame } : {}),
      ...(hasUv ? { uTiles: tiles[i] as number, uStart: uOff && uOff.length === sk.count ? (uOff[i] as number) : 0 } : {}),
    });
  }
  return out;
}

/** Orthonormal frame (`normal` x `binormal` = `direction`) from a hint normal that is projected off the direction. */
function endFrame(direction: Vec3, hint: Vec3): OpenEndFrame {
  const d = direction[0] * hint[0] + direction[1] * hint[1] + direction[2] * hint[2];
  let n: Vec3 = [hint[0] - direction[0] * d, hint[1] - direction[1] * d, hint[2] - direction[2] * d];
  let nl = Math.hypot(n[0], n[1], n[2]);
  if (nl < 1e-6) {
    n = Math.abs(direction[0]) < 0.9 ? [0, -direction[2], direction[1]] : [direction[2], 0, -direction[0]];
    nl = Math.hypot(n[0], n[1], n[2]) || 1;
  }
  const normal: Vec3 = [n[0] / nl, n[1] / nl, n[2] / nl];
  const b: Vec3 = [
    direction[1] * normal[2] - direction[2] * normal[1],
    direction[2] * normal[0] - direction[0] * normal[2],
    direction[0] * normal[1] - direction[1] * normal[0],
  ];
  const bl = Math.hypot(b[0], b[1], b[2]) || 1;
  return { normal, binormal: [b[0] / bl, b[1] / bl, b[2] / bl] };
}
