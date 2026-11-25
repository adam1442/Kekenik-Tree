import { curveToLUT, evaluateCurve, type Curve } from '@/contracts/curve';
import { lodLengthFactor, lodRadialFactor, readGeneratorLod } from './dynamicLodParams';
import { OUTPUT_KEY } from '@/contracts/engine';
import { emptyMeshData } from '@/contracts/mesh';
import type { NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import type { PortValue } from '@/contracts/ports';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { isNeutralVertexColor, parseVcMode, type VertexColorOptions } from '@/geometry/vertexColor';
import { RADIAL_BASIS, radialSegmentCount } from '@/generators/spine';
import { applyGeneratorForces } from './forcesHook';
import { displacedSides, tubeDisplacementOptions } from './displacement';
import { resolveMaterialRef } from '@/materials/materialSource';
import { applySeasonGravity, seasonNodeValue } from '@/seasons/gravity';
import { Rng } from '@/core/rng';
import type { SectionKind, SectionShape } from '@/geometry/crossSection';
import { buildTubeMesh, SQUASH_ANGLE_ATTR, SQUASH_ATTR, type TubeOptions } from '@/geometry/tubeMesher';
import { branchVisibility, isSpineOnly, SUB_LEVEL_ATTR } from '@/generators/skin';
import { attachSkeletonWind } from '@/geometry/windAttributes';
import { readWeldConfig } from './weldApply';
import { MATERIAL_INHERITED } from '@/generators/uv';
import { primaryMaterialRef, readUvMapping, uvMaterialOptions } from './uvConfig';
import { fillTableBounds } from '@/instances/scope';
import { FLAG_HIDDEN, type InstanceTable } from '@/instances/types';

export const MAX_BRANCHES_PER_NODE = 250_000;

export function extractParentSkeleton(inputs: NodeInputs): Skeleton {
  const v = inputs.parent?.[0];
  return v && v.kind === 'Structure' ? v.value.skeleton : emptySkeleton();
}

/** Instance table of the parent generator (Node mode), or null when the parent does not track instances. */
export function extractParentTable(inputs: NodeInputs | undefined): InstanceTable | null {
  const v = inputs?.parent?.[0];
  return v && v.kind === 'Structure' ? (v.value.instances ?? null) : null;
}

export function isGeneratorActive(params: NodeParams, lod: number): boolean {
  if (!getBool(params, 'active', true)) return false;
  const activeCurve = params.active?.curve;
  if (activeCurve) {
    const uLod = clamp(lod / 3, 0, 1);
    return evaluateCurve(activeCurve, uLod) >= 0.5;
  }
  return true;
}

export function lodRadialSides(sides: number, lod: number, lodSidesReduction: number): number {
  if (lod <= 0) return Math.max(3, Math.round(sides));
  const factor = Math.pow(1 - clamp(lodSidesReduction, 0, 0.9) * 0.4, Math.min(lod, 3));
  return Math.max(3, Math.round(sides * factor));
}

/** Fraction of rings kept at a LOD level (continuous in `lod`). */
export function lodSegmentKeep(lod: number, lodSegmentReduction: number): number {
  if (lod <= 0) return 1;
  return clamp(Math.pow(1 - clamp(lodSegmentReduction, 0, 0.9) * 0.4, Math.min(lod, 3)), 0.1, 1);
}

export function barkRingColor(tint: readonly number[], generation: number, t: number): [number, number, number] {
  const l = 0.11 - generation * 0.01 - t * 0.02;
  const rScale = (tint[0] ?? 0.36) / 0.36;
  const gScale = (tint[1] ?? 0.26) / 0.26;
  const bScale = (tint[2] ?? 0.18) / 0.18;
  return [
    Math.max(0.015, l * 1.45 * rScale),
    Math.max(0.012, l * 1.02 * gScale),
    Math.max(0.008, l * 0.68 * bScale),
  ];
}

const SECTION_KINDS: Record<string, SectionKind> = { round: 'round', ridged: 'ridged', lobed: 'lobed', noise: 'noise', organic: 'organic' };

/** Skin > Vertex color of a generator; undefined = neutral (the mesher keeps the exact legacy colour path). */
export function readVertexColorOptions(params: NodeParams): VertexColorOptions | undefined {
  const raw = params.vcColor?.value;
  const c = Array.isArray(raw) && raw.length >= 3 ? (raw as number[]) : [1, 1, 1];
  const curveLut = (id: string): Float32Array | null => {
    const v = params[id]?.value;
    return v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points) ? curveToLUT(v as Curve, 256) : null;
  };
  const o: VertexColorOptions = {
    mode: parseVcMode(getString(params, 'vcMode', 'inherit')),
    color: [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1],
    variance: clamp(getNumber(params, 'vcVariance', 0), 0, 1),
    seamless: getBool(params, 'vcSeamless', false),
    profile: curveLut('vcProfile'),
    parentCurve: curveLut('vcParentCurve'),
  };
  return isNeutralVertexColor(o) ? undefined : o;
}

