/** Skin > Type & Visibility (pure). */
import { evaluateCurve, type Curve } from '@/contracts/curve';
import { getBool, getString, type NodeParams } from '@/contracts/params';

export const SKIN_TYPE_POLYGONS = 'polygons';
export const SKIN_TYPE_SPINE_ONLY = 'spine-only';

/** A branch has geometry when its Visibility value is above this. */
export const VISIBILITY_THRESHOLD = 0.5;

export const isBranchVisible = (value: number): boolean => value > VISIBILITY_THRESHOLD;

/** Visibility of a branch from its curve at the 0..1 position of the attachment on the parent (no curve = visible). */
export function branchVisibility(curve: Curve | undefined, u: number): boolean {
  return curve ? isBranchVisible(evaluateCurve(curve, Math.min(1, Math.max(0, u)))) : true;
}

/** Skin > Type is Spine only (the legacy `spineOnly` switch of older projects still counts). */
export function isSpineOnly(params: NodeParams): boolean {
  return getString(params, 'skinType', SKIN_TYPE_POLYGONS) === SKIN_TYPE_SPINE_ONLY || getBool(params, 'spineOnly', false);
}

/** Skeleton attribute (1 = the branch grows on a branch of the same node: Generations > 1). */
export const SUB_LEVEL_ATTR = 'subLevel';
