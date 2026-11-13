import type { PortDef } from '@/contracts/ports';
import { PORT } from '@/graph/ports';

export const parentIn: PortDef = { id: PORT.parent, label: 'Parent', kind: 'Structure', direction: 'in', edge: 'hierarchy' };
export const childrenOut: PortDef = { id: PORT.children, label: 'Children', kind: 'Structure', direction: 'out', edge: 'hierarchy', multiple: true };

const attach = (id: string, label: string, kind: PortDef['kind']): PortDef => ({ id, label, kind, direction: 'in', edge: 'attachment', multiple: true, optional: true });
export const forcesIn = attach(PORT.forces, 'Forces', 'Force');
export const materialsIn = attach(PORT.materials, 'Materials', 'Material');
export const meshesIn = attach(PORT.meshes, 'Meshes', 'Mesh');
export const windIn = attach(PORT.wind, 'Wind', 'Wind');
export const attachIns: PortDef[] = [forcesIn, materialsIn, meshesIn, windIn];

/** Output of an attachment node (Force / Material / Mesh / Wind / utility). */
export const attachOut = (kind: PortDef['kind']): PortDef => ({ id: PORT.out, label: kind, kind, direction: 'out', edge: 'attachment', multiple: true });
