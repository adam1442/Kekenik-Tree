import type { NodeDef, NodeCategory } from '@/contracts/nodes';
import { portsCompatible, type EdgeKind, type PortDef } from '@/contracts/ports';

/** Conventional port ids shared by node definitions (a convention, not a requirement). */
export const PORT = {
  /** Hierarchy input (towards the root). */
  parent: 'parent',
  /** Hierarchy output (towards the leaves). */
  children: 'children',
  forces: 'forces',
  materials: 'materials',
  meshes: 'meshes',
  wind: 'wind',
  /** Output of attachment nodes (Force / Material / Mesh / Wind). */
  out: 'out',
} as const;

export function hierarchyIn(def: NodeDef): PortDef | undefined {
  return def.ports.find((p) => p.edge === 'hierarchy' && p.direction === 'in');
}

export function hierarchyOut(def: NodeDef): PortDef | undefined {
  return def.ports.find((p) => p.edge === 'hierarchy' && p.direction === 'out');
}

/** A node is drawn on the canvas (and takes part in the hierarchy) when it owns a hierarchy port. */
export function isHierarchyDef(def: NodeDef): boolean {
  return def.ports.some((p) => p.edge === 'hierarchy');
}

/** Attachment categories listed in the graph panel footer (order = footer order). */
export const ATTACHMENT_CATEGORIES: NodeCategory[] = ['force', 'material', 'utility', 'mesh', 'wind'];

/**
 * First output port of `src` that can feed an input port of `dst` (definition-level check only: kinds and edge
 * family; capacity/cycles are checked by GraphModel.canConnect once both nodes exist). Optional port id filters.
 */
export function matchPorts(src: NodeDef, dst: NodeDef, edge?: EdgeKind, srcPortId?: string, dstPortId?: string): { out: PortDef; in: PortDef } | null {
  for (const out of src.ports) {
    if (out.direction !== 'out' || (edge && out.edge !== edge) || (srcPortId && out.id !== srcPortId)) continue;
    for (const inp of dst.ports) {
      if (inp.direction !== 'in' || inp.edge !== out.edge || (dstPortId && inp.id !== dstPortId)) continue;
      if (portsCompatible(out.kind, inp.kind)) return { out, in: inp };
    }
  }
  return null;
}
