import type { MaterialSlotRange, MeshData } from '@/contracts/mesh';
import { hash01 } from '@/geometry/math3';

/** Mesh surgery used by the LOD generator. Pure; never mutates the input (engine results are cached and shared). */

export interface MeshComponents {
  /** Component id per vertex. */
  ids: Uint32Array;
  count: number;
}

/** Connected components over shared vertices (union-find). Leaf cards / branch tubes are separate components. */
export function meshComponents(mesh: MeshData): MeshComponents {
  const n = mesh.positions.length / 3;
  const parent = new Uint32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while ((parent[r] as number) !== r) r = parent[r] as number;
    while ((parent[a] as number) !== r) {
      const next = parent[a] as number;
      parent[a] = r;
      a = next;
    }
    return r;
  };
  const idx = mesh.indices;
  for (let i = 0; i + 2 < idx.length; i += 3) {
    const a = find(idx[i] as number);
    const b = find(idx[i + 1] as number);
    const c = find(idx[i + 2] as number);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== c) parent[c] = a2;
  }
  const remap = new Map<number, number>();
  const ids = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let id = remap.get(r);
    if (id === undefined) {
      id = remap.size;
      remap.set(r, id);
    }
    ids[i] = id;
  }
  return { ids, count: remap.size };
}

export interface ComponentInfo {
  triangles: Uint32Array;
  /** Bounding box diagonal. */
  diagonal: Float32Array;
  /** Attachment point (the base of a leaf: lowest-v vertices, else the centroid), 3 floats per component. */
  base: Float32Array;
}

export function describeComponents(mesh: MeshData, comps: MeshComponents): ComponentInfo {
  const k = comps.count;
  const mins = new Float32Array(k * 3).fill(Infinity);
  const maxs = new Float32Array(k * 3).fill(-Infinity);
  const sum = new Float64Array(k * 3);
  const cnt = new Uint32Array(k);
  const vMin = new Float32Array(k).fill(Infinity);
  const vMax = new Float32Array(k).fill(-Infinity);
  const n = mesh.positions.length / 3;
  for (let i = 0; i < n; i++) {
    const c = comps.ids[i] as number;
    cnt[c] = (cnt[c] as number) + 1;
    for (let a = 0; a < 3; a++) {
      const v = mesh.positions[i * 3 + a] as number;
      if (v < (mins[c * 3 + a] as number)) mins[c * 3 + a] = v;
      if (v > (maxs[c * 3 + a] as number)) maxs[c * 3 + a] = v;
      sum[c * 3 + a] = (sum[c * 3 + a] as number) + v;
    }
    const uvv = mesh.uv0[i * 2 + 1];
    if (uvv !== undefined) {
      if (uvv < (vMin[c] as number)) vMin[c] = uvv;
      if (uvv > (vMax[c] as number)) vMax[c] = uvv;
    }
  }
  const triangles = new Uint32Array(k);
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const c = comps.ids[mesh.indices[i] as number] as number;
    triangles[c] = (triangles[c] as number) + 1;
  }
  const diagonal = new Float32Array(k);
  const base = new Float32Array(k * 3);
  const baseSum = new Float64Array(k * 3);
  const baseCnt = new Uint32Array(k);
  for (let c = 0; c < k; c++) {
    diagonal[c] = Math.hypot((maxs[c * 3] as number) - (mins[c * 3] as number), (maxs[c * 3 + 1] as number) - (mins[c * 3 + 1] as number), (maxs[c * 3 + 2] as number) - (mins[c * 3 + 2] as number));
  }
  for (let i = 0; i < n; i++) {
    const c = comps.ids[i] as number;
    const span = (vMax[c] as number) - (vMin[c] as number);
    if (span < 1e-4) continue;
    if ((mesh.uv0[i * 2 + 1] as number) <= (vMin[c] as number) + span * 0.05) {
      for (let a = 0; a < 3; a++) baseSum[c * 3 + a] = (baseSum[c * 3 + a] as number) + (mesh.positions[i * 3 + a] as number);
      baseCnt[c] = (baseCnt[c] as number) + 1;
    }
  }
  for (let c = 0; c < k; c++) {
    const bc = baseCnt[c] as number;
    for (let a = 0; a < 3; a++) base[c * 3 + a] = bc > 0 ? (baseSum[c * 3 + a] as number) / bc : (sum[c * 3 + a] as number) / Math.max(1, cnt[c] as number);
  }
  return { triangles, diagonal, base };
}

