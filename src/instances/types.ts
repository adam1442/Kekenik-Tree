/**
 * Per-instance editing (Node mode). An *instance* is one spawn of a generator: a trunk, a branch (together with the
 * split daughters it produced) or a spine. Instances have stable keys so overrides survive re-evaluation.
 */

/** Uint32 hash of (generator node id, parent instance key, index in parent, sub-seed). */
export type InstanceKey = number;

export type OverrideMode = 'set' | 'offset' | 'scale';

export type OverrideScalar = number | boolean | string;

/** One overridden ParamDef value of an instance. `offset` / `scale` apply to numeric params only. */
export interface OverrideParam {
  mode: OverrideMode;
  value: OverrideScalar;
}

/** Placement transform applied to the procedural spawn (all offsets, neutral = 0 / 1). */
export interface InstanceTransform {
  /** Offset of the normalised position along the parent spine (-1..1, result is clamped to 0..1). */
  positionAlongParent?: number;
  /** Offset (degrees) of the rotation around the parent axis. */
  rotation?: number;
  /** Offset (degrees) of the roll around the instance's own axis. */
  roll?: number;
  /** Multiplier of the procedural length. */
  lengthScale?: number;
  /** Multiplier of the procedural base radius. */
  radiusScale?: number;
}

export type TransformField = keyof InstanceTransform;

export interface InstanceOverride {
  key: InstanceKey;
  /** Where the instance was when the override was made; used to re-anchor / report orphans. */
  anchor?: { parentKey: InstanceKey; index: number };
  params: Record<string, OverrideParam>;
  transform?: InstanceTransform;
  /** Not drawn / not meshed, but still grown (children follow). */
  hidden?: boolean;
  /** Not grown at all (children disappear with it). */
  pruned?: boolean;
}

/**
 * Compact per-instance table of one generator evaluation (struct of arrays). Instance `i` owns the skeleton branches
 * `[branchStart[i], branchStart[i] + branchCount[i])` and points `[pointStart[i], pointStart[i] + pointCount[i])`.
 * `bounds` (min xyz, max xyz) is filled once forces have been applied. Mesh triangle ranges are not tracked: the tube
 * mesher merges all branches into one buffer, picking refines against the skeleton capsules instead.
 */
export interface InstanceTable {
  nodeId: string;
  count: number;
  key: Uint32Array;
  parentKey: Uint32Array;
  /** Index of the instance among the children of its parent (the placement slot). */
  index: Int32Array;
  /** Row in the PARENT node's table, -1 when the parent has no table. */
  parentInstance: Int32Array;
  /** Branch id in the parent's skeleton, -1 for first generation. */
  parentBranch: Int32Array;
  branchStart: Int32Array;
  branchCount: Int32Array;
  pointStart: Int32Array;
  pointCount: Int32Array;
  /** Procedural position along the parent (before overrides), 0..1. */
  baseU: Float32Array;
  /** Bit 0 = hidden. */
  flags: Uint8Array;
  bounds: Float32Array;
  /** Skeleton branch -> instance row (-1 when unknown). */
  branchToInstance: Int32Array;
  /** Keys of instances an override pruned (they have no row; listed so the override is not reported as orphan). */
  pruned: Uint32Array;
}

export const FLAG_HIDDEN = 1;

/** Reference to one instance of one generator node. */
export interface InstanceRef {
  nodeId: string;
  key: InstanceKey;
}

export function sameInstance(a: InstanceRef, b: InstanceRef): boolean {
  return a.nodeId === b.nodeId && a.key === b.key;
}
