import { curveToLUT, evaluateCurve, sampleCurveLUT, type Curve } from '@/contracts/curve';
import type { CancellationToken, NodeInputs } from '@/contracts/nodes';
import { getBool, getNumber, getString, type NodeParams } from '@/contracts/params';
import { clamp, deg2rad } from '@/core/math';
import { createSimplex, type SimplexNoise } from '@/core/noise';
import type { Rng } from '@/core/rng';
import { sampleVariance } from '@/graph/engine/seeds';
import { compileSpineForceHook, type CompiledSpineForceHook } from './forcesHook';
import {
  advanceRMF,
  orthonormalNormal,
  rotateAroundAxis,
  selectAdaptiveSampleIndices,
  v3Add,
  v3Cross,
  v3Dot,
  v3Norm,
  v3Scale,
  type Frame3,
  type Vec3,
} from './frames';
import type { StructureSkeletonBuilder } from './skeletonBuild';

const LOD_SEG_SCALE = [1, 0.75, 0.5, 0.35] as const;

function getCurveValue(params: NodeParams, id: string): Curve | null {
  const v = params[id]?.value;
  if (v && typeof v === 'object' && 'points' in v && Array.isArray((v as Curve).points)) {
    return v as Curve;
  }
  return null;
}

function evalParentCurve(params: NodeParams, id: string, u: number, fallback = 1): number {
  const c = params[id]?.curve;
  return c ? evaluateCurve(c, u) : fallback;
}

export interface CompiledSpineConfig {
  readonly params: NodeParams;
  readonly lod: number;
  readonly noise: SimplexNoise;
  readonly flareNoiseGen: SimplexNoise;
  readonly forceHook: CompiledSpineForceHook;

  readonly accuracy: number;
  readonly baseSegments: number;
  readonly relativeSegments: number;
  readonly optimizationRad: number;

  readonly lengthBase: number;
  readonly lengthVar: number;
  readonly lengthRelative: boolean;
  readonly lengthPercent: number;
  readonly lengthPercentRadius: number;
  readonly lengthMin: number;
  readonly lengthMax: number;
  readonly crownShape: string;
  readonly crownLut: Float32Array | null;
  readonly shapeScale: number;
  readonly curlUp: number;
  readonly curlRight: number;
  readonly curlOut: number;
  readonly zigzag: number;
  readonly lengthLimit: boolean;
  readonly crownHeight: number;

  readonly radiusBase: number;
  readonly radiusVar: number;
  readonly minRadius: number;
  readonly taperBase: number;
  readonly parentRadiusInfluence: number;
  readonly parentRadiusMax: number;

  readonly spreadDeg: number;
  readonly spreadVar: number;
  readonly startRollDeg: number;
  readonly startRollVar: number;
  readonly pitchDeg: number;
  readonly pitchVar: number;
  readonly spineRollDeg: number;
  readonly alignment: number;
  readonly weldStart: boolean;

  readonly curvatureBase: number;
  readonly curvatureVar: number;
  readonly straightness: number;
  readonly twistDeg: number;
  readonly twistVar: number;

  readonly earlyNoiseAmount: number;
  readonly earlyNoiseFreq: number;
  readonly noiseAmountBase: number;
  readonly noiseFrequency: number;
  readonly noiseTwist: number;
  readonly noiseSmooth: number;

  readonly flareRadiusBase: number;
  readonly flareHeight: number;
  readonly flareNoise: number;
  readonly flareLobes: number;
  readonly flareBlend: number;
  readonly bulgeAmountBase: number;
  readonly bulgeFrequency: number;

  readonly termination: string;
  readonly breakChance: number;
  readonly breakSpot: number;
  readonly breakSpotVar: number;

  readonly splitChance: number;
  readonly splitSpreadDeg: number;
  readonly splitBalance: number;
  readonly splitStart: number;
  readonly splitMaxDepth: number;

  readonly pruneGeneral: number;
  readonly pruneInterior: number;
  readonly pruneUp: number;
  readonly pruneDown: number;
  readonly pruneGround: boolean;

  // Root-specific parameters
  readonly isRoot: boolean;
  readonly rootSpread: number;
  readonly rootDepth: number;
  readonly rootDiveAngleDeg: number;
  readonly surfaceHug: number;

  // Precompiled 256-sample profile LUTs
  readonly radiusProfileLut: Float32Array | null;
  readonly taperLut: Float32Array | null;
  readonly curvatureLut: Float32Array | null;
  readonly noiseAmountLut: Float32Array | null;
  readonly earlyNoiseLut: Float32Array | null;
  readonly flareLut: Float32Array | null;
  readonly bulgeLut: Float32Array | null;
  readonly twistLut: Float32Array | null;
}

