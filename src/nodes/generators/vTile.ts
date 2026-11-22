import { getString, type NodeParams } from '@/contracts/params';
import type { MaterialDef } from '@/contracts/material';
import { getSourceSize } from '@/materials/displacement';
import { getMaterialSource } from '@/materials/materialSource';

function findMaterial(params: NodeParams): MaterialDef | null {
  const src = getMaterialSource();
  const ref = getString(params, 'material', '');
  if (!src || !ref) return null;
  const materials = src.materials();
  const direct = materials.find((m) => m.id === ref || m.name === ref);
  if (direct) return direct;
  const set = src.sets().find((s) => s.id === ref || s.name === ref);
  const first = set?.members[0]?.materialId;
  return first ? materials.find((m) => m.id === first) ?? null : null;
}

/**
 * Height / width ratio of the colour texture of the node's material (1 when the node has no material, the material has no
 * colour texture or the image is not decoded yet). Used by Spine > Length > Match one V tile.
 */
export function barkTextureAspect(params: NodeParams): number {
  const id = findMaterial(params)?.slots.color?.texture?.assetId;
  const size = id ? getSourceSize(id) : null;
  return size && size.width > 0 && size.height > 0 ? size.height / size.width : 1;
}

/** Cache-key part: changes when the aspect used by Match one V tile changes (image decoded, material swapped). */
export function vTileDependencyKey(params: NodeParams): string {
  return params.matchOneVTile?.value === true ? `vt${barkTextureAspect(params).toFixed(4)}` : '';
}