/** Mesh-building options from a generator's Skin / UV / Shape / LOD tabs. */
export function tubeOptionsFromParams(
  params: NodeParams,
  lod: number,
  parent: Skeleton | null,
  materialId: string,
  seed: number,
  skeleton?: Skeleton,
  inheritedMaterial?: string,
): TubeOptions {
  const displacement = tubeDisplacementOptions(params, lod, skeleton ?? parent, materialId);
  const displaced = displacement.displace !== undefined || displacement.displaceField !== undefined;
  const radialAbsolute = getNumber(params, 'sides', 8);
  const radialRelative = getNumber(params, 'radialRelative', 0);
  const radialBasis = getString(params, 'radialBasis', RADIAL_BASIS.radius);
  const segmentScalar = clamp(getNumber(params, 'segmentScalar', 1), 0.1, 4);
  const stored = skeleton?.attributes.get('radialSides');
  const autoSubdivide = displaced && getBool(params, 'displaceAutoSubdivide', true);
  const minSides = Math.round(getNumber(params, 'displaceMinSides', 16));
  /** Radial segments of a branch: the count the spine stored (Segments > Radial), or the formula without a parent. */
  const sidesOf = (radius: number, branchIndex: number | undefined): number => {
    const branch = branchIndex === undefined ? undefined : skeleton?.branches[branchIndex];
    const own = branch && stored ? (stored[branch.start] as number) : 0;
    const base =
      own > 0
        ? own
        : radialSegmentCount({ absolute: radialAbsolute, relative: radialRelative, basis: radialBasis, radius, parentSides: 0, scalar: segmentScalar });
    return autoSubdivide ? Math.max(base, minSides) : base;
  };
  const rawTint = params.tint?.value;
  const tint = Array.isArray(rawTint) && rawTint.length >= 3 ? (rawTint as number[]) : [0.36, 0.26, 0.18, 1];
  const section: SectionShape = {
    kind: SECTION_KINDS[getString(params, 'sectionShape', 'round')] ?? 'round',
    aspect: getNumber(params, 'sectionAspect', 1),
    roundness: getNumber(params, 'sectionRoundness', 1),
    lobes: Math.round(getNumber(params, 'sectionLobes', 5)),
    depth: getNumber(params, 'sectionDepth', 0.12),
    spiral: getNumber(params, 'sectionSpiral', 0),
    noiseFrequency: getNumber(params, 'sectionNoiseFrequency', 2),
    seed: seed || 1,
    oval: Math.max(0, getNumber(params, 'sectionOval', 0.1)),
    drift: Math.max(0.05, getNumber(params, 'sectionDrift', 2)),
    grainTwist: getNumber(params, 'grainTwist', 0),
  };
  const capBase = getString(params, 'capBase', 'auto');
  const genLod = readGeneratorLod(params);
  const radialLod = lodRadialFactor(genLod, lod);
  return {
    maxGeneration: 64,
    radialSegments: (_gen, radius, branchIndex) => {
      const sides = sidesOf(radius, branchIndex);
      const reduced = lodRadialSides(
        displaced && displacement.maxSegmentLength
          ? displacedSides(radius, displacement.displaceSideSpacing ?? displacement.maxSegmentLength, sides, displacement.displaceMaxSides)
          : sides,
        lod,
        getNumber(params, 'lodSides', 0.5),
      );
      return radialLod === 1 ? reduced : Math.max(3, Math.round(reduced * radialLod));
    },
    color: (gen, t) => barkRingColor(tint, gen, t),
    uvMetres: 1,
    materialId,
    ...(parent ? { parent } : {}),
    segmentKeep: clamp(lodSegmentKeep(lod, getNumber(params, 'lodSegments', 0.5)) * lodLengthFactor(genLod, lod), 0.05, 1),
    section,
    uvMapping: readUvMapping(params),
    ...(uvMaterialOptions(params) ? { uvMaterials: uvMaterialOptions(params) as NonNullable<TubeOptions['uvMaterials']> } : {}),
    ...(inheritedMaterial ? { inheritedMaterial } : {}),
    ...displacement,
    smoothing: lod >= 2 ? 1 : getNumber(params, 'smoothing', 1),
    flatten: getNumber(params, 'flatten', 0),
    capEnd: getBool(params, 'capEnd', true),
    capStart: capBase === 'yes' ? true : capBase === 'no' ? false : 'auto',
    tipRings: lod >= 2 ? 1 : Math.round(getNumber(params, 'tipRings', 2)),
    collarAmount: getNumber(params, 'collarAmount', 0.3),
    collarLength: getNumber(params, 'collarLength', 1.5),
    collarSwell: Math.max(0, getNumber(params, 'collarSwell', 0)),
    ...buttressOptions(params),
    twist: getNumber(params, 'skinTwist', 0),
    tintVariance: getNumber(params, 'tintVariance', 0.1),
    aoStrength: getNumber(params, 'aoStrength', 0.6),
    ...(readVertexColorOptions(params) ? { vertexColor: readVertexColorOptions(params) as VertexColorOptions } : {}),
    ...weldMeshOptions(params),
    roll: getNumber(params, 'skinRoll', 0),
    smooth: getNumber(params, 'skinSmooth', 0),
    seam: getNumber(params, 'seamReduction', 0),
    extensionBlend: {
      length: clamp(getNumber(params, 'extensionBlendLength', 2), 0.5, 8),
      contrast: clamp(getNumber(params, 'extensionBlendContrast', 0.35), 0, 1),
      noise: clamp(getNumber(params, 'extensionBlendNoise', 0.3), 0, 1),
    },
    ...squashOptions(params),
    seed,
  };
}

