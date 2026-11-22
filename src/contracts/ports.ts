import type { ForceDef, MaterialDef, TextureRef, WindSettings } from './material';
import type { MeshData } from './mesh';
import type { InstanceTable } from '@/instances/types';
import type { Skeleton } from './skeleton';
import type { AttachmentSet } from './attachment';
import type { LeafLightingSettings } from './lighting';

/**
 * Ports & data kinds.
 *
 * Two edge families exist:
 *  - 'hierarchy'  : parent -> child structure edges (Trunk -> Branch -> Leaf). Drawn as curves with
 *                   instance counts in the graph panel.
 *  - 'attachment' : Force / Material / Mesh / Wind nodes attached to a generator. Not drawn as curves; they
 *                   are listed in the graph panel's bottom bar (Forces, Materials, Meshes ...) and in the
 *                   generator's properties.
 */

export type DataKind = 'Structure' | 'Mesh' | 'Material' | 'Force' | 'Wind' | 'Texture' | 'Scalar';
export type EdgeKind = 'hierarchy' | 'attachment';
export type PortDirection = 'in' | 'out';

export interface PortDef {
  id: string;
  label: string;
  kind: DataKind;
  direction: PortDirection;
  edge: EdgeKind;
  /** Accepts several connections (e.g. a generator collects many forces). */
  multiple?: boolean;
  optional?: boolean;
}

/** Shape of the placement area. Only the circle shape exists. */
export type PlacementShape = 'circle';

/** Ground disc defined by the Tree node; first-generation generators place their instances inside it. */
export interface TreePlacement {
  shape: PlacementShape;
  /** Disc radius in metres. */
  radius: number;
  /** Disc centre offset on the ground plane. */
  centerX: number;
  centerY: number;
  /** Extra depth (m) every child is sunk into the ground. */
  sink: number;
  /** Rotation (degrees) of the whole pattern around the vertical axis. */
  rollDeg: number;
  /** Align all children (same yaw, no splay) instead of randomising their orientation. */
  unify: boolean;
}

/**
 * Ancestor chains of the branches of one skeleton, flat. Branch `i` (index in `skeleton.branches`) owns the chain
 * entries `[offset[i], offset[i + 1])`: base positions (xyz) of its ancestors, highest first, ending with its own base.
 */
export interface Lineage {
  offset: Int32Array;
  points: Float32Array;
}

export interface StructureData {
  skeleton: Skeleton;
  /** Ancestor chains (Leaf anchors: Global / Deep / Intermediate / Local). Absent = unknown, chains start at the parent. */
  lineage?: Lineage;
  /** Present on the Tree node's output: the placement disc for first-generation children. */
  placement?: TreePlacement;
  /** Per-instance table of the generator that produced `skeleton` (Node mode picking / overrides). */
  instances?: InstanceTable;
  /** Attachment frames of the instances in `skeleton`. Absent = no anchors. */
  attachments?: AttachmentSet;
  /** Tree-level (global) leaf lighting; handed down the hierarchy by the generators. */
  lighting?: LeafLightingSettings;
  /** Cumulative Size scalar of this node and its ancestors (children multiply their own value into it). Absent = 1. */
  sizeScalar?: number;
  /** Node type of the generator that produced this structure (e.g. `generator.meshes`). */
  kind?: string;
}

/** Tagged payload travelling along edges during evaluation. */
export type PortValue =
  | { kind: 'Structure'; value: StructureData }
  | { kind: 'Mesh'; value: MeshData }
  | { kind: 'Material'; value: MaterialDef }
  | { kind: 'Force'; value: ForceDef }
  | { kind: 'Wind'; value: WindSettings }
  | { kind: 'Texture'; value: TextureRef }
  | { kind: 'Scalar'; value: number };

/** Can an output of kind `from` be connected to an input of kind `to`? */
export function portsCompatible(from: DataKind, to: DataKind): boolean {
  return from === to;
}
