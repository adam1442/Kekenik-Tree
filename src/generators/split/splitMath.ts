/**
 * Skin > Splits (pure): a branch that splits ends in two short fused tubes ("sides"), each an open end that Extend parent
 * nodes (Branch / Cap) continue. Everything here is plain math on tuples and typed arrays so it can be tested without a graph.
 * The tree stands along +Z.
 */
export type Vec3 = readonly [number, number, number];

/** Skeleton attribute: bit flags of {@link SplitFlag}. 0 / missing = an ordinary branch. */
export const SPLIT_ATTR = 'splitInfo';

/** Bit flags of the `splitInfo` skeleton attribute. */
export const SplitFlag = {
  /** The branch ends in a split: its tip is fused into two sides, so it is not an open end itself. */
  Parent: 1,
  /** This branch is Side 1 of a split (an open end). */
  Side1: 2,
  /** This branch is Side 2 of a split (an open end). */
  Side2: 4,
  /** This side is the fatter of the two (equal radii: Side 1). */
  Fat: 8,
} as const;

export interface SplitSettings {
  /** 0..1: 0.5 = equal radii, above 0.5 Side 1 is thicker. */
  balance: number;
  /** Angle of each side away from the parent direction (degrees). */
  spread1Deg: number;
  spread2Deg: number;
  /** Radius multipliers of each side (1 = default). */
  expand1: number;
  expand2: number;
  /** 0 = hard crease between the two sides, 1 = no crease. */
  smoothInner: number;
  /** 0 = hard outer bend, 1 = the bend is spread over the whole side. */
  smoothOuter: number;
  /** Pipe-model exponent: `r1^e + r2^e = R^e` (2 = the halves keep the parent's cross-section area). */
  areaExponent: number;
  /**
   * 0..1: both halves turn toward gravity after the lateral balance (roots: default 0.4). 0 / missing = no tilt. The tilt never
   * lets a half point higher than its parent.
   */
  downBias?: number;
  /** Skin > Splits > Split shape (T08). Missing = neutral = the former cusp outline. See {@link SplitShape}. */
  waist?: number;
  neckSwell?: number;
  valleyRadius?: number;
  ridge?: number;
  ridgeLength?: number;
  stretch?: number;
  ease?: number;
  /** T10: 0..1 dominant leader: towards 1 the fat half continues the parent direction and the skinny half leaves at its full Spread. 0 / missing = Balance only. */
  dominance?: number;
  /** T10: fork type. `y` (default / missing) = symmetric Y, `lateral` = the parent goes on, a clearly thinner side branch leaves. */
  mode?: SplitForkMode;
  /** T10: 0..1 chance that a fork of mode `y` is a lateral one (the draw uses the Splits seed). */
  lateralChance?: number;
  /** T10: 0..1 narrow, dark, V-shaped crevice with a bark ridge (codominant stems). 0 / missing = off. */
  includedBark?: number;
}

/** Kinds of fork a split can make. */
export type SplitForkMode = 'y' | 'lateral';

/**
 * Shape of the fork cross-section (the "figure-8"). Neutral values reproduce the former outline (two circle arcs that meet in a cusp).
 * `ringBias` is derived: the curvature-adaptive ring spacing is used exactly when any other value is not neutral.
 */
export interface SplitShape {
  /** Neck width at mid transition relative to the narrower lobe (1 = old look, 0.6 = pronounced peanut). */
  waist: number;
  /** Radius swell (fraction) just before the fork; the lobes' area reservoir pays for it, the open ends are unchanged. */
  neckSwell: number;
  /** Fillet radius of the valley as a fraction of the smaller lobe radius. */
  valleyRadius: number;
  /** Height of the bark ridge on the pinch axis as a fraction of the smaller lobe radius. */
  ridge: number;
  /** The ridge fades into the parent over this many parent radii. */
  ridgeLength: number;
  /** Elongation of the section along the divergence axis early in the transition. */
  stretch: number;
  /** 0 = smoothstep separation, 1 = late, sudden pinch. */
  ease: number;
  /** Strength of the curvature-adaptive ring spacing (0 = uniform). */
  ringBias: number;
  /** T10: included bark 0..1: only drives the valley AO strength / width here (the geometry comes from valley, ridge and waist). */
  includedBark: number;
}

export const NEUTRAL_SPLIT_SHAPE: SplitShape = { waist: 1, neckSwell: 0, valleyRadius: 0, ridge: 0, ridgeLength: 2, stretch: 1, ease: 0, ringBias: 0, includedBark: 0 };
/** Ring spacing strength of a non-neutral shape (rings per unit transition are 0.65 x at the ends .. 1.35 x in the middle). */
export const SPLIT_ADAPTIVE_RING_BIAS = 0.35;

