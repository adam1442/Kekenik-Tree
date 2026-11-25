/**
 * Natural split model (pure math). A branch that splits keeps ONE continuous skin: the parent spine runs on as the shared axis
 * through a transition zone and both halves ("lobes") leave that axis along a smooth Hermite path, ending as two circles that are
 * exactly tangent. Each lobe end is an open end that Extend parent / Cap continue.
 *
 * Everything here is plain math on tuples and typed arrays: no graph, no mesher. The tree stands along +Z.
 */
import type { Rng } from '@/core/rng';
import { rotateAbout, splitShapeOf, type SplitForkMode, type SplitSettings, type OpenEnd, type Vec3 } from './splitMath';

/** Shortest radius of a half relative to the parent (keeps a skinny half from turning into a thread). */
export const SPLIT_MIN_RADIUS_FRACTION = 0.2;
/** Transition length in parent radii and its bounds as fractions of the parent spine length. */
export const SPLIT_TRANSITION_RADII = 3.5;
export const SPLIT_TRANSITION_MIN_FRACTION = 0.08;
export const SPLIT_TRANSITION_MAX_FRACTION = 0.35;
/** Seeded jitter of the divergence axis around the parent direction (degrees, +-). */
export const SPLIT_AXIS_JITTER_DEG = 15;
/** Largest ring-to-ring direction change the lobe sampling aims for (degrees). */
const MAX_RING_TURN_DEG = 5;
const MIN_SEGMENTS = 5;
/** A figure-8 transition needs more rings to resolve the neck: the least number of segments of a non-neutral shape. */
export const SPLIT_SHAPE_MIN_SEGMENTS = 12;
const MAX_SEGMENTS = 48;

/** Fat half of a dominant leader keeps this fraction of its Spread at full Dominance (the lateral fork: LATERAL_KINK). */
export const SPLIT_DOMINANT_KINK = 0.25;
export const SPLIT_LATERAL_KINK = 0.2;
/** Area fraction the fat half reaches at full Dominance / in a lateral fork (the rest is the thin side branch). */
export const SPLIT_DOMINANT_AREA = 0.85;
export const SPLIT_LATERAL_AREA = 0.88;
/** Junction shape a lateral fork implies when Skin > Split shape is not set (neck swell, ridge, valley fillet). */
export const SPLIT_LATERAL_SWELL = 0.12;
export const SPLIT_LATERAL_RIDGE = 0.15;
export const SPLIT_LATERAL_VALLEY = 0.12;

const DEG = Math.PI / 180;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

function norm(a: Vec3, fallback: Vec3): Vec3 {
  const l = len(a);
  return l < 1e-9 ? fallback : [a[0] / l, a[1] / l, a[2] / l];
}

/** End frame of the parent spine: where the split happens. */
export interface ParentEndFrame {
  position: Vec3;
  tangent: Vec3;
  up: Vec3;
  radius: number;
}

/** Point and direction of a spine at some distance before its end. */
export interface SpineSample {
  position: Vec3;
  tangent: Vec3;
  /** Index of the polyline point at or just before the sample (only set by `sampleSpineBack`). */
  index?: number;
}

export interface SplitDecision {
  split: boolean;
  /** The parent's U tile count after promotion to an even number (>= 2). */
  parentTiles: number;
  /** The parent's tile count was odd (or below 2) and has been raised. */
  promoted: boolean;
}

export interface SplitPlanInput {
  end: ParentEndFrame;
  /** Length of the parent spine (metres). */
  parentLength: number;
  settings: SplitSettings;
  /** Typical distance between rings (metres); sets the sampling of the transition. */
  ringSpacing: number;
  /** Stream of this feature (the planner forks `split` from it). */
  rng: Rng;
  /** Skin > Splits > Chance (0..1) and the profile curve value at the parent end (default 1). */
  chance: number;
  chanceProfile?: number;
  /** U tiles the parent would have; odd counts are promoted. */
  parentTiles: number;
  /** Id of the branch that splits (stored on the open ends). */
  parentSpineId?: number;
  /** Axis point at the start of the transition (default: straight back along the parent tangent). */
  axisStart?: SpineSample;
  /** A point of the tree's centre axis (a vertical line); only x and y are used. Default: the origin. */
  treeAxis?: Vec3;
}

