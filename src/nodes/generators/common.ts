import { evaluateCurve } from '@/contracts/curve';
import { OUTPUT_KEY } from '@/contracts/engine';
import { emptyMeshData } from '@/contracts/mesh';
import type { NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import type { PortValue } from '@/contracts/ports';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { clamp } from '@/core/math';
import { applyGeneratorForces } from './forcesHook';
import { displacedSides, tubeDisplacementOptions } from './displacement';
import { resolveMaterialRef } from '@/materials/materialSource';
import { Rng } from '@/core/rng';
import type { SectionKind, SectionShape } from '@/geometry/crossSection';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';
import { attachSkeletonWind } from '@/geometry/windAttributes';
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

function barkRingColor(tint: readonly number[], generation: number, t: number): [number, number, number] {
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

const SECTION_KINDS: Record<string, SectionKind> = { round: 'round', ridged: 'ridged', lobed: 'lobed', noise: 'noise' };

/** Mesh-building options from a generator's Skin / UV / Shape / LOD tabs. */
export function tubeOptionsFromParams(
  params: NodeParams,
  lod: number,
  parent: Skeleton | null,
  materialId: string,
  seed: number,
): TubeOptions {
  const displacement = tubeDisplacementOptions(params, lod, parent);
  const displaced = displacement.displace !== undefined;
  const baseSides = getNumber(params, 'sides', 8);
  const sides = displaced && getBool(params, 'displaceAutoSubdivide', true) ? Math.max(baseSides, Math.round(getNumber(params, 'displaceMinSides', 16))) : baseSides;
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
  };
  const capBase = getString(params, 'capBase', 'auto');
  return {
    maxGeneration: 64,
    radialSegments: (_gen, radius) =>
      lodRadialSides(
        displaced && displacement.maxSegmentLength ? displacedSides(radius, displacement.maxSegmentLength, sides) : sides,
        lod,
        getNumber(params, 'lodSides', 0.5),
      ),
    color: (gen, t) => barkRingColor(tint, gen, t),
    uvMetres: 1,
    materialId,
    ...(parent ? { parent } : {}),
    lengthSegments: Math.round(getNumber(params, 'lengthSegments', 0)),
    segmentKeep: lodSegmentKeep(lod, getNumber(params, 'lodSegments', 0.5)),
    section,
    uv: {
      normalized: getString(params, 'uvMode', 'metric') === 'normalized' || getString(params, 'matchOneVTile', 'generated') === 'yes',
      scaleU: Math.max(0.01, getNumber(params, 'uvScaleU', 1)),
      scaleV: Math.max(0.01, getNumber(params, 'uvScaleV', 1)),
      offsetU: getNumber(params, 'uvOffsetU', 0),
      offsetV: getNumber(params, 'uvOffsetV', 0),
      rotate: getBool(params, 'uvRotate', false),
    },
    ...displacement,
    smoothing: lod >= 2 ? 1 : getNumber(params, 'smoothing', 1),
    flatten: getNumber(params, 'flatten', 0),
    capEnd: getBool(params, 'capEnd', true),
    capStart: capBase === 'yes' ? true : capBase === 'no' ? false : 'auto',
    tipRings: lod >= 2 ? 1 : Math.round(getNumber(params, 'tipRings', 2)),
    collarAmount: getNumber(params, 'collarAmount', 0.3),
    collarLength: getNumber(params, 'collarLength', 1.5),
    twist: getNumber(params, 'skinTwist', 0),
    tintVariance: getNumber(params, 'tintVariance', 0.1),
    aoStrength: getNumber(params, 'aoStrength', 0.6),
    seed,
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
  if (table) fillTableBounds(table, skeleton);
  const hiddenBranches = hiddenBranchSet(table);
  const spineOnly = getBool(params, 'spineOnly', false);
  attachSkeletonWind(skeleton, parent ?? null, seed);
  // The Material property overrides the generator's built-in slot id; a Material Set is resolved with the node's RNG.
  const chosen = getString(params, 'material', '') || materialId;
  const resolvedMaterial = resolveMaterialRef(chosen, new Rng(seed).fork('material'));
  const mesh =
    spineOnly || skeleton.count === 0
      ? emptyMeshData()
      : buildTubeMesh(skeleton, {
          ...tubeOptionsFromParams(params, lod, parent ?? null, resolvedMaterial, seed),
          ...(hiddenBranches ? { skipBranch: (bi: number) => hiddenBranches.has(bi) } : {}),
        });

  const instances = instancesOverride ?? skeleton.branches.length;
  return {
    children: { kind: 'Structure', value: { skeleton, ...(table ? { instances: table } : {}) } } satisfies PortValue,
    [OUTPUT_KEY.geometry]: { kind: 'Mesh', value: mesh },
    [OUTPUT_KEY.instances]: { kind: 'Scalar', value: instances },
    [OUTPUT_KEY.branchCount]: { kind: 'Scalar', value: skeleton.branches.length },
    [OUTPUT_KEY.pointCount]: { kind: 'Scalar', value: skeleton.count },
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
