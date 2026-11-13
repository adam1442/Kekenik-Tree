import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getNumber, getString, type NodeParams } from '@/contracts/params';
import type { TreePlacement } from '@/contracts/ports';
import { emptySkeleton } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { sampleVariance } from '@/graph/engine/seeds';
import { InstanceScope } from '@/instances/scope';
import { emitStructureOutput, MAX_BRANCHES_PER_NODE } from './common';
import { createInstanceConfigResolver } from './instanceSupport';
import { orthonormalNormal, rotateAroundAxis, v3Cross, v3Norm, type Frame3, type Vec3 } from './frames';
import {
  computeInstances,
  DEFAULT_PLACEMENT,
  DISTRIBUTION_MODES,
  GOLDEN_ANGLE,
  type DistributionMode,
  type DistributionOptions,
} from './placement';
import { StructureSkeletonBuilder } from './skeletonBuild';
import { compileSpineConfig, growSpineIntoBuilder } from './spine';

/** Placement disc handed down by the Tree node (null when the parent is not a Tree). */
export function extractPlacement(inputs: NodeInputs): TreePlacement | null {
  const v = inputs.parent?.[0];
  return v && v.kind === 'Structure' ? v.value.placement ?? null : null;
}

/** Read the `Tree placement` section + Common / Generation params into distribution options. */
export function distributionOptionsFromParams(params: NodeParams, count: number): DistributionOptions {
  const rawMode = getString(params, 'distMode', 'uniform');
  const mode: DistributionMode = (DISTRIBUTION_MODES as readonly string[]).includes(rawMode) ? (rawMode as DistributionMode) : 'uniform';
  return {
    mode,
    count,
    position: getNumber(params, 'distPosition', 0.5),
    positionVar: params.distPosition?.variance ?? 0,
    rotation: getNumber(params, 'distRotation', 0),
    rotationVar: params.distRotation?.variance ?? 0,
    sweep: clamp(getNumber(params, 'sweep', 1), 0.01, 1),
    jumble: clamp(getNumber(params, 'jumble', 0), 0, 1),
    roll: getNumber(params, 'roll', 0) * Math.PI,
    minDistance: Math.max(0, getNumber(params, 'distMinDistance', 0.5)),
    sink: getNumber(params, 'sink', 0),
    sinkVar: params.sink?.variance ?? 0,
    splayDeg: getNumber(params, 'distSplay', 0),
  };
}

/** Number of root-level instances: `Number` (+variance) or, in Density mode, density x disc area. */
export function rootInstanceCount(ctx: NodeContext, params: NodeParams, placement: TreePlacement): number {
  const mode = getString(params, 'mode', 'absolute');
  if (mode === 'density') {
    const area = Math.PI * placement.radius * placement.radius;
    return Math.max(1, Math.round(getNumber(params, 'density', 1) * area));
  }
  const n = sampleVariance(ctx.rng.fork('tnum'), getNumber(params, 'number', 1), params.number?.variance ?? 0);
  return Math.max(0, Math.round(n));
}

export type RootLevelKind = 'trunk' | 'branch' | 'spine';

/**
 * First-generation growth directly under the Tree node: `Number` stems placed inside the Tree's placement disc
 * (Trunk, and Spine / Branch connected straight to the Tree - grass, ferns, moss).
 */
