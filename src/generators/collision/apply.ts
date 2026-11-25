import type { MaterialSlotRange, MeshData, MeshPartTable } from '@/contracts/mesh';
import { LEAF_MOVED, LEAF_REMOVED, LEAF_SHRUNK, type Collider, type CollisionOutcome } from './types';

/** Colliders of every leaf of a mesh that carries a collision table (ids start at `firstId`). */
export function collidersFromMesh(mesh: MeshData, generator: number, firstId: number, parentSalt: number): Collider[] {
  const t = mesh.collision;
  if (!t) return [];
  const out: Collider[] = [];
  for (let i = 0; i < t.count; i++) {
    const parent = t.parent[i] as number;
    out.push({
      id: firstId + i,
      generator,
      priority: t.priority[i] as number,
      threshold: t.threshold,
      action: t.action,
      testAgainst: t.testAgainst,
      parentRule: t.parentRule,
      parentKey: parent < 0 ? -1 : parentSalt * 1_000_003 + parent,
      origin: [t.origin[i * 3] as number, t.origin[i * 3 + 1] as number, t.origin[i * 3 + 2] as number],
      shape: {
        positions: mesh.positions,
        indices: mesh.indices,
        vertexStart: t.vertexStart[i] as number,
        vertexCount: t.vertexCount[i] as number,
        indexStart: t.indexStart[i] as number,
        indexCount: t.indexCount[i] as number,
        normals: mesh.normals,
      },
    });
  }
  return out;
}

/**
 * The mesh with the outcome applied: removed leaves lose their triangles, shrunk / moved leaves get new positions.
 * Vertex buffers other than positions are shared with the input mesh. `outcome` slices start at `first`.
 */
export function applyOutcomeToMesh(mesh: MeshData, outcome: CollisionOutcome, first: number): MeshData {
  const t = mesh.collision;
  if (!t) return mesh;
  let positions = mesh.positions;
  const removed: [number, number][] = [];
  for (let i = 0; i < t.count; i++) {
    const s = outcome.state[first + i] as number;
    if (s === LEAF_REMOVED) removed.push([t.indexStart[i] as number, t.indexCount[i] as number]);
    else if (s === LEAF_SHRUNK || s === LEAF_MOVED) {
      if (positions === mesh.positions) positions = Float32Array.from(mesh.positions);
      const k = outcome.scale[first + i] as number;
      const ox = t.origin[i * 3] as number;
      const oy = t.origin[i * 3 + 1] as number;
      const oz = t.origin[i * 3 + 2] as number;
      const dx = outcome.offset[(first + i) * 3] as number;
      const dy = outcome.offset[(first + i) * 3 + 1] as number;
      const dz = outcome.offset[(first + i) * 3 + 2] as number;
      const v0 = t.vertexStart[i] as number;
      for (let v = v0; v < v0 + (t.vertexCount[i] as number); v++) {
        positions[v * 3] = ox + ((positions[v * 3] as number) - ox) * k + dx;
        positions[v * 3 + 1] = oy + ((positions[v * 3 + 1] as number) - oy) * k + dy;
        positions[v * 3 + 2] = oz + ((positions[v * 3 + 2] as number) - oz) * k + dz;
      }
    }
  }
  const { collision: _drop, ...rest } = mesh;
  void _drop;
  if (removed.length === 0) return { ...rest, positions };
  removed.sort((a, b) => a[0] - b[0]);
  // Index positions after removal: old position minus the removed indices before it.
  const before = new Float64Array(removed.length + 1);
  removed.forEach((r, k) => (before[k + 1] = (before[k] as number) + r[1]));
  const shift = (pos: number): number => {
    let lo = 0;
    let hi = removed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((removed[mid] as [number, number])[0] < pos) lo = mid + 1;
      else hi = mid;
    }
    return pos - (before[lo] as number);
  };
  const indices = new Uint32Array(mesh.indices.length - (before[removed.length] as number));
  let from = 0;
  let to = 0;
  for (const [start, count] of removed) {
    indices.set(mesh.indices.subarray(from, start), to);
    to += start - from;
    from = start + count;
  }
  indices.set(mesh.indices.subarray(from), to);
  const slots: MaterialSlotRange[] = mesh.slots.map((s) => {
    const a = shift(s.indexStart);
    return { ...s, indexStart: a, indexCount: shift(s.indexStart + s.indexCount) - a };
  });
  const result: MeshData = { ...rest, positions, indices, slots };
  if (mesh.parts) result.parts = remapParts(mesh.parts, removed, shift);
  return result;
}

function remapParts(p: MeshPartTable, removed: readonly [number, number][], shift: (pos: number) => number): MeshPartTable {
  const isRemoved = new Set(removed.map((r) => r[0]));
  const rows: number[] = [];
  for (let i = 0; i < p.count; i++) if (!isRemoved.has(p.indexStart[i] as number)) rows.push(i);
  const pick = <T extends Uint32Array | Int32Array>(a: T): T => a.constructor === Int32Array ? (Int32Array.from(rows, (r) => a[r] as number) as T) : (Uint32Array.from(rows, (r) => a[r] as number) as T);
  const table: MeshPartTable = {
    count: rows.length,
    key: pick(p.key),
    branch: pick(p.branch),
    slot: pick(p.slot),
    vertexStart: pick(p.vertexStart),
    vertexCount: pick(p.vertexCount),
    indexStart: Uint32Array.from(rows, (r) => shift(p.indexStart[r] as number)),
    indexCount: pick(p.indexCount),
  };
  return table;
}
