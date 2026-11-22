import { evaluateCurve, type Curve } from '@/contracts/curve';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { isSpineOnly } from '@/generators/skin';
import { parentSurfaceFor, solveWeld, weldHeightFraction, weldKept, weldRingCount, type ChildPath } from '@/generators/weld';
import { squashedParentSurface } from '@/geometry/tubeMesher';
import { computePolylineRMF, type PreparedParentBranch, type Vec3 } from './frames';
import type { StructureSkeletonBuilder } from './skeletonBuild';

/** Skeleton attribute: 0 = no weld, 1 = fused to the parent, 2 = the weld failed and the branch was kept. */
export const WELD_ATTR = 'weld';
/** Skeleton attribute: 1 when the parent of a welded branch is a branch of the same skeleton (sub-level of one node). */
export const WELD_SELF_ATTR = 'weldSelf';

export const WELD_STATE = { none: 0, welded: 1, failedKept: 2 } as const;

/** Columns used to decide whether a weld works (the mesher uses the real radial segment count). */
const ANALYSIS_SIDES = 12;

/** Skin > Welding of a generator. */
export interface WeldConfig {
  enabled: boolean;
  keep: Curve | undefined;
  keepFailed: boolean;
  forceRays: boolean;
  /** Length of the weld part beyond the skin, in child radii. */
  offset: number;
  spreadAmount: number;
  upperScale: number;
  lowerScale: number;
  /** Length > Weld scalar. */
  scalar: number;
}

export function readWeldConfig(params: NodeParams): WeldConfig {
  return {
    enabled: getBool(params, 'weldEnabled', false) && !isSpineOnly(params),
    keep: params.weldKeep?.curve ?? undefined,
    keepFailed: getBool(params, 'weldKeepFailed', false),
    forceRays: getBool(params, 'weldForceRays', false),
    offset: Math.max(0, getNumber(params, 'weldOffset', 1.5)),
    spreadAmount: Math.max(0, getNumber(params, 'weldSpreadAmount', 0.3)),
    upperScale: Math.max(0, getNumber(params, 'weldSpreadUpper', 0.2)),
    lowerScale: Math.max(0, getNumber(params, 'weldSpreadLower', 0.1)),
    scalar: Math.max(0, getNumber(params, 'weldScalar', 1)),
  };
}

/** Child centre line with ring frames and arc length, from raw polyline points. */
export function childPathFromPolyline(positions: ArrayLike<number>, radii: ArrayLike<number>, count: number): ChildPath {
  const frames = computePolylineRMF(positions, count);
  const s = new Float32Array(count);
  for (let k = 1; k < count; k++) {
    s[k] =
      (s[k - 1] as number) +
      Math.hypot(
        (positions[k * 3] as number) - (positions[(k - 1) * 3] as number),
        (positions[k * 3 + 1] as number) - (positions[(k - 1) * 3 + 1] as number),
        (positions[k * 3 + 2] as number) - (positions[(k - 1) * 3 + 2] as number),
      );
  }
  return { count, pos: positions, rad: radii, nrm: frames.normals, tan: frames.tangents, s };
}

export function weldSettingsFrom(cfg: WeldConfig, sides: number, childRadius: number): {
  sides: number;
  segments: number;
  offset: number;
  spread: number;
  upper: number;
  lower: number;
} {
  return {
    sides,
    segments: weldRingCount(cfg.scalar) - 1,
    offset: cfg.offset * childRadius,
    spread: cfg.spreadAmount,
    upper: cfg.upperScale,
    lower: cfg.lowerScale,
  };
}

/** Per-level state of the weld pass: the parent skeleton and the height range the Keep curve is measured on. */
export interface WeldLevel {
  readonly cfg: WeldConfig;
  readonly parent: Skeleton;
  readonly parentIsSelf: boolean;
  readonly zMin: number;
  readonly zMax: number;
}

export function createWeldLevel(cfg: WeldConfig, parent: Skeleton, parentIsSelf: boolean): WeldLevel | null {
  if (!cfg.enabled || parent.count === 0) return null;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < parent.count; i++) {
    const z = parent.position[i * 3 + 2] as number;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  return { cfg, parent, parentIsSelf, zMin, zMax };
}

export interface WeldChildInput {
  /** Index of the child's first branch in the builder (`builder.branchCount` before it was grown). */
  firstBranch: number;
  prep: PreparedParentBranch;
  /** Attachment point on the parent spine. */
  position: Vec3;
  /** Global parent point index nearest to the attachment. */
  parentPoint: number;
}

/**
 * Decides the weld of one freshly grown child: applies the Keep curve, runs the weld solver on the child's spine and writes
 * the `weld` attributes. A failed weld removes the child (unless Keep failed). Returns the number of branches removed.
 */
export function weldChild(level: WeldLevel, builder: StructureSkeletonBuilder, input: WeldChildInput): number {
  const first = input.firstBranch;
  const view = builder.branchView(first);
  if (!view || view.count < 2) return 0;
  const { cfg } = level;
  const keepValue = cfg.keep ? evaluateCurve(cfg.keep, weldHeightFraction(input.position[2], level.zMin, level.zMax)) : 1;
  if (!weldKept(keepValue)) return 0;

  const prep = input.prep;
  const parentSides = level.parent.attributes.get('radialSides')?.[prep.branch.start] ?? 0;
  const base: [number, number, number] = [view.positions[0] as number, view.positions[1] as number, view.positions[2] as number];
  const rawSurface = parentSurfaceFor(prep.positions, prep.radii, prep.branch.count, base, input.parentPoint - prep.branch.start, parentSides, cfg.forceRays);
  const surface = rawSurface ? squashedParentSurface(rawSurface, level.parent, input.parentPoint, base) : null;
  let ok = false;
  if (surface) {
    const path = childPathFromPolyline(view.positions, view.radii, view.count);
    const st = weldSettingsFrom(cfg, ANALYSIS_SIDES, view.radii[0] as number);
    ok = solveWeld(path, surface, { ...st, analyzeOnly: true }).ok;
  }
  if (ok || cfg.keepFailed) {
    builder.setBranchExtra(first, WELD_ATTR, ok ? WELD_STATE.welded : WELD_STATE.failedKept);
    if (level.parentIsSelf) builder.setBranchExtra(first, WELD_SELF_ATTR, 1);
    return 0;
  }
  const removed = builder.branchCount - first;
  builder.truncate(first);
  return removed;
}
