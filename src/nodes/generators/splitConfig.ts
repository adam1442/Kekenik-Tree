import { curveToLUT } from '@/contracts/curve';
import { getNumber, getString, type NodeParams } from '@/contracts/params';
import { clamp } from '@/core/math';
import type { SplitSettings, SplitVariance } from '@/generators/split';
import { resolveUTiles } from '@/generators/uv';
import { readUvMapping } from './uvConfig';

/** Skin > Splits as read from the node parameters. `chance` 0 = the branch never splits. */
export interface SplitConfig {
  readonly chance: number;
  readonly seed: number;
  readonly settings: SplitSettings;
  /** The "±" variance of Chance, Balance, Spread, Expand and Smooth (each draws from its own forked stream). */
  readonly variance: SplitVariance;
  /** U tiles the branch gets around a tube of this radius (the same rule as the mesher, world scale 1 m per tile). */
  tilesAt(radius: number): number;
}

/** Branch > Extensions (Spine / Skin groups): how the extensions made by this node's Extend parent are shaped. */
export interface ExtensionConfig {
  readonly lengthScale: number;
  readonly spreadDeg: number;
  /** Profile of the spread along the extension (null = constant). */
  readonly spreadLut: Float32Array | null;
  /** How much of the radius profile is used (0..1) and the profile along the extension. */
  readonly radiusValue: number;
  readonly radiusLut: Float32Array | null;
  readonly normalSmooth: number;
  readonly displaceScale: number;
}

const varianceOf = (params: NodeParams, id: string): number => clamp(params[id]?.variance ?? 0, 0, 1);

export function readSplitConfig(params: NodeParams): SplitConfig {
  const uv = readUvMapping(params);
  return {
    tilesAt: (radius: number): number =>
      resolveUTiles({
        style: uv.style,
        absolute: uv.uAbsolute,
        relative: uv.uRelative,
        fractional: uv.fractional,
        circumference: 2 * Math.PI * radius,
        metresPerTile: 1,
      }),
    chance: clamp(getNumber(params, 'splitsChance', 0), 0, 1),
    seed: Math.round(getNumber(params, 'splitsSeed', 0)),
    variance: {
      chance: varianceOf(params, 'splitsChance'),
      balance: varianceOf(params, 'splitsBalance'),
      spread1: varianceOf(params, 'splitsSpread1'),
      spread2: varianceOf(params, 'splitsSpread2'),
      expand1: varianceOf(params, 'splitsExpand1'),
      expand2: varianceOf(params, 'splitsExpand2'),
      smoothInner: varianceOf(params, 'splitsSmoothInner'),
      smoothOuter: varianceOf(params, 'splitsSmoothOuter'),
      dominance: varianceOf(params, 'splitsDominance'),
      lateralChance: varianceOf(params, 'splitsLateralChance'),
      includedBark: varianceOf(params, 'splitsIncludedBark'),
    },
    settings: {
      balance: clamp(getNumber(params, 'splitsBalance', 0.5), 0, 1),
      spread1Deg: clamp(getNumber(params, 'splitsSpread1', 22), 0, 80),
      spread2Deg: clamp(getNumber(params, 'splitsSpread2', 22), 0, 80),
      expand1: clamp(getNumber(params, 'splitsExpand1', 1), 0.5, 2),
      expand2: clamp(getNumber(params, 'splitsExpand2', 1), 0.5, 2),
      smoothInner: clamp(getNumber(params, 'splitsSmoothInner', 0.25), 0, 1),
      smoothOuter: clamp(getNumber(params, 'splitsSmoothOuter', 0.5), 0, 1),
      areaExponent: clamp(getNumber(params, 'splitsAreaExponent', 2), 1.5, 3),
      downBias: clamp(getNumber(params, 'splitsDownBias', 0), 0, 1),
      waist: clamp(getNumber(params, 'splitsWaist', 1), 0.2, 1),
      neckSwell: clamp(getNumber(params, 'splitsNeckSwell', 0), 0, 0.5),
      valleyRadius: clamp(getNumber(params, 'splitsValleyRadius', 0), 0, 1),
      ridge: clamp(getNumber(params, 'splitsRidge', 0), 0, 1),
      ridgeLength: clamp(getNumber(params, 'splitsRidgeLength', 2), 0.25, 8),
      stretch: clamp(getNumber(params, 'splitsStretch', 1), 0.8, 1.6),
      ease: clamp(getNumber(params, 'splitsEase', 0), 0, 1),
      dominance: clamp(getNumber(params, 'splitsDominance', 0), 0, 1),
      mode: getString(params, 'splitsMode', 'y') === 'lateral' ? 'lateral' : 'y',
      lateralChance: clamp(getNumber(params, 'splitsLateralChance', 0), 0, 1),
      includedBark: clamp(getNumber(params, 'splitsIncludedBark', 0), 0, 1),
    },
  };
}

export function readExtensionConfig(params: NodeParams): ExtensionConfig {
  const spreadCurve = params.extensionSpread?.curve;
  const radiusCurve = params.extensionRadius?.curve;
  return {
    lengthScale: clamp(getNumber(params, 'extensionLengthScale', 1), 0.1, 3),
    spreadDeg: clamp(getNumber(params, 'extensionSpread', 0), 0, 90),
    spreadLut: spreadCurve ? curveToLUT(spreadCurve, 128) : null,
    radiusValue: clamp(getNumber(params, 'extensionRadius', 0), 0, 1),
    radiusLut: radiusCurve ? curveToLUT(radiusCurve, 128) : null,
    normalSmooth: clamp(getNumber(params, 'extensionNormalSmooth', 0.5), 0, 1),
    displaceScale: clamp(getNumber(params, 'extensionDisplaceScale', 1), 0, 2),
  };
}