export function compileSpineConfig(
  params: NodeParams,
  inputs: NodeInputs,
  lod: number,
  seed: number,
  isRoot = false,
): CompiledSpineConfig {
  const noiseSeedOffset = getNumber(params, 'noiseSeed', 0);
  const displaceSeedOffset = getNumber(params, 'displaceSeed', 0);
  const noise = createSimplex((seed ^ Math.imul(noiseSeedOffset + 1, 0x9e3779b1)) >>> 0);
  const flareNoiseGen = createSimplex((seed ^ Math.imul(displaceSeedOffset + 7, 0x85ebca6b)) >>> 0);
  const forceHook = compileSpineForceHook(inputs, params);

  const lodSegReduction = clamp(getNumber(params, 'lodSegments', 0.5), 0, 1);
  const lodFactor =
    lod === 0
      ? 1
      : clamp(
          1 - (1 - (LOD_SEG_SCALE[Math.min(lod, LOD_SEG_SCALE.length - 1)] as number)) * (0.4 + 0.6 * lodSegReduction),
          0.2,
          1,
        );

  const rawAccuracy = Math.max(8, Math.min(128, Math.round(getNumber(params, 'accuracy', 32))));
  const accuracy = lod >= 2 ? Math.max(8, Math.round(rawAccuracy * 0.5)) : rawAccuracy;
  const baseSegments = Math.max(1, Math.round(getNumber(params, 'segments', 12) * lodFactor));
  const relativeSegments = Math.max(0, getNumber(params, 'relativeSegments', 0) * lodFactor);
  const optimizationRad = deg2rad(clamp(getNumber(params, 'optimization', 0), 0, 45));

  const radiusProfileCurve = getCurveValue(params, 'radiusProfile');

  return {
    params,
    lod,
    noise,
    flareNoiseGen,
    forceHook,

    accuracy,
    baseSegments,
    relativeSegments,
    optimizationRad,

    lengthBase: Math.max(0.01, getNumber(params, 'length', 4)),
    lengthVar: params.length?.variance ?? 0,
    lengthRelative: getBool(params, 'lengthRelative', false),
    lengthPercent: Math.max(0, getNumber(params, 'lengthPercent', 0)),
    lengthPercentRadius: Math.max(0, getNumber(params, 'lengthPercentRadius', 0)),
    lengthMin: Math.max(0, getNumber(params, 'lengthMin', 0)),
    lengthMax: Math.max(0, getNumber(params, 'lengthMax', 0)),
    crownShape: getString(params, 'crownShape', 'natural'),
    crownLut: getCurveValue(params, 'crownCurve') ? curveToLUT(getCurveValue(params, 'crownCurve') as Curve, 256) : null,
    shapeScale: Math.max(0, getNumber(params, 'shapeScale', 1)),
    curlUp: getNumber(params, 'curlUp', 0),
    curlRight: getNumber(params, 'curlRight', 0),
    curlOut: getNumber(params, 'curlOut', 0),
    zigzag: Math.max(0, getNumber(params, 'zigzag', 0)),
    lengthLimit: getBool(params, 'lengthLimit', false),
    crownHeight: clamp(getNumber(params, 'crownHeight', 0.25), 0, 0.95),

    radiusBase: Math.max(0.001, getNumber(params, 'radius', 0.08)),
    radiusVar: params.radius?.variance ?? 0,
    minRadius: Math.max(0.0005, getNumber(params, 'minRadius', 0.002)),
    taperBase: clamp(getNumber(params, 'taper', 0.9), 0, 1),
    parentRadiusInfluence: clamp(getNumber(params, 'parentRadiusInfluence', 0.35), 0, 1),
    parentRadiusMax: clamp(getNumber(params, 'parentRadiusMax', 0.85), 0.05, 2),

    spreadDeg: getNumber(params, 'spread', 45),
    spreadVar: params.spread?.variance ?? 0,
    startRollDeg: getNumber(params, 'startRoll', 0),
    startRollVar: params.startRoll?.variance ?? 0,
    pitchDeg: getNumber(params, 'pitch', 0),
    pitchVar: params.pitch?.variance ?? 0,
    spineRollDeg: getNumber(params, 'spineRoll', 0),
    alignment: clamp(getNumber(params, 'alignment', 0), 0, 1),
    weldStart: getBool(params, 'weldStart', false),

    curvatureBase: getNumber(params, 'curvature', 0) * Math.max(0, getNumber(params, 'shapeScale', 1)),
    curvatureVar: params.curvature?.variance ?? 0,
    straightness: clamp(getNumber(params, 'straightness', 0.2), 0, 1),
    twistDeg: getNumber(params, 'twist', 0),
    twistVar: params.twist?.variance ?? 0,

    earlyNoiseAmount: Math.max(0, getNumber(params, 'earlyNoiseAmount', 0.08)),
    earlyNoiseFreq: Math.max(0.05, getNumber(params, 'earlyNoiseFrequency', 1.2)),
    noiseAmountBase: Math.max(0, getNumber(params, 'noiseAmount', 0.2)) * Math.max(0, getNumber(params, 'shapeScale', 1)),
    noiseFrequency: Math.max(0, getNumber(params, 'noiseFrequency', 1)),
    noiseTwist: getNumber(params, 'noiseTwist', 0),
    noiseSmooth: clamp(getNumber(params, 'noiseSmooth', 0), 0, 1),

    flareRadiusBase: Math.max(0, getNumber(params, 'flareRadius', 0)),
    flareHeight: clamp(getNumber(params, 'flareHeight', 0.12), 0.01, 1),
    flareNoise: clamp(getNumber(params, 'flareNoise', 0), 0, 1),
    flareLobes: Math.max(0, Math.round(getNumber(params, 'flareLobes', 4))),
    flareBlend: clamp(getNumber(params, 'flareBlend', 0.5), 0, 1),
    bulgeAmountBase: Math.max(0, getNumber(params, 'bulgeAmount', 0)),
    bulgeFrequency: Math.max(0.1, getNumber(params, 'bulgeFrequency', 1)),

    termination: getString(params, 'termination', 'taper'),
    breakChance: clamp(getNumber(params, 'breakChance', 0), 0, 1),
    breakSpot: clamp(getNumber(params, 'breakSpot', 0.65), 0.1, 0.98),
    breakSpotVar: params.breakSpot?.variance ?? 0,

    splitChance: clamp(getNumber(params, 'splitChance', 0), 0, 1),
    splitSpreadDeg: clamp(getNumber(params, 'splitSpread', 26), 2, 85),
    splitBalance: clamp(getNumber(params, 'splitBalance', 0.5), 0.15, 0.85),
    splitStart: clamp(getNumber(params, 'splitStart', 0.55), 0.15, 0.9),
    splitMaxDepth: Math.max(1, Math.min(3, Math.round(getNumber(params, 'splitMaxDepth', 1)))),

    pruneGeneral: clamp(getNumber(params, 'pruneGeneral', 0), 0, 1),
    pruneInterior: clamp(getNumber(params, 'pruneInterior', 0), 0, 1),
    pruneUp: clamp(getNumber(params, 'pruneUp', 0), 0, 1),
    pruneDown: clamp(getNumber(params, 'pruneDown', 0), 0, 1),
    pruneGround: isRoot ? false : getBool(params, 'pruneGround', false),

    isRoot,
    rootSpread: clamp(getNumber(params, 'rootSpread', 1), 0, 3),
    rootDepth: Math.max(0, getNumber(params, 'rootDepth', 1.4)),
    rootDiveAngleDeg: clamp(getNumber(params, 'rootDiveAngle', 42), 0, 89),
    surfaceHug: clamp(getNumber(params, 'surfaceHug', 0.3), 0, 0.95),

    radiusProfileLut: radiusProfileCurve ? curveToLUT(radiusProfileCurve, 256) : null,
    taperLut: params.taper?.curve ? curveToLUT(params.taper.curve, 256) : null,
    curvatureLut: params.curvature?.curve ? curveToLUT(params.curvature.curve, 256) : null,
    noiseAmountLut: params.noiseAmount?.curve ? curveToLUT(params.noiseAmount.curve, 256) : null,
    earlyNoiseLut: params.earlyNoiseAmount?.curve ? curveToLUT(params.earlyNoiseAmount.curve, 256) : null,
    flareLut: params.flareRadius?.curve ? curveToLUT(params.flareRadius.curve, 256) : null,
    bulgeLut: params.bulgeAmount?.curve ? curveToLUT(params.bulgeAmount.curve, 256) : null,
    twistLut: params.twist?.curve ? curveToLUT(params.twist.curve, 256) : null,
  };
}

