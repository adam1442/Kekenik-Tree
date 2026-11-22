import { getNumber, type NodeParams } from '@/contracts/params';

/** Parameters that carry the size of a node's own geometry, per node type (scaled by the cumulative Size scalar). */
export const SIZE_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'generator.trunk': ['length', 'radius'],
  'generator.branch': ['length', 'radius'],
  'generator.root': ['length', 'radius'],
  'generator.spine': ['length', 'radius'],
  'generator.leaf': ['postScale'],
  'generator.batchedLeaf': ['postScale'],
  'generator.meshes': ['postScale'],
  'generator.cluster': ['postScale'],
  'generator.cap': ['capRadiusScale'],
  'generator.frond': ['frondWidth'],
  'generator.decoration': ['decoScale'],
};

/** Size scalar of a node (own value only). */
export function readSizeScalar(params: NodeParams): number {
  const v = getNumber(params, 'sizeScalar', 1);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** A node's effective scalar is the product of its own value and the scalar handed down by its parent. */
export function cumulativeSizeScalar(parentScalar: number | undefined, own: number): number {
  return (parentScalar && parentScalar > 0 ? parentScalar : 1) * own;
}

/** Returns a copy of `params` with the size parameters of `type` multiplied by `scalar` (no change at 1). */
export function applySizeScalar(type: string, params: NodeParams, scalar: number): NodeParams {
  const ids = SIZE_PARAMS[type];
  if (!ids || Math.abs(scalar - 1) < 1e-9) return params;
  const out: NodeParams = { ...params };
  for (const id of ids) {
    const st = params[id];
    if (st && typeof st.value === 'number') out[id] = { ...st, value: st.value * scalar };
  }
  return out;
}
