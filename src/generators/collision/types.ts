import type { CollisionAction, CollisionParentRule, CollisionTestAgainst } from '@/contracts/mesh';
import type { V3 } from '@/geometry/math3';

/** Leaf collision removal quality (Tree > Collision). */
export const COLLISION_LEVELS = ['none', 'low', 'medium', 'high'] as const;
export type CollisionLevel = (typeof COLLISION_LEVELS)[number];

export const asCollisionLevel = (v: string): CollisionLevel => ((COLLISION_LEVELS as readonly string[]).includes(v) ? (v as CollisionLevel) : 'none');

/** Triangles of one leaf: a window into shared buffers (nothing is copied). */
export interface LeafShape {
  positions: Float32Array;
  indices: Uint32Array;
  /** Indices are absolute vertex numbers; the vertex window is only used for bounds. */
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  /** Optional vertex normals (used to pick the side a leaf moves to). */
  normals?: Float32Array;
}

/** One leaf taking part in the pass. */
export interface Collider {
  /** Unique, stable id: breaks priority ties (the lower id wins). */
  id: number;
  /** Generator group (leaves of one node share it): used by Test against. */
  generator: number;
  priority: number;
  /** Scales the test sphere (0.1 .. 2). */
  threshold: number;
  action: CollisionAction;
  testAgainst: CollisionTestAgainst;
  parentRule: CollisionParentRule;
  /** Leaves with the same key share a parent twig (-1 = none). */
  parentKey: number;
  /** Shrink pivot. */
  origin: V3;
  shape: LeafShape;
}

/** Skeleton capsule: a tapered cylinder segment of a branch. */
export interface Capsule {
  a: V3;
  b: V3;
  ra: number;
  rb: number;
  /** Branch the segment belongs to (host test). */
  branch: number;
}

/** Triangle soup of the branch meshes (High: exact leaf - branch triangles). */
export interface TriangleSoup {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Optional alpha test for cutout / cluster cards: is the card opaque at this world point? */
export type AlphaTest = (leaf: Collider, point: V3) => boolean;

export interface CollisionSettings {
  level: CollisionLevel;
  /** Use spherical tests on leaves instead of boxes / triangles (faster, keeps more leaves). */
  spherical: boolean;
  /** Test only in the top-down XY plane. */
  plane: boolean;
}

export interface CollisionInput {
  colliders: readonly Collider[];
  capsules?: readonly Capsule[];
  branchTriangles?: readonly TriangleSoup[];
  settings: CollisionSettings;
  alpha?: AlphaTest;
}

export interface CollisionHooks {
  /** Called regularly; may throw to cancel and may return a promise to yield to the event loop. */
  checkpoint?: () => void | Promise<void>;
}

export const LEAF_KEPT = 0;
export const LEAF_REMOVED = 1;
export const LEAF_SHRUNK = 2;
export const LEAF_MOVED = 3;

export interface CollisionStats {
  removed: number;
  shrunk: number;
  moved: number;
  /** Parent twigs whose leaves were all removed (Parent = Remove). */
  orphanedParents: number;
  tests: number;
}

export interface CollisionOutcome {
  /** LEAF_* per collider (same order as the input). */
  state: Uint8Array;
  /** Uniform shrink factor per collider (1 = unchanged). */
  scale: Float32Array;
  /** xyz offset per collider (zero unless moved). */
  offset: Float32Array;
  /** Sorted parent keys that lost every leaf (only groups that asked to remove the parent). */
  orphanedParents: number[];
  stats: CollisionStats;
}
