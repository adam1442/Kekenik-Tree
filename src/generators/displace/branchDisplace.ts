import { curveToLUT, type Curve } from '@/contracts/curve';
import { lodDisplacementFactor, mipLevelFor } from '@/geometry/displaceMesh';
import type { TubeDisplaceVertex } from '@/geometry/displaceMesh';
import { sampleHeightMips, type HeightField } from '@/materials/displacement';
import { barkHeight, barkMaturityFactor, type BarkSpec } from './bark';
import { branchSeed, periodicFbm2, periodicNoise2 } from './noise';

/** Extra per-vertex inputs the branch displacer needs on top of the legacy tube vertex. */
export interface BranchDisplaceVertex extends TubeDisplaceVertex {
  /** Mesher U coordinate of the vertex (tile units, includes the UV offset). */
  uvU: number;
  /** Mesher V coordinate of the vertex. */
  uvV: number;
  /** Number of U tiles around the branch. */
  uTiles: number;
  /** Length of the branch in metres. */
  length: number;
  /** Radius of the first real ring (flares are a multiple of it). */
  baseRadius: number;
  /** Metres past the end of the junction / weld rings (negative or 0 on the rings that must not move). */
  sFree: number;
  /** Id of the branch (every branch gets its own noise pattern). */
  branch: number;
  /** Bark: lineage key (the host's branch id for split halves / extensions); defaults to `branch`. */
  lineage?: number;
  /** Bark: metres along the lineage at this vertex (`s` plus the host's length up to the attach point); defaults to `s`. */
  sLineage?: number;
  /** true when the branch continues its parent's open end (split half, extension): the bark fades in like a junction. */
  continued?: boolean;
}

/** Offsets of one vertex in metres: along the ring direction, along the spine, along the surface normal. */
export interface DisplaceOut {
  radial: number;
  along: number;
  normal: number;
}

export type BranchDisplacer = (v: BranchDisplaceVertex, out: DisplaceOut) => void;

export type DisplaceSource = 'noise' | 'material' | 'displacement' | 'bark';
export type DisplaceMapping = 'uvs' | 'fit';

export interface BranchDisplaceSpec {
  source: DisplaceSource;
  /** Main: metres of movement away from (+) / toward (-) the spine at full height. */
  radial: number;
  /** Main: metres of movement along the spine at full height. */
  length: number;
  /** Main: remaps the height values (null = linear). */
  sharpness: Float32Array | null;
  mapping: DisplaceMapping;
  scaleU: number;
  scaleV: number;
  seed: number;
  /** Mip chain of the Height map (Material / Displacement sources). */
  map: readonly HeightField[] | null;
  fine: { amount: number; sharpness: Float32Array | null; scale: number };
  /** Shape creases: `amount` is a fraction of the local radius, `twist` degrees of rotation per metre of spine. */
  shape: { amount: number; twist: number; scale: number; seed: number };
  /** Flares: `radius` is a multiple of the base radius, `height` metres, `angle` degrees, `pinch` 0..1. */
  flares: { radius: number; noiseScale: number; height: number; pinch: number; angle: number; seed: number };
  /** Fade lengths in radii (junction base / tip). */
  fadeBase: number;
  fadeTip: number;
  lod: number;
  lodFade: boolean;
  /** Bark source settings (used when `source` is 'bark'). */
  bark?: BarkSpec;
}

/** Noise cells per image tile / per unit of scale. */
const CELLS = 4;
/** Fine noise feature size in metres at Scale 1. */
const FINE_CELL = 0.125;
/** Shape creases are this much longer along the spine than they are wide. */
const CREASE_STRETCH = 6;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

const smooth01 = (x: number): number => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};

/** Linear when the curve is the identity (so nothing needs remapping), otherwise a 256-entry lookup table. */
export function sharpnessLut(curve: Curve | null | undefined): Float32Array | null {
  if (!curve) return null;
  const lut = curveToLUT(curve, 256);
  let identity = true;
  for (let i = 0; i < lut.length; i++) {
    if (Math.abs((lut[i] as number) - i / (lut.length - 1)) > 1e-3) {
      identity = false;
      break;
    }
  }
  return identity ? null : lut;
}

/** Applies the Sharpness remap to a 0..1 height value. */
export function applySharpness(lut: Float32Array | null, h: number): number {
  const x = clamp01(h);
  if (!lut) return x;
  const f = x * (lut.length - 1);
  const i = Math.min(lut.length - 2, Math.floor(f));
  const a = lut[i] as number;
  return clamp01(a + ((lut[i + 1] as number) - a) * (f - i));
}

/**
 * Flare offset (metres, outward) of one vertex: lobes around the circumference (seamless noise, `noiseScale`
 * cells), strongest at the base and gone at `height` metres up the spine. Never exceeds `radius x baseRadius`.
 */
export function flareOffset(f: BranchDisplaceSpec['flares'], u: number, s: number, baseRadius: number, branch: number): number {
  if (f.radius <= 0 || f.height <= 0) return 0;
  const up = s <= 0 ? 0 : clamp01(s / f.height);
  const profile = (1 - up) * (1 - up);
  if (profile <= 0) return 0;
  const cells = Math.max(1, Math.round(f.noiseScale));
  const n = periodicNoise2((u + f.angle / 360) * cells, 0.37, cells, branchSeed(f.seed, branch));
  // Pinch narrows the lobes toward their spine (1 = thin ridges, no spread at the base).
  const lobe = Math.pow(clamp01((n - 0.25) / 0.6), 1 + 2 * clamp01(f.pinch));
  return f.radius * baseRadius * lobe * profile;
}

