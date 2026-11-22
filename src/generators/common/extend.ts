export const EXTEND_TYPES = ['none', 'any', 'split-1', 'split-2', 'skinny', 'fat', 'breaks-only', 'bottom'] as const;
export type ExtendType = (typeof EXTEND_TYPES)[number];

/** Node types that may use Extend parent (the parent must be a Branch). */
export const EXTEND_CHILD_TYPES: ReadonlySet<string> = new Set(['generator.branch', 'generator.cap', 'generator.leaf', 'generator.batchedLeaf']);
export const EXTEND_PARENT_TYPE = 'generator.branch';

export const asExtendType = (v: string): ExtendType => ((EXTEND_TYPES as readonly string[]).includes(v) ? (v as ExtendType) : 'none');

/**
 * Split 1 / Split 2 / Skinny / Fat need the split data of the Branch spine and behave like Any for now.
 */
export function resolveExtendType(type: ExtendType): 'none' | 'any' | 'breaks-only' | 'bottom' {
  switch (type) {
    case 'none':
      return 'none';
    case 'breaks-only':
      return 'breaks-only';
    case 'bottom':
      return 'bottom';
    default:
      return 'any';
  }
}

/** Valid only for a Branch parent and a Branch / Cap / Leaf / Batched leaf child. */
export function extendIsValid(childType: string, parentType: string | undefined): boolean {
  return EXTEND_CHILD_TYPES.has(childType) && parentType === EXTEND_PARENT_TYPE;
}

/**
 * Positions (0..1 along the parent) of the extension nodes of one parent branch.
 * Any = the tip; Bottom = the base; Breaks only = the tip, and only for parents that end in a break (`broken`).
 */
export function extensionPositions(type: ExtendType, count: number, broken: boolean): number[] {
  const r = resolveExtendType(type);
  if (r === 'none' || count <= 0) return [];
  if (r === 'breaks-only' && !broken) return [];
  const u = r === 'bottom' ? 0 : 1;
  return Array.from({ length: count }, () => u);
}