/** Shape > Buttress as the mesher receives it (empty when the count is 0 or a size is 0). */
function buttressOptions(params: NodeParams): Pick<TubeOptions, 'buttress'> {
  const count = Math.max(0, Math.round(getNumber(params, 'buttressCount', 0)));
  const height = Math.max(0, getNumber(params, 'buttressHeight', 1.5));
  const length = Math.max(0, getNumber(params, 'buttressLength', 1));
  if (count < 1 || height <= 0 || length <= 0) return {};
  return { buttress: { count, height, length, thickness: clamp(getNumber(params, 'buttressThickness', 0.3), 0.02, 1) } };
}

/** Skin > Squash Amount (0..1) and Rotate (degrees); the single reader of both parameters. */
function readSquash(params: NodeParams): { amount: number; rotateDeg: number } {
  return { amount: clamp(getNumber(params, 'squashAmount', 0), 0, 1), rotateDeg: getNumber(params, 'squashRotate', 0) };
}

/** Skin > Squash as the mesher receives it (empty when the amount is 0). */
function squashOptions(params: NodeParams): Pick<TubeOptions, 'squash'> {
  const { amount, rotateDeg } = readSquash(params);
  return amount > 0 ? { squash: { amount, rotate: deg2rad(rotateDeg) } } : {};
}

/** Mesher options of Skin > Welding (empty when welding is off). */
function weldMeshOptions(params: NodeParams): Pick<TubeOptions, 'weld'> {
  const w = readWeldConfig(params);
  if (!w.enabled) return {};
  const blend = getBool(params, 'weldBlendEnabled', true)
    ? {
        texture: Math.max(0, getNumber(params, 'weldBlendTexture', 1)),
        textureScale: Math.max(0.01, getNumber(params, 'weldBlendTextureScale', 1)),
        contrast: clamp(getNumber(params, 'weldBlendContrast', 0.35), 0, 1),
        noise: clamp(getNumber(params, 'weldBlendNoise', 0.3), 0, 1),
        ...(params.weldBlendLighting?.curve ? { lighting: params.weldBlendLighting.curve } : {}),
      }
    : undefined;
  return {
    weld: { offset: w.offset, spread: w.spreadAmount, upper: w.upperScale, lower: w.lowerScale, scalar: w.scalar, forceRays: w.forceRays, ...(blend ? { blend } : {}) },
  };
}

/**
 * Wraps a generated `Skeleton` into `NodeOutputs`, emitting `children`, `instances`,
 * `branchCount`, `pointCount`, and `geometry` (unless `spineOnly` is true). Wind channels are attached to the
 * skeleton so children inherit them.
 */