export interface SpineSpawnSpec {
  parentBranch: number;
  parentPoint: number;
  generation: number;
  origin: Vec3;
  initialFrame: Frame3;
  parentTangent: Vec3;
  parentU: number;
  parentLength: number;
  parentRadius: number;
  hasParent: boolean;
  isExtension: boolean;
  /** Optional explicit length override (used by daughter splits or helper nodes). */
  lengthOverride?: number;
  /** Optional explicit base radius override (used by daughter splits). */
  baseRadiusOverride?: number;
  /** Current recursive split depth within this spine (0 = primary stem). */
  splitDepth?: number;
  /** Per-instance multiplier of the computed length (Node mode override). */
  lengthScale?: number;
  /** Per-instance multiplier of the computed base radius (Node mode override). */
  radiusScale?: number;
}

/**
 * Evaluates orientation-based pruning rules (`pruneGeneral`, `pruneUp`, `pruneDown`, `pruneInterior`).
 * Returns true if this candidate branch should be pruned before integration.
 */
export function shouldPruneBranch(cfg: CompiledSpineConfig, spec: SpineSpawnSpec, rng: Rng): boolean {
  if (cfg.pruneGeneral > 0 && rng.fork('pg').next() < cfg.pruneGeneral) {
    return true;
  }
  const T = spec.initialFrame.tangent;
  if (cfg.pruneUp > 0 && T[2] > 0.1) {
    if (rng.fork('pu').next() < cfg.pruneUp * clamp(T[2], 0, 1)) return true;
  }
  if (cfg.pruneDown > 0 && T[2] < -0.05) {
    if (rng.fork('pd').next() < cfg.pruneDown * clamp(-T[2], 0, 1)) return true;
  }
  if (cfg.pruneInterior > 0 && spec.hasParent) {
    const rHorizLen = Math.hypot(spec.origin[0], spec.origin[1]);
    if (rHorizLen > 0.05) {
      const outX = spec.origin[0] / rHorizLen;
      const outY = spec.origin[1] / rHorizLen;
      const horizDot = outX * T[0] + outY * T[1];
      if (horizDot < 0) {
        if (rng.fork('pi').next() < cfg.pruneInterior * clamp(-horizDot, 0, 1)) return true;
      }
    }
  }
  return false;
}

