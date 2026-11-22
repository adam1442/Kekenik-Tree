import type { MaterialSlotRange, MeshData, MeshPartTable } from '@/contracts/mesh';

/** Where one leaf of a Batched Leaf node lives inside the mesh it was built into. */
export interface LeafSpan {
  /** Stable key of the source placement (instance key). */
  key: number;
  /** Index of the leaf's branch in the output skeleton (-1 unknown). */
  branch: number;
  materialId: string;
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
}

/**
 * Batches the leaves of `mesh` into ONE slot per material and records an index table so every triangle can still be
 * traced back to its source leaf. Vertex buffers are shared (no vertex is copied, added or dropped); only the index
 * buffer is rewritten so all triangles of a material are contiguous, in the order of `spans` within the material.
 * Materials appear in the order of their first span.
 */
export function mergeByMaterial(mesh: MeshData, spans: readonly LeafSpan[]): MeshData {
  const order: string[] = [];
  const byMaterial = new Map<string, LeafSpan[]>();
  let totalIndices = 0;
  for (const s of spans) {
    if (s.indexCount <= 0) continue;
    let list = byMaterial.get(s.materialId);
    if (!list) {
      list = [];
      byMaterial.set(s.materialId, list);
      order.push(s.materialId);
    }
    list.push(s);
    totalIndices += s.indexCount;
  }
  const rows = order.reduce((n, m) => n + (byMaterial.get(m) as LeafSpan[]).length, 0);
  const indices = new Uint32Array(totalIndices);
  const slots: MaterialSlotRange[] = [];
  const table: MeshPartTable = {
    count: rows,
    key: new Uint32Array(rows),
    branch: new Int32Array(rows),
    slot: new Uint32Array(rows),
    vertexStart: new Uint32Array(rows),
    vertexCount: new Uint32Array(rows),
    indexStart: new Uint32Array(rows),
    indexCount: new Uint32Array(rows),
  };
  let offset = 0;
  let row = 0;
  for (const materialId of order) {
    const slotStart = offset;
    for (const s of byMaterial.get(materialId) as LeafSpan[]) {
      indices.set(mesh.indices.subarray(s.indexStart, s.indexStart + s.indexCount), offset);
      table.key[row] = s.key >>> 0;
      table.branch[row] = s.branch;
      table.slot[row] = slots.length;
      table.vertexStart[row] = s.vertexStart;
      table.vertexCount[row] = s.vertexCount;
      table.indexStart[row] = offset;
      table.indexCount[row] = s.indexCount;
      offset += s.indexCount;
      row += 1;
    }
    slots.push({ materialId, indexStart: slotStart, indexCount: offset - slotStart });
  }
  return { ...mesh, indices, slots, parts: table };
}

/** Row of the part that owns triangle `triangle` (index-buffer position / 3), -1 when none does. */
export function partAtTriangle(table: MeshPartTable, triangle: number): number {
  const at = triangle * 3;
  let lo = 0;
  let hi = table.count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = table.indexStart[mid] as number;
    if (at < start) hi = mid - 1;
    else if (at >= start + (table.indexCount[mid] as number)) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** Source key (instance key of the placement) of the leaf that owns triangle `triangle`, null when unknown. */
export function sourceKeyAtTriangle(table: MeshPartTable | undefined, triangle: number): number | null {
  if (!table) return null;
  const row = partAtTriangle(table, triangle);
  return row < 0 ? null : (table.key[row] as number);
}

/** Row of the part with source `key`, -1 when absent. */
export function partRowOfKey(table: MeshPartTable, key: number): number {
  const k = key >>> 0;
  for (let i = 0; i < table.count; i++) if (table.key[i] === k) return i;
  return -1;
}