/** Shape crease offset (metres, signed) of one vertex: creases running along the spine, twisted from the base. */
export function creaseOffset(sh: BranchDisplaceSpec['shape'], v: BranchDisplaceVertex): number {
  if (sh.amount === 0) return 0;
  const cells = Math.max(2, Math.round(CELLS * 1.5 * sh.scale));
  const phase = (sh.twist * Math.max(0, v.s)) / 360;
  const along = (Math.max(0, v.s) * cells) / (CREASE_STRETCH * Math.max(1e-4, v.circumference));
  const n = periodicNoise2((v.u + phase) * cells, along, cells, branchSeed(sh.seed, v.branch));
  const ridge = 1 - Math.abs(2 * n - 1);
  return sh.amount * v.radius * (ridge - 0.5);
}

/** Fine noise offset (metres, signed) along the surface normal. */
export function fineOffset(fine: BranchDisplaceSpec['fine'], v: BranchDisplaceVertex, seed: number): number {
  if (fine.amount === 0) return 0;
  const size = FINE_CELL * Math.max(0.05, fine.scale);
  const cells = Math.max(1, Math.round(v.circumference / size));
  const n = periodicFbm2(v.u * cells, Math.max(0, v.s) / size, cells, branchSeed(seed + 7919, v.branch));
  // Scale above 1 pushes the surface out on average, below 1 pulls it in.
  const bias = Math.min(0.5, Math.max(-0.5, (fine.scale - 1) * 0.5));
  return fine.amount * (applySharpness(fine.sharpness, n) - 0.5 + bias);
}

/** Height 0..1 of the Main source at a vertex (before Sharpness). */
export function mainHeight(spec: BranchDisplaceSpec, v: BranchDisplaceVertex): number {
  const uvs = spec.mapping === 'uvs';
  const along = uvs ? v.uvV : v.t;
  if (spec.source === 'noise' || !spec.map) {
    const cells = Math.max(1, Math.round((uvs ? v.uTiles : 1) * CELLS * spec.scaleU));
    return periodicFbm2(v.u * cells, along * CELLS * spec.scaleV, cells, branchSeed(spec.seed, v.branch));
  }
  const chain = spec.map;
  const base = chain[0] as HeightField;
  const tilesU = Math.max(1, Math.round((uvs ? v.uTiles : 1) * spec.scaleU));
  const level = mipLevelFor((base.width * tilesU) / Math.max(3, v.sides), spec.lod);
  return sampleHeightMips(chain, v.u * tilesU, along * spec.scaleV, level);
}

/** Fade 0..1 near the junction / weld rings (`sFree` metres past them) and toward the tip. */
export function displaceFade(spec: BranchDisplaceSpec, v: BranchDisplaceVertex, tip: boolean): number {
  const r = Math.max(1e-4, v.radius);
  let fade = 1;
  if (tip && spec.fadeTip > 0) fade *= smooth01(v.sEnd / (spec.fadeTip * r));
  if ((v.junction || (spec.source === 'bark' && v.continued)) && spec.fadeBase > 0) fade *= smooth01(v.sFree / (spec.fadeBase * r));
  return fade;
}

/** true when the Bark source is selected and has a non-zero depth. */
export const barkActive = (spec: BranchDisplaceSpec): boolean => spec.source === 'bark' && spec.bark !== undefined && spec.bark.depth !== 0;

/** Bark offset (metres, signed, along the surface normal) of one vertex, before the junction / tip fade. */
export function barkOffset(bark: BarkSpec, v: BranchDisplaceVertex): number {
  const lineage = v.lineage ?? v.branch;
  const s = v.sLineage ?? v.s;
  const h = barkHeight(bark, { u: v.u, s, circumference: v.circumference }, branchSeed(bark.seed, lineage));
  return bark.depth * v.radius * (h - 0.5) * barkMaturityFactor(bark.maturity, v.radius, v.t);
}

/** true when the spec would not move any vertex. */
export function isDisplaceIdle(spec: BranchDisplaceSpec): boolean {
  const main = (spec.radial !== 0 || spec.length !== 0) && (spec.source === 'noise' || spec.map !== null);
  return !main && !barkActive(spec) && spec.fine.amount === 0 && spec.shape.amount === 0 && !(spec.flares.radius > 0 && spec.flares.height > 0);
}

/** Builds the per-vertex displacer of the Displacement tab; null when nothing would move. */
export function createBranchDisplacer(spec: BranchDisplaceSpec): BranchDisplacer | null {
  if (isDisplaceIdle(spec)) return null;
  const lodFactor = spec.lodFade ? lodDisplacementFactor(spec.lod) : 1;
  const useMain = (spec.radial !== 0 || spec.length !== 0) && (spec.source === 'noise' || (spec.source !== 'bark' && spec.map !== null));
  const bark = barkActive(spec) ? spec.bark : undefined;
  return (v, out) => {
    let radial = 0;
    let along = 0;
    let normal = 0;
    const fade = displaceFade(spec, v, true);
    if (lodFactor > 0 && fade > 0) {
      if (useMain) {
        const h = applySharpness(spec.sharpness, mainHeight(spec, v));
        radial += spec.radial * h * fade * lodFactor;
        along += spec.length * h * fade * lodFactor;
      }
      if (bark) normal += barkOffset(bark, v) * fade * lodFactor;
      normal += fineOffset(spec.fine, v, spec.seed) * fade * lodFactor;
      radial += creaseOffset(spec.shape, v) * fade * lodFactor;
    }
    radial += flareOffset(spec.flares, v.u, v.s, v.baseRadius, v.branch) * displaceFade(spec, v, false);
    out.radial = Number.isFinite(radial) ? radial : 0;
    out.along = Number.isFinite(along) ? along : 0;
    out.normal = Number.isFinite(normal) ? normal : 0;
  };
}
