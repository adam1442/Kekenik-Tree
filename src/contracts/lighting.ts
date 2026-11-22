/** Shape of the normal-editing settings shared by the Leaf "Lighting" tab and the Tree-level global lighting group. */

/** Anchor the "Parent puffiness" normals radiate from (or the parent axis they align with for the Surface choices). */
export type LightAnchor = 'global' | 'deep' | 'intermediate' | 'local' | 'none' | 'height' | 'surface-x' | 'surface-y' | 'surface-z' | 'origin';

export const LIGHT_ANCHORS: readonly LightAnchor[] = ['global', 'deep', 'intermediate', 'local', 'none', 'height', 'surface-x', 'surface-y', 'surface-z', 'origin'];

export interface LeafLightingSettings {
  /** 0..1 blend between the original and the face-averaged normals. */
  smooth: number;
  /** 0..1 blend towards "out from the anchor" (1 = fully aligned). */
  parentAmount: number;
  parentAnchor: LightAnchor;
  /** 0..1 position of the anchor inside its shift range. */
  anchorPosition: number;
  /** Range (metres) of the anchor shift; the position has no effect while this is 0. */
  anchorAmount: number;
  /** 0..1 spherize around the centre of each leaf. */
  puffiness: number;
  /** 0..1 blend of all normals of a leaf towards their average. */
  unify: number;
  /** Degrees about the leaf's local X / Y / Z (normals only). */
  up: number;
  right: number;
  out: number;
  /** "±" variance of Up / Right / Out (fraction). */
  upVariance: number;
  rightVariance: number;
  outVariance: number;
  /** 0..1 blend towards world up, overrides puffiness and adjustments. */
  worldUp: number;
}

export const NEUTRAL_LEAF_LIGHTING: Readonly<LeafLightingSettings> = {
  smooth: 0,
  parentAmount: 0,
  parentAnchor: 'none',
  anchorPosition: 0,
  anchorAmount: 0,
  puffiness: 0,
  unify: 0,
  up: 0,
  right: 0,
  out: 0,
  upVariance: 0,
  rightVariance: 0,
  outVariance: 0,
  worldUp: 0,
};