/**
 * Computes effective branch length from Absolute + Relative (% of parent) + Crown shape + Variance.
 */
export function computeBranchLength(cfg: CompiledSpineConfig, spec: SpineSpawnSpec, rng: Rng): number {
  if (spec.lengthOverride !== undefined) return Math.max(0.02, spec.lengthOverride);

  const sampledAbs = Math.max(0.02, sampleVariance(rng.fork('len'), cfg.lengthBase, cfg.lengthVar));
  const parentCurveScale = Math.max(0.02, evalParentCurve(cfg.params, 'length', spec.parentU, 1));

  let len: number;
  if (!spec.hasParent) {
    len = sampledAbs * parentCurveScale;
  } else if (cfg.isRoot) {
    // Roots near ground (low parentU) are longest
    len = (sampledAbs + cfg.lengthPercent * spec.parentLength) * parentCurveScale * (1 - spec.parentU * 0.25);
  } else {
    // Natural conical/crown envelope along parent unless overridden by an explicit curve
    const hasExplicitCurve = Boolean(cfg.params.length?.curve);
    const naturalEnvelope = hasExplicitCurve ? 1 : crownEnvelope(cfg, spec.parentU);
    const relPart = cfg.lengthRelative
      ? (cfg.lengthPercent > 0 ? cfg.lengthPercent : 0.35) * spec.parentLength
      : cfg.lengthPercent * spec.parentLength;
    const absPart = cfg.lengthRelative && cfg.lengthPercent > 0 ? 0 : sampledAbs;
    const genDamping = spec.generation > 1 ? Math.pow(0.82, spec.generation - 1) : 1;
    len = (absPart + relPart + cfg.lengthPercentRadius * spec.parentRadius) * parentCurveScale * naturalEnvelope * genDamping;
    if (cfg.lengthLimit) {
      len = Math.min(len, cfg.lengthBase);
    }
  }
  if (cfg.lengthMax > 0) len = Math.min(len, cfg.lengthMax);
  if (cfg.lengthMin > 0) len = Math.max(len, cfg.lengthMin);
  return Math.max(0.02, len);
}

/** Branch length multiplier as a function of the normalised height `u` on the parent (crown silhouette). */
export function crownEnvelope(cfg: Pick<CompiledSpineConfig, 'crownShape' | 'crownLut'>, u: number): number {
  const x = clamp(u, 0, 1);
  switch (cfg.crownShape) {
    case 'conical':
      return clamp(1 - x * 0.88, 0.1, 1);
    case 'oval':
      return clamp(Math.sin(Math.PI * (0.12 + 0.76 * x)), 0.2, 1);
    case 'vase':
      return clamp(0.3 + 0.7 * Math.pow(x, 0.75), 0.3, 1);
    case 'columnar':
      return 1;
    case 'custom':
      return cfg.crownLut ? Math.max(0.02, sampleCurveLUT(cfg.crownLut, x)) : 1;
    default:
      return clamp(1 - x * 0.55, 0.2, 1);
  }
}

/**
 * Computes effective base radius at `f = 0`, honoring `parentRadiusInfluence`, `parentRadiusMax`, and `flareBlend`.
 */
export function computeBaseRadius(cfg: CompiledSpineConfig, spec: SpineSpawnSpec, rng: Rng): number {
  if (spec.baseRadiusOverride !== undefined) return Math.max(cfg.minRadius, spec.baseRadiusOverride);

  const sampledR = Math.max(cfg.minRadius, sampleVariance(rng.fork('rad'), cfg.radiusBase, cfg.radiusVar));
  const curveScale = Math.max(0.02, evalParentCurve(cfg.params, 'radius', spec.parentU, 1));
  let baseR = sampledR * curveScale;

  if (spec.hasParent && spec.parentRadius > 0) {
    if (spec.isExtension) {
      return Math.max(cfg.minRadius, spec.parentRadius);
    }
    if (cfg.isRoot) {
      // Blend root base smoothly with trunk base radius
      const rootRatio = spec.parentRadius * (0.35 + 0.4 * cfg.flareBlend);
      baseR = baseR * (1 - cfg.flareBlend) + rootRatio * cfg.flareBlend;
      baseR = Math.min(baseR, spec.parentRadius * 0.95);
    } else {
      const parentScaled = spec.parentRadius * 0.55;
      baseR = baseR * (1 - cfg.parentRadiusInfluence) + parentScaled * cfg.parentRadiusInfluence;
      baseR = Math.min(baseR, spec.parentRadius * cfg.parentRadiusMax);
    }
  }

  return Math.max(cfg.minRadius, baseR);
}

