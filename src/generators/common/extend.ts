import { selectsOpenEnd } from '@/generators/split';

export const EXTEND_TYPES = ['none', 'any', 'split-1', 'split-2', 'skinny', 'fat', 'breaks-only', 'bottom'] as const;
export type ExtendType = (typeof EXTEND_TYPES)[number];

/** Node types that may use Extend parent (the parent must be a Branch or the Trunk). */
export const EXTEND_CHILD_TYPES: ReadonlySet<string> = new Set(['generator.branch', 'generator.cap', 'generator.leaf', 'generator.batchedLeaf']);
/** Parent node types whose open ends can be extended: the Trunk is the first branch of the tree (trunk -> boughs -> twig tips). */
export const EXTEND_PARENT_TYPES: ReadonlySet<string> = new Set(['generator.branch', 'generator.trunk']);

export const asExtendType = (v: string): ExtendType => ((EXTEND_TYPES as readonly string[]).includes(v) ? (v as ExtendType) : 'none');

/** `slotIndex` of the first extension placement of a parent (ordinary nodes use their mode slot index). */
export const EXTENSION_SLOT_BASE = 100_000;

/** Valid only for a Branch / Trunk parent and a Branch / Cap / Leaf / Batched leaf child. */
export function extendIsValid(childType: string, parentType: string | undefined): boolean {
  return EXTEND_CHILD_TYPES.has(childType) && parentType !== undefined && EXTEND_PARENT_TYPES.has(parentType);
}

/**
 * Positions (0..1 along the parent) of the extension nodes of one parent branch.
 * Bottom = the base of any parent. The other types continue the open end at the tip: Any = every open end (a branch that splits
 * has none itself, its two sides do), Split 1 / Split 2 = that side of a split, Skinny / Fat = the thinner / thicker side,
 * Breaks only = a branch that ended in a break. `splitFlags` is the parent's `splitInfo` (see `generators/split`).
 */
export function extensionPositions(type: ExtendType, count: number, broken: boolean, splitFlags = 0): number[] {
  if (type === 'none' || count <= 0) return [];
  if (type === 'bottom') return Array.from({ length: count }, () => 0);
  if (!selectsOpenEnd(type, splitFlags, broken)) return [];
  return Array.from({ length: count }, () => 1);
}
