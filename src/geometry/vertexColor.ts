import { getBool, getString, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { hash01 } from './math3';

/**
 * Procedural vertex colours (SpeedTree "Vertex Color" group). Pure maths: no three.js, no graph types.
 *
 * Generator side (`VertexColorOptions`): a tube generator either keeps the colour it would have had (Inherit), tints it
 * (Multiply), replaces it (Set) or brightens it (Add). The result is blended in by `profile` (along the branch) and
 * `parentCurve` (along the parent at the attach point), so colour can vary along a branch and across the tree.
 *
 * Tree side (`VertexColorPacking`): `legacy` stores the baked albedo tint x AO in RGB (the behaviour before this
 * feature). `kekenik` stores shader masks instead: R = per-branch random tint, G = height 0 (base) .. 1 (top of the
 * plant), B = ambient occlusion (analytic, or baked at export).
 */
export const VC_MODES = ['inherit', 'multiply', 'set', 'add'] as const;
export type VcMode = (typeof VC_MODES)[number];

export const VC_PACKINGS = ['legacy', 'kekenik'] as const;
export type VcPacking = (typeof VC_PACKINGS)[number];

export type Rgb = [number, number, number];

export interface VertexColorOptions {
  mode: VcMode;
  /** Linear RGB used by Multiply / Set / Add. */
  color: Rgb;
  /** 0..1 per-branch brightness variation (deterministic). */
  variance: number;
  /** The colour at the attach point equals the parent's colour exactly and fades into the own colour along the collar. */
  seamless: boolean;
  /** Effect amount along the branch (x: base 0 .. tip 1); null = 1. */
  profile: Float32Array | null;
  /** Effect amount along the parent at the attach point (x: parent base 0 .. tip 1); null = 1. */
  parentCurve: Float32Array | null;
}

/** Channel layout of the Kekenik packing, as documented for shader authors. */
export const KEKENIK_CHANNELS = { r: 'per-branch random tint', g: 'height 0 (base) .. 1 (top)', b: 'ambient occlusion' } as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export function parseVcMode(raw: string): VcMode {
  return (VC_MODES as readonly string[]).includes(raw) ? (raw as VcMode) : 'inherit';
}

export function parseVcPacking(raw: unknown): VcPacking {
  return typeof raw === 'string' && (VC_PACKINGS as readonly string[]).includes(raw.toLowerCase()) ? (raw.toLowerCase() as VcPacking) : 'legacy';
}

/** True when the options change nothing: the mesher then keeps the exact legacy colour path. */
export function isNeutralVertexColor(o: VertexColorOptions | undefined): boolean {
  return !o || (o.mode === 'inherit' && o.variance <= 0 && !o.seamless);
}

/** Colour maths of one mode: `base` is the colour inherited from the parent generator / bark ramp, `color` the generator's own. */
export function applyVcMode(mode: VcMode, base: Rgb, color: Rgb): Rgb {
  switch (mode) {
    case 'multiply':
      return [base[0] * color[0], base[1] * color[1], base[2] * color[2]];
    case 'set':
      return [color[0], color[1], color[2]];
    case 'add':
      return [Math.min(1, base[0] + color[0]), Math.min(1, base[1] + color[1]), Math.min(1, base[2] + color[2])];
    default:
      return [base[0], base[1], base[2]];
  }
}

/** Deterministic per-branch brightness factor from a 0..1 hash: 1 +- variance. */
export function varianceFactor(hash01: number, variance: number): number {
  return 1 + (hash01 * 2 - 1) * Math.max(0, Math.min(1, variance));
}

/** Samples a 0..1 lookup table (256 entries) at x in 0..1; null = 1. */
export function sampleLut(lut: Float32Array | null, x: number): number {
  if (!lut || lut.length === 0) return 1;
  const f = clamp01(x) * (lut.length - 1);
  const i = Math.floor(f);
  const a = lut[i] as number;
  const b = lut[Math.min(lut.length - 1, i + 1)] as number;
  return Math.max(0, a + (b - a) * (f - i));
}

/**
 * The generator colour of one ring: `base` -> mode result by `amount` (profile x parent curve), then the per-branch
 * variance. Neutral options return `base` unchanged.
 */
export function modifyColor(base: Rgb, o: VertexColorOptions, amount: number, hash01: number): Rgb {
  const own = applyVcMode(o.mode, base, o.color);
  const a = clamp01(amount);
  const f = o.variance > 0 ? varianceFactor(hash01, o.variance) : 1;
  return [(base[0] + (own[0] - base[0]) * a) * f, (base[1] + (own[1] - base[1]) * a) * f, (base[2] + (own[2] - base[2]) * a) * f];
}

/** Kekenik packing of one vertex: R random tint, G height, B ambient occlusion (all clamped to 0..1). */
export function packKekenik(branchTint: number, height01: number, ao: number): Rgb {
  return [clamp01(branchTint), clamp01(height01), clamp01(ao)];
}

/** Height 0..1 of `z` inside [zMin, zMax]; a flat range gives 0. */
export function normalisedHeight(z: number, zMin: number, zMax: number): number {
  const span = zMax - zMin;
  return span > 1e-9 ? clamp01((z - zMin) / span) : 0;
}

/** Neutral per-branch tint of meshes that have none (leaves, cards, imported meshes). */
export const DEFAULT_BRANCH_TINT = 0.5;

interface PackInput {
  positions: Float32Array;
  ao?: Float32Array;
  branchTint?: Float32Array;
  /** Plant-wide z range (all meshes together); defaults to this mesh's own range. */
  zRange?: readonly [number, number];
}

/** Z range of several position arrays (Z is up). */
export function zRangeOf(list: readonly Float32Array[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of list) {
    for (let i = 2; i < p.length; i += 3) {
      const z = p[i] as number;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
  }
  return lo <= hi ? [lo, hi] : [0, 0];
}

/** RGBA colours of the Kekenik packing for one mesh (alpha 1). */
export function packKekenikColors(m: PackInput): Float32Array {
  const n = m.positions.length / 3;
  const [zMin, zMax] = m.zRange ?? zRangeOf([m.positions]);
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const c = packKekenik(m.branchTint ? (m.branchTint[i] as number) : DEFAULT_BRANCH_TINT, normalisedHeight(m.positions[i * 3 + 2] as number, zMin, zMax), m.ao ? (m.ao[i] as number) : 1);
    out[i * 4] = c[0];
    out[i * 4 + 1] = c[1];
    out[i * 4 + 2] = c[2];
    out[i * 4 + 3] = 1;
  }
  return out;
}

/**
 * Final colour of every skeleton point written while meshing (rgb per point), keyed by skeleton. A child generator reads
 * the parent's entry at the attach point so that "Inherit + seamless" continues the parent's colour exactly.
 */
const POINT_COLORS = new WeakMap<Skeleton, Float32Array>();

export function recordPointColors(sk: Skeleton): Float32Array {
  const a = new Float32Array(sk.count * 3).fill(-1);
  POINT_COLORS.set(sk, a);
  return a;
}

/** Recorded colour of skeleton point `index`, or null when it was never written. */
export function recordedPointColor(sk: Skeleton, index: number): Rgb | null {
  const a = POINT_COLORS.get(sk);
  if (!a || index < 0 || index * 3 + 2 >= a.length) return null;
  const r = a[index * 3] as number;
  return r < 0 ? null : [r, a[index * 3 + 1] as number, a[index * 3 + 2] as number];
}

/** Colour of one item (leaf, frond, decal, fin, cluster body) at `t` 0 (base) .. 1 (tip), starting from its own base colour. */
export type ItemColorFn = (base: Rgb, t: number) => Rgb;

/** Length of the Seamless transition from the parent's colour into the item's own colour, as a fraction of the item. */
export const ITEM_SEAMLESS_LENGTH = 0.25;

/** Inputs of `itemColorFn`: the item's attach point on its parent and its deterministic hash keys. */
export interface ItemColorSpec {
  options: VertexColorOptions | undefined;
  parent: Skeleton;
  /** Parent skeleton point the item grows from. */
  point: number;
  /** Position of the attach point along the parent (0 base .. 1 tip), or the [from, to] range an item runs along (a frond). */
  at: number | readonly [number, number];
}

/** Per-item random tint 0..1 (the R channel of the Kekenik packing). */
export function itemBranchTint(key: number, seed: number): number {
  return hash01(key + 17, seed);
}

/**
 * The Mode / Profile / Parent curve / Seamless maths of a non-tube generator: the same `modifyColor` the tube mesher uses.
 * Undefined for neutral options, so the caller keeps its exact legacy colour. The brightness variance of items is the
 * generator's own Material > Vertex Color > Variance, so `variance` of the options is not read here.
 */
export function itemColorFn(spec: ItemColorSpec): ItemColorFn | undefined {
  const o = spec.options;
  if (!o) return undefined;
  const own: VertexColorOptions = { ...o, variance: 0 };
  const parentColor = o.seamless ? recordedPointColor(spec.parent, spec.point) : null;
  const range = typeof spec.at === 'number' ? null : spec.at;
  const fixed = typeof spec.at === 'number' ? sampleLut(o.parentCurve, spec.at) : 1;
  return (base, t) => {
    const along = range ? sampleLut(o.parentCurve, range[0] + (range[1] - range[0]) * t) : fixed;
    const c = modifyColor(base, own, sampleLut(o.profile, t) * along, 0);
    if (!parentColor) return c;
    const k = Math.exp(-clamp01(t) / ITEM_SEAMLESS_LENGTH);
    return [c[0] + (parentColor[0] - c[0]) * k, c[1] + (parentColor[1] - c[1]) * k, c[2] + (parentColor[2] - c[2]) * k];
  };
}

/** Tree > Vertex Color as the scene carries it. */
export interface TreeVertexColor {
  compute: boolean;
  packing: VcPacking;
}

/** Reads the Tree node's Vertex Color tab (defaults = the behaviour before the feature). */
export function readTreeVertexColor(params: NodeParams): TreeVertexColor {
  return { compute: getBool(params, 'vertexColorCompute', true), packing: parseVcPacking(getString(params, 'vertexColorPacking', 'legacy')) };
}