/**
 * Evaluates radius along normalized spine coordinate `f` in [0, 1].
 * Guarantees monotonic non-increasing radius when `taper > 0`, `flareRadius == 0`, `bulgeAmount == 0`,
 * and `radiusProfile` is flat or monotonically decreasing.
 */
export function evaluateSpineRadius(
  cfg: CompiledSpineConfig,
  baseRadius: number,
  f: number,
  noiseSeedPhase: number,
  effectiveTaperScale = 1,
): number {
  const cf = clamp(f, 0, 1);
  const profile = cfg.radiusProfileLut ? Math.max(0, sampleCurveLUT(cfg.radiusProfileLut, cf)) : 1;
  const taperCurve = cfg.taperLut ? clamp(sampleCurveLUT(cfg.taperLut, cf), 0, 2) : 1;
  const taper = clamp(cfg.taperBase * taperCurve * effectiveTaperScale, 0, 1);

  const core = Math.max(0, baseRadius * profile * (1 - taper * cf));

  // Base flare / buttress swelling near f in [0, flareHeight]
  let flareAdd = 0;
  if (cfg.flareRadiusBase > 0 && cf < cfg.flareHeight) {
    const uFlare = 1 - cf / Math.max(1e-4, cfg.flareHeight);
    const falloff = uFlare * uFlare * (3 - 2 * uFlare) * uFlare; // smooth buttress skirt
    const fCurve = cfg.flareLut ? Math.max(0, sampleCurveLUT(cfg.flareLut, cf / cfg.flareHeight)) : 1;
    const nMod =
      cfg.flareNoise > 0
        ? 1 + cfg.flareNoise * 0.45 * cfg.flareNoiseGen.noise3(cf * Math.max(1, cfg.flareLobes), noiseSeedPhase, 2.3)
        : 1;
    flareAdd = baseRadius * cfg.flareRadiusBase * falloff * fCurve * Math.max(0, nMod);
  }

  // Burl / bulge modulation along length
  let bulgeAdd = 0;
  if (cfg.bulgeAmountBase > 0) {
    const bCurve = cfg.bulgeLut ? Math.max(0, sampleCurveLUT(cfg.bulgeLut, cf)) : 1;
    const wave = 0.5 + 0.5 * cfg.flareNoiseGen.noise3(cf * cfg.bulgeFrequency * 3.1, noiseSeedPhase * 1.7, 7.9);
    const pin = Math.sin(Math.PI * cf); // zero at exact ends
    bulgeAdd = baseRadius * cfg.bulgeAmountBase * bCurve * wave * pin * 0.5;
  }

  return Math.max(cfg.minRadius, core + flareAdd + bulgeAdd);
}

/**
 * Integrates one spine (plus any bifurcated split daughters) and appends the resulting branch(es)
 * into `builder`. Returns the number of branches written.
 */
