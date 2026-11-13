import { curveToLUT, evaluateCurve, sampleCurveLUT, type Curve } from '@/contracts/curve';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import { clamp, deg2rad } from '@/core/math';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import { findCurvaturePeaks, type PreparedParentBranch } from './frames';

/** Golden angle in radians (~137.507764 deg). */
export const GOLDEN_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));

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

/**
 * Generates deterministic child placements `(u, azimuthRad)` for one `PreparedParentBranch`.
 * Every random draw uses `branchRng.fork(...)` so sibling branches are completely isolated.
 */
export function generateChildPlacements(
  prep: PreparedParentBranch,
  params: NodeParams,
  branchRng: Rng,
  lod: number,
  maxRemaining: number,
): ChildPlacement[] {
  if (maxRemaining <= 0 || prep.branch.count < 2) return [];

  const mode = getString(params, 'mode', 'absolute');
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
  const alignStyle = getString(params, 'alignStyle', 'group');

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

  const computeAzimuth = (idx: number, stepPhase: number, slotRng: Rng): number => {
    const sector = Math.PI * 2 * sweep;
    const basePhase = rotationOffset + groupRoll + (prep.branch.id * GOLDEN_ANGLE_RAD) % (Math.PI * 2);
    const jitter = (slotRng.next() - 0.5) * jumble * Math.PI * 1.2;

    switch (alignStyle) {
      case 'individual':
        return basePhase + slotRng.next() * sector;
      case 'alternate':
        return basePhase + (idx % 2) * Math.PI * sweep + jitter * 0.5;
      case 'opposite': {
        const pair = Math.floor(idx / 2);
        const side = idx % 2;
        return basePhase + side * Math.PI + pair * (Math.PI * 0.5) + jitter * 0.35;
      }
      case 'spiral':
        return basePhase + idx * GOLDEN_ANGLE_RAD * sweep + jitter * 0.4;
      case 'group':
      default:
        return basePhase + stepPhase * sweep + jitter;
    }
  };

  const rawCandidates: { slotIndex: number; rawU: number; azimuthRad: number; isExtension: boolean }[] = [];
  const modeRng = branchRng.fork(`dist:${mode}`);

  const scaledCount = (base: number): number => {
    const c = Math.round(base * effectiveLodKeep);
    return Math.min(maxRemaining, Math.max(0, c));
  };

  switch (mode) {
    case 'density': {
      const dens = Math.max(0, getNumber(params, 'density', 1) * evalParamCurve(params, 'density', 0.5, 1));
      const metricSpan = Math.max(0, prep.arcLength * span);
      const count = scaledCount(dens * metricSpan);
      const jitterAmt = clamp(getNumber(params, 'densityJitter', 0.2), 0, 1);
      for (let k = 0; k < count; k++) {
        const slotRng = modeRng.fork(k);
        const baseS = count === 1 ? 0.5 : (k + 0.5) / count;
        const jS = baseS + (slotRng.next() - 0.5) * (jitterAmt / Math.max(1, count));
        const u = first + warpNormalized(jS) * span + positionOffset;
        const az = computeAzimuth(k, k * GOLDEN_ANGLE_RAD, slotRng);
        rawCandidates.push({ slotIndex: k, rawU: u, azimuthRad: az, isExtension: false });
      }
      break;
    }

    case 'proportional': {
      const propRate = Math.max(0, getNumber(params, 'proportionalCount', 2.5));
      const count = scaledCount(propRate * Math.max(0.25, prep.arcLength * span));
      for (let k = 0; k < count; k++) {
        const slotRng = modeRng.fork(k);
        const baseS = count === 1 ? 0.5 : k / (count - 1);
        const jS = baseS + (slotRng.next() - 0.5) * jumble * (1 / Math.max(1, count)) * 1.6;
        const u = attractToCurvature(first + warpNormalized(jS) * span + positionOffset);
        const az = computeAzimuth(k, k * GOLDEN_ANGLE_RAD, slotRng);
        rawCandidates.push({ slotIndex: k, rawU: u, azimuthRad: az, isExtension: false });
      }
      break;
    }

    case 'interval': {
      const stepMetres = Math.max(0.02, getNumber(params, 'intervalStep', 0.6));
      const perStep = Math.max(1, Math.round(getNumber(params, 'perStep', 1)));
      const metricSpan = Math.max(0, prep.arcLength * span);
      const steps = Math.min(Math.ceil(maxRemaining / perStep), Math.max(1, Math.floor(metricSpan / stepMetres) + 1));
      let slot = 0;
      for (let s = 0; s < steps && slot < maxRemaining; s++) {
        const baseS = steps === 1 ? 0.5 : s / (steps - 1);
        const stepU = first + warpNormalized(baseS) * span + positionOffset;
        for (let m = 0; m < perStep && slot < maxRemaining; m++) {
          if (lod > 0 && modeRng.fork(`lod:${slot}`).next() > effectiveLodKeep) {
            slot += 1;
            continue;
          }
          const slotRng = modeRng.fork(slot);
          const u = stepU + (slotRng.next() - 0.5) * jumble * 0.08 * span;
          const stepAz = (m / perStep) * Math.PI * 2 + s * GOLDEN_ANGLE_RAD;
          const az = rotationOffset + groupRoll + stepAz * sweep + (slotRng.next() - 0.5) * jumble * 0.6;
          rawCandidates.push({ slotIndex: slot, rawU: u, azimuthRad: az, isExtension: false });
          slot += 1;
        }
      }
      break;
    }

    case 'phyllotaxy': {
      const rawNum = sampleVariance(modeRng.fork('num'), getNumber(params, 'number', 12), params.number?.variance ?? 0);
      const count = scaledCount(rawNum * evalParamCurve(params, 'number', 0.5, 1));
      const divergenceRad = deg2rad(getNumber(params, 'phyllotaxyAngle', 137.508));
      const phase0 = rotationOffset + groupRoll + (prep.branch.id * 1.6180339) % (Math.PI * 2);
      for (let k = 0; k < count; k++) {
        const slotRng = modeRng.fork(k);
        const baseS = count === 1 ? 0.5 : k / (count - 1);
        const u = first + warpNormalized(baseS) * span + positionOffset + (slotRng.next() - 0.5) * jumble * 0.1 * span;
        const az = phase0 + k * divergenceRad + (slotRng.next() - 0.5) * jumble * 0.35;
        rawCandidates.push({ slotIndex: k, rawU: u, azimuthRad: az, isExtension: false });
      }
      break;
    }

    case 'whorled': {
      const whorls = Math.max(1, Math.round(getNumber(params, 'whorlCount', 5) * Math.sqrt(effectiveLodKeep)));
      const perWhorl = Math.max(1, Math.round(getNumber(params, 'whorlPerStep', 4) * Math.sqrt(effectiveLodKeep)));
      const whorlSpread = clamp(getNumber(params, 'whorlSpread', 0.03), 0, 0.5);
      let slot = 0;
      for (let w = 0; w < whorls && slot < maxRemaining; w++) {
        const baseS = whorls === 1 ? 0.5 : w / (whorls - 1);
        const centerU = first + warpNormalized(baseS) * span + positionOffset;
        // Alternate half-step rotation per whorl for natural conifer packing
        const whorlPhase = rotationOffset + groupRoll + (w % 2) * (Math.PI / perWhorl) + w * deg2rad(getNumber(params, 'whorlRoll', 15));
        for (let m = 0; m < perWhorl && slot < maxRemaining; m++) {
          const slotRng = modeRng.fork(slot);
          const u = centerU + (slotRng.next() - 0.5) * (whorlSpread + jumble * 0.08) * span;
          const az = whorlPhase + (m / perWhorl) * Math.PI * 2 * sweep + (slotRng.next() - 0.5) * jumble * 0.45;
          rawCandidates.push({ slotIndex: slot, rawU: u, azimuthRad: az, isExtension: false });
          slot += 1;
        }
      }
      break;
    }

    case 'bifurcation': {
      const threshRad = deg2rad(Math.max(0.5, getNumber(params, 'bifurcationThreshold', 6)));
      const minSpacing = clamp(getNumber(params, 'bifurcationSpacing', 0.12), 0.01, 0.9);
      const peaks = findCurvaturePeaks(prep, first, last, threshRad, minSpacing);
      const maxPeaks = scaledCount(Math.max(peaks.length, getNumber(params, 'number', 4)));
      if (peaks.length > 0) {
        const chosen = peaks.slice(0, maxPeaks);
        for (let k = 0; k < chosen.length; k++) {
          const pk = chosen[k]!;
          const slotRng = modeRng.fork(k);
          const az = pk.azimuthRad + groupRoll + (slotRng.next() - 0.5) * jumble * 0.5;
          rawCandidates.push({ slotIndex: k, rawU: pk.u + positionOffset, azimuthRad: az, isExtension: false });
        }
      } else {
        // Fallback when parent has zero bends above threshold: place sparse fork points along [first, last]
        const fallbackCount = Math.min(maxRemaining, Math.max(1, Math.round(getNumber(params, 'number', 3) * 0.5 * effectiveLodKeep)));
        for (let k = 0; k < fallbackCount; k++) {
          const slotRng = modeRng.fork(k);
          const s = (k + 0.5) / fallbackCount;
          const u = first + warpNormalized(s) * span + positionOffset;
          const az = computeAzimuth(k, k * Math.PI + 0.4, slotRng);
          rawCandidates.push({ slotIndex: k, rawU: u, azimuthRad: az, isExtension: false });
        }
      }
      break;
    }

    case 'flood': {
      const rawNum = sampleVariance(modeRng.fork('num'), getNumber(params, 'number', 12), params.number?.variance ?? 0);
      const count = scaledCount(rawNum * evalParamCurve(params, 'number', 0.5, 1));
      for (let k = 0; k < count; k++) {
        const slotRng = modeRng.fork(k);
        const u = first + warpNormalized(slotRng.next()) * span + positionOffset;
        const az = rotationOffset + groupRoll + slotRng.next() * Math.PI * 2 * sweep;
        rawCandidates.push({ slotIndex: k, rawU: u, azimuthRad: az, isExtension: false });
      }
      break;
    }

    case 'absolute':
    default: {
      const rawNum = sampleVariance(modeRng.fork('num'), getNumber(params, 'number', 10), params.number?.variance ?? 0);
      const count = scaledCount(rawNum * evalParamCurve(params, 'number', 0.5, 1));
      for (let k = 0; k < count; k++) {
        const slotRng = modeRng.fork(k);
        const baseS = count === 1 ? 0.5 : k / (count - 1);
        const jitterSpan = count > 1 ? 0.65 / (count - 1) : 0.25;
        const jS = baseS + (slotRng.next() - 0.5) * 2 * jumble * jitterSpan;
        const u = attractToCurvature(first + warpNormalized(jS) * span + positionOffset);
        const az = computeAzimuth(k, k * GOLDEN_ANGLE_RAD, slotRng);
        rawCandidates.push({ slotIndex: k, rawU: u, azimuthRad: az, isExtension: false });
      }
      break;
    }
  }

  const accepted: ChildPlacement[] = [];
  for (const cand of rawCandidates) {
    if (accepted.length >= maxRemaining) break;
    if (clipEnabled && (cand.rawU < minU || cand.rawU > maxU)) {
      continue;
    }
    const u = clamp(cand.rawU, first, last);

    // Pruning curve & scalar check along normalized [first..last]
    const normSpanU = span > 1e-6 ? clamp((u - first) / span, 0, 1) : 0.5;
    if (pruningLut) {
      // Convention: curve value < 0.5 prunes when pruning curve is active
      const pCurveVal = sampleCurveLUT(pruningLut, normSpanU);
      if (pCurveVal < 0.5 && modeRng.fork(`prn:${cand.slotIndex}`).next() > pCurveVal * 2) {
        continue;
      }
    }
    if (pruningBase > 0) {
      if (modeRng.fork(`prnb:${cand.slotIndex}`).next() < pruningBase) {
        continue;
      }
    }

    // Knockout random removal
    const koProb = clamp(knockoutBase * (knockoutLut ? sampleCurveLUT(knockoutLut, u) : 1), 0, 1);
    if (koProb > 0 && modeRng.fork(`ko:${cand.slotIndex}`).next() < koProb) {
      continue;
    }

    accepted.push({
      slotIndex: cand.slotIndex,
      u,
      azimuthRad: cand.azimuthRad,
      isExtension: false,
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
      });
    }
  }

  return accepted;
}
