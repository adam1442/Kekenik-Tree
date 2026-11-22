import type { V3 } from '@/geometry/math3';
import { cross, norm } from '@/geometry/math3';

export const MESH_ALIGNMENTS = ['none', 'tangent', 'binormal', 'parent-x', 'parent-y', 'parent-z', 'world-x', 'world-y', 'world-z'] as const;
export type MeshAlignment = (typeof MESH_ALIGNMENTS)[number];

export const asMeshAlignment = (v: string): MeshAlignment => ((MESH_ALIGNMENTS as readonly string[]).includes(v) ? (v as MeshAlignment) : 'none');

/** Parent frame at the attachment point: tangent, normal and binormal of the parent mesh. */
export interface MeshFrame {
  tangent: V3;
  normal: V3;
  binormal: V3;
}

/**
 * Direction the growth axis of a leaf must take for a mesh alignment, or null for None.
 * Parent X / Y / Z are the axes of the parent frame (tangent = Y, normal = X, binormal = Z); World X / Y / Z are fixed.
 */
export function meshAlignmentAxis(mode: MeshAlignment, f: MeshFrame): V3 | null {
  switch (mode) {
    case 'none':
      return null;
    case 'tangent':
      return norm(f.tangent);
    case 'binormal':
      return norm(f.binormal);
    case 'parent-x':
      return norm(f.normal);
    case 'parent-y':
      return norm(f.tangent);
    case 'parent-z':
      return norm(cross(f.normal, f.tangent), f.binormal);
    case 'world-x':
      return [1, 0, 0];
    case 'world-y':
      return [0, 1, 0];
    case 'world-z':
      return [0, 0, 1];
  }
}

/** Alignment only applies to leaves whose parent is a mesh (Mesh Instance node). */
export const MESH_PARENT_TYPES: ReadonlySet<string> = new Set(['generator.meshes']);
