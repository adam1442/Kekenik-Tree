import { curveToLUT, sampleCurveLUT } from '@/contracts/curve';
import type { ForceDef } from '@/contracts/material';
import type { NodeInputs } from '@/contracts/nodes';
import { getBool, getNumber, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { clamp } from '@/core/math';
import { Rng } from '@/core/rng';
import { applyForces } from '@/forces';
import { PORT } from '@/graph/ports';
import type { Vec3 } from './frames';

export interface SpineForceSampleContext {
  /** World position of the current spine integration point. */
  position: Vec3;
  /** Current unit growth direction. */
  direction: Vec3;
  /** Parent tangent at branch origin (for `ancestor` steering). */
  parentTangent: Vec3;
  /** Normalized coordinate along the spine, 0..1. */
  f: number;
  /** Normalized coordinate along the parent branch, 0..1. */
  parentU: number;
  /** Attached ForceDefs from the `forces` port. */
  forces: readonly ForceDef[];
  /** Node parameters of the active generator. */
  params: NodeParams;
}

/**
 * Pluggable hook (Forces & Wind). Returns a world-space steering vector
 * added per integration step (scaled by step fraction `df`).
 */
export type ExternalSpineForceEvaluator = (ctx: SpineForceSampleContext) => Vec3;

let externalEvaluator: ExternalSpineForceEvaluator | null = null;

export function registerExternalForceEvaluator(evaluator: ExternalSpineForceEvaluator | null): void {
  externalEvaluator = evaluator;
}

export function getExternalForceEvaluator(): ExternalSpineForceEvaluator | null {
  return externalEvaluator;
}

export function extractAttachedForces(inputs: NodeInputs): ForceDef[] {
  const raw = inputs[PORT.forces];
  if (!raw || raw.length === 0) return [];
  const out: ForceDef[] = [];
  for (const pv of raw) {
    if (pv.kind === 'Force' && pv.value.enabled) {
      out.push(pv.value);
    }
  }
  return out;
}

export interface CompiledSpineForceHook {
  /** Evaluates world-space steering impulse at normalized spine fraction `f` in [0, 1]. */
  sample(position: Vec3, direction: Vec3, parentTangent: Vec3, f: number, parentU: number): Vec3;
}

/**
 * Applies the attached forces (`forces` port) to a finished skeleton with the solver: physically based
 * bending (thin / long segments bend more, lengths preserved). The generator's own Forces tab (Influence, Stiffness,
 * Falloff, curves along the length) modulates every attached force. Call before meshing.
 */
export function applyGeneratorForces(skeleton: Skeleton, params: NodeParams, inputs: NodeInputs | undefined, seed: number): void {
  if (!inputs || skeleton.count === 0 || !getBool(params, 'forcesEnabled', true)) return;
  const forces = extractAttachedForces(inputs);
  if (forces.length === 0) return;
  const influenceBase = getNumber(params, 'forceInfluence', 1);
  const influenceLut = params.forceInfluence?.curve ? curveToLUT(params.forceInfluence.curve, 128) : null;
  const stiffnessBase = clamp(getNumber(params, 'forceStiffness', 0.5), 0, 1);
  const stiffnessLut = params.forceStiffness?.curve ? curveToLUT(params.forceStiffness.curve, 128) : null;
  const falloff = clamp(getNumber(params, 'forceFalloff', 0), 0, 1);
  applyForces(skeleton, forces, {
    rng: new Rng(seed || 1).fork('forces'),
    influence: (t) => influenceBase * (influenceLut ? sampleCurveLUT(influenceLut, t) : 1) * (1 - falloff * (1 - t)),
    // 0.5 is the neutral generator stiffness (the force's own stiffness is used as is).
    stiffness: (t) => (0.25 + 1.5 * stiffnessBase) * (stiffnessLut ? sampleCurveLUT(stiffnessLut, t) : 1),
  });
}

/**
 * Compiles curve LUTs once per generator invocation and returns a fast per-step force sampler.
 * Combines built-in Spine properties (`gravity`, `upDown`, `ancestor`) with either a registered `ExternalSpineForceEvaluator` or the lightweight `ForceDef` reader.
 */
export function compileSpineForceHook(inputs: NodeInputs, params: NodeParams): CompiledSpineForceHook {
  const forcesEnabled = getBool(params, 'forcesEnabled', true);
  const forces = forcesEnabled ? extractAttachedForces(inputs) : [];

  const gravityBase = getNumber(params, 'gravity', 0);
  const gravityLut = params.gravity?.curve ? curveToLUT(params.gravity.curve, 256) : null;

  const upDownBase = getNumber(params, 'upDown', 0);
  const upDownLut = params.upDown?.curve ? curveToLUT(params.upDown.curve, 256) : null;

  const ancestorBase = getNumber(params, 'ancestor', 0);
  const ancestorLut = params.ancestor?.curve ? curveToLUT(params.ancestor.curve, 256) : null;


  const stiffnessBase = clamp(getNumber(params, 'forceStiffness', 0.5), 0, 0.99);
  const stiffnessLut = params.forceStiffness?.curve ? curveToLUT(params.forceStiffness.curve, 256) : null;

  return {
    sample(position: Vec3, direction: Vec3, parentTangent: Vec3, f: number, parentU: number): Vec3 {
      const stiffness = clamp(stiffnessBase * (stiffnessLut ? sampleCurveLUT(stiffnessLut, f) : 1), 0, 0.99);
      const compliance = (1 - stiffness * 0.75) * (0.25 + 0.75 * f);

      const grav = gravityBase * (gravityLut ? sampleCurveLUT(gravityLut, f) : 1);
      const upBias = upDownBase * (upDownLut ? sampleCurveLUT(upDownLut, f) : 1);
      const anc = ancestorBase * (ancestorLut ? sampleCurveLUT(ancestorLut, f) : 1);

      // Built-in spine forces: gravity pulls -Z, upDown pulls +Z, ancestor pulls toward/away from parentTangent
      const fx = parentTangent[0] * anc * compliance;
      const fy = parentTangent[1] * anc * compliance;
      const fz = (-grav + upBias) * compliance + parentTangent[2] * anc * compliance;

      if (forces.length === 0) return [fx, fy, fz];

      if (externalEvaluator) {
        const ext = externalEvaluator({ position, direction, parentTangent, f, parentU, forces, params });
        return [fx + ext[0], fy + ext[1], fz + ext[2]];
      }

      return [fx, fy, fz];
    },
  };
}
