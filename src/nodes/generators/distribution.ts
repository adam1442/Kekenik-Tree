import { curveToLUT, evaluateCurve, sampleCurveLUT, type Curve } from '@/contracts/curve';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import { clamp, deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import {
  GOLDEN_ANGLE_RAD,
  generatePlacements,
  ignoresBoundaries,
  normalizeMode,
  PHYLLOTAXY_STYLES,
  type CountAlignStyle,
  type GroupAlignStyle,
  type ModeFrame,
  type ModeId,
  type ModeRequest,
  type PhyllotaxyStyle,
  type PlacementRecord,
} from '@/generators/modes';
import { findCurvaturePeaks, type PreparedParentBranch } from './frames';

export { GOLDEN_ANGLE_RAD };

const LOD_COUNT_SCALE = [1, 0.72, 0.45, 0.25] as const;

export interface ChildPlacement {
  /** Stable index of this child on its parent branch (used to fork deterministic child RNG). */
  slotIndex: number;
  /** Normalized coordinate along parent branch, strictly within [first, last] (or 1.0 for extensions). */
  u: number;
  /** Azimuth around parent tangent in radians. */
  azimuthRad: number;
  /** True when spawned by `extendParent` at the parent tip. */
  isExtension: boolean;
  /**
   * Left / right side (+1 / -1) of the child on its parent, written by every mode (Interval / Phyllotaxy alternate it per
   * group member, the others derive it from the roll); 0 = extensions.
   */
  side: number;
  /** Index of the group (step, internode, bend ...) the child belongs to; 0 for extensions. */
  groupIndex: number;
}

function evalParamCurve(params: NodeParams, id: string, x: number, fallback = 1): number {
  const c = params[id]?.curve;
  return c ? evaluateCurve(c, x) : fallback;
}

function getCurveParam(params: NodeParams, id: string): Curve | null {
  const v = params[id]?.value;
  if (v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points)) {
    return v as Curve;
  }
  return null;
}

const COUNT_ALIGN_STYLES: ReadonlySet<string> = new Set(['group', 'individual', 'alternate', 'opposite', 'spiral']);

function countAlignStyle(params: NodeParams): CountAlignStyle {
  const v = getString(params, 'alignStyle', 'group');
  return COUNT_ALIGN_STYLES.has(v) ? (v as CountAlignStyle) : 'group';
}

function groupAlignStyle(params: NodeParams, id: string): GroupAlignStyle {
  return getString(params, id, 'group') === 'individual' ? 'individual' : 'group';
}

function phyllotaxyStyle(params: NodeParams): PhyllotaxyStyle {
  const v = getString(params, 'phyllotaxyStyle', 'alternating-distichous');
  return (PHYLLOTAXY_STYLES as readonly string[]).includes(v) ? (v as PhyllotaxyStyle) : 'alternating-distichous';
}

