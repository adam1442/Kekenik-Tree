import { linearCurve, linearPoint, type Curve } from '@/contracts/curve';
import { dynamicLodGeneratorParams, lightmapGeneratorParams } from './dynamicLodParams';
import { getNumber, type NodeParams, type ParamDef } from '@/contracts/params';
import { deg2rad } from '@/core/math';
import { createSimplex, type SimplexNoise } from '@/core/noise';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import { NEUTRAL_DEFORM, isDeformActive, type LeafDeform } from '@/geometry/leafDeform';
import { MAX_LOD } from '@/geometry/leafLod';
import { createDisplacementDef, displacementStamp, getHeightField, hasDisplacementSource, sampleHeightField } from '@/materials/displacement';
import { getMaterialSource } from '@/materials/materialSource';
import { section } from '../shared/builders';
import { curveFactor } from './foliageCommon';

export const DEFORM_TAB = 'Deformation';
export const RESOLUTION_TAB = 'Resolution';

/** Default "Size increase %" curve: +36 % at the lowest LOD (the growth the Leaf node always applied: 12 % per LOD). */
export const defaultSizeIncreaseCurve = (): Curve => linearCurve(0, 36, [0, 1], [0, 100]);

/** Default "Mesh LOD" curve: High at LOD 0, Medium at LOD 1, Low from LOD 2 on (value 0 / 1 / 2). */
export function defaultMeshLodCurve(): Curve {
  return {
    points: [linearPoint(0, 0), linearPoint(1 / MAX_LOD, 1), linearPoint(2 / MAX_LOD, 2), linearPoint(1, 2)],
    xRange: [0, 1],
    yRange: [0, 2],
    wrap: 'clamp',
  };
}

/** Leaf "Deformation" tab (Height, Fold, Curl, Twist, Vertex, Scale) and "Resolution" tab. */
export function leafDeformParams(): ParamDef[] {
  const d = section(DEFORM_TAB, 'Deformation');
  const v = section(DEFORM_TAB, 'Vertex');
  const s = section(DEFORM_TAB, 'Scale');
  const r = section(RESOLUTION_TAB, 'Resolution');
  const scale = (id: string, label: string, axis: string): ParamDef =>
    s.float(id, label, 1, { min: 0.01, max: 10, softMax: 3, variance: 0, curve: true, tooltip: `Scales each leaf along its local ${axis} axis. The attachment point stays fixed.` });
  return [
    d.float('deformHeight', 'Height', 0, {
      min: -1,
      max: 1,
      softMin: -0.1,
      softMax: 0.1,
      step: 0.001,
      unit: 'm',
      variance: 0,
      curve: true,
      tooltip: 'Pushes vertices along their normals by the Height map of the leaf’s material (mid grey = no change). Needs a Height texture in the material.',
    }),
    d.float('deformFold', 'Fold', 0, { min: -90, max: 90, unit: '°', variance: 0, curve: true, tooltip: 'Folds both halves of the leaf lengthwise about its Y axis. Negative folds down, positive folds up.' }),
    d.float('deformCurl', 'Curl', 0, { min: -180, max: 180, unit: '°', variance: 0, curve: true, tooltip: 'Curls the leaf around its X axis: the total angle between base and tip.' }),
    d.float('deformTwist', 'Twist', 0, { min: -360, max: 360, unit: '°', variance: 0, curve: true, tooltip: 'Twists the leaf about its Y axis. The farther a vertex is from the X axis, the larger its rotation.' }),
    v.float('vertexAmount', 'Amount', 0, { min: 0, max: 1, softMax: 0.1, step: 0.001, unit: 'm', variance: 0, curve: true, tooltip: 'Strength of the random per-vertex offset (noise in the leaf’s local space).' }),
    v.float('vertexNoise', 'Noise', 2, { min: 0.1, max: 50, softMax: 10, tooltip: 'Tightness of the vertex noise: higher values make smaller, more localized bumps.' }),
    v.seed('vertexSeed', 'Seed'),
    scale('deformScaleX', 'X', 'X'),
    scale('deformScaleY', 'Y', 'Y'),
    scale('deformScaleZ', 'Z', 'Z'),
    r.curve('resSizeIncrease', 'Size increase %', defaultSizeIncreaseCurve(), {
      tooltip: 'Enlarges leaves at lower detail to make up for fewer leaves. X: LOD (0 = highest detail … 3 = lowest), Y: percent.',
    }),
    r.curve('resMeshLod', 'Mesh LOD', defaultMeshLodCurve(), {
      tooltip: 'Which mesh version to use at each LOD. X: LOD (0 … 3), Y: 0 = High, 1 = Medium, 2 = Low.',
    }),
    r.int('resMeshLodOffset', 'Mesh LOD offset', 0, {
      min: -2,
      max: 2,
      tooltip: 'Shifts the chosen mesh LOD toward lower (+) or higher (−) detail. Needs at least two mesh LOD slots filled: with one, it is ignored.',
    }),
    ...dynamicLodGeneratorParams(RESOLUTION_TAB, 'Dynamic LOD'),
    ...lightmapGeneratorParams(0, RESOLUTION_TAB),
  ];
}

const curveParam = (p: NodeParams, id: string): Curve | null => {
  const v = p[id]?.value;
  return v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points) ? (v as Curve) : null;
};

/** Resolution settings of a Leaf node. */
export interface LeafResolution {
  sizeIncrease: Curve | null;
  meshLod: Curve | null;
  meshLodOffset: number;
}