export function growSpineIntoBuilder(
  cfg: CompiledSpineConfig,
  spec: SpineSpawnSpec,
  rng: Rng,
  builder: StructureSkeletonBuilder,
  cancel?: CancellationToken,
): number {
  cancel?.throwIfCancelled();

  const splitDepth = spec.splitDepth ?? 0;
  if (splitDepth === 0 && shouldPruneBranch(cfg, spec, rng)) {
    return 0;
  }

  const fullLength = computeBranchLength(cfg, spec, rng) * Math.max(0.01, spec.lengthScale ?? 1);
  const baseRadius = computeBaseRadius(cfg, spec, rng) * Math.max(0.01, spec.radiusScale ?? 1);

  // Determine break / termination behavior
  const isForkMode = cfg.termination === 'fork' && splitDepth === 0;
  const isBroken =
    splitDepth === 0 &&
    (cfg.termination === 'broken' || (cfg.breakChance > 0 && rng.fork('brk').chance(cfg.breakChance)));
  const fBreak = isBroken
    ? clamp(sampleVariance(rng.fork('brkSpot'), cfg.breakSpot, cfg.breakSpotVar, 0.35), 0.15, 0.95)
    : 1;

  // Determine split / bifurcation behavior
  const willSplit =
    !isBroken &&
    splitDepth < cfg.splitMaxDepth &&
    (isForkMode || (cfg.splitChance > 0 && rng.fork('spl').chance(cfg.splitChance)));
  const fSplit = willSplit
    ? clamp(isForkMode ? 0.62 : cfg.splitStart + rng.fork('splPos').range(-0.1, 0.1), 0.2, 0.85)
    : 1;

  const fEnd = willSplit ? fSplit : fBreak;
  const activeLength = Math.max(0.015, fullLength * fEnd);

  const curv = sampleVariance(rng.fork('curv'), cfg.curvatureBase, cfg.curvatureVar, 0.5);
  const totalTwistRad = deg2rad(sampleVariance(rng.fork('tws'), cfg.twistDeg, cfg.twistVar, 45));
  const noisePhase = rng.fork('nph').range(-100, 100);

  const steps = Math.max(4, Math.round(cfg.accuracy * fEnd));
  const denseCount = steps + 1;
  const densePos = new Float32Array(denseCount * 3);
  const denseTan = new Float32Array(denseCount * 3);
  const denseNrm = new Float32Array(denseCount * 3);

  let curPos: Vec3 = [spec.origin[0], spec.origin[1], spec.origin[2]];
  let curT: Vec3 = [...spec.initialFrame.tangent];
  let curN: Vec3 = [...spec.initialFrame.normal];

  densePos[0] = curPos[0];
  densePos[1] = curPos[1];
  densePos[2] = curPos[2];
  denseTan[0] = curT[0];
  denseTan[1] = curT[1];
  denseTan[2] = curT[2];
  denseNrm[0] = curN[0];
  denseNrm[1] = curN[1];
  denseNrm[2] = curN[2];

  const dtStep = activeLength / steps;
  const curlActive = cfg.curlUp !== 0 || cfg.curlRight !== 0 || cfg.curlOut !== 0;
  const curlUpV: Vec3 = v3Norm(spec.parentTangent);
  const curlOutRaw: Vec3 = [
    spec.initialFrame.tangent[0] - curlUpV[0] * v3Dot(spec.initialFrame.tangent, curlUpV),
    spec.initialFrame.tangent[1] - curlUpV[1] * v3Dot(spec.initialFrame.tangent, curlUpV),
    spec.initialFrame.tangent[2] - curlUpV[2] * v3Dot(spec.initialFrame.tangent, curlUpV),
  ];
  const curlOutV: Vec3 = v3Norm(curlOutRaw, spec.initialFrame.normal);
  const curlRightV: Vec3 = v3Norm(v3Cross(curlUpV, curlOutV), spec.initialFrame.normal);
  const zigPeriod = Math.max(1, Math.round(steps / Math.max(2, cfg.baseSegments)));
  let zigFlip = 0;
  let actualDenseCount = denseCount;

  // Pass 1: Stepwise tangent integration (Early noise + Curvature + Root dive + Forces)
  for (let s = 1; s <= steps; s++) {
    const localU = s / steps;
    const f = localU * fEnd;
    const curB = v3Norm(v3Cross(curT, curN));

    let nextDir: Vec3 = [curT[0], curT[1], curT[2]];

    // Early noise perturbs growth direction incrementally, damped near base by straightness
    if (cfg.earlyNoiseAmount > 0) {
      const straightDamp = 1 - cfg.straightness * (1 - f);
      const eCurve = cfg.earlyNoiseLut ? sampleCurveLUT(cfg.earlyNoiseLut, f) : 1;
      const eAmp = cfg.earlyNoiseAmount * eCurve * straightDamp * (1 / Math.sqrt(steps)) * 1.4;
      const nx = cfg.noise.noise3(f * cfg.earlyNoiseFreq * 2.3 + noisePhase, 1.7, splitDepth * 3.1);
      const ny = cfg.noise.noise3(f * cfg.earlyNoiseFreq * 2.3 + noisePhase, 8.9, splitDepth * 3.1 + 4.2);
      nextDir = v3Add(nextDir, v3Add(v3Scale(curN, nx * eAmp), v3Scale(curB, ny * eAmp)));
    }

    // Curvature bends around local binormal
    if (Math.abs(curv) > 1e-5) {
      const cVal = curv * (cfg.curvatureLut ? sampleCurveLUT(cfg.curvatureLut, f) : 1);
      nextDir = rotateAroundAxis(nextDir, curB, (cVal * 1.2) / steps);
    }

    // Parent curl: bend relative to the parent's frame (up = parent tangent, out = away from the parent axis)
    if (curlActive) {
      const w = (0.5 + f) * (1.4 / steps);
      nextDir = [
        nextDir[0] + (curlUpV[0] * cfg.curlUp + curlRightV[0] * cfg.curlRight + curlOutV[0] * cfg.curlOut) * w,
        nextDir[1] + (curlUpV[1] * cfg.curlUp + curlRightV[1] * cfg.curlRight + curlOutV[1] * cfg.curlOut) * w,
        nextDir[2] + (curlUpV[2] * cfg.curlUp + curlRightV[2] * cfg.curlRight + curlOutV[2] * cfg.curlOut) * w,
      ];
    }

    // Zigzag: alternate the heading at every final segment (first kick +a, then -2a, +2a ...)
    if (cfg.zigzag > 0 && s % zigPeriod === 0 && s < steps) {
      const a = cfg.zigzag * 0.45;
      const flip = zigFlip++;
      nextDir = rotateAroundAxis(nextDir, curB, flip === 0 ? a : flip % 2 === 1 ? -2 * a : 2 * a);
    }

    // Root subterranean profile: hug surface horizontally near trunk, then dive underground
    if (cfg.isRoot) {
      const diveRad = deg2rad(cfg.rootDiveAngleDeg);
      const diveBlend = f <= cfg.surfaceHug ? (f / Math.max(0.05, cfg.surfaceHug)) * 0.35 : 0.35 + 0.65 * ((f - cfg.surfaceHug) / Math.max(0.05, 1 - cfg.surfaceHug));
      const targetDown = -Math.sin(diveRad) * diveBlend * (0.5 + 0.5 * (cfg.rootDepth / Math.max(0.5, fullLength)));
      const horizScale = Math.max(0.15, cfg.rootSpread);
      nextDir = [
        nextDir[0] * (1 + (horizScale - 1) * 0.12),
        nextDir[1] * (1 + (horizScale - 1) * 0.12),
        nextDir[2] + (targetDown - nextDir[2]) * (1.8 / steps),
      ];
    }

    // Built-in & external spine forces
    const forceVec = cfg.forceHook.sample(curPos, nextDir, spec.parentTangent, f, spec.parentU);
    nextDir = v3Norm([
      nextDir[0] + (forceVec[0] * 1.35) / steps,
      nextDir[1] + (forceVec[1] * 1.35) / steps,
      nextDir[2] + (forceVec[2] * 1.35) / steps,
    ], curT);

    const nextPos: Vec3 = [
      curPos[0] + nextDir[0] * dtStep,
      curPos[1] + nextDir[1] * dtStep,
      curPos[2] + nextDir[2] * dtStep,
    ];

    // Ground plane pruning / clipping for aerial branches
    if (cfg.pruneGround && spec.hasParent && nextPos[2] < 0.01) {
      if (s <= 2) return 0; // Entire branch immediately hits ground -> prune cleanly
      actualDenseCount = s;
      break;
    }

    const nextN = advanceRMF(curPos, curT, curN, nextPos, nextDir);

    densePos[s * 3] = nextPos[0];
    densePos[s * 3 + 1] = nextPos[1];
    densePos[s * 3 + 2] = nextPos[2];
    denseTan[s * 3] = nextDir[0];
    denseTan[s * 3 + 1] = nextDir[1];
    denseTan[s * 3 + 2] = nextDir[2];
    denseNrm[s * 3] = nextN[0];
    denseNrm[s * 3 + 1] = nextN[1];
    denseNrm[s * 3 + 2] = nextN[2];

    curPos = nextPos;
    curT = nextDir;
    curN = nextN;
  }

  if (actualDenseCount < 2) return 0;

  // Pass 2: Late noise / gnarliness displacement in local RMF (N, B) plane, pinned at s = 0
  const lateAmpScale = cfg.noiseAmountBase * (1 - cfg.noiseSmooth);
  if (lateAmpScale > 1e-5 && cfg.noiseFrequency > 1e-5) {
    for (let s = 1; s < actualDenseCount; s++) {
      const localU = s / (actualDenseCount - 1);
      const f = localU * fEnd;
      // Smoothly ramp from 0 at base so attachment point never detaches from parent!
      const pinEnvelope = Math.min(1, f * 3.5) * (1 - cfg.straightness * (1 - f) * 0.7);
      const lCurve = cfg.noiseAmountLut ? Math.max(0, sampleCurveLUT(cfg.noiseAmountLut, f)) : 1;
      // Scale proportional to branch length so gnarliness looks proportional across trunk & twigs
      const amp = lateAmpScale * lCurve * pinEnvelope * Math.min(1.8, 0.12 + fullLength * 0.08);
      if (amp <= 1e-6) continue;

      const freqCoord = f * cfg.noiseFrequency * 1.85;
      const rawNx = cfg.noise.noise3(freqCoord, noisePhase + 3.1, 0.7);
      const rawNy = cfg.noise.noise3(freqCoord, noisePhase + 11.7, 5.3);
      const helixAng = cfg.noiseTwist * f * Math.PI * 4;
      const ch = Math.cos(helixAng);
      const sh = Math.sin(helixAng);
      const dispN = rawNx * ch - rawNy * sh;
      const dispB = rawNx * sh + rawNy * ch;

      const tk: Vec3 = [denseTan[s * 3] as number, denseTan[s * 3 + 1] as number, denseTan[s * 3 + 2] as number];
      const nk: Vec3 = [denseNrm[s * 3] as number, denseNrm[s * 3 + 1] as number, denseNrm[s * 3 + 2] as number];
      const bk = v3Norm(v3Cross(tk, nk));

      densePos[s * 3] = (densePos[s * 3] as number) + nk[0] * dispN * amp + bk[0] * dispB * amp;
      densePos[s * 3 + 1] = (densePos[s * 3 + 1] as number) + nk[1] * dispN * amp + bk[1] * dispB * amp;
      densePos[s * 3 + 2] = (densePos[s * 3 + 2] as number) + nk[2] * dispN * amp + bk[2] * dispB * amp;
    }
  }

  // Pass 3: Adaptive curvature-aware resampling to target segment count
  const targetSegs = Math.max(
    1,
    Math.round((cfg.baseSegments + cfg.relativeSegments * activeLength) * Math.max(0.35, fEnd)),
  );
  const sampleIdx = selectAdaptiveSampleIndices(densePos, actualDenseCount, targetSegs, cfg.optimizationRad);
  const outCount = sampleIdx.length;
  if (outCount < 2) return 0;

  const outPos = new Float32Array(outCount * 3);
  const outRad = new Float32Array(outCount);
  const outAges = new Float32Array(outCount);
  const outTwists = new Float32Array(outCount);

  const effectiveTaperScale =
    willSplit ? 0.35 : cfg.termination === 'blunt' ? 0.35 : isBroken ? 0.65 : 1;

  for (let k = 0; k < outCount; k++) {
    const si = sampleIdx[k] as number;
    const localU = si / (actualDenseCount - 1);
    const f = localU * fEnd;
    outPos[k * 3] = densePos[si * 3] as number;
    outPos[k * 3 + 1] = densePos[si * 3 + 1] as number;
    outPos[k * 3 + 2] = densePos[si * 3 + 2] as number;
    outRad[k] = evaluateSpineRadius(cfg, baseRadius, f, noisePhase, effectiveTaperScale);
    outAges[k] = isBroken ? 1 - f : 1 - localU;
    const twFactor = cfg.twistLut ? sampleCurveLUT(cfg.twistLut, f) : f;
    outTwists[k] = totalTwistRad * twFactor;
  }

  const added = builder.addPolylineBranch({
    parentBranch: spec.parentBranch,
    parentPoint: spec.parentPoint,
    generation: spec.generation,
    count: outCount,
    positions: outPos,
    radii: outRad,
    ages: outAges,
    twists: outTwists,
    initialNormalHint: spec.initialFrame.normal,
  });

  if (added.branchId < 0) return 0;
  let written = 1;

  // Pass 4: Spawn daughter split branches at tip if bifurcated
  if (willSplit) {
    const tipIndex = added.end;
    const tipPos: Vec3 = [
      outPos[(outCount - 1) * 3] as number,
      outPos[(outCount - 1) * 3 + 1] as number,
      outPos[(outCount - 1) * 3 + 2] as number,
    ];
    const prevPos: Vec3 = [
      outPos[(outCount - 2) * 3] as number,
      outPos[(outCount - 2) * 3 + 1] as number,
      outPos[(outCount - 2) * 3 + 2] as number,
    ];
    const tipT = v3Norm([tipPos[0] - prevPos[0], tipPos[1] - prevPos[1], tipPos[2] - prevPos[2]], curT);
    const tipN = orthonormalNormal(tipT, curN);
    const splitRoll = rng.fork('splRoll').range(0, Math.PI * 2);
    const forkPlaneN = orthonormalNormal(tipT, rotateAroundAxis(tipN, tipT, splitRoll));
    const forkAxis = v3Norm(v3Cross(tipT, forkPlaneN));

    const tipRadius = outRad[outCount - 1] as number;
    const bal = cfg.splitBalance;
    // Leonardo da Vinci / pipe-model cross-sectional area conservation: r1^2 + r2^2 = r_tip^2
    const r1 = Math.max(cfg.minRadius, tipRadius * Math.sqrt(bal));
    const r2 = Math.max(cfg.minRadius, tipRadius * Math.sqrt(1 - bal));

    const halfSpread = deg2rad(cfg.splitSpreadDeg);
    const ang1 = halfSpread * (1 - (bal - 0.5) * 0.5);
    const ang2 = -halfSpread * (1 + (bal - 0.5) * 0.5);
    const remLen = Math.max(0.03, fullLength * (1 - fEnd));

    const d1T = v3Norm(rotateAroundAxis(tipT, forkAxis, ang1));
    const d1N = orthonormalNormal(d1T, rotateAroundAxis(forkPlaneN, forkAxis, ang1));
    const d1B = v3Norm(v3Cross(d1T, d1N));

    const d2T = v3Norm(rotateAroundAxis(tipT, forkAxis, ang2));
    const d2N = orthonormalNormal(d2T, rotateAroundAxis(forkPlaneN, forkAxis, ang2));
    const d2B = v3Norm(v3Cross(d2T, d2N));

    written += growSpineIntoBuilder(
      cfg,
      {
        parentBranch: added.branchId,
        parentPoint: tipIndex,
        generation: spec.generation,
        origin: tipPos,
        initialFrame: { tangent: d1T, normal: d1N, binormal: d1B },
        parentTangent: tipT,
        parentU: spec.parentU,
        parentLength: added.length,
        parentRadius: tipRadius,
        hasParent: true,
        isExtension: true,
        lengthOverride: remLen * (0.92 + bal * 0.16),
        baseRadiusOverride: r1,
        splitDepth: splitDepth + 1,
      },
      rng.fork('splitA'),
      builder,
      cancel,
    );

    written += growSpineIntoBuilder(
      cfg,
      {
        parentBranch: added.branchId,
        parentPoint: tipIndex,
        generation: spec.generation,
        origin: tipPos,
        initialFrame: { tangent: d2T, normal: d2N, binormal: d2B },
        parentTangent: tipT,
        parentU: spec.parentU,
        parentLength: added.length,
        parentRadius: tipRadius,
        hasParent: true,
        isExtension: true,
        lengthOverride: remLen * (1.08 - bal * 0.16),
        baseRadiusOverride: r2,
        splitDepth: splitDepth + 1,
      },
      rng.fork('splitB'),
      builder,
      cancel,
    );
  }

  // Silence unused v3Dot warning if not used directly here
  void v3Dot;
  return written;
}
