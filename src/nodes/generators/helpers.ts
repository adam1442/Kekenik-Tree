import { evaluateCurve } from '@/contracts/curve';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getNumber, type NodeParams } from '@/contracts/params';
import { emptySkeleton } from '@/contracts/skeleton';
import { clamp, deg2rad } from '@/core/math';
import { sampleVariance } from '@/graph/engine/seeds';
import { evaluateBranch } from './branch';
import { emitStructureOutput, extractParentSkeleton, isGeneratorActive, MAX_BRANCHES_PER_NODE } from './common';
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
import { StructureSkeletonBuilder } from './skeletonBuild';
import { compileSpineConfig, growSpineIntoBuilder } from './spine';

function evalParentCurve(params: NodeParams, id: string, u: number, fallback = 1): number {
  const c = params[id]?.curve;
  return c ? evaluateCurve(c, u) : fallback;
}

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

  const builder = new StructureSkeletonBuilder(parent.branches.length * forkCount * (cfg.baseSegments + 2));
  let written = 0;

  for (let bi = 0; bi < parent.branches.length && written < MAX_BRANCHES_PER_NODE; bi++) {
    if ((bi & 31) === 0) ctx.cancel.throwIfCancelled();
    const pb = parent.branches[bi]!;
    if (pb.count < 2) continue;

    const prep = prepareParentBranch(parent, pb);
    const sample = sampleParentBranch(prep, splitAt);
    const pbRng = ctx.rng.fork(`spl:${pb.id}`);
    const phase = sampleVariance(pbRng.fork('rol'), rollBase, rollVar, Math.PI);

    // Compute area weights summing to 1 so cross-sectional area is conserved across forks
    const weights: number[] = [];
    let weightSum = 0;
    for (let f = 0; f < forkCount; f++) {
      const w = forkCount === 2 ? (f === 0 ? balance : 1 - balance) : 1 / forkCount;
      weights.push(w);
      weightSum += w;
    }

    for (let f = 0; f < forkCount && written < MAX_BRANCHES_PER_NODE; f++) {
      const fRng = pbRng.fork(f);
      const areaShare = (weights[f] as number) / Math.max(1e-6, weightSum);
      const childRadius = Math.max(cfg.minRadius, sample.radius * Math.sqrt(areaShare));
      const az = phase + (f / forkCount) * Math.PI * 2;
      // Thicker fork bends less than thinner fork (natural mechanical momentum balance!)
      const angleWeight = 1.25 - areaShare * 0.5;
      const spreadDeg = sampleVariance(fRng.fork('ang'), cfg.spreadDeg * angleWeight, cfg.spreadVar);

      const frame = buildChildInitialFrame(
        { tangent: sample.tangent, normal: sample.normal, binormal: sample.binormal },
        {
          azimuthRad: az,
          spreadRad: deg2rad(clamp(spreadDeg, 2, 120)),
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
 * Knot helper (`generator.knot`): places short protruding stub/burl skeleton segments
 * along parent branches (outer collar -> inner ridge -> blunt/cupped core).
 */
export function evaluateKnot(ctx: NodeContext, inputs: NodeInputs, params: NodeParams): NodeOutputs {
  const parent = extractParentSkeleton(inputs);
  if (!isGeneratorActive(params, ctx.lod) || parent.count === 0) {
    return emitStructureOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
  }

  const segs = Math.max(2, Math.min(32, Math.round(getNumber(params, 'segments', 5))));
  const knotRadiusFrac = Math.max(0.05, getNumber(params, 'knotRadius', 0.55));
  const knotRadiusVar = params.knotRadius?.variance ?? 0;
  const knotLengthBase = Math.max(0.01, getNumber(params, 'knotLength', 0.12));
  const knotLengthVar = params.knotLength?.variance ?? 0;
  const coreScale = clamp(getNumber(params, 'knotCoreScale', 0.65), 0.1, 1.2);
  const knotCurv = clamp(getNumber(params, 'knotCurvature', 0.25), -1, 1);
  const spreadDeg = getNumber(params, 'spread', 82);
  const spreadVar = params.spread?.variance ?? 0;

  const builder = new StructureSkeletonBuilder(parent.branches.length * 32);
  let written = 0;

  for (let bi = 0; bi < parent.branches.length && written < MAX_BRANCHES_PER_NODE; bi++) {
    if ((bi & 31) === 0) ctx.cancel.throwIfCancelled();
    const pb = parent.branches[bi]!;
    if (pb.count < 2) continue;

    const prep = prepareParentBranch(parent, pb);
    const pbRng = ctx.rng.fork(`knt:${pb.id}`);
    const placements = generateChildPlacements(prep, params, pbRng, ctx.lod, MAX_BRANCHES_PER_NODE - written);

    for (let pi = 0; pi < placements.length && written < MAX_BRANCHES_PER_NODE; pi++) {
      const pl = placements[pi]!;
      const kRng = pbRng.fork(`kc:${pl.slotIndex}`);
      const sample = sampleParentBranch(prep, pl.u);

      const outerR = Math.max(
        0.003,
        sample.radius *
          sampleVariance(kRng.fork('kr'), knotRadiusFrac, knotRadiusVar) *
          evalParentCurve(params, 'knotRadius', pl.u, 1),
      );
      const extrudeLen = Math.max(
        0.008,
        sampleVariance(kRng.fork('kl'), knotLengthBase, knotLengthVar) *
          evalParentCurve(params, 'knotLength', pl.u, 1),
      );
      const ang = deg2rad(clamp(sampleVariance(kRng.fork('ka'), spreadDeg, spreadVar), 15, 165));

      const frame = buildChildInitialFrame(
        { tangent: sample.tangent, normal: sample.normal, binormal: sample.binormal },
        { azimuthRad: pl.azimuthRad, spreadRad: ang },
      );

      // Start slightly embedded inside parent bark so outer ring welds cleanly
      const startPos = v3Add(sample.position, v3Scale(frame.tangent, sample.radius * 0.55));
      const count = segs + 1;
      const pos = new Float32Array(count * 3);
      const rad = new Float32Array(count);

      for (let s = 0; s <= segs; s++) {
        const f = s / segs;
        const arch = Math.sin(f * Math.PI * 0.5) * knotCurv * extrudeLen * 0.35;
        const p: Vec3 = [
          startPos[0] + frame.tangent[0] * (f * extrudeLen) + frame.normal[0] * arch,
          startPos[1] + frame.tangent[1] * (f * extrudeLen) + frame.normal[1] * arch,
          startPos[2] + frame.tangent[2] * (f * extrudeLen) + frame.normal[2] * arch,
        ];
        pos[s * 3] = p[0];
        pos[s * 3 + 1] = p[1];
        pos[s * 3 + 2] = p[2];

        // Outer -> puffed Inner rim -> Core radius profile
        const puff = Math.sin(Math.PI * Math.min(1, f * 1.4)) * 0.18 * Math.max(0, knotCurv);
        const r = outerR * (1 - f * (1 - coreScale) + puff);
        rad[s] = Math.max(0.001, r);
      }

      const res = builder.addPolylineBranch({
        parentBranch: pb.id,
        parentPoint: sample.parentPoint,
        generation: pb.generation + 1,
        count,
        positions: pos,
        radii: rad,
        initialNormalHint: v3Norm(frame.normal),
      });
      if (res.branchId >= 0) written += 1;
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