export function emitStructureOutput(
  skeleton: Skeleton,
  params: NodeParams,
  lod: number,
  materialId = 'bark',
  instancesOverride?: number,
  parent?: Skeleton,
  seed = 0,
  inputs?: NodeInputs,
  table?: InstanceTable,
): NodeOutputs {
  applyGeneratorForces(skeleton, params, inputs, seed);
  const seasonT = seasonNodeValue(params);
  applySeasonGravity(skeleton, params, seasonT, seed);
  if (table) fillTableBounds(table, skeleton);
  const hiddenBranches = hiddenBranchSet(table);
  const spineOnly = isSpineOnly(params);
  attachSkeletonWind(skeleton, parent ?? null, seed, getNumber(params, 'windPhaseVariance', 0.5));
  writeSquashAttributes(skeleton, params);
  // The Material property overrides the generator's built-in slot id; a Material Set is resolved with the node's RNG.
  const parentValue = inputs?.parent?.[0];
  const parentMaterial = parentValue && parentValue.kind === 'Structure' ? parentValue.value.materialId : undefined;
  const ref = primaryMaterialRef(params);
  const chosen = ref === MATERIAL_INHERITED ? (parentMaterial ?? materialId) : ref || materialId;
  const resolvedMaterial = resolveMaterialRef(chosen, new Rng(seed).fork('material'), undefined, seasonT);
  const mesh =
    spineOnly || skeleton.count === 0
      ? emptyMeshData()
      : buildTubeMesh(skeleton, {
          ...tubeOptionsFromParams(params, lod, parent ?? null, resolvedMaterial, seed, skeleton, parentMaterial ?? materialId),
          ...skipOptions(skeleton, params, parent ?? null, hiddenBranches),
        });

  const instances = instancesOverride ?? skeleton.branches.length;
  return {
    children: { kind: 'Structure', value: { skeleton, materialId: resolvedMaterial, ...(table ? { instances: table } : {}) } } satisfies PortValue,
    [OUTPUT_KEY.geometry]: { kind: 'Mesh', value: mesh },
    [OUTPUT_KEY.instances]: { kind: 'Scalar', value: instances },
    [OUTPUT_KEY.branchCount]: { kind: 'Scalar', value: skeleton.branches.length },
    [OUTPUT_KEY.pointCount]: { kind: 'Scalar', value: skeleton.count },
  };
}

/** The squash of this node's skin, stored on its skeleton so children that weld to it follow the squashed profile. */
function writeSquashAttributes(skeleton: Skeleton, params: NodeParams): void {
  const { amount, rotateDeg } = readSquash(params);
  if (skeleton.count === 0 || !(amount > 0)) return;
  const angle = deg2rad(rotateDeg + getNumber(params, 'skinRoll', 0));
  skeleton.attributes.set(SQUASH_ATTR, new Float32Array(skeleton.count).fill(amount));
  skeleton.attributes.set(SQUASH_ANGLE_ATTR, new Float32Array(skeleton.count).fill(angle));
}

/** Mesher `skipBranch`: instances hidden in Node mode and branches whose Skin > Visibility curve is not above 0.5. */
function skipOptions(skeleton: Skeleton, params: NodeParams, parent: Skeleton | null, hidden: Set<number> | null): Pick<TubeOptions, 'skipBranch'> {
  const curve = params.skinVisibility?.curve;
  if (!hidden && !curve) return {};
  const subLevel = skeleton.attributes.get(SUB_LEVEL_ATTR);
  return {
    skipBranch: (bi: number): boolean => {
      if (hidden?.has(bi)) return true;
      const b = skeleton.branches[bi];
      if (!curve || !b) return false;
      const host = subLevel && (subLevel[b.start] ?? 0) > 0 ? skeleton : parent;
      const u = host && b.parentPoint >= 0 && b.parentPoint < host.count ? (host.t[b.parentPoint] as number) : 0;
      return !branchVisibility(curve, u);
    },
  };
}

/** Skeleton branch indices owned by hidden instances (null when none is hidden). */
function hiddenBranchSet(table: InstanceTable | undefined): Set<number> | null {
  if (!table) return null;
  let set: Set<number> | null = null;
  for (let i = 0; i < table.count; i++) {
    if (((table.flags[i] as number) & FLAG_HIDDEN) === 0) continue;
    set ??= new Set<number>();
    const s = table.branchStart[i] as number;
    for (let b = 0; b < (table.branchCount[i] as number); b++) set.add(s + b);
  }
  return set;
}