/** One half of a split: the lobe-centre path from the shared axis to the open end. */
export interface SplitLobe {
  side: 1 | 2;
  kind: 'fat' | 'skinny';
  radius: number;
  /** Deviation of the half from the parent direction (radians, after lateral balance). */
  angle: number;
  /** Ring centres (`ringCount * 3`); ring 0 on the shared axis, the last ring is the open end. */
  positions: Float32Array;
  radii: Float32Array;
  ringCount: number;
  /** Unit direction of the path at its start (equals the parent tangent) and at its end. */
  startTangent: Vec3;
  endTangent: Vec3;
  openEnd: OpenEnd & Required<Pick<OpenEnd, 'kind' | 'frame' | 'uTiles' | 'uStart' | 'parentSpineId'>>;
}

export interface SplitPlan {
  /** Length of the transition measured back from the parent end (metres). */
  transitionLength: number;
  /** Horizontal-ish unit direction towards Side 1 (perpendicular to the parent tangent). */
  divergence: Vec3;
  decision: SplitDecision;
  lobes: [SplitLobe, SplitLobe];
  openEnds: [SplitLobe['openEnd'], SplitLobe['openEnd']];
  /** T10: kind of this fork (`lateralChance` is drawn per fork from the Splits seed). */
  mode: SplitForkMode;
  /** The settings the plan used: the given ones plus the junction shape a lateral fork / included bark implies. */
  settings: SplitSettings;
}

/** Even tile count >= 2 at or above `n` (odd counts and fractions are raised). */
export function evenTiles(n: number): number {
  if (!Number.isFinite(n)) return 2;
  return Math.max(2, 2 * Math.ceil(n / 2 - 1e-9));
}

/**
 * Whether the branch splits. Chance x profile is compared with one draw of the `split` stream (the draw is always made, so the
 * stream position never depends on the outcome). The parent's tile count is promoted to an even number >= 2 (never fails).
 */
export function decideSplit(rng: Rng, chance: number, chanceProfile: number, parentTiles: number): SplitDecision {
  const roll = rng.fork('split').fork('decide').next();
  const tiles = evenTiles(parentTiles);
  return { split: roll < clamp(chance, 0, 1) * Math.max(0, chanceProfile), parentTiles: tiles, promoted: tiles !== parentTiles };
}

/**
 * Radii of the two halves from the pipe model `r1^e + r2^e = R^e` with area fractions Balance / (1 - Balance). Each half is at least
 * 0.2 R. Returns `[r1, r2]`.
 */
export function splitRadiiByArea(radius: number, balance: number, exponent = 2): [number, number] {
  const e = clamp(exponent, 1.5, 3);
  const a1 = clamp(balance, 0, 1);
  const lo = SPLIT_MIN_RADIUS_FRACTION * radius;
  return [Math.max(lo, radius * Math.pow(a1, 1 / e)), Math.max(lo, radius * Math.pow(1 - a1, 1 / e))];
}

/**
 * Actual deviation angles (radians) of the halves. `side1` / `side2` are the neutral angles of two equal halves; `area1` / `area2`
 * are the cross-section areas. The result keeps `a1 + a2 = side1 + side2` and balances the lateral pull so the parent's mean direction
 * is preserved: `area1 sin(a1) / sin(side1) = area2 sin(a2) / sin(side2)` (for equal neutral angles: `area1 sin a1 = area2 sin a2`).
 * The fat half therefore bends less.
 */