export function evaluateRootLevel(
  ctx: NodeContext,
  inputs: NodeInputs,
  params: NodeParams,
  kind: RootLevelKind,
  placementOverride?: TreePlacement | null,
): NodeOutputs {
  const placement = placementOverride ?? extractPlacement(inputs) ?? DEFAULT_PLACEMENT;
  const isTrunk = kind === 'trunk';
  const cfg = compileSpineConfig(params, inputs, ctx.lod, ctx.seed, false);
  const rawCount = rootInstanceCount(ctx, params, placement);
  if (rawCount === 0) return emitStructureOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);

  const stemCount = Math.min(MAX_BRANCHES_PER_NODE, rawCount);
  const set = computeInstances(placement, distributionOptionsFromParams(params, stemCount), ctx.rng);
  const leanAzVar = params.leanAzimuth?.variance ?? 0;
  const groupRoll = getNumber(params, 'roll', 0) * Math.PI + deg2rad(getNumber(params, 'rotationOffset', 0));

  // Strengthen the bole's straightness when crownHeight > 0 so the lower trunk stays majestic.
  const stemOf = (c: typeof cfg): typeof cfg => (isTrunk && c.crownHeight > 0 ? { ...c, straightness: clamp(c.straightness + c.crownHeight * 0.25, 0, 0.95) } : c);
  const stemCfg = stemOf(cfg);
  const builder = new StructureSkeletonBuilder(set.count * (cfg.baseSegments + 4));
  const scope = new InstanceScope(ctx.nodeId, params, null);
  const cfgFor = createInstanceConfigResolver(cfg, (p) => compileSpineConfig(p, inputs, ctx.lod, ctx.seed, false));
  const worldUp: Vec3 = [0, 0, 1];

  for (let k = 0; k < set.count; k++) {
    if ((k & 63) === 0) ctx.cancel.throwIfCancelled();
    const stemRng = ctx.rng.fork(`stem:${k}`);
    const inst = scope.spawn({ parentBranch: -1, index: k }, builder);
    if (inst.pruned) continue;
    const icfg = cfgFor(inst);
    const iStem = icfg === cfg ? stemCfg : stemOf(icfg);
    const ip = inst.params;
    const baseTilt = isTrunk
      ? sampleVariance(stemRng.fork('lean'), getNumber(ip, 'lean', 2), ip.lean?.variance ?? 0, 15)
      : sampleVariance(stemRng.fork('pit'), icfg.spreadDeg, icfg.spreadVar, 15);
    const tiltRad = deg2rad(clamp(baseTilt + (set.tiltDeg[k] as number), 0, 85));
    const az = (placement.unify || (isTrunk && set.count === 1)
      ? deg2rad(sampleVariance(stemRng.fork('laz'), getNumber(ip, 'leanAzimuth', 25), placement.unify ? 0 : leanAzVar, 90))
      : (set.yaw[k] as number)) + inst.rotationOffsetRad;

    const origin: Vec3 = [set.position[k * 3] as number, set.position[k * 3 + 1] as number, set.position[k * 3 + 2] as number];
    const radialOut: Vec3 = [Math.cos(az), Math.sin(az), 0];
    const bendAxis = v3Norm(v3Cross(worldUp, radialOut), [0, 1, 0]);
    const stemT = v3Norm(rotateAroundAxis(worldUp, bendAxis, tiltRad), worldUp);
    const rollAng = placement.unify ? groupRoll : groupRoll + k * GOLDEN_ANGLE;
    const baseN = orthonormalNormal(stemT, rotateAroundAxis([1, 0, 0], worldUp, rollAng));
    const rolledN = orthonormalNormal(stemT, rotateAroundAxis(baseN, stemT, deg2rad(icfg.spineRollDeg + inst.rollOffsetDeg)));
    const frame: Frame3 = { tangent: stemT, normal: rolledN, binormal: v3Norm(v3Cross(stemT, rolledN)) };

    growSpineIntoBuilder(
      iStem,
      {
        parentBranch: -1,
        parentPoint: -1,
        generation: 0,
        origin,
        initialFrame: frame,
        parentTangent: worldUp,
        parentU: set.count > 1 ? k / (set.count - 1) : 0,
        parentLength: iStem.lengthBase,
        parentRadius: iStem.radiusBase,
        hasParent: false,
        isExtension: false,
        lengthScale: inst.lengthScale,
        radiusScale: inst.radiusScale,
      },
      stemRng,
      builder,
      ctx.cancel,
    );
    scope.finish(inst, builder);
  }

  return emitStructureOutput(builder.build(), params, ctx.lod, 'bark', undefined, undefined, ctx.seed, inputs, scope.table());
}
