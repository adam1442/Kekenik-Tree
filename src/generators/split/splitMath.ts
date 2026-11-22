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

/** Rings of a split side (tube from the fused base to the open end). */
export const SPLIT_SIDE_RINGS = 5;
/** Side length in parent radii. */
export const SPLIT_SIDE_LENGTH_RADII = 3.2;
/** Smallest radius of a split side (metres). */
export const SPLIT_MIN_RADIUS = 0.0005;

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
}

export const DEFAULT_SPLIT_SETTINGS: SplitSettings = {
  balance: 0.5,
  spread1Deg: 25,
  spread2Deg: 25,
  expand1: 1,
  expand2: 1,
  smoothInner: 0.25,
  smoothOuter: 0.5,
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
}

export interface SplitSide {
  side: 1 | 2;
  fat: boolean;
  radius: number;
  /** Ring centres, `SPLIT_SIDE_RINGS * 3`; ring 0 sits on the fused base, the last ring is the open end. */
  positions: Float32Array;
  radii: Float32Array;
  openEnd: OpenEnd;
}

export interface SplitInput {
  /** Centre and radius of the parent's last ring, and its unit direction. */
  tip: Vec3;
  radius: number;
  tangent: Vec3;
  /** Direction away from the centre of the tree (any vector; projected onto the plane of the split). */
  away: Vec3;
  /** Radians around the parent direction the plane of the split is turned from `away` (seeded jitter). */
  roll?: number;
  settings: SplitSettings;
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function norm(a: Vec3, fallback: Vec3): Vec3 {
  const l = len(a);
  return l < 1e-9 ? fallback : [a[0] / l, a[1] / l, a[2] / l];
}

/** Rodrigues rotation of `v` around the unit `axis`. */
export function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = cross(axis, v);
  const d = dot(axis, v) * (1 - c);
  return [v[0] * c + k[0] * s + axis[0] * d, v[1] * c + k[1] * s + axis[1] * d, v[2] * c + k[2] * s + axis[2] * d];
}

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * Radii of the two sides. The pipe model keeps the cross-section area: `r1^2 + r2^2 = R^2` (at Expand 1). Balance 0.5 gives equal
 * radii; Balance shifts the area between the sides; Expand scales each radius on top.
 */
export function splitRadii(radius: number, balance: number, expand1 = 1, expand2 = 1, minRadius = SPLIT_MIN_RADIUS): [number, number] {
  const share = Math.min(0.98, Math.max(0.02, balance));
  const r1 = radius * Math.sqrt(share) * Math.max(0.05, expand1);
  const r2 = radius * Math.sqrt(1 - share) * Math.max(0.05, expand2);
  return [Math.max(minRadius, r1), Math.max(minRadius, r2)];
}

/** The unit direction, perpendicular to `tangent`, in which Side 1 leans (away from the tree centre; any perpendicular when degenerate). */
export function splitPlaneDirection(tangent: Vec3, away: Vec3, roll = 0): Vec3 {
  const t = norm(tangent, [0, 0, 1]);
  let p: Vec3 = add(away, scale(t, -dot(away, t)));
  if (len(p) < 1e-6) {
    const ref: Vec3 = Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
    p = add(ref, scale(t, -dot(ref, t)));
  }
  const out = norm(p, [1, 0, 0]);
  return Math.abs(roll) > 1e-9 ? norm(rotateAbout(out, t, roll), out) : out;
}

/**
 * Builds the two sides of a split. Both start parallel to the parent at its tip, offset toward their own side so the outer wall is
 * tangent to the parent's wall (Smooth > Inner shrinks the offset: 1 = both start on the axis, no crease). The direction then eases
 * from the parent direction to the side's own angle over Smooth > Outer x the side length (0 = hard bend).
 */
export function computeSplit(input: SplitInput): [SplitSide, SplitSide] {
  const s = input.settings;
  const T = norm(input.tangent, [0, 0, 1]);
  const out = splitPlaneDirection(T, input.away, input.roll ?? 0);
  const axis = norm(cross(T, out), [0, 1, 0]);
  const [r1, r2] = splitRadii(input.radius, s.balance, s.expand1, s.expand2);
  const fat1 = r1 >= r2;
  const build = (side: 1 | 2): SplitSide => {
    const r = side === 1 ? r1 : r2;
    const sign = side === 1 ? 1 : -1;
    const angle = (((side === 1 ? s.spread1Deg : s.spread2Deg) * Math.PI) / 180) * sign;
    const lean = scale(out, sign);
    const offset = Math.max(0, input.radius - r) * (1 - Math.min(1, Math.max(0, s.smoothInner)));
    const origin = add(input.tip, scale(lean, offset));
    const length = Math.max(0.02, SPLIT_SIDE_LENGTH_RADII * Math.max(input.radius, r));
    const blend = Math.min(1, Math.max(0, s.smoothOuter)) * length;
    const positions = new Float32Array(SPLIT_SIDE_RINGS * 3);
    const radii = new Float32Array(SPLIT_SIDE_RINGS);
    let p = origin;
    let dir: Vec3 = T;
    for (let k = 0; k < SPLIT_SIDE_RINGS; k++) {
      if (k > 0) {
        const mid = ((k - 0.5) / (SPLIT_SIDE_RINGS - 1)) * length;
        const w = blend > 1e-9 ? smooth01(mid / blend) : 1;
        dir = norm(rotateAbout(T, axis, angle * w), T);
        p = add(p, scale(dir, length / (SPLIT_SIDE_RINGS - 1)));
      }
      positions[k * 3] = p[0];
      positions[k * 3 + 1] = p[1];
      positions[k * 3 + 2] = p[2];
      radii[k] = r;
    }
    const fat = side === 1 ? fat1 : !fat1;
    return { side, fat, radius: r, positions, radii, openEnd: { position: p, direction: dir, radius: r, side, fat } };
  };
  return [build(1), build(2)];
}

/** Flags stored on a side branch / on a branch that splits. */
export function splitFlags(side: SplitSide | 'parent'): number {
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
      return (flags & SplitFlag.Side1) !== 0;
    case 'split-2':
      return (flags & SplitFlag.Side2) !== 0;
    case 'fat':
      return isSide && (flags & SplitFlag.Fat) !== 0;
    case 'skinny':
      return isSide && (flags & SplitFlag.Fat) === 0;
    case 'breaks-only':
      return broken && !isSide;
  }
}

// ---- Extensions ---------------------------------------------------------------------------------------------------------

/** Skeleton attributes written on extension branches. */
export const EXTENSION_ATTR = 'extensionInfo';
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
