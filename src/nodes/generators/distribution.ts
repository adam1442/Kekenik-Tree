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
import {
  asExtendType,
  clipRange,
  extensionPositions,
  isOutsideClip,
  knockedOut,
  knockoutChance,
  normalizedAlong,
  pruningKeeps,
} from '@/generators/common';
import { EXTEND_PARENT_TYPES, EXTENSION_SLOT_BASE } from '@/generators/common/extend';
import { envFiltersByPosition, keepsAtPosition, type GenerationEnv } from './generationEnv';
import { findCurvaturePeaks, sampleParentBranch, type PreparedParentBranch } from './frames';

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
 * the shared steps in this order: mode placement -> boundaries / Clip -> Position / Rotation (inside the mode frame; Sink is
 * applied when the child grows) -> Pruning -> Knockout -> Force containers -> Masks -> Extend parent. Every random draw uses
 * `branchRng.fork(...)` so sibling branches are completely isolated.
 */
export function generateChildPlacements(
  prep: PreparedParentBranch,
  params: NodeParams,
  branchRng: Rng,
  lod: number,
  maxRemaining: number,
  env?: GenerationEnv,
): ChildPlacement[] {
  if (maxRemaining <= 0 || prep.branch.count < 2) return [];

  const rawMode = getString(params, 'mode', 'absolute');
  const mode = normalizeMode(rawMode);
  const rawFirst = clamp(getNumber(params, 'first', 0.15) * evalParamCurve(params, 'first', 0.5, 1), 0, 1);
  const rawLast = clamp(getNumber(params, 'last', 0.95) * evalParamCurve(params, 'last', 0.5, 1), 0, 1);
  const first = Math.min(rawFirst, rawLast);
  const last = Math.max(rawFirst, rawLast);

  const clipEnabled = getBool(params, 'clipEnabled', false);
  const clipBounds = clipRange(first, last, clipEnabled ? getNumber(params, 'clip', 0) : 0);

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
  const knockoutResolution = clamp(getNumber(params, 'knockoutResolution', 0), -1, 1);
  const knockoutLut = params.knockout?.curve ? curveToLUT(params.knockout.curve, 256) : null;
  const pruningCurve = getCurveParam(params, 'pruningCurve');

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
    clip: clipEnabled,
    branchPhase: (prep.branch.id * GOLDEN_ANGLE_RAD) % (Math.PI * 2),
    positionOffset,
    warp: warpNormalized,
    attract: attractToCurvature,
    bends: (thresholdRad, minSpacing) =>
      findCurvaturePeaks(prep, first, last, thresholdRad, minSpacing).map((p) => ({ t: p.u, curvature: p.curvature, roll: p.azimuthRad })),
  };
  const rawCandidates = generatePlacements(frame, readModeRequest(mode, params, modeRng, jumble, sweep));
  const boundless = ignoresBoundaries(mode);

  const clipActive = clipEnabled && !boundless;
  const byPosition = envFiltersByPosition(env);

  const accepted: ChildPlacement[] = [];
  for (let slotIndex = 0; slotIndex < rawCandidates.length; slotIndex++) {
    const cand = rawCandidates[slotIndex] as PlacementRecord;
    if (accepted.length >= maxRemaining) break;
    // Boundaries / Clip
    if (clipActive && isOutsideClip(cand.t, clipBounds.min, clipBounds.max)) continue;
    const u = boundless ? clamp(cand.t, 0, 1) : clipActive ? clamp(cand.t, 0, 1) : clamp(cand.t, first, last);

    // Pruning: curve over First..Last, nodes vanish where it is below 0.5
    if (!boundless && !pruningKeeps(pruningCurve, normalizedAlong(u, first, last))) continue;

    // Knockout
    const koChance = knockoutChance(knockoutBase, knockoutResolution, lod, knockoutLut ? sampleCurveLUT(knockoutLut, u) : 1);
    if (koChance > 0 && knockedOut(modeRng.fork(`ko:${slotIndex}`), koChance)) continue;

    // Force containers, Masks (evaluated where the node leaves the parent surface)
    if (byPosition && env) {
      const sample = sampleParentBranch(prep, u);
      const ca = Math.cos(cand.roll);
      const sa = Math.sin(cand.roll);
      const out: [number, number, number] = [
        sample.normal[0] * ca + sample.binormal[0] * sa,
        sample.normal[1] * ca + sample.binormal[1] * sa,
        sample.normal[2] * ca + sample.binormal[2] * sa,
      ];
      const len = Math.hypot(out[0], out[1], out[2]) || 1;
      const n: [number, number, number] = [out[0] / len, out[1] / len, out[2] / len];
      const at: [number, number, number] = [
        sample.position[0] + n[0] * sample.radius,
        sample.position[1] + n[1] * sample.radius,
        sample.position[2] + n[2] * sample.radius,
      ];
      if (!keepsAtPosition(env, at, n)) continue;
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

  // Extend parent (seamless extensions at the tip or base of the parent). Only valid under a Branch, Trunk or Root parent.
  const extendType = asExtendType(getString(params, 'extendParent', 'none'));
  if (extendType !== 'none' && accepted.length < maxRemaining && (env === undefined || env.parentType === undefined || EXTEND_PARENT_TYPES.has(env.parentType))) {
    const extCount = Math.min(maxRemaining - accepted.length, Math.max(1, Math.round(getNumber(params, 'extendCount', 1))));
    const positions = extensionPositions(extendType, extCount, branchLooksBroken(prep), prep.splitFlags);
    const baseSlot = EXTENSION_SLOT_BASE;
    for (let e = 0; e < positions.length; e++) {
      const az = rotationOffset + groupRoll + (e / Math.max(1, positions.length)) * Math.PI * 2;
      accepted.push({
        slotIndex: baseSlot + e,
        u: positions[e] as number,
        azimuthRad: az,
        isExtension: true,
        side: 0,
        groupIndex: 0,
      });
    }
  }

  return accepted;
}

/**
 * Whether the parent branch ends in a break (open end), as flagged by the Break parameters of its spine (`openEnd` attribute).
 * Skeletons without that flag fall back to a heuristic: a thick tip (a taper would close it), i.e. a tip radius above 30 % of the base radius.
 */
export function branchLooksBroken(prep: PreparedParentBranch): boolean {
  if (prep.openEnd !== undefined) return prep.openEnd;
  const n = prep.radii.length;
  if (n < 2) return false;
  const base = prep.radii[0] as number;
  const tip = prep.radii[n - 1] as number;
  return base > 1e-6 && tip / base > 0.3;
}