/** Skeleton attribute (on both lobes) of every {@link SplitShape} field; only written when the value is not neutral. */
export const SPLIT_SHAPE_ATTRS: readonly { key: keyof SplitShape; attr: string }[] = [
  { key: 'waist', attr: 'splitWaist' },
  { key: 'neckSwell', attr: 'splitNeckSwell' },
  { key: 'valleyRadius', attr: 'splitValleyRadius' },
  { key: 'ridge', attr: 'splitRidge' },
  { key: 'ridgeLength', attr: 'splitRidgeLength' },
  { key: 'stretch', attr: 'splitStretch' },
  { key: 'ease', attr: 'splitEase' },
  { key: 'ringBias', attr: 'splitRingBias' },
  { key: 'includedBark', attr: 'splitIncludedBark' },
];

const clampShape = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** True when no shape value changes the former outline (ridge length alone never does). */
export function isSplitShapeNeutral(s: Partial<SplitShape> | undefined): boolean {
  if (!s) return true;
  return (s.waist ?? 1) >= 1 && (s.neckSwell ?? 0) <= 0 && (s.valleyRadius ?? 0) <= 0 && (s.ridge ?? 0) <= 0 && (s.stretch ?? 1) === 1 && (s.ease ?? 0) <= 0 && (s.includedBark ?? 0) <= 0;
}

/** The complete, clamped shape of some settings (`ringBias` follows from the other values). */
export function splitShapeOf(s: Partial<SplitShape> | undefined): SplitShape {
  const out: SplitShape = {
    waist: clampShape(s?.waist ?? 1, 0.2, 1),
    neckSwell: clampShape(s?.neckSwell ?? 0, 0, 0.5),
    valleyRadius: clampShape(s?.valleyRadius ?? 0, 0, 1),
    ridge: clampShape(s?.ridge ?? 0, 0, 1),
    ridgeLength: clampShape(s?.ridgeLength ?? 2, 0.25, 8),
    stretch: clampShape(s?.stretch ?? 1, 0.8, 1.6),
    ease: clampShape(s?.ease ?? 0, 0, 1),
    ringBias: 0,
    includedBark: clampShape(s?.includedBark ?? 0, 0, 1),
  };
  out.ringBias = isSplitShapeNeutral(out) ? 0 : (s?.ringBias ?? SPLIT_ADAPTIVE_RING_BIAS);
  return out;
}

export const DEFAULT_SPLIT_SETTINGS: SplitSettings = {
  balance: 0.5,
  spread1Deg: 22,
  spread2Deg: 22,
  expand1: 1,
  expand2: 1,
  smoothInner: 0.25,
  smoothOuter: 0.5,
  areaExponent: 2,
};

/** One open end of a split (or of a broken branch). */
export interface OpenEnd {
  position: Vec3;
  /** Unit direction the end points along. */
  direction: Vec3;
  radius: number;
  /** 0 = broken branch end, 1 / 2 = Side 1 / Side 2 of a split. */
  side: 0 | 1 | 2;
  /** The thicker of the two sides (broken ends are never fat or skinny). */
  fat: boolean;
  /** Split ends only: fat / skinny (the same information as `fat`, in the Extend parent vocabulary). */
  kind?: 'fat' | 'skinny';
  /** Split ends only: orthonormal frame around `direction` (`normal` x `binormal` = `direction`). */
  frame?: OpenEndFrame;
  /** Split ends only: number of U tiles the half carries around its tube (half of the parent's). */
  uTiles?: number;
  /** Split ends only: first U tile of the half in the parent's tile numbering. */
  uStart?: number;
  /** Split ends only: id of the branch (spine) that split. */
  parentSpineId?: number;
}

