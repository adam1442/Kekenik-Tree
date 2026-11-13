import { evaluateCurve } from '@/contracts/curve';
import type { NodeContext, NodeInputs, NodeOutputs } from '@/contracts/nodes';
import { getNumber, getString, type NodeParams } from '@/contracts/params';
import { emptySkeleton } from '@/contracts/skeleton';
import { markSkeletonWindStatic } from '@/geometry/windAttributes';
import { clamp, deg2rad } from '@/core/math';
import { sampleVariance } from '@/graph/engine/seeds';
import { emitStructureOutput as emitStructure, extractParentSkeleton, isGeneratorActive, MAX_BRANCHES_PER_NODE } from './common';
import { generateChildPlacements, GOLDEN_ANGLE_RAD } from './distribution';
import {
  buildChildInitialFrame,
  orthonormalNormal,
  prepareParentBranch,
  sampleParentBranch,
  v3Add,
  v3Cross,
  v3Norm,
  v3Scale,
  type Frame3,
  type Vec3,
} from './frames';
import { StructureSkeletonBuilder } from './skeletonBuild';
import { compileSpineConfig, growSpineIntoBuilder } from './spine';

function evalParentCurve(params: NodeParams, id: string, u: number, fallback = 1): number {
  const c = params[id]?.curve;
  return c ? evaluateCurve(c, u) : fallback;
}

/** Root systems live under the ground: their wind channels are all zero so they never move (children inherit this). */
const emitRootOutput: typeof emitStructure = (skeleton, ...rest) => {
  markSkeletonWindStatic(skeleton);
  return emitStructure(skeleton, ...rest);
};

/**
 * Root generator (`generator.root`): grows subterranean / buttress root systems.
 * Works both when parented to a Trunk/Root skeleton (blending smoothly with trunk base flare)
 * and when parented directly to the `Tree` output node at world origin.
 */
