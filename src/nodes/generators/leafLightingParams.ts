import { getNumber, getString, type NodeParams, type ParamDef } from '@/contracts/params';
import { LIGHT_ANCHORS, NEUTRAL_LEAF_LIGHTING, type LeafLightingSettings, type LightAnchor } from '@/contracts/lighting';
import { section } from '../shared/builders';

export const LIGHTING_TAB = 'Lighting';
/** Param id of the per-generator Style (Global / Local). */
export const LIGHTING_STYLE_ID = 'lightingStyle';
/** Id prefix of the Local group (Leaf) and of the shared tree-level group (Tree node). */
export const LOCAL_PREFIX = 'light';
export const GLOBAL_PREFIX = 'globalLight';

const ANCHOR_LABELS = ['Global', 'Deep', 'Intermediate', 'Local', 'None', 'Height', 'Surface X', 'Surface Y', 'Surface Z'];

const idOf = (prefix: string, name: string): string => `${prefix}${name}`;

export interface LightingParamOptions {
  /** Batched leaf: no Unify and no World up. */
  batched?: boolean;
}

/** The normal-editing parameters (same ids/ranges for the Leaf's Local group and the Tree's global group). */
function lightingGroup(prefix: string, opts: LightingParamOptions, visibleIf?: ParamDef['visibleIf']): ParamDef[] {
  const n = section(LIGHTING_TAB, 'Normals');
  const pp = section(LIGHTING_TAB, 'Parent puffiness');
  const as = section(LIGHTING_TAB, 'Anchor shift');
  const adj = section(LIGHTING_TAB, 'Adjustments');
  const vis = visibleIf ? { visibleIf } : {};
  const defs: ParamDef[] = [
    n.float(idOf(prefix, 'Smooth'), 'Smooth', 0, { min: 0, max: 1, tooltip: 'Blends the original normals towards smoothed ones (averaged over the neighbouring faces) after the leaf is deformed. The other normal edits follow the smoothing.', ...vis }),
    pp.float(idOf(prefix, 'ParentAmount'), 'Amount', 0, { min: 0, max: 1, tooltip: 'Turns the normals to face out from the anchor through each vertex. 1 = fully aligned. Needs an anchor other than None.', ...vis }),
    pp.enumOf(idOf(prefix, 'ParentAnchor'), 'Anchor', 'None', ANCHOR_LABELS, {
      tooltip: 'Global / Deep / Intermediate / Local: an ancestor in the hierarchy. Height: the ground below the highest ancestor. Surface X / Y / Z: align with the parent’s X / Y / Z axis at the attachment.',
      ...vis,
    }),
    as.float(idOf(prefix, 'AnchorPosition'), 'Position', 0, { min: 0, max: 1, tooltip: 'Where the anchor sits inside its shift range (straight up). Has no effect while Amount is 0.', ...vis }),
    as.float(idOf(prefix, 'AnchorAmount'), 'Amount', 0, { min: 0, max: 100, softMax: 10, unit: 'm', tooltip: 'Length of the range the anchor can be moved up by Position.', ...vis }),
    n.float(idOf(prefix, 'Puffiness'), 'Puffiness', 0, { min: 0, max: 1, tooltip: 'Spherizes the normals around the centre of each leaf. Applied after all other normal edits.', ...vis }),
  ];
  if (!opts.batched) defs.push(n.float(idOf(prefix, 'Unify'), 'Unify', 0, { min: 0, max: 1, tooltip: 'Blends every normal of a leaf towards the average normal direction.', ...vis }));
  const rot = (name: string, label: string, axis: string): ParamDef =>
    adj.float(idOf(prefix, name), label, 0, {
      min: -180,
      max: 180,
      unit: '°',
      variance: 0,
      tooltip: `Rotates the normals (not the geometry) about the leaf’s local ${axis} axis. Use the variance to jumble clusters.`,
      ...vis,
    });
  defs.push(rot('Up', 'Up', 'X'), rot('Right', 'Right', 'Y'), rot('Out', 'Out', 'Z'));
  if (!opts.batched) defs.push(n.float(idOf(prefix, 'WorldUp'), 'World up', 0, { min: 0, max: 1, tooltip: 'Forces the normals upwards (even grass-like lighting). Overrides puffiness and the adjustments.', ...vis }));
  return defs;
}

/** Leaf / Batched leaf Lighting tab: Style + the Local group (shown for Local). */
export function leafLightingParams(opts: LightingParamOptions = {}): ParamDef[] {
  const style = section(LIGHTING_TAB, 'Style');
  return [
    style.enumOf(LIGHTING_STYLE_ID, 'Style', 'Global', ['Global', 'Local'], { tooltip: 'Global reads the shared leaf lighting of the Tree node; Local uses the settings below for this generator only.' }),
    ...lightingGroup(LOCAL_PREFIX, opts, { param: LIGHTING_STYLE_ID, value: 'local' }),
  ];
}

/** Tree node Lighting tab: the shared leaf lighting group read by every leaf generator in Global style. */
export function treeLightingParams(): ParamDef[] {
  return lightingGroup(GLOBAL_PREFIX, {});
}

/** Settings stored under `prefix` (neutral where a parameter is missing). */
export function readLeafLighting(p: NodeParams, prefix: string): LeafLightingSettings {
  const d = NEUTRAL_LEAF_LIGHTING;
  const num = (name: string, fallback: number): number => {
    const v = getNumber(p, idOf(prefix, name), fallback);
    return Number.isFinite(v) ? v : fallback;
  };
  const anchorText = getString(p, idOf(prefix, 'ParentAnchor'), d.parentAnchor);
  const parentAnchor: LightAnchor = (LIGHT_ANCHORS as readonly string[]).includes(anchorText) ? (anchorText as LightAnchor) : 'none';
  return {
    smooth: num('Smooth', d.smooth),
    parentAmount: num('ParentAmount', d.parentAmount),
    parentAnchor,
    anchorPosition: num('AnchorPosition', d.anchorPosition),
    anchorAmount: num('AnchorAmount', d.anchorAmount),
    puffiness: num('Puffiness', d.puffiness),
    unify: num('Unify', d.unify),
    up: num('Up', d.up),
    right: num('Right', d.right),
    out: num('Out', d.out),
    upVariance: p[idOf(prefix, 'Up')]?.variance ?? 0,
    rightVariance: p[idOf(prefix, 'Right')]?.variance ?? 0,
    outVariance: p[idOf(prefix, 'Out')]?.variance ?? 0,
    worldUp: num('WorldUp', d.worldUp),
  };
}

/**
 * Settings a leaf generator lights its leaves with: its own Local group, or the Tree's global group (handed down in
 * `StructureData.lighting`; neutral when absent). Batched leaves have no Unify / World up.
 */
export function resolveLeafLighting(p: NodeParams, global: LeafLightingSettings | undefined, batched = false): LeafLightingSettings {
  const local = getString(p, LIGHTING_STYLE_ID, 'global') === 'local';
  const s = local ? readLeafLighting(p, LOCAL_PREFIX) : { ...(global ?? NEUTRAL_LEAF_LIGHTING) };
  return batched ? { ...s, unify: 0, worldUp: 0 } : s;
}
