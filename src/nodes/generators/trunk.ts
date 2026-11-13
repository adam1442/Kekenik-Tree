import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import type { NodeParams } from '@/contracts/params';
import { emptySkeleton } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { InstanceScope } from '@/instances/scope';
import { sampleVariance } from '@/graph/engine/seeds';
import { emitStructureOutput, extractParentSkeleton, extractParentTable, isGeneratorActive, MAX_BRANCHES_PER_NODE } from './common';
import { createInstanceConfigResolver } from './instanceSupport';
import { generateChildPlacements } from './distribution';
import {
  buildChildInitialFrame,
  prepareParentBranch,
  sampleParentBranch,
} from './frames';
import { evaluateRootLevel } from './rootLevel';
import { StructureSkeletonBuilder } from './skeletonBuild';
import { compileSpineConfig, growSpineIntoBuilder } from './spine';

/**
 * Trunk generator (`generator.trunk`): root of the tree skeleton hierarchy.
 * Can grow from world ground origin (single bole or multi-stem clump when `number > 1`),
 * or off an upstream parent skeleton if connected.
 */
export function evaluateTrunk(ctx: NodeContext, inputs: NodeInputs, params: NodeParams): NodeOutputs {
  if (!isGeneratorActive(params, ctx.lod)) {
    return emitStructureOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
  }

  const parent = extractParentSkeleton(inputs);
  const cfg = compileSpineConfig(params, inputs, ctx.lod, ctx.seed, false);

  // When Trunk is connected under another structure node with actual points, grow off that parent
  if (parent.count > 0 && parent.branches.length > 0) {
    const builder = new StructureSkeletonBuilder(Math.max(256, parent.branches.length * (cfg.baseSegments + 2)));
    const nextGen = (parent.branches[0]?.generation ?? 0) + 1;
    let total = 0;
    const scope = new InstanceScope(ctx.nodeId, params, extractParentTable(inputs));
    const cfgFor = createInstanceConfigResolver(cfg, (p) => compileSpineConfig(p, inputs, ctx.lod, ctx.seed, false));

    for (let bi = 0; bi < parent.branches.length && total < MAX_BRANCHES_PER_NODE; bi++) {
      if ((bi & 63) === 0) ctx.cancel.throwIfCancelled();
      const pb = parent.branches[bi]!;
      const prep = prepareParentBranch(parent, pb);
      const branchRng = ctx.rng.fork(`tpb:${pb.id}`);
      const placements = generateChildPlacements(prep, params, branchRng, ctx.lod, MAX_BRANCHES_PER_NODE - total);

      for (const pl of placements) {
        const childRng = branchRng.fork(`tc:${pl.slotIndex}`);
        const inst = scope.spawn({ parentBranch: pb.id, index: pl.slotIndex, baseU: pl.u }, builder);
        if (inst.pruned) continue;
        const icfg = cfgFor(inst);
        const u = pl.isExtension ? pl.u : clamp(pl.u + inst.positionOffset, 0, 1);
        const sample = sampleParentBranch(prep, u);
        const spreadRad = pl.isExtension
          ? 0
          : deg2rad(sampleVariance(childRng.fork('spr'), icfg.spreadDeg, icfg.spreadVar));
        const pitchRad = deg2rad(sampleVariance(childRng.fork('pit'), icfg.pitchDeg, icfg.pitchVar));
        const frame = buildChildInitialFrame(
          { tangent: sample.tangent, normal: sample.normal, binormal: sample.binormal },
          {
            azimuthRad: pl.azimuthRad + inst.rotationOffsetRad,
            spreadRad,
            pitchRad,
            rollRad: deg2rad(icfg.spineRollDeg + inst.rollOffsetDeg),
            alignment: icfg.alignment,
          },
        );
        total += growSpineIntoBuilder(
          icfg,
          {
            parentBranch: pb.id,
            parentPoint: sample.parentPoint,
            generation: nextGen,
            origin: sample.position,
            initialFrame: frame,
            parentTangent: sample.tangent,
            parentU: u,
            parentLength: prep.arcLength,
            parentRadius: sample.radius,
            hasParent: true,
            isExtension: pl.isExtension,
            lengthScale: inst.lengthScale,
            radiusScale: inst.radiusScale,
          },
          childRng,
          builder,
          ctx.cancel,
        );
        scope.finish(inst, builder);
      }
    }
    return emitStructureOutput(builder.build(), params, ctx.lod, 'bark', undefined, parent, ctx.seed, inputs, scope.table());
  }

  // Root-level Trunk(s): placed inside the Tree's placement disc (see rootLevel.ts)
  return evaluateRootLevel(ctx, inputs, params, 'trunk');
}
