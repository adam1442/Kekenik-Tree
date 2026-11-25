import type { EndClaim, EndClaimOwner } from '@/contracts/nodes';
import { selectsOpenEnd, type OpenEndSelector } from './splitMath';

/**
 * Sibling claim list (pure): which open ends are already extended by another generator under the same parent?
 *
 * A Cap must never close an end that a Branch generator continues (and two Caps never close the same end twice). The list is
 * derived from the node parameters only (never from the outputs of other nodes), so it is cache-safe: the evaluator adds it to the
 * cache key of the Cap and the result stays deterministic whatever the evaluation order is.
 */

/** Node type of the generators that own an extension. */
export const CLAIM_OWNER_TYPES: Readonly<Record<string, EndClaimOwner>> = { 'generator.branch': 'branch', 'generator.cap': 'cap' };

/** A node as the claim rule sees it (the evaluator builds these from the snapshot). */
export interface ClaimCandidate {
  id: string;
  /** Registry node type. */
  type: string;
  /** Hierarchy parent node id (null = none). */
  parentId: string | null;
  /** Enabled and not bypassed. */
  live: boolean;
  /** The node's own `active` switch. */
  active: boolean;
  /** Its Extend parent type (`none` when it extends nothing). */
  extendType: string;
}

/**
 * Claims that apply to node `nodeId`: the Extend parent types of its live siblings (same hierarchy parent) that extend open ends.
 * Branch siblings always claim; a Cap sibling claims only when it comes BEFORE `nodeId` in `candidates` (the first Cap wins).
 * Only Caps receive claims: any other node gets an empty list.
 */
export function collectEndClaims(candidates: readonly ClaimCandidate[], nodeId: string): EndClaim[] {
  const selfIndex = candidates.findIndex((c) => c.id === nodeId);
  const self = candidates[selfIndex];
  if (!self || CLAIM_OWNER_TYPES[self.type] !== 'cap' || self.parentId === null) return [];
  const out: EndClaim[] = [];
  candidates.forEach((c, i) => {
    const owner = CLAIM_OWNER_TYPES[c.type];
    if (!owner || c.id === nodeId || c.parentId !== self.parentId || !c.live || !c.active || c.extendType === 'none') return;
    if (owner === 'cap' && i > selfIndex) return;
    out.push({ owner, type: c.extendType });
  });
  return out;
}

/** The end as the claim rule needs it: the flags written by Break / Splits and whether it is a break. */
export interface ClaimableEnd {
  flags: number;
  broken: boolean;
}

/**
 * Whether `end` is already extended by a claim, so a node with Extend parent `type` must skip it. A claim of exactly the same
 * explicit type never blocks (Any is not explicit: a Cap on Any yields to every other generator). Bottom works on the base of
 * the parent, not on its open ends, so it neither blocks nor is blocked.
 */
export function isEndClaimed(claims: readonly EndClaim[], type: string, end: ClaimableEnd): boolean {
  if (type === 'bottom') return false;
  for (const c of claims) {
    if (c.type === 'bottom' || (type !== 'any' && c.type === type)) continue;
    if (selectsOpenEnd(c.type as OpenEndSelector, end.flags, end.broken)) return true;
  }
  return false;
}
