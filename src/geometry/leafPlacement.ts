import { cross, dot, len, norm, orthogonalize, rotate, sub, type V3 } from './math3';

/**
 * Pure placement / orientation maths of the Leaf generator (no graph or mesh dependencies).
 *
 * Leaf frame: `axis` = local +Y (growth, base -> tip), `side` = local +X (across the blade),
 * normal = local +Z = `side x axis` (the face of the leaf).
 */

export type AnchorStyle = 'none' | 'global' | 'deep' | 'intermediate' | 'local';
export const ANCHOR_STYLES: readonly AnchorStyle[] = ['none', 'global', 'deep', 'intermediate', 'local'];
export type ParentFrameStyle = 'legacy' | 'match-parent';
export type InitialOrientation = 'classic' | 'synchronized';

export const asAnchorStyle = (v: string): AnchorStyle => ((ANCHOR_STYLES as readonly string[]).includes(v) ? (v as AnchorStyle) : 'none');

export interface LeafFrame {
  axis: V3;
  side: V3;
}

export const frameNormal = (f: LeafFrame): V3 => norm(cross(f.side, f.axis));

const UP: V3 = [0, 0, 1];
const EPS = 1e-9;
const clamp1 = (x: number): number => Math.max(-1, Math.min(1, x));

/** Re-orthonormalise a frame (axis wins, side is made perpendicular to it). */
function tidy(f: LeafFrame): LeafFrame {
  const axis = norm(f.axis, [0, 1, 0]);
  const side = orthogonalize(f.side, axis);
  return { axis, side };
}

function rotateFrame(f: LeafFrame, about: V3, angle: number): LeafFrame {
  if (Math.abs(angle) < EPS) return f;
  return tidy({ axis: rotate(f.axis, about, angle), side: rotate(f.side, about, angle) });
}

/** Signed angle from `a` to `b` around unit `about` (both are projected onto the plane first). */
export function signedAngleAround(a: V3, b: V3, about: V3): number {
  const pa = orthogonalize(a, about);
  const pb = orthogonalize(b, about);
  return Math.atan2(dot(about, cross(pa, pb)), dot(pa, pb));
}

/* ---------------------------------------------------------------------------------------- anchors */

/**
 * Ancestor chain of a parent branch as base positions, highest ancestor first; the last entry is the base of the parent
 * branch itself. Anchor styles pick one point of this chain.
 */
export function anchorFromChain(chain: readonly V3[], style: AnchorStyle): V3 | null {
  const n = chain.length;
  if (n === 0 || style === 'none') return null;
  switch (style) {
    case 'global':
      return chain[0] as V3;
    case 'deep':
      return chain[Math.min(1, n - 1)] as V3;
    case 'intermediate':
      return chain[Math.floor((n - 1) / 2)] as V3;
    case 'local':
      return chain[n - 1] as V3;
  }
}

/** `computeAnchorPoint(instanceKey, style)` with a per-(parent, style) cache. `chainOf` resolves a parent key. */
export class AnchorResolver {
  private readonly cache = new Map<number, V3 | null>();

  constructor(private readonly chainOf: (instanceKey: number) => readonly V3[]) {}

  computeAnchorPoint(instanceKey: number, style: AnchorStyle): V3 | null {
    if (style === 'none') return null;
    const k = instanceKey * 8 + ANCHOR_STYLES.indexOf(style);
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    const v = anchorFromChain(this.chainOf(instanceKey), style);
    this.cache.set(k, v);
    return v;
  }
}

/** Unit vector from the anchor through the attachment point ("out"), or null when degenerate / no anchor. */
export function outFromAnchor(anchor: V3 | null, attach: V3): V3 | null {
  if (!anchor) return null;
  const d = sub(attach, anchor);
  return len(d) < 1e-6 ? null : norm(d);
}

/* ------------------------------------------------------------------------------ parent basis */

/** Reference basis around the parent tangent for the outward direction. `legacy` ignores the parent's own frame twist. */
export function parentBasis(tangent: V3, normal: V3, binormal: V3, style: ParentFrameStyle): { normal: V3; binormal: V3 } {
  if (style === 'match-parent') return { normal, binormal };
  const t = norm(tangent, UP);
  const n = orthogonalize(UP, t);
  return { normal: n, binormal: norm(cross(t, n), binormal) };
}

/* -------------------------------------------------------------------------------- orientation */

export interface LocalOrientation {
  unification: AnchorStyle;
  /** 0..1 */
  sky: number;
  /** Radians, around the parent's growth direction. */
  fold: number;
  /** Radians, tip toward (+) / away from (-) the parent's growth direction. */
  align: number;
  /** 0..1 spin that brings the leaf's up vector toward the parent's growth direction. */
  face: number;
}

export interface ParentSensitivity {
  /** 0..1 */
  amount: number;
  anchor: AnchorStyle;
  /** 0..1 */
  sky: number;
}

export interface FinalAdjustments {
  /** Radians around local X / Y / Z. */
  up: number;
  right: number;
  out: number;
}

export interface OrientContext {
  /** Attachment point (after weld). */
  position: V3;
  /** Parent growth direction at the attachment. */
  parentTangent: V3;
  anchor(style: AnchorStyle): V3 | null;
}

export const NEUTRAL_LOCAL: LocalOrientation = { unification: 'none', sky: 0, fold: 0, align: 0, face: 0 };
export const NEUTRAL_SENSITIVITY: ParentSensitivity = { amount: 0, anchor: 'none', sky: 0 };
export const NEUTRAL_FINAL: FinalAdjustments = { up: 0, right: 0, out: 0 };

