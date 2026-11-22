import { curveToLUT } from '@/contracts/curve';
import { getNumber, type NodeParams } from '@/contracts/params';
import { clamp } from '@/core/math';
import type { SplitSettings } from '@/generators/split';

/** Skin > Splits as read from the node parameters. `chance` 0 = the branch never splits. */
export interface SplitConfig {
  readonly chance: number;
  readonly seed: number;
  readonly settings: SplitSettings;
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

export function readSplitConfig(params: NodeParams): SplitConfig {
  return {
    chance: clamp(getNumber(params, 'splitsChance', 0), 0, 1),
    seed: Math.round(getNumber(params, 'splitsSeed', 0)),
    settings: {
      balance: clamp(getNumber(params, 'splitsBalance', 0.5), 0, 1),
      spread1Deg: clamp(getNumber(params, 'splitsSpread1', 25), 0, 85),
      spread2Deg: clamp(getNumber(params, 'splitsSpread2', 25), 0, 85),
      expand1: clamp(getNumber(params, 'splitsExpand1', 1), 0.05, 4),
      expand2: clamp(getNumber(params, 'splitsExpand2', 1), 0.05, 4),
      smoothInner: clamp(getNumber(params, 'splitsSmoothInner', 0.25), 0, 1),
      smoothOuter: clamp(getNumber(params, 'splitsSmoothOuter', 0.5), 0, 1),
    },
  };
}

export function readExtensionConfig(params: NodeParams): ExtensionConfig {
  const spreadCurve = params.extensionSpread?.curve;
  const radiusCurve = params.extensionRadius?.curve;
  return {
    lengthScale: clamp(getNumber(params, 'extensionLengthScale', 1), 0.05, 8),
    spreadDeg: clamp(getNumber(params, 'extensionSpread', 15), 0, 90),
    spreadLut: spreadCurve ? curveToLUT(spreadCurve, 128) : null,
    radiusValue: clamp(getNumber(params, 'extensionRadius', 1), 0, 1),
    radiusLut: radiusCurve ? curveToLUT(radiusCurve, 128) : null,
    normalSmooth: clamp(getNumber(params, 'extensionNormalSmooth', 0.5), 0, 1),
    displaceScale: clamp(getNumber(params, 'extensionDisplaceScale', 1), 0, 8),
  };
}