const copyAttr = (src: Float32Array | undefined, stride: number, map: Int32Array, outCount: number): Float32Array | undefined => {
  if (!src) return undefined;
  const out = new Float32Array(outCount * stride);
  for (let i = 0; i < map.length; i++) {
    const to = map[i] as number;
    if (to < 0) continue;
    for (let k = 0; k < stride; k++) out[to * stride + k] = src[i * stride + k] as number;
  }
  return out;
};

/**
 * Keep the components for which `keep[c]` is 1 and scale them by `scale[c]` about their base point.
 * Vertices of dropped components are removed; slots are rebuilt.
 */
export function subsetComponents(mesh: MeshData, comps: MeshComponents, info: ComponentInfo, keep: Uint8Array, scale: Float32Array | null): MeshData {
  const n = mesh.positions.length / 3;
  const map = new Int32Array(n).fill(-1);
  let outCount = 0;
  for (let i = 0; i < n; i++) if (keep[comps.ids[i] as number]) map[i] = outCount++;
  const positions = copyAttr(mesh.positions, 3, map, outCount) as Float32Array;
  if (scale) {
    for (let i = 0; i < n; i++) {
      const to = map[i] as number;
      if (to < 0) continue;
      const c = comps.ids[i] as number;
      const s = scale[c] as number;
      if (s === 1) continue;
      for (let a = 0; a < 3; a++) {
        const b = info.base[c * 3 + a] as number;
        positions[to * 3 + a] = b + ((mesh.positions[i * 3 + a] as number) - b) * s;
      }
    }
  }
  const indices: number[] = [];
  const slots: MaterialSlotRange[] = [];
  const source = mesh.slots.length > 0 ? mesh.slots : [{ materialId: 'default', indexStart: 0, indexCount: mesh.indices.length }];
  for (const s of source) {
    const start = indices.length;
    for (let i = s.indexStart; i + 2 < s.indexStart + s.indexCount; i += 3) {
      const a = mesh.indices[i] as number;
      if (!keep[comps.ids[a] as number]) continue;
      indices.push(map[a] as number, map[mesh.indices[i + 1] as number] as number, map[mesh.indices[i + 2] as number] as number);
    }
    if (indices.length > start) slots.push({ materialId: s.materialId, indexStart: start, indexCount: indices.length - start });
  }
  const out: MeshData = {
    positions,
    normals: copyAttr(mesh.normals, 3, map, outCount) as Float32Array,
    uv0: copyAttr(mesh.uv0, 2, map, outCount) as Float32Array,
    indices: Uint32Array.from(indices),
    slots,
  };
  const tangents = copyAttr(mesh.tangents, 4, map, outCount);
  const uv1 = copyAttr(mesh.uv1, 2, map, outCount);
  const colors = copyAttr(mesh.colors, 4, map, outCount);
  const ao = copyAttr(mesh.ao, 1, map, outCount);
  if (tangents) out.tangents = tangents;
  if (uv1) out.uv1 = uv1;
  if (colors) out.colors = colors;
  if (ao) out.ao = ao;
  if (mesh.wind) {
    out.wind = { pivot: copyAttr(mesh.wind.pivot, 3, map, outCount) as Float32Array, weights: copyAttr(mesh.wind.weights, 4, map, outCount) as Float32Array };
  }
  return out;
}

/** Instanced payload: keep a subset of the instances (and scale their local axes about the instance origin). */
export function subsetInstances(mesh: MeshData, keepFraction: number, scale: number, seed: number): MeshData {
  const inst = mesh.instanced;
  if (!inst) return mesh;
  const kept: number[] = [];
  for (let i = 0; i < inst.count; i++) if (hash01(i, seed) < keepFraction) kept.push(i);
  if (kept.length === 0 && inst.count > 0) kept.push(0);
  const matrices = new Float32Array(kept.length * 16);
  kept.forEach((src, dst) => {
    for (let k = 0; k < 16; k++) matrices[dst * 16 + k] = inst.matrices[src * 16 + k] as number;
    if (scale !== 1) for (let k = 0; k < 12; k++) matrices[dst * 16 + k] = (matrices[dst * 16 + k] as number) * scale;
  });
  return { ...mesh, instanced: { count: kept.length, matrices } };
}

/** Deterministic per-component rank in [0, 1): a component survives when its rank < keep fraction (nested subsets). */
export const componentRank = (component: number, seed: number): number => hash01(component, seed);
