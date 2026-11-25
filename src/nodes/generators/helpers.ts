import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';
import { emptySkeleton } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { sampleVariance } from '@/graph/engine/seeds';
import { lateralBalanceAngles, splitRadiiByArea } from '@/generators/split';
import { evaluateBranch } from './branch';
import { emitStructureOutput, extractParentSkeleton, isGeneratorActive, MAX_BRANCHES_PER_NODE } from './common';
import { buildChildInitialFrame, prepareParentBranch, sampleParentBranch } from './frames';
import { StructureSkeletonBuilder } from './skeletonBuild';
import { compileSpineConfig, growSpineIntoBuilder } from './spine';
import { branchIsSplitParent, createFusedParents } from './fusedParent';

/**
 * Split / Fork helper (`generator.split`): bifurcates each parent branch at `splitAt` (default 1.0 = tip)
 * into `forkCount` (2..5) diverging daughter branches with pipe-model area conservation.
 */
export function evaluateSplit(ctx: NodeContext, inputs: NodeInputs, params: NodeParams): NodeOutputs {
  const parent = extractParentSkeleton(inputs);
  if (!isGeneratorActive(params, ctx.lod) || parent.count === 0) {
    return emitStructureOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
  }

  const cfg = compileSpineConfig(params, inputs, ctx.lod, ctx.seed, false);
  const forkCount = Math.max(2, Math.min(5, Math.round(getNumber(params, 'forkCount', 2))));
  const splitAt = clamp(getNumber(params, 'splitAt', 1), 0.1, 1);
  const balance = clamp(getNumber(params, 'splitBalance', 0.5), 0.15, 0.85);
  const rollBase = getNumber(params, 'roll', 0) * Math.PI;
  const rollVar = params.roll?.variance ?? 0;
  const splitParentsOnly = getBool(params, 'splitParentsOnly', false);
  // A split is one logical spine: the fused halves are never forked, the parent counts up to the start of its transition
  const fused = createFusedParents(parent);

  const builder = new StructureSkeletonBuilder(parent.branches.length * forkCount * (cfg.baseSegments + 2));
  let written = 0;

  for (let bi = 0; bi < parent.branches.length && written < MAX_BRANCHES_PER_NODE; bi++) {
    if ((bi & 31) === 0) ctx.cancel.throwIfCancelled();
    const pb = parent.branches[bi]!;
    if (pb.count < 2 || fused.halves.has(pb.id)) continue;
    if (splitParentsOnly && !branchIsSplitParent(parent, pb)) continue;

    const prep = fused.prepare(pb, prepareParentBranch(parent, pb));
    const sample = sampleParentBranch(prep, splitAt);
    const pbRng = ctx.rng.fork(`spl:${pb.id}`);
    const phase = sampleVariance(pbRng.fork('rol'), rollBase, rollVar, Math.PI);

    // Radii and bend angles come from the shared split model (pipe model + lateral balance), the same functions Skin > Splits uses.
    const pair = forkCount === 2 ? splitRadiiByArea(sample.radius, balance) : null;
    const baseSpread = sampleVariance(pbRng.fork('ang'), cfg.spreadDeg, cfg.spreadVar);
    const pairAngles = pair
      ? lateralBalanceAngles(deg2rad(clamp(baseSpread, 2, 120)), deg2rad(clamp(baseSpread, 2, 120)), pair[0] * pair[0], pair[1] * pair[1])
      : null;

    for (let f = 0; f < forkCount && written < MAX_BRANCHES_PER_NODE; f++) {
      const fRng = pbRng.fork(f);
      const areaShare = pair ? (f === 0 ? balance : 1 - balance) : 1 / forkCount;
      const childRadius = Math.max(cfg.minRadius, pair ? (pair[f] as number) : sample.radius * Math.sqrt(areaShare));
      const az = phase + (f / forkCount) * Math.PI * 2;
      const spreadRad = pairAngles ? (pairAngles[f] as number) : deg2rad(clamp(sampleVariance(fRng.fork('ang'), cfg.spreadDeg, cfg.spreadVar), 2, 120));

      const frame = buildChildInitialFrame(
        { tangent: sample.tangent, normal: sample.normal, binormal: sample.binormal },
        {
          azimuthRad: az,
          spreadRad,
          alignment: 0.15,
        },
      );

      const childLen =
        (sampleVariance(fRng.fork('len'), cfg.lengthBase, cfg.lengthVar) + cfg.lengthPercent * prep.arcLength) *
        (0.85 + 0.3 * areaShare);

      written += growSpineIntoBuilder(
        cfg,
        {
          parentBranch: pb.id,
          parentPoint: sample.parentPoint,
          generation: pb.generation + 1,
          origin: sample.position,
          initialFrame: frame,
          parentTangent: sample.tangent,
          parentU: splitAt,
          parentLength: prep.arcLength,
          parentRadius: sample.radius,
          hasParent: true,
          isExtension: true,
          lengthOverride: Math.max(0.03, childLen),
          baseRadiusOverride: childRadius,
        },
        fRng,
        builder,
        ctx.cancel,
      );
    }
  }

  return emitStructureOutput(builder.build(), params, ctx.lod, 'bark', undefined, parent, ctx.seed, inputs);
}

/**
 * Spine helper (`generator.spine`): evaluates pure guide spines (defaults to `spineOnly = true`)
 * for attaching leaves, fronds, clusters, or secondary branches without tube mesh overhead.
 */
export function evaluateSpine(ctx: NodeContext, inputs: NodeInputs, params: NodeParams): NodeOutputs {
  const effectiveParams: NodeParams =
    params.spineOnly !== undefined ? params : { ...params, spineOnly: { value: true } };
  return evaluateBranch(ctx, inputs, effectiveParams, 'spine');
}