export function evaluateRoot(ctx: NodeContext, inputs: NodeInputs, params: NodeParams): NodeOutputs {
  if (!isGeneratorActive(params, ctx.lod)) {
    return emitRootOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
  }

  const parent = extractParentSkeleton(inputs);
  const cfg = compileSpineConfig(params, inputs, ctx.lod, ctx.seed, true);
  const sink = getNumber(params, 'sink', 0);
  const maxGeneration = Math.max(1, Math.round(getNumber(params, 'maxGeneration', 8)));

  // Case 1: Parented directly to Tree (or empty parent) -> radial roots from ground collar (0, 0, -sink)
  if (parent.count === 0 || parent.branches.length === 0) {
    const mode = getString(params, 'mode', 'absolute');
    const rawCount =
      mode === 'density'
        ? Math.max(1, Math.round(getNumber(params, 'density', 5)))
        : Math.max(0, Math.round(sampleVariance(ctx.rng.fork('rnum'), getNumber(params, 'number', 5), params.number?.variance ?? 0)));

    const rootCount = Math.min(MAX_BRANCHES_PER_NODE, rawCount);
    if (rootCount === 0) {
      return emitRootOutput(emptySkeleton(), params, ctx.lod, 'bark', 0);
    }

    const jumble = clamp(getNumber(params, 'jumble', 0.25), 0, 1);
    const sweep = clamp(getNumber(params, 'sweep', 1), 0.01, 1);
    const groupRoll = getNumber(params, 'roll', 0) * Math.PI + deg2rad(getNumber(params, 'rotationOffset', 0));
    const builder = new StructureSkeletonBuilder(rootCount * (cfg.baseSegments + 4));

    for (let k = 0; k < rootCount; k++) {
      if ((k & 63) === 0) ctx.cancel.throwIfCancelled();
      const rootRng = ctx.rng.fork(`groot:${k}`);
      const az =
        groupRoll +
        (k / rootCount) * Math.PI * 2 * sweep +
        (rootRng.fork('az').next() - 0.5) * jumble * ((Math.PI * 1.3) / Math.max(1, rootCount));

      const diveStartRad = deg2rad(
        clamp(sampleVariance(rootRng.fork('dv'), cfg.rootDiveAngleDeg * 0.45, 0.2, 20), 4, 82),
      );
      const horizFactor = Math.cos(diveStartRad) * Math.max(0.2, cfg.rootSpread);
      const downFactor = -Math.sin(diveStartRad);

      const dir = v3Norm([Math.cos(az) * horizFactor, Math.sin(az) * horizFactor, downFactor], [0, 0, -1]);
      const nrm = orthonormalNormal(dir, [0, 0, 1]);
      const frame: Frame3 = { tangent: dir, normal: nrm, binormal: v3Norm(v3Cross(dir, nrm)) };
      const collarOffset = cfg.radiusBase * 0.6 * cfg.flareBlend;
      const origin: Vec3 = [Math.cos(az) * collarOffset, Math.sin(az) * collarOffset, 0.08 * cfg.flareBlend - sink];

      growSpineIntoBuilder(
        cfg,
        {
          parentBranch: -1,
          parentPoint: -1,
          generation: 0,
          origin,
          initialFrame: frame,
          parentTangent: [0, 0, -1],
          parentU: rootCount > 1 ? k / (rootCount - 1) : 0,
          parentLength: cfg.lengthBase,
          parentRadius: cfg.radiusBase * 1.8,
          hasParent: false,
          isExtension: false,
        },
        rootRng,
        builder,
        ctx.cancel,
      );
    }

    return emitRootOutput(builder.build(), params, ctx.lod, 'bark', undefined, parent, ctx.seed, inputs);
  }

  // Case 2: Parented to Trunk or upstream Root skeleton -> grow roots along [first..last] downward & outward
  const builder = new StructureSkeletonBuilder(Math.min(32768, Math.max(256, parent.branches.length * 24)));
  let written = 0;

  for (let bi = 0; bi < parent.branches.length && written < MAX_BRANCHES_PER_NODE; bi++) {
    if ((bi & 31) === 0) ctx.cancel.throwIfCancelled();
    const pb = parent.branches[bi]!;
    if (pb.count < 2) continue;

    const childGen = pb.generation + 1;
    if (childGen > maxGeneration) continue;

    const prep = prepareParentBranch(parent, pb);
    const branchRng = ctx.rng.fork(`rpb:${pb.id}`);
    const placements = generateChildPlacements(prep, params, branchRng, ctx.lod, MAX_BRANCHES_PER_NODE - written);

    const parentIsAerialStem = (prep.tangents[2] as number) >= 0;

    for (let pi = 0; pi < placements.length && written < MAX_BRANCHES_PER_NODE; pi++) {
      const pl = placements[pi]!;
      const childRng = branchRng.fork(`rch:${pl.slotIndex}`);
      const sample = sampleParentBranch(prep, pl.u);

      let frame: Frame3;
      let origin: Vec3 = sample.position;

      if (parentIsAerialStem) {
        // Sprouting from lower Trunk base: sweep radially outward and angle downward into ground
        const ca = Math.cos(pl.azimuthRad);
        const sa = Math.sin(pl.azimuthRad);
        const radialOut = v3Norm([
          sample.normal[0] * ca + sample.binormal[0] * sa,
          sample.normal[1] * ca + sample.binormal[1] * sa,
          0,
        ], [Math.cos(pl.azimuthRad + GOLDEN_ANGLE_RAD), Math.sin(pl.azimuthRad + GOLDEN_ANGLE_RAD), 0]);

        const initialDiveDeg = clamp(
          sampleVariance(childRng.fork('rdv'), cfg.rootDiveAngleDeg * (0.4 + 0.4 * pl.u), 0.18, 18),
          5,
          84,
        );
        const diveRad = deg2rad(initialDiveDeg);
        const spreadScale = Math.max(0.2, cfg.rootSpread);
        const rootT = v3Norm([
          radialOut[0] * Math.cos(diveRad) * spreadScale,
          radialOut[1] * Math.cos(diveRad) * spreadScale,
          -Math.sin(diveRad),
        ]);
        const rootN = orthonormalNormal(rootT, [0, 0, 1]);
        frame = { tangent: rootT, normal: rootN, binormal: v3Norm(v3Cross(rootT, rootN)) };

        // Blend origin smoothly into trunk collar surface according to flareBlend
        origin = v3Add(origin, v3Scale(radialOut, sample.radius * (0.35 + 0.35 * cfg.flareBlend)));
        origin = [origin[0], origin[1], origin[2] - sink];
      } else {
        // Secondary lateral roots branching off a primary Root
        const spreadDeg =
          sampleVariance(childRng.fork('spr'), cfg.spreadDeg, cfg.spreadVar) *
          evalParentCurve(params, 'spread', pl.u, 1);
        frame = buildChildInitialFrame(
          { tangent: sample.tangent, normal: sample.normal, binormal: sample.binormal },
          {
            azimuthRad: pl.azimuthRad,
            spreadRad: deg2rad(clamp(spreadDeg, 5, 130)),
            pitchRad: -deg2rad(Math.abs(cfg.pitchDeg)),
            alignment: 0.25,
          },
        );
        // Ensure lateral roots never shoot upward above soil if already underground
        if (origin[2] < 0 && frame.tangent[2] > 0.05) {
          const clampedT = v3Norm([frame.tangent[0], frame.tangent[1], -Math.abs(frame.tangent[2]) * 0.35]);
          const clampedN = orthonormalNormal(clampedT, frame.normal);
          frame = { tangent: clampedT, normal: clampedN, binormal: v3Norm(v3Cross(clampedT, clampedN)) };
        }
      }

      written += growSpineIntoBuilder(
        cfg,
        {
          parentBranch: pb.id,
          parentPoint: sample.parentPoint,
          generation: childGen,
          origin,
          initialFrame: frame,
          parentTangent: sample.tangent,
          parentU: pl.u,
          parentLength: prep.arcLength,
          parentRadius: sample.radius,
          hasParent: true,
          isExtension: pl.isExtension,
        },
        childRng,
        builder,
        ctx.cancel,
      );
    }
  }

  return emitRootOutput(builder.build(), params, ctx.lod, 'bark', undefined, parent, ctx.seed, inputs);
}