/** Execution order of `orientLeaf` (also written to its optional trace). */
export const ORIENTATION_STEPS = ['anchorStyle', 'unification', 'sky', 'fold', 'align', 'face', 'sensitivityAmount', 'sensitivitySky', 'final'] as const;
export type OrientationStep = (typeof ORIENTATION_STEPS)[number];

/** Spin around the leaf axis so the leaf normal gets closer to `target` (`fraction` 0..1 of the full turn). */
function spinTowards(f: LeafFrame, target: V3, fraction: number): LeafFrame {
  if (fraction <= 0) return f;
  const a = signedAngleAround(frameNormal(f), target, f.axis);
  return rotateFrame(f, f.axis, a * Math.min(1, fraction));
}

/**
 * Local orientation pipeline, applied in this order:
 * (1) 3D anchor style (selects the parent basis before this call), (2) Unification, (3) Sky influence, (4) Fold,
 * (5) Align, (6) Face, then Sensitivity -> Parent (Amount, Sky) and finally the Final adjustments as one group.
 */
export function orientLeaf(
  start: LeafFrame,
  ctx: OrientContext,
  local: LocalOrientation,
  sens: ParentSensitivity,
  fin: FinalAdjustments,
  trace?: OrientationStep[],
): LeafFrame {
  let f = tidy(start);
  const T = norm(ctx.parentTangent, UP);
  trace?.push('anchorStyle');

  trace?.push('unification');
  const out = local.unification === 'none' ? null : outFromAnchor(ctx.anchor(local.unification), ctx.position);
  if (out) {
    const c = cross(f.axis, out);
    if (len(c) > 1e-9) f = rotateFrame(f, norm(c), Math.acos(clamp1(dot(f.axis, out))));
    else if (dot(f.axis, out) < 0) f = rotateFrame(f, f.side, Math.PI);
  }

  trace?.push('sky');
  if (local.sky > 0) {
    const n = frameNormal(f);
    const c = cross(n, UP);
    const about = len(c) < 1e-9 ? f.side : norm(c);
    f = rotateFrame(f, about, Math.acos(clamp1(dot(n, UP))) * Math.min(1, local.sky));
  }

  trace?.push('fold');
  f = rotateFrame(f, T, local.fold);

  trace?.push('align');
  if (Math.abs(local.align) > EPS) {
    const h = cross(f.axis, T);
    f = rotateFrame(f, len(h) < 1e-9 ? f.side : norm(h), local.align);
  }

  trace?.push('face');
  if (local.face > 0) f = spinTowards(f, T, local.face);

  trace?.push('sensitivityAmount');
  if (sens.amount > 0) {
    const anchor = ctx.anchor(sens.anchor);
    const to = anchor ? sub(anchor, ctx.position) : null;
    if (to && len(to) > 1e-6) f = spinTowards(f, [-to[0], -to[1], -to[2]], sens.amount);
  }

  trace?.push('sensitivitySky');
  if (sens.sky > 0) f = spinTowards(f, UP, sens.sky);

  trace?.push('final');
  return applyFinal(f, fin);
}

/** Up (local X), Right (local Y) and Out (local Z) rotations composed about the frame's original axes (X first). */
export function applyFinal(f: LeafFrame, fin: FinalAdjustments): LeafFrame {
  if (Math.abs(fin.up) < EPS && Math.abs(fin.right) < EPS && Math.abs(fin.out) < EPS) return f;
  const x = f.side;
  const y = f.axis;
  const z = frameNormal(f);
  const turn = (v: V3): V3 => rotate(rotate(rotate(v, x, fin.up), y, fin.right), z, fin.out);
  return tidy({ axis: turn(f.axis), side: turn(f.side) });
}

/* --------------------------------------------------------------------------------------- weld */

/** Parents thinner than this have no skin to weld to (leaf / frond parents, hair-thin spines). */
export const WELD_MIN_RADIUS = 0.0015;

/** Point of the parent tube's skin in direction `outward` from its spine point; null when the parent has no skin. */
export function weldToSkin(spine: V3, tangent: V3, outward: V3, radius: number): V3 | null {
  if (!(radius >= WELD_MIN_RADIUS)) return null;
  const o = orthogonalize(outward, norm(tangent, UP));
  return [spine[0] + o[0] * radius, spine[1] + o[1] * radius, spine[2] + o[2] * radius];
}

/* -------------------------------------------------------------------------------- cross / side */

/** Side direction of the crossed copy: the leaf turned 90 degrees about its growth axis. */
export const crossedSide = (side: V3, axis: V3): V3 => rotate(side, norm(axis, [0, 1, 0]), Math.PI / 2);

/**
 * Left / right side (+1 / -1) of a leaf: its own Interval / Phyllotaxy placement side, else the parent's `side`
 * attribute, else a random side (`random` yields 0..1).
 */
export function resolveSide(placementSide: number, parentSide: number, random: () => number): 1 | -1 {
  if (placementSide !== 0) return placementSide > 0 ? 1 : -1;
  if (parentSide !== 0) return parentSide > 0 ? 1 : -1;
  return random() < 0.5 ? -1 : 1;
}

/** Whether a leaf is mirrored across its local Y axis. `flipDraw` is a 0..1 random number. */
export function isMirrored(flip: boolean, initial: InitialOrientation, side: number, flipDraw: number): boolean {
  if (flip) return flipDraw < 0.5;
  return initial === 'classic' && side < 0;
}

/** Size multiplier: `size` plus `percentOfParent` (a fraction) times the parent's size. */
export function effectiveSize(size: number, percentOfParent: number, parentSize: number): number {
  return Math.max(0.001, size + percentOfParent * parentSize);
}
