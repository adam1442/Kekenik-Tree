import type { ForceDef, MaterialDef, TextureRef, WindSettings } from './material';
import type { MeshData } from './mesh';
import type { InstanceTable } from '@/instances/types';
import type { Skeleton } from './skeleton';
import type { AttachmentSet } from './attachment';

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

export interface StructureData {
  skeleton: Skeleton;
  /** Present on the Tree node's output: the placement disc for first-generation children. */
  placement?: TreePlacement;
  /** Per-instance table of the generator that produced `skeleton` (Node mode picking / overrides). */
  instances?: InstanceTable;
  /** Attachment frames of the instances in `skeleton`. Absent = no anchors. */
  attachments?: AttachmentSet;
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
