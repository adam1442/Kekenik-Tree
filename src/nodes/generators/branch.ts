import { evaluateCurve } from '@/contracts/curve';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { sampleVariance } from '@/graph/engine/seeds';
import { InstanceScope, type InstanceHandle } from '@/instances/scope';
import { emitStructureOutput, extractParentSkeleton, extractParentTable, isGeneratorActive, MAX_BRANCHES_PER_NODE } from './common';
import { createInstanceConfigResolver } from './instanceSupport';
import { generateChildPlacements } from './distribution';
import {
  buildChildInitialFrame,
  prepareParentBranch,
  sampleParentBranch,
  v3Add,
  v3Norm,
  v3Scale,
  type Vec3,
} from './frames';
import { evaluateRootLevel, extractPlacement, type RootLevelKind } from './rootLevel';
import { StructureSkeletonBuilder } from './skeletonBuild';
import { compileSpineConfig, growSpineIntoBuilder, type CompiledSpineConfig } from './spine';

function evalParentCurve(params: NodeParams, id: string, u: number, fallback = 1): number {
  const c = params[id]?.curve;
  return c ? evaluateCurve(c, u) : fallback;
}

function growOneLevel(
  parentSk: Skeleton,
  cfg: CompiledSpineConfig,
  params: NodeParams,
  ctx: NodeContext,
  levelIndex: number,
  maxGeneration: number,
  maxTotalRemaining: number,
  scope: InstanceScope,
  cfgFor: (h: InstanceHandle) => CompiledSpineConfig,
): Skeleton {
  if (parentSk.count === 0 || parentSk.branches.length === 0 || maxTotalRemaining <= 0) {
    return emptySkeleton();
  }

  const sink = getNumber(params, 'sink', 0);
  const alignBool = getBool(params, 'align', false);
  const effectiveAlignment = alignBool ? Math.max(0.75, cfg.alignment) : cfg.alignment;
  // Sub-levels inside a single Branch node scale down length & count organically
  const subScale = levelIndex === 0 ? 1 : Math.pow(0.62, levelIndex);

  const builder = new StructureSkeletonBuilder(Math.min(65536, Math.max(512, parentSk.branches.length * 32)));
  let written = 0;

  for (let bi = 0; bi < parentSk.branches.length && written < maxTotalRemaining; bi++) {
    if ((bi & 31) === 0) ctx.cancel.throwIfCancelled();
    const pb = parentSk.branches[bi]!;
    if (pb.count < 2) continue;

    const childGen = pb.generation + 1;
    if (childGen > maxGeneration) continue;

    const prep = prepareParentBranch(parentSk, pb);
    const branchRng = ctx.rng.fork(`lvl:${levelIndex}:pb:${pb.id}`);
    const placements = generateChildPlacements(prep, params, branchRng, ctx.lod, maxTotalRemaining - written);

    for (let pi = 0; pi < placements.length && written < maxTotalRemaining; pi++) {
      if ((pi & 127) === 0) ctx.cancel.throwIfCancelled();
      const pl = placements[pi]!;
      const childRng = branchRng.fork(`ch:${pl.slotIndex}`);
      const inst = scope.spawn({ parentBranch: pb.id, index: pl.slotIndex, level: levelIndex, baseU: pl.u }, builder);
      if (inst.pruned) continue;
      const icfg = cfgFor(inst);
      const u = pl.isExtension ? pl.u : clamp(pl.u + inst.positionOffset, 0, 1);
      const sample = sampleParentBranch(prep, u);

      const spreadDeg = pl.isExtension
        ? 0
        : sampleVariance(childRng.fork('spr'), icfg.spreadDeg, icfg.spreadVar) * evalParentCurve(inst.params, 'spread', u, 1);
      const startRollDeg =
        sampleVariance(childRng.fork('srl'), icfg.startRollDeg, icfg.startRollVar, 45) *
        evalParentCurve(inst.params, 'startRoll', u, 1);
      const pitchDeg =
        sampleVariance(childRng.fork('pit'), icfg.pitchDeg, icfg.pitchVar, 30) *
        evalParentCurve(inst.params, 'pitch', u, 1);

      const frame = buildChildInitialFrame(
        { tangent: sample.tangent, normal: sample.normal, binormal: sample.binormal },
        {
          azimuthRad: pl.azimuthRad + inst.rotationOffsetRad,
          spreadRad: deg2rad(clamp(spreadDeg, 0, 179)),
          startRollRad: deg2rad(startRollDeg),
          pitchRad: deg2rad(pitchDeg),
          rollRad: deg2rad(icfg.spineRollDeg + inst.rollOffsetDeg),
          alignment: effectiveAlignment,
        },
      );

      let origin: Vec3 = sample.position;
      if (cfg.weldStart && !pl.isExtension) {
        const ca = Math.cos(pl.azimuthRad);
        const sa = Math.sin(pl.azimuthRad);
        const radial = v3Norm([
          sample.normal[0] * ca + sample.binormal[0] * sa,
          sample.normal[1] * ca + sample.binormal[1] * sa,
          sample.normal[2] * ca + sample.binormal[2] * sa,
        ]);
        origin = v3Add(origin, v3Scale(radial, sample.radius * 0.85));
      }
      if (Math.abs(sink) > 1e-5) {
        origin = v3Add(origin, v3Scale(frame.tangent, -sink));
      }

      const levelCfg = subScale === 1 ? icfg : { ...icfg, lengthBase: Math.max(0.02, icfg.lengthBase * subScale) };
      written += growSpineIntoBuilder(
        levelCfg,
        {
          parentBranch: pb.id,
          parentPoint: sample.parentPoint,
          generation: childGen,
          origin,
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

  return builder.build();
}

function mergeSkeletons(levels: readonly Skeleton[]): Skeleton {
  if (levels.length === 0) return emptySkeleton();
  if (levels.length === 1) return levels[0]!;

  let totalPoints = 0;
  for (const sk of levels) totalPoints += sk.count;
  if (totalPoints === 0) return emptySkeleton();

  const builder = new StructureSkeletonBuilder(totalPoints);
  let prevPointOffset = 0;
  let prevBranchOffset = 0;

  for (let li = 0; li < levels.length; li++) {
    const sk = levels[li]!;
    const nx = sk.attributes.get('rmfNormalX');
    const ny = sk.attributes.get('rmfNormalY');
    const nz = sk.attributes.get('rmfNormalZ');
    const tw = sk.attributes.get('twist');
    const curPointOffset = builder.pointCount;
    const curBranchOffset = builder.branchCount;

    for (const b of sk.branches) {
      const pos = sk.position.subarray(b.start * 3, (b.start + b.count) * 3);
      const rad = sk.radius.subarray(b.start, b.start + b.count);
      const ages = sk.age.subarray(b.start, b.start + b.count);
      const twists = tw ? tw.subarray(b.start, b.start + b.count) : undefined;
      const hint: Vec3 | undefined =
        nx && ny && nz ? [nx[b.start] as number, ny[b.start] as number, nz[b.start] as number] : undefined;

      // Level 0 references the external upstream node's skeleton; deeper sub-levels reference the previous level inside this merged skeleton
      const parentBranch = li === 0 ? b.parentBranch : b.parentBranch >= 0 ? prevBranchOffset + b.parentBranch : -1;
      const parentPoint = li === 0 ? b.parentPoint : b.parentPoint >= 0 ? prevPointOffset + b.parentPoint : -1;

      builder.addPolylineBranch({
        parentBranch,
        parentPoint,
        generation: b.generation,
        count: b.count,
        positions: pos,
        radii: rad,
        ages,
        twists,
        initialNormalHint: hint,
      });
    }

    prevPointOffset = curPointOffset;
    prevBranchOffset = curBranchOffset;
  }

  return builder.build();
}

/**
 * Branch generator (`generator.branch`): grows primary, secondary, or recursive sub-branches
 * along its upstream parent skeleton.
 */
export function evaluateBranch(ctx: NodeContext, inputs: NodeInputs, params: NodeParams, rootKind: RootLevelKind = 'branch'): NodeOutputs {
  const parent = extractParentSkeleton(inputs);
  if (!isGeneratorActive(params, ctx.lod)) {
    return emitStructureOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
  }
  if (parent.count === 0) {
    // Connected straight to the Tree node: first-generation instances inside the placement disc.
    const placement = extractPlacement(inputs);
    if (!placement) return emitStructureOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
    return evaluateRootLevel(ctx, inputs, params, rootKind, placement);
  }

  const cfg = compileSpineConfig(params, inputs, ctx.lod, ctx.seed, false);
  const subGenerations = Math.max(1, Math.min(5, Math.round(getNumber(params, 'generations', 1))));
  const maxGeneration = Math.max(1, Math.round(getNumber(params, 'maxGeneration', 8)));

  const levels: Skeleton[] = [];
  const scope = new InstanceScope(ctx.nodeId, params, extractParentTable(inputs));
  const cfgFor = createInstanceConfigResolver(cfg, (p) => compileSpineConfig(p, inputs, ctx.lod, ctx.seed, false));
  let currentParent = parent;
  let remaining = MAX_BRANCHES_PER_NODE;

  for (let lvl = 0; lvl < subGenerations && remaining > 0; lvl++) {
    const sk = growOneLevel(currentParent, cfg, params, ctx, lvl, maxGeneration, remaining, scope, cfgFor);
    if (sk.branches.length === 0) break;
    levels.push(sk);
    remaining -= sk.branches.length;
    currentParent = sk;
  }

  const merged = mergeSkeletons(levels);
  const table = scope.table(levels.map((sk) => ({ branches: sk.branches.length, points: sk.count })));
  return emitStructureOutput(merged, params, ctx.lod, 'bark', undefined, parent, ctx.seed, inputs, table);
}
