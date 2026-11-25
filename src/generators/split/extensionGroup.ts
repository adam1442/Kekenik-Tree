import type { Rng } from '@/core/rng';
import type { Vec3 } from './splitMath';

/**
 * Several extensions on one open end (Generation > Extend parent > Count above 1), pure math.
 *
 * - Every extension gets the radius `endRadius x count^(-1/e)` (area rule: `count x r^e = R^e`).
 * - Count 2 is built as a virtual split (the fused crotch of S2); Count 3 and more start on a small Fermat spiral inside the end
 *   disc (radius <= {@link EXTENSION_BASE_DISC}) and fan out by Spread.
 * - Every jitter comes from its own forked stream, so changing one extension never moves another.
 */

/** Largest distance of an extension base from the end centre, as a fraction of the end radius. */
export const EXTENSION_BASE_DISC = 0.5;
/** Golden angle in radians (the Fermat spiral turn per point). */
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Largest random turn / radial change applied to one spiral point (fraction of the point spacing). */
const JITTER = 0.18;

/** Radius multiplier of every extension when `count` of them share one end: `count^(-1/e)` (1 for a single extension). */
export function extensionAreaRadiusFactor(count: number, areaExponent: number): number {
  const n = Math.max(1, Math.round(count));
  const e = Math.min(3, Math.max(1.5, Number.isFinite(areaExponent) ? areaExponent : 2));
  return Math.pow(n, -1 / e);
}

/** Radius of each of `count` extensions on an end of radius `endRadius`. */
export function extensionGroupRadius(endRadius: number, count: number, areaExponent: number): number {
  return Math.max(0, endRadius) * extensionAreaRadiusFactor(count, areaExponent);
}

/** Stream key of the base jitter of extension `index` (a feature of its own: nothing else reads it). */
export const extensionJitterKey = (index: number): string => `extBase:${index}`;

/** Base of one extension: offset in the end plane (end normal / binormal axes) and the azimuth its fan direction points to. */
export interface ExtensionBase {
  /** Offset along the end frame's normal / binormal (metres). */
  readonly x: number;
  readonly y: number;
  /** Azimuth (radians) of the base around the end centre, also the direction the extension fans out to. */
  readonly azimuth: number;
}

/**
 * Deterministic Fermat spiral of `count` bases inside the end disc: point i sits at `r = disc x sqrt((i + 0.5) / count)` and turns by
 * the golden angle, so they never coincide and cover the disc evenly. `disc = {@link EXTENSION_BASE_DISC} x endRadius` at most.
 * A single extension (count 1) stays on the centre. `rng` is forked per index for the jitter.
 */
export function fermatBases(count: number, endRadius: number, rng: Rng, azimuthOffset = 0): ExtensionBase[] {
  const n = Math.max(1, Math.round(count));
  const out: ExtensionBase[] = [];
  if (n === 1) return [{ x: 0, y: 0, azimuth: azimuthOffset }];
  const disc = Math.max(0, endRadius) * EXTENSION_BASE_DISC;
  for (let i = 0; i < n; i++) {
    const j = rng.fork(extensionJitterKey(i));
    const turn = (j.next() * 2 - 1) * JITTER * GOLDEN_ANGLE;
    const grow = 1 + (j.next() * 2 - 1) * JITTER;
    const r = Math.min(disc, disc * Math.sqrt((i + 0.5) / n) * grow);
    const a = azimuthOffset + i * GOLDEN_ANGLE + turn;
    out.push({ x: r * Math.cos(a), y: r * Math.sin(a), azimuth: a });
  }
  return out;
}

/**
 * Fan direction angle (radians away from the end direction) of an extension at fraction `f` of its length: the Spread angle times
 * the profile curve (null = constant 1) eased in over the first 30 % (the base keeps the parent's direction). `count` 1 never fans.
 */
export function extensionFanAngle(spreadDeg: number, count: number, f: number, lut: Float32Array | null): number {
  if (count < 2) return 0;
  const x = Math.min(1, Math.max(0, f));
  let c = 1;
  if (lut && lut.length > 0) {
    const p = x * (lut.length - 1);
    const i0 = Math.floor(p);
    const i1 = Math.min(lut.length - 1, i0 + 1);
    c = (lut[i0] as number) + ((lut[i1] as number) - (lut[i0] as number)) * (p - i0);
  }
  const e = Math.min(1, x / 0.3);
  return ((Math.max(0, spreadDeg) * Math.PI) / 180) * c * (e * e * (3 - 2 * e));
}

/** Count 2 is a virtual split (fused crotch); every other count uses separate tubes. */
export const usesVirtualSplit = (count: number): boolean => Math.round(count) === 2;

/**
 * Length of the shared stub of a virtual split, in end radii. The stub is the short fused body between the open end and the fork;
 * the Length scale applies to the two extensions that leave it, not to the stub.
 */
export const VIRTUAL_SPLIT_STUB_RADII = 4;
/** Fraction of the stub over which the two halves leave the shared axis (the rest is the plain fused body). */
export const VIRTUAL_SPLIT_FORK_FRACTION = 0.7;

/**
 * Normal of the shared end cylinder at skin point `p`: the unit vector from the end axis (`centre`, unit `axis`) to `p`, taken
 * perpendicular to the axis. Sibling extensions of one end lean their first rings towards it (Normal smooth), so the bundle shades
 * like the single tube it grew out of. A point on the axis returns `fallback`.
 */
export function sharedEndNormal(p: Vec3, centre: Vec3, axis: Vec3, fallback: Vec3): [number, number, number] {
  const x = p[0] - centre[0];
  const y = p[1] - centre[1];
  const z = p[2] - centre[2];
  const along = x * axis[0] + y * axis[1] + z * axis[2];
  const rx = x - axis[0] * along;
  const ry = y - axis[1] * along;
  const rz = z - axis[2] * along;
  const l = Math.hypot(rx, ry, rz);
  return l < 1e-9 ? [fallback[0], fallback[1], fallback[2]] : [rx / l, ry / l, rz / l];
}