/** Orthonormal frame of an open end (the third axis is its `direction`). */
export interface OpenEndFrame {
  normal: Vec3;
  binormal: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Rodrigues rotation of `v` around the unit `axis`. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

/** Flags stored on a side branch / on a branch that splits. */
export function splitFlags(side: { side: 1 | 2; fat: boolean } | 'parent'): number {
  if (side === 'parent') return SplitFlag.Parent;
  return (side.side === 1 ? SplitFlag.Side1 : SplitFlag.Side2) | (side.fat ? SplitFlag.Fat : 0);
}

/** Extension types that pick open ends (`none` and `bottom` do not). */
export type OpenEndSelector = 'any' | 'split-1' | 'split-2' | 'skinny' | 'fat' | 'breaks-only';

/**
 * Whether a branch ending in an open end takes an extension of the given type. `flags` are the branch's `splitInfo`; `broken` is
 * true when the end is a break (a split side is open but not broken). A branch that splits is never an open end.
 */
export function selectsOpenEnd(type: OpenEndSelector, flags: number, broken: boolean): boolean {
  if (flags & SplitFlag.Parent) return false;
  const isSide = (flags & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0;
  switch (type) {
    case 'any':
      return true;
    case 'split-1':
      // an unsplit end is the single "Split 1" end
      return (flags & SplitFlag.Side2) === 0;
    case 'split-2':
      return (flags & SplitFlag.Side2) !== 0;
    case 'fat':
      // an unsplit end counts as Fat, never as Skinny
      return !isSide || (flags & SplitFlag.Fat) !== 0;
    case 'skinny':
      return isSide && (flags & SplitFlag.Fat) === 0;
    case 'breaks-only':
      return broken && !isSide;
  }
}

// ---- Extensions ---------------------------------------------------------------------------------------------------------

/** Skeleton attributes written on extension branches. */
export const EXTENSION_ATTR = 'extensionInfo';
/** Value of {@link EXTENSION_ATTR} on an extension that shares its open end with siblings (Count 3+); any other extension stores 1. */
export const EXTENSION_GROUP_VALUE = 2;
/** Skeleton attributes of the two lobes of a split (one value per point): Expand of the lobe, Smooth > Inner / Outer of the split. */
export const SPLIT_EXPAND_ATTR = 'splitExpand';
export const SPLIT_SMOOTH_INNER_ATTR = 'splitSmoothInner';
export const SPLIT_SMOOTH_OUTER_ATTR = 'splitSmoothOuter';
export const EXTENSION_SMOOTH_ATTR = 'extensionNormalSmooth';
export const EXTENSION_DISPLACE_ATTR = 'extensionDisplaceScale';

/**
 * Azimuth (radians around the parent direction) of extension `index` of `count` sharing one open end. A single extension continues
 * straight on (azimuth irrelevant, spread 0); several fan out evenly.
 */
export function extensionAzimuth(index: number, count: number, offset = 0): number {
  return offset + (index / Math.max(1, count)) * Math.PI * 2;
}

/** Spread angle in radians: only extensions that share an open end separate. */
export function extensionSpreadAngle(spreadDeg: number, count: number): number {
  return count > 1 ? (Math.max(0, spreadDeg) * Math.PI) / 180 : 0;
}

/** Fraction of an extension's length over which the spread angle eases in. */
const SPREAD_EASE = 0.3;

/**
 * Pushes the points of an extension sideways along `side` (unit): the offset at arc fraction f is `tan(spread) x length x
 * integral(curve x ease-in, 0..f)`, so the base stays on the parent end and the direction there is unchanged. `lut` = profile curve over the
 * length (null = constant 1).
 */
export function applyExtensionSpread(positions: Float32Array, count: number, side: Vec3, spreadRad: number, lut: Float32Array | null): void {
  if (count < 2 || Math.abs(spreadRad) < 1e-9) return;
  let total = 0;
  const cum = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    total += Math.hypot(
      (positions[i * 3] as number) - (positions[(i - 1) * 3] as number),
      (positions[i * 3 + 1] as number) - (positions[(i - 1) * 3 + 1] as number),
      (positions[i * 3 + 2] as number) - (positions[(i - 1) * 3 + 2] as number),
    );
    cum[i] = total;
  }
  if (total < 1e-9) return;
  const sample = (f: number): number => {
    if (!lut || lut.length === 0) return 1;
    const x = Math.min(1, Math.max(0, f)) * (lut.length - 1);
    const i0 = Math.floor(x);
    const i1 = Math.min(lut.length - 1, i0 + 1);
    return (lut[i0] as number) + ((lut[i1] as number) - (lut[i0] as number)) * (x - i0);
  };
  const tanA = Math.tan(Math.min(1.4, Math.abs(spreadRad))) * Math.sign(spreadRad);
  // The separation angle eases in over the first part of the length, so the direction at the base stays the parent's.
  const rate = (f: number): number => sample(f) * smooth01(f / SPREAD_EASE);
  let integral = 0;
  let prevF = 0;
  let prevV = rate(0);
  const offsets = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const f = (cum[i] as number) / total;
    const v = rate(f);
    integral += ((prevV + v) / 2) * (f - prevF);
    prevF = f;
    prevV = v;
    offsets[i] = tanA * total * integral;
  }
  for (let i = 1; i < count; i++) {
    const o = offsets[i] as number;
    positions[i * 3] = (positions[i * 3] as number) + side[0] * o;
    positions[i * 3 + 1] = (positions[i * 3 + 1] as number) + side[1] * o;
    positions[i * 3 + 2] = (positions[i * 3 + 2] as number) + side[2] * o;
  }
}

/**
 * Radius factor of an extension at arc fraction f: `lerp(1, curve(f) / curve(0), value)`. The factor is 1 at the base, so the
 * extension always starts with the radius of the parent's end (no step). `curve0` / `curveF` are the curve at 0 and at f.
 */
export function extensionRadiusFactor(value: number, curve0: number, curveF: number): number {
  const v = Math.min(1, Math.max(0, value));
  const rel = curve0 > 1e-3 ? curveF / curve0 : curveF;
  return Math.max(0.02, 1 + (rel - 1) * v);
}