export function lateralBalanceAngles(side1: number, side2: number, area1: number, area2: number): [number, number] {
  const total = side1 + side2;
  if (side1 < 1e-6 || side2 < 1e-6 || area1 < 1e-12 || area2 < 1e-12 || total >= Math.PI - 1e-3) return [side1, side2];
  // sin(a2) = q sin(a1) with a1 + a2 = total: solve for a1 by bisection (the residual is monotonic on [0, pi/2]).
  const q = (area1 * Math.sin(side2)) / (area2 * Math.sin(side1));
  const residual = (a1: number): number => a1 + Math.asin(Math.min(1, q * Math.sin(a1))) - total;
  let lo = 0;
  let hi = Math.min(total, Math.PI / 2);
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (residual(mid) < 0) lo = mid;
    else hi = mid;
  }
  const a1 = (lo + hi) / 2;
  return [a1, total - a1];
}

/**
 * Unit direction towards Side 1: horizontally away from the tree's centre axis (seeded when the parent end is almost on it), projected
 * onto the plane perpendicular to the parent tangent and turned around the tangent by a seeded jitter of +-15 degrees.
 */
export function divergenceAxis(end: ParentEndFrame, treeAxis: Vec3, rng: Rng): Vec3 {
  const T = norm(end.tangent, [0, 0, 1]);
  const hx = end.position[0] - treeAxis[0];
  const hy = end.position[1] - treeAxis[1];
  let h: Vec3;
  if (Math.hypot(hx, hy) < Math.max(1e-4, 0.25 * end.radius)) {
    const phi = rng.fork('axis').next() * Math.PI * 2;
    h = [Math.cos(phi), Math.sin(phi), 0];
  } else {
    h = norm([hx, hy, 0], [1, 0, 0]);
  }
  let p: Vec3 = sub(h, scale(T, dot(h, T)));
  if (len(p) < 1e-3) {
    const ref: Vec3 = Math.abs(T[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    p = sub(ref, scale(T, dot(ref, T)));
  }
  const base = norm(p, [1, 0, 0]);
  const jitter = (rng.fork('jitter').next() * 2 - 1) * SPLIT_AXIS_JITTER_DEG * DEG;
  return norm(rotateAbout(base, T, jitter), base);
}

/**
 * Turns `dir` toward gravity (-Z) by `bias` (0..1) of the remaining angle. When `reference` (the parent direction) is given the
 * result also never points higher than the reference (unless the reference already points straight down), so a half of a root
 * never climbs relative to its parent. Unit in, unit out; `bias` 0 returns `dir` unchanged.
 */
export function tiltTowardGravity(dir: Vec3, reference: Vec3 | null, bias: number): Vec3 {
  const b = clamp(Number.isFinite(bias) ? bias : 0, 0, 1);
  if (b <= 0) return dir;
  const d = norm(dir, [0, 0, -1]);
  const down: Vec3 = [0, 0, -1];
  const phi = Math.acos(clamp(-d[2], -1, 1));
  let target = phi * (1 - b);
  if (reference) {
    const ref = norm(reference, [0, 0, -1]);
    const phiRef = Math.acos(clamp(-ref[2], -1, 1));
    target = Math.min(target, phiRef * (1 - 0.02 * b));
  }
  const turn = phi - target;
  if (turn <= 1e-9) return d;
  const axis = cross(d, down);
  if (len(axis) < 1e-9) return d;
  return norm(rotateAbout(d, norm(axis, [0, 1, 0]), turn), d);
}

/** Position and direction of a polyline `distance` metres before its last point (clamped to the first point). */
export function sampleSpineBack(positions: ArrayLike<number>, count: number, distance: number): SpineSample {
  const at = (i: number): Vec3 => [positions[i * 3] as number, positions[i * 3 + 1] as number, positions[i * 3 + 2] as number];
  if (count < 2) return { position: count === 1 ? at(0) : [0, 0, 0], tangent: [0, 0, 1], index: 0 };
  let remaining = Math.max(0, distance);
  for (let i = count - 1; i >= 1; i--) {
    const a = at(i - 1);
    const b = at(i);
    const seg = len(sub(b, a));
    if (remaining <= seg || i === 1) {
      const f = seg > 1e-12 ? clamp(remaining / seg, 0, 1) : 0;
      return { position: add(b, scale(sub(a, b), f)), tangent: norm(sub(b, a), [0, 0, 1]), index: i - 1 };
    }
    remaining -= seg;
  }
  return { position: at(0), tangent: [0, 0, 1], index: 0 };
}

/** Cubic Hermite point and (unnormalised) derivative. */
function hermite(p0: Vec3, m0: Vec3, p1: Vec3, m1: Vec3, t: number): { p: Vec3; d: Vec3 } {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  const d00 = 6 * t2 - 6 * t;
  const d10 = 3 * t2 - 4 * t + 1;
  const d01 = -6 * t2 + 6 * t;
  const d11 = 3 * t2 - 2 * t;
  const out = (a: number, b: number, c: number, d: number, k: number): number => a * p0[k]! + b * m0[k]! + c * p1[k]! + d * m1[k]!;
  return {
    p: [out(h00, h10, h01, h11, 0), out(h00, h10, h01, h11, 1), out(h00, h10, h01, h11, 2)],
    d: [out(d00, d10, d01, d11, 0), out(d00, d10, d01, d11, 1), out(d00, d10, d01, d11, 2)],
  };
}

function openEndFrame(direction: Vec3, up: Vec3, fallback: Vec3): { normal: Vec3; binormal: Vec3 } {
  let n: Vec3 = sub(up, scale(direction, dot(up, direction)));
  if (len(n) < 1e-6) n = sub(fallback, scale(direction, dot(fallback, direction)));
  const normal = norm(n, cross(direction, [1, 0, 0]));
  return { normal, binormal: norm(cross(direction, normal), [0, 1, 0]) };
}

/**
 * Curvature-adaptive ring parameter: maps the uniform ring fraction `u` (0..1) to the position along the transition. The section
 * changes fastest near the pinch (the neck closes like a square root) and right after the parent's ring (swell, ovalisation), so
 * rings are denser at both ends: spacing is `1 - bias cos(2 pi u)` times the uniform one. Monotonic for `bias < 1`, exact at 0 and 1.
 */
export function splitRingParam(u: number, bias: number): number {
  if (!(bias > 0)) return u;
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u - (bias * Math.sin(2 * Math.PI * u)) / (2 * Math.PI);
}


/**
 * Kind of one fork: `lateral` mode always, otherwise `lateralChance` of the `y` forks. One draw of its own stream (`split:mode`) is
 * always made, so the stream position never depends on the settings and no other decision changes.
 */
export function decideSplitMode(rng: Rng, settings: Pick<SplitSettings, 'mode' | 'lateralChance'>): SplitForkMode {
  const roll = rng.fork('split').fork('mode').next();
  if (settings.mode === 'lateral') return 'lateral';
  return roll < clamp(settings.lateralChance ?? 0, 0, 1) ? 'lateral' : 'y';
}

/**
 * The settings a fork really uses: a lateral fork gets a neck swell, a ridge and a valley fillet (the junction of a branch on a
 * trunk) unless the user set larger values; included bark deepens the valley into a narrow crevice (small fillet, narrower neck, a
 * ridge). Only ever raises ridge / swell and lowers fillet / waist, so applying it twice gives the same result.
 */
export function resolveSplitSettings(s: SplitSettings, mode: SplitForkMode): SplitSettings {
  let out: SplitSettings = s;
  if (mode === 'lateral') {
    out = {
      ...out,
      neckSwell: Math.max(out.neckSwell ?? 0, SPLIT_LATERAL_SWELL),
      ridge: Math.max(out.ridge ?? 0, SPLIT_LATERAL_RIDGE),
      valleyRadius: Math.max(out.valleyRadius ?? 0, SPLIT_LATERAL_VALLEY),
    };
  }
  const ib = clamp(s.includedBark ?? 0, 0, 1);
  if (ib > 0) {
    out = {
      ...out,
      ridge: Math.max(out.ridge ?? 0, 0.45 * ib),
      valleyRadius: Math.max(0.04, Math.min(out.valleyRadius ?? 0, 0.06 + 0.44 * (1 - ib))),
      waist: Math.min(out.waist ?? 1, 1 - 0.3 * ib),
    };
  }
  return out;
}

/** Result of {@link dominantSplit}: the area fraction of the fat half and the deviation of both halves (radians). */
export interface DominantSplit {
  /** Balance (area fraction of Side 1) after the dominance; equals the given one at dominance 0. */
  balance: number;
  /** Deviation angles of Side 1 and Side 2 from the parent direction. */
  angles: [number, number];
}

/**
 * Dominant leader. `dominance` 0 = the old behaviour (Balance + lateral balance). Towards 1 the fat half takes up to `areaTarget` of the
 * area (the skinny half gets a reduced radius, the pipe model holds) and continues the parent direction: its deviation shrinks to
 * `kink` x its Spread; the skinny half leaves at its full Spread. The fat deviation never increases with the dominance.
 */
export function dominantSplit(balance: number, spread1: number, spread2: number, dominance: number, exponent: number, kink = SPLIT_DOMINANT_KINK, areaTarget = SPLIT_DOMINANT_AREA): DominantSplit {
  const e = clamp(exponent, 1.5, 3);
  const dom = clamp(dominance, 0, 1);
  const b = clamp(balance, 0, 1);
  const [q1, q2] = splitRadiiByArea(1, b, e);
  const base = lateralBalanceAngles(spread1, spread2, q1 * q1, q2 * q2);
  if (!(dom > 0)) return { balance: b, angles: base };
  const fat1 = q1 >= q2;
  const fatFrac0 = Math.max(b, 1 - b);
  const fatFrac = fatFrac0 + dom * Math.max(0, areaTarget - fatFrac0);
  const nb = fat1 ? fatFrac : 1 - fatFrac;
  const [n1, n2] = splitRadiiByArea(1, nb, e);
  const bal = lateralBalanceAngles(spread1, spread2, n1 * n1, n2 * n2);
  const fatSpread = fat1 ? spread1 : spread2;
  const skinnySpread = fat1 ? spread2 : spread1;
  const fatBal = fat1 ? bal[0] : bal[1];
  const skinnyBase = fat1 ? base[1] : base[0];
  const fat = fatBal - dom * Math.max(0, fatBal - kink * fatSpread);
  const skinny = Math.min(80 * DEG, skinnyBase + dom * (skinnySpread - skinnyBase));
  return { balance: nb, angles: fat1 ? [fat, skinny] : [skinny, fat] };
}

/** Length of the transition measured back from the parent end: `clamp(3.5 R, 0.08 L, 0.35 L)`. */
export function splitTransitionLength(parentRadius: number, parentLength: number): number {
  return Math.min(SPLIT_TRANSITION_MAX_FRACTION * parentLength, Math.max(SPLIT_TRANSITION_MIN_FRACTION * parentLength, SPLIT_TRANSITION_RADII * parentRadius));
}

/**
 * Plans a split at the parent's end. Returns null when the branch does not split (Chance x profile fails the seeded draw). Same
 * input and stream -> identical plan; the plan only reads the `split` fork of `rng`, so no other feature is affected.
 */
export function planSplit(input: SplitPlanInput): SplitPlan | null {
  const decision = decideSplit(input.rng, input.chance, input.chanceProfile ?? 1, input.parentTiles);
  if (!decision.split || !(input.end.radius > 0)) return null;
  const mode = decideSplitMode(input.rng, input.settings);
  const s = resolveSplitSettings(input.settings, mode);
  const rng = input.rng.fork('split');
  const R = input.end.radius;
  const T = norm(input.end.tangent, [0, 0, 1]);

  // Pipe model radii, fat / skinny (tie: Side 1 is fat).
  // T10: a dominant leader / lateral fork moves area to the fat half and decides the angles (dominance 0 = the former rule).
  const lateral = mode === 'lateral';
  const dominance = lateral ? 1 : clamp(s.dominance ?? 0, 0, 1);
  const dom = dominantSplit(s.balance, clamp(s.spread1Deg, 0, 80) * DEG, clamp(s.spread2Deg, 0, 80) * DEG, dominance, s.areaExponent, lateral ? SPLIT_LATERAL_KINK : SPLIT_DOMINANT_KINK, lateral ? SPLIT_LATERAL_AREA : SPLIT_DOMINANT_AREA);
  const [r1, r2] = splitRadiiByArea(R, dom.balance, s.areaExponent);
  const fat1 = r1 >= r2;

  // Divergence axis and the bend of each half (lateral balance keeps the mean direction).
  const d = divergenceAxis({ ...input.end, tangent: T }, input.treeAxis ?? [0, 0, 0], rng);
  const [a1, a2] = dominance > 0 ? dom.angles : lateralBalanceAngles(clamp(s.spread1Deg, 0, 80) * DEG, clamp(s.spread2Deg, 0, 80) * DEG, r1 * r1, r2 * r2);
  const rotAxis = norm(cross(T, d), [0, 1, 0]);

  // Transition: the last Lt of the parent spine is the shared body.
  const Lt = splitTransitionLength(R, input.parentLength);
  const axisStart: SpineSample = input.axisStart ?? { position: sub(input.end.position, scale(T, Lt)), tangent: T };
  const startTangent = norm(axisStart.tangent, T);

  // Lateral offsets: the two circles are tangent (centre separation r1 + r2) and balanced around the axis by area.
  const sep = r1 + r2;
  const w1 = r1 * r1;
  const w2 = r2 * r2;
  const off1 = (sep * w2) / (w1 + w2);
  const off2 = sep - off1;

  const ringBias = splitShapeOf(s).ringBias;
  const minSegments = ringBias > 0 ? SPLIT_SHAPE_MIN_SEGMENTS : MIN_SEGMENTS;
  const spacing = Math.max(1e-4, input.ringSpacing);
  const maxAngleDeg = Math.max(a1, a2) / DEG;
  const segments = clamp(Math.max(Math.ceil(Lt / spacing), Math.ceil(maxAngleDeg / MAX_RING_TURN_DEG), minSegments), minSegments, MAX_SEGMENTS);
  const ringCount = segments + 1;
  const half = decision.parentTiles / 2;
  const parentSpineId = input.parentSpineId ?? -1;

  const build = (side: 1 | 2): SplitLobe => {
    const r = side === 1 ? r1 : r2;
    const angle = side === 1 ? a1 : a2;
    const sign = side === 1 ? 1 : -1;
    const childT = tiltTowardGravity(norm(rotateAbout(T, rotAxis, angle * sign), T), T, s.downBias ?? 0);
    const end = add(input.end.position, scale(d, sign * (side === 1 ? off1 : off2)));
    const chord = Math.max(1e-6, len(sub(end, axisStart.position)));
    const m0 = scale(startTangent, chord);
    const m1 = scale(childT, chord);
    const positions = new Float32Array(ringCount * 3);
    const radii = new Float32Array(ringCount).fill(r);
    for (let k = 0; k < ringCount; k++) {
      const p = k === ringCount - 1 ? end : hermite(axisStart.position, m0, end, m1, splitRingParam(k / segments, ringBias)).p;
      positions[k * 3] = p[0];
      positions[k * 3 + 1] = p[1];
      positions[k * 3 + 2] = p[2];
    }
    const kind: 'fat' | 'skinny' = (side === 1 ? fat1 : !fat1) ? 'fat' : 'skinny';
    const frame = openEndFrame(childT, input.end.up, d);
    return {
      side,
      kind,
      radius: r,
      angle,
      positions,
      radii,
      ringCount,
      startTangent: norm(hermite(axisStart.position, m0, end, m1, 0).d, T),
      endTangent: childT,
      openEnd: {
        position: end,
        direction: childT,
        radius: r,
        frame,
        side,
        fat: kind === 'fat',
        kind,
        uTiles: half,
        uStart: side === 1 ? 0 : half,
        parentSpineId,
      },
    };
  };
  const lobes: [SplitLobe, SplitLobe] = [build(1), build(2)];
  return { transitionLength: Lt, divergence: d, decision, lobes, openEnds: [lobes[0].openEnd, lobes[1].openEnd], mode, settings: s };
}