/** Reads the parameters of `mode` into a pure `ModeRequest`. */
function readModeRequest(mode: ModeId, params: NodeParams, modeRng: Rng, jumble: number, sweep: number): ModeRequest {
  const resolvedNumber = (fallback: number): number => {
    const raw = sampleVariance(modeRng.fork('num'), getNumber(params, 'number', fallback), params.number?.variance ?? 0);
    return raw * evalParamCurve(params, 'number', 0.5, 1);
  };
  const spread = { jumble, sweep, alignStyle: countAlignStyle(params) };
  switch (mode) {
    case 'proportional':
      return { mode, frequency: Math.max(0, getNumber(params, 'proportionalCount', 2.5)), ...spread };
    case 'density':
      return {
        mode,
        density: Math.max(0, getNumber(params, 'density', 1) * evalParamCurve(params, 'density', 0.5, 1)),
        jitter: clamp(getNumber(params, 'densityJitter', 0.2), 0, 1),
        ...spread,
      };
    case 'flood':
      return { mode, number: resolvedNumber(12), sweep };
    case 'parent':
      return { mode, number: resolvedNumber(1), sweep };
    case 'absolute-steps':
    case 'proportional-steps':
      return {
        mode,
        steps: Math.max(0, mode === 'absolute-steps' ? getNumber(params, 'whorlCount', 5) : getNumber(params, 'stepsFrequency', 0.5)),
        perStep: Math.max(1, getNumber(params, 'whorlPerStep', 4)),
        spread: clamp(getNumber(params, 'whorlSpread', 0.03), 0, 1),
        stepRoll: deg2rad(getNumber(params, 'whorlRoll', 15)),
        balance: clamp(getNumber(params, 'stepsBalance', 1), 0, 1),
      };
    case 'phyllotaxy':
      return {
        mode,
        style: phyllotaxyStyle(params),
        internode: Math.max(0, getNumber(params, 'phyllotaxyInternode', 0.25)),
        childrenPerNode: Math.max(1, getNumber(params, 'phyllotaxyChildren', 3)),
        spread: clamp(getNumber(params, 'phyllotaxySpread', 0), 0, 1),
        spiral: deg2rad(getNumber(params, 'phyllotaxySpiral', 0)),
        limit: Math.max(0, getNumber(params, 'phyllotaxyLimit', 0)),
        alignStyle: groupAlignStyle(params, 'phyllotaxyAlignStyle'),
      };
    case 'interval': {
      const curve = params.intervalStep?.curve;
      return {
        mode,
        frequency: Math.max(0.001, getNumber(params, 'intervalStep', 0.6)),
        frequencyCurve: (x: number): number => (curve ? Math.max(0, evaluateCurve(curve, x)) : 1),
        count: Math.max(1, getNumber(params, 'perStep', 1)),
        spread: clamp(getNumber(params, 'intervalSpread', 0), 0, 1),
        spiral: deg2rad(getNumber(params, 'intervalSpiral', 0)),
        limit: Math.max(0, getNumber(params, 'intervalLimit', 0)),
        alignStyle: groupAlignStyle(params, 'intervalAlignStyle'),
        balance: clamp(getNumber(params, 'intervalBalance', 0), 0, 1),
      };
    }
    case 'bifurcation':
      return {
        mode,
        count: Math.max(0, getNumber(params, 'bifurcationCount', 4)),
        threshold: deg2rad(Math.max(0.5, getNumber(params, 'bifurcationThreshold', 6))),
        spread: clamp(getNumber(params, 'bifurcationSpread', 0), 0, 1),
        minSpacing: clamp(getNumber(params, 'bifurcationSpacing', 0.12), 0.01, 0.9),
      };
    case 'absolute':
    case 'classic':
    default:
      return { mode: 'absolute', number: resolvedNumber(10), ...spread };
  }
}

/**
 * Generates deterministic child placements `(u, azimuthRad)` for one `PreparedParentBranch`.
 * The node layout itself is computed by the pure `generators/modes` module; this adapter reads the parameters and then applies
 * the shared Clip / Pruning / Knockout / Extend-parent steps. Every random draw uses `branchRng.fork(...)` so sibling
 * branches are completely isolated.
 */
