import { getNumber, getString, type NodeParams, type ParamDef } from '@/contracts/params';
import { LIGHT_ANCHORS, NEUTRAL_LEAF_LIGHTING, type LeafLightingSettings, type LightAnchor } from '@/contracts/lighting';
import type { FrondLightingExtras } from '@/geometry/leafLighting';
import { section } from '../shared/builders';
import { LIGHTING_STYLE_ID, LIGHTING_TAB } from './leafLightingParams';

/** Id prefix of the Frond's Local lighting group. */
export const FROND_LIGHT_PREFIX = 'frondLight';

const ANCHOR_LABELS = ['Global', 'Deep', 'Intermediate', 'Local', 'None', 'Height', 'Surface X', 'Surface Y', 'Surface Z', 'Origin'];

const id = (name: string): string => `${FROND_LIGHT_PREFIX}${name}`;

/**
 * Frond Lighting tab: Style (Global = the shared lighting of the Tree node, Local = the groups below) plus the Local group:
 * Normals (Smooth, Alignment, Spread), Parent puffiness (Anchor, Amount) and Adjustments (Up, Right, Out).
 */
export function frondLightingParams(): ParamDef[] {
  const style = section(LIGHTING_TAB, 'Style');
  const n = section(LIGHTING_TAB, 'Normals');
  const pp = section(LIGHTING_TAB, 'Parent puffiness');
  const adj = section(LIGHTING_TAB, 'Adjustments');
  const vis = { visibleIf: { param: LIGHTING_STYLE_ID, value: 'local' } } as const;
  const rot = (name: string, label: string, axis: string): ParamDef =>
    adj.float(id(name), label, 0, {
      min: -180,
      max: 180,
      unit: '°',
      variance: 0,
      tooltip: `Rotates the normals (not the geometry) about the frond’s local ${axis} axis. Use the variance to jumble the fronds.`,
      ...vis,
    });
  return [
    style.enumOf(LIGHTING_STYLE_ID, 'Style', 'Global', ['Global', 'Local'], { tooltip: 'Global reads the shared lighting of the Tree node; Local uses the settings below for this generator only.' }),
    n.float(id('Smooth'), 'Smooth', 0, { min: 0, max: 1, tooltip: 'Blends the normals toward smoothed ones (averaged over the neighbouring faces). The other normal edits follow the smoothing.', ...vis }),
    n.float(id('Alignment'), 'Alignment', 0, { min: 0, max: 1, tooltip: 'Turns the normals toward the growth direction of the parent spine (base to tip). 1 = fully aligned.', ...vis }),
    n.float(id('Spread'), 'Spread', 0, { min: 0, max: 1, tooltip: 'Turns the normals away from the parent spine, outward across the frond. 1 = fully spread.', ...vis }),
    pp.enumOf(id('ParentAnchor'), 'Anchor', 'None', ANCHOR_LABELS, {
      tooltip: 'Global / Deep / Intermediate / Local: an ancestor in the hierarchy. Height: the ground below the highest ancestor. Surface X / Y / Z: the axes of the parent spine at the base of the frond. Origin: the model origin.',
      ...vis,
    }),
    pp.float(id('ParentAmount'), 'Amount', 0, { min: 0, max: 1, tooltip: 'Turns the normals to face out from the anchor through each vertex. 1 = fully aligned. Needs an anchor other than None.', ...vis }),
    rot('Up', 'Up', 'X'),
    rot('Right', 'Right', 'Y'),
    rot('Out', 'Out', 'Z'),
  ];
}

export interface FrondLightingResolved {
  settings: LeafLightingSettings;
  extras: FrondLightingExtras;
}

const NO_EXTRAS: FrondLightingExtras = { alignment: 0, spread: 0 };

/**
 * Lighting of a Frond node: its own Local group, or the Tree's global group (`StructureData.lighting`, neutral when absent;
 * Alignment and Spread only exist in Local style).
 */
export function resolveFrondLighting(p: NodeParams, global: LeafLightingSettings | undefined): FrondLightingResolved {
  if (getString(p, LIGHTING_STYLE_ID, 'global') !== 'local') return { settings: { ...(global ?? NEUTRAL_LEAF_LIGHTING) }, extras: NO_EXTRAS };
  const d = NEUTRAL_LEAF_LIGHTING;
  const num = (name: string, fallback: number): number => {
    const v = getNumber(p, id(name), fallback);
    return Number.isFinite(v) ? v : fallback;
  };
  const text = getString(p, id('ParentAnchor'), d.parentAnchor);
  const parentAnchor: LightAnchor = (LIGHT_ANCHORS as readonly string[]).includes(text) ? (text as LightAnchor) : 'none';
  return {
    settings: {
      ...d,
      smooth: num('Smooth', 0),
      parentAmount: num('ParentAmount', 0),
      parentAnchor,
      up: num('Up', 0),
      right: num('Right', 0),
      out: num('Out', 0),
      upVariance: p[id('Up')]?.variance ?? 0,
      rightVariance: p[id('Right')]?.variance ?? 0,
      outVariance: p[id('Out')]?.variance ?? 0,
    },
    extras: { alignment: num('Alignment', 0), spread: num('Spread', 0) },
  };
}
