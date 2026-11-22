import type { MaskDef } from '@/contracts/material';
import { evaluateMask, type MaskSample } from '@/materials/masks';

/**
 * Mask gating: a node is kept when every assigned mask evaluates to 0.5 or more at its position. Inclusive / Exclusive
 * behaviour comes from the mask itself (`evaluateMask`). No masks = everything passes.
 */
export function maskGateKeeps(masks: readonly MaskDef[], sample: MaskSample): boolean {
  for (const m of masks) if (evaluateMask(m, sample) < 0.5) return false;
  return true;
}
