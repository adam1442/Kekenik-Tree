/**
 * Attachment frames. Every placed cutout instance exports the frames of its Anchors so that child
 * generators (Leaf, Mesh, Decoration, ...) can be planted exactly on them.
 *
 * Frame convention (all world space, Z-up, metres): `direction` = +Y of the frame (growth axis), `up` = +Z
 * (card normal), +X = direction x up.
 */

/** One attachment frame, unpacked from the typed arrays of an `AttachmentSet`. */
export interface AttachmentFrame {
  position: [number, number, number];
  direction: [number, number, number];
  up: [number, number, number];
  scale: number;
  /** Anchor id as authored in Edit Mesh ('' for the instance base frame). */
  anchorId: string;
  /** Index of the anchor in axis order (-1 for the instance base frame). */
  anchorIndex: number;
  /** Position of the anchor along the cutout axis, 0 (base) .. 1 (tip). */
  axisT: number;
  /** Tags authored on the anchor. */
  tags: readonly string[];
}

/**
 * Struct-of-arrays attachment data of one generator evaluation. Instance `i` owns frames
 * `[frameStart[i], frameStart[i] + frameCount[i])`.
 */
export interface AttachmentSet {
  nodeId: string;
  instanceCount: number;
  /** Stable `InstanceKey` of every instance. */
  instanceKey: Uint32Array;
  /** Skeleton branch id (in the Structure that carries this set) that represents the instance. */
  instanceBranch: Int32Array;
  /** Column-major 4x4 rigid transform of the instance base frame (origin = axis base, +Y = growth, +Z = normal). */
  instanceTransform: Float32Array;
  instanceScale: Float32Array;
  frameStart: Int32Array;
  frameCount: Int32Array;
  position: Float32Array;
  direction: Float32Array;
  up: Float32Array;
  scale: Float32Array;
  /** FNV hash of the anchor id (compare with `hashParts(id)`); `anchorIds` holds the readable strings. */
  anchorHash: Uint32Array;
  anchorIndex: Int32Array;
  axisT: Float32Array;
  /** Readable anchor ids, parallel to the frame arrays. */
  anchorIds: string[];
  /** Tags per frame (usually empty arrays). */
  tags: (readonly string[])[];
}

export function emptyAttachmentSet(nodeId = ''): AttachmentSet {
  return {
    nodeId,
    instanceCount: 0,
    instanceKey: new Uint32Array(0),
    instanceBranch: new Int32Array(0),
    instanceTransform: new Float32Array(0),
    instanceScale: new Float32Array(0),
    frameStart: new Int32Array(0),
    frameCount: new Int32Array(0),
    position: new Float32Array(0),
    direction: new Float32Array(0),
    up: new Float32Array(0),
    scale: new Float32Array(0),
    anchorHash: new Uint32Array(0),
    anchorIndex: new Int32Array(0),
    axisT: new Float32Array(0),
    anchorIds: [],
    tags: [],
  };
}
