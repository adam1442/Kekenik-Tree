/**
 * Lineage of a spine instance (consumed by S7: which part of a split tree a branch belongs to).
 * Stored per point in the skeleton attribute {@link SPINE_ORIGIN_ATTR} (one value per branch, copied by `mergeSkeletons`).
 * A missing attribute means every branch is `primary`, so older consumers are unaffected.
 */
export const SPINE_ORIGIN_ATTR = 'spineOrigin';

export const SpineOrigin = {
  /** An ordinary spine grown by a generator (also the spine that splits: it is the parent of its two halves). */
  Primary: 0,
  /** One of the two fused halves of a split (an open end). */
  SplitHalf: 1,
  /** A spine that continues an open end (Extend parent, Cap, the stub and halves of a virtual split). */
  Extension: 2,
} as const;

export type SpineOriginName = 'primary' | 'splitHalf' | 'extension';

const NAMES: readonly SpineOriginName[] = ['primary', 'splitHalf', 'extension'];

/** Name of a stored attribute value (unknown / missing values read as primary). */
export function spineOriginName(value: number | undefined): SpineOriginName {
  const i = Math.round(value ?? 0);
  return NAMES[i] ?? 'primary';
}

/**
 * Whether a spine is a ground base: the start of a spine that no other spine of the structure carries, grown by a generator itself
 * (lineage `primary`). Roots anchor only here: never on the fused halves of a split, never on an extension.
 */
export function isGroundBase(parentBranch: number, origin: SpineOriginName): boolean {
  return parentBranch < 0 && origin === 'primary';
}