export function readLeafResolution(p: NodeParams): LeafResolution {
  return {
    sizeIncrease: curveParam(p, 'resSizeIncrease') ?? defaultSizeIncreaseCurve(),
    meshLod: curveParam(p, 'resMeshLod') ?? defaultMeshLodCurve(),
    meshLodOffset: Math.round(getNumber(p, 'resMeshLodOffset', 0)),
  };
}

/** Deformation settings of a Leaf node, read once per evaluation. */
export interface LeafDeformConfig {
  noise: SimplexNoise | null;
  tightness: number;
  /** Any deformation parameter is non-neutral. */
  active: boolean;
  hasHeight: boolean;
}

const DEFORM_IDS = ['deformHeight', 'deformFold', 'deformCurl', 'deformTwist', 'vertexAmount'] as const;
const SCALE_IDS = ['deformScaleX', 'deformScaleY', 'deformScaleZ'] as const;

export function readLeafDeform(p: NodeParams): LeafDeformConfig {
  const amount = getNumber(p, 'vertexAmount', 0);
  const active = DEFORM_IDS.some((id) => getNumber(p, id, 0) !== 0) || SCALE_IDS.some((id) => getNumber(p, id, 1) !== 1);
  return {
    noise: amount !== 0 ? createSimplex(Math.round(getNumber(p, 'vertexSeed', 0))) : null,
    tightness: Math.max(0.01, getNumber(p, 'vertexNoise', 2)),
    active,
    hasHeight: getNumber(p, 'deformHeight', 0) !== 0,
  };
}

/** Variance span that still lets "±" act on a neutral value (0): `fraction` of the parameter's useful range. */
const spanOf = (value: number, floor: number): number => Math.max(Math.abs(value), floor);

/**
 * Deformation of one leaf: parameter value with its variance (one random number each, from `rng`'s own sub-stream so the
 * rest of the leaf's randomness is unchanged), times the curve at `u` (position on the parent).
 * Returns undefined when the leaf is not deformed.
 */
export function leafDeformFor(
  cfg: LeafDeformConfig,
  p: NodeParams,
  rng: Rng,
  u: number,
  length: number,
  heightSample: ((u: number, v: number) => number) | null,
  lod: number,
): LeafDeform | undefined {
  if (!cfg.active) return undefined;
  const r = rng.fork('deform');
  const pick = (id: string, fallback: number, floor: number): number =>
    sampleVariance(r, getNumber(p, id, fallback), p[id]?.variance ?? 0, spanOf(getNumber(p, id, fallback), floor)) * curveFactor(p, id, u);
  const height = pick('deformHeight', 0, 0.05);
  const fold = pick('deformFold', 0, 45);
  const curl = pick('deformCurl', 0, 90);
  const twist = pick('deformTwist', 0, 180);
  const amount = pick('vertexAmount', 0, 0.05);
  const scale: [number, number, number] = [pick('deformScaleX', 1, 0.5), pick('deformScaleY', 1, 0.5), pick('deformScaleZ', 1, 0.5)];
  const deform: LeafDeform = {
    ...NEUTRAL_DEFORM,
    length,
    scale: [Math.max(0.001, scale[0]), Math.max(0.001, scale[1]), Math.max(0.001, scale[2])],
    fold: deg2rad(fold),
    curl: deg2rad(curl),
    twist: deg2rad(twist),
    vertexAmount: amount,
    vertexTightness: cfg.tightness,
    noise: cfg.noise,
    noiseOffset: [r.next() * 512, r.next() * 512, r.next() * 512],
    height,
    heightSample,
    // Sparse meshes need vertices to bend: subdivide at high detail only.
    minVertices: lod < 2 ? 24 : 0,
  };
  return isDeformActive(deform) ? deform : undefined;
}

/** Height-map sampler (uv -> 0..1) of a material, or null when it has no decoded Height texture. */
export function materialHeightSampler(materialId: string): ((u: number, v: number) => number) | null {
  const assetId = heightAssetOf(materialId);
  if (!assetId || !hasDisplacementSource(assetId)) return null;
  const field = getHeightField(heightDef(assetId));
  return field ? (u, v) => sampleHeightField(field, u, v) : null;
}

/** true when the material has a Height texture assigned (decoded or not). */
export const materialHasHeight = (materialId: string): boolean => heightAssetOf(materialId) !== '';

function heightAssetOf(materialId: string): string {
  const m = getMaterialSource()?.materials().find((x) => x.id === materialId);
  return m?.slots.height?.texture?.assetId ?? '';
}

/** The material Height texture as a plain greyscale field (no brightness / contrast / normalisation). */
function heightDef(assetId: string) {
  return { ...createDisplacementDef(`height:${assetId}`, 'Height'), assetId, brightness: 0.5, contrast: 0.5, normalize: false };
}

/** Cache-key extra of the Leaf node: changes when a material Height image (or its decoding) changes. */
export function leafDependencyKey(p: NodeParams): string {
  if (getNumber(p, 'deformHeight', 0) === 0) return '';
  return materialHeightKey();
}

/** Stamp of every material Height texture (changes when an image or its decoding changes). */
export function materialHeightKey(): string {
  const mats = getMaterialSource()?.materials() ?? [];
  const parts: string[] = [];
  for (const m of mats) {
    const assetId = m.slots.height?.texture?.assetId;
    if (assetId) parts.push(`${m.id}:${displacementStamp(heightDef(assetId))}`);
  }
  return parts.join('|');
}