export function generateChildPlacements(
  prep: PreparedParentBranch,
  params: NodeParams,
  branchRng: Rng,
  lod: number,
  maxRemaining: number,
): ChildPlacement[] {
  if (maxRemaining <= 0 || prep.branch.count < 2) return [];

  const rawMode = getString(params, 'mode', 'absolute');
  const mode = normalizeMode(rawMode);
  const rawFirst = clamp(getNumber(params, 'first', 0.15) * evalParamCurve(params, 'first', 0.5, 1), 0, 1);
  const rawLast = clamp(getNumber(params, 'last', 0.95) * evalParamCurve(params, 'last', 0.5, 1), 0, 1);
  const first = Math.min(rawFirst, rawLast);
  const last = Math.max(rawFirst, rawLast);
  const span = Math.max(0, last - first);

  const clipEnabled = getBool(params, 'clipEnabled', false);
  const clipMargin = clipEnabled ? clamp(getNumber(params, 'clip', 0.025), 0, 0.49) * span : 0;
  const minU = clamp(first + clipMargin, first, last);
  const maxU = clamp(last - clipMargin, minU, last);

  const jumble = clamp(getNumber(params, 'jumble', 0), 0, 1);
  const sweep = clamp(getNumber(params, 'sweep', 1), 0.01, 1);
  const groupRoll = getNumber(params, 'roll', 0) * Math.PI;
  const rotationOffset = deg2rad(sampleVariance(branchRng.fork('rot'), getNumber(params, 'rotationOffset', 0), params.rotationOffset?.variance ?? 0));
  const positionOffset = sampleVariance(branchRng.fork('posOff'), getNumber(params, 'positionOffset', 0), params.positionOffset?.variance ?? 0, 0.5);
  const favorSplits = clamp(getNumber(params, 'favorSplits', 0), -1, 1);

  const distCurve = getCurveParam(params, 'distributionCurve');
  const distLut = distCurve ? curveToLUT(distCurve, 256) : null;

  const lodCull = clamp(getNumber(params, 'lodCull', 0), 0, 1);
  const baseLodScale = LOD_COUNT_SCALE[Math.min(Math.max(0, lod), LOD_COUNT_SCALE.length - 1)] as number;
  const effectiveLodKeep = lod === 0 ? 1 : clamp(baseLodScale * (1 - lodCull * 0.5), 0.1, 1);

  const knockoutBase = clamp(getNumber(params, 'knockout', 0), 0, 1);
  const knockoutLut = params.knockout?.curve ? curveToLUT(params.knockout.curve, 256) : null;
  const pruningBase = clamp(getNumber(params, 'pruning', 0), 0, 1);
  const pruningLut = params.pruning?.curve ? curveToLUT(params.pruning.curve, 256) : null;

  const warpNormalized = (s: number): number => {
    const cs = clamp(s, 0, 1);
    if (!distLut) return cs;
    return clamp(sampleCurveLUT(distLut, cs), 0, 1);
  };

  // Optional curvature attraction helper (`favorSplits` != 0)
  const attractToCurvature = (u0: number): number => {
    if (Math.abs(favorSplits) < 1e-4 || prep.branch.count < 3) return u0;
    let bestU = u0;
    let bestScore = -Infinity;
    for (let k = 1; k < prep.branch.count - 1; k++) {
      const uk = prep.t[k] as number;
      if (uk < first || uk > last) continue;
      const dist = Math.abs(uk - u0);
      if (dist > 0.2) continue;
      const curv = prep.curvatures[k] as number;
      const score = (favorSplits > 0 ? curv : -curv) - dist * 1.5;
      if (score > bestScore) {
        bestScore = score;
        bestU = uk;
      }
    }
    return u0 + (bestU - u0) * Math.abs(favorSplits) * 0.65;
  };

  const modeRng = branchRng.fork(`dist:${rawMode}`);
  const frame: ModeFrame = {
    rng: modeRng,
    first,
    last,
    parentLength: prep.arcLength,
    maxCount: maxRemaining,
    lodKeep: effectiveLodKeep,
    rollBase: rotationOffset + groupRoll,
    branchPhase: (prep.branch.id * GOLDEN_ANGLE_RAD) % (Math.PI * 2),
    positionOffset,
    warp: warpNormalized,
    attract: attractToCurvature,
    bends: (thresholdRad, minSpacing) =>
      findCurvaturePeaks(prep, first, last, thresholdRad, minSpacing).map((p) => ({ t: p.u, curvature: p.curvature, roll: p.azimuthRad })),
  };
  const rawCandidates = generatePlacements(frame, readModeRequest(mode, params, modeRng, jumble, sweep));
  const boundless = ignoresBoundaries(mode);

  const accepted: ChildPlacement[] = [];
  for (let slotIndex = 0; slotIndex < rawCandidates.length; slotIndex++) {
    const cand = rawCandidates[slotIndex] as PlacementRecord;
    if (accepted.length >= maxRemaining) break;
    if (clipEnabled && !boundless && (cand.t < minU || cand.t > maxU)) {
      continue;
    }
    const u = boundless ? clamp(cand.t, 0, 1) : clamp(cand.t, first, last);

    // Pruning curve & scalar check along normalized [first..last]
    const normSpanU = span > 1e-6 ? clamp((u - first) / span, 0, 1) : 0.5;
    if (pruningLut) {
      // Convention: curve value < 0.5 prunes when pruning curve is active
      const pCurveVal = sampleCurveLUT(pruningLut, normSpanU);
      if (pCurveVal < 0.5 && modeRng.fork(`prn:${slotIndex}`).next() > pCurveVal * 2) {
        continue;
      }
    }
    if (pruningBase > 0) {
      if (modeRng.fork(`prnb:${slotIndex}`).next() < pruningBase) {
        continue;
      }
    }

    // Knockout random removal
    const koProb = clamp(knockoutBase * (knockoutLut ? sampleCurveLUT(knockoutLut, u) : 1), 0, 1);
    if (koProb > 0 && modeRng.fork(`ko:${slotIndex}`).next() < koProb) {
      continue;
    }

    accepted.push({
      slotIndex,
      u,
      azimuthRad: cand.roll,
      isExtension: false,
      side: cand.side,
      groupIndex: cand.groupIndex,
    });
  }

  // Extend parent (seamless tip extensions)
  const extendType = getString(params, 'extendParent', 'none');
  if (extendType !== 'none' && accepted.length < maxRemaining) {
    const extCount = Math.min(maxRemaining - accepted.length, Math.max(1, Math.round(getNumber(params, 'extendCount', 1))));
    const baseSlot = 100_000;
    for (let e = 0; e < extCount; e++) {
      const az = rotationOffset + groupRoll + (e / Math.max(1, extCount)) * Math.PI * 2;
      accepted.push({
        slotIndex: baseSlot + e,
        u: 1,
        azimuthRad: az,
        isExtension: true,
        side: 0,
        groupIndex: 0,
      });
    }
  }

  return accepted;
}
