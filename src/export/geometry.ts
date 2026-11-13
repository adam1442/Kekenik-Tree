import type { MeshData } from '@/contracts/mesh';
import { expandInstances } from '@/geometry/instancing';
import type { GeometryStats, MergeMode } from './types';
import { transformDirections, transformPoints, type ExportTransform } from './transform';

/** Indices of one material inside a `PlantGeometry` (one glTF primitive / one draw call). */
export interface PlantPrimitive {
  materialId: string;
  indices: Uint32Array;
}

/** Export-ready geometry: instances expanded, all pieces merged into shared vertex buffers, one primitive per material. */
export interface PlantGeometry {
  name: string;
  positions: Float32Array;
  normals: Float32Array;
  uv0: Float32Array;
  uv1?: Float32Array;
  tangents?: Float32Array;
  /** rgba */
  colors?: Float32Array;
  ao?: Float32Array;
  wind?: { pivot: Float32Array; weights: Float32Array };
  primitives: PlantPrimitive[];
}

export interface NamedMesh {
  name: string;
  mesh: MeshData;
}

const DEFAULT_MATERIAL = 'default';

/** Concatenate `parts`' attribute; missing parts are filled with `fill` (length = stride). */
function concatAttr(parts: (Float32Array | undefined)[], counts: number[], stride: number, fill: readonly number[]): Float32Array {
  const total = counts.reduce((s, c) => s + c, 0);
  const out = new Float32Array(total * stride);
  let o = 0;
  parts.forEach((p, i) => {
    const n = (counts[i] as number) * stride;
    if (p && p.length >= n) out.set(p.subarray(0, n), o);
    else for (let k = 0; k < n; k++) out[o + k] = fill[k % stride] as number;
    o += n;
  });
  return out;
}

/** Merge meshes into one `PlantGeometry` (attributes present on ANY mesh are kept, gaps are filled with neutral values). */
export function mergeToPlantGeometry(name: string, meshes: readonly MeshData[]): PlantGeometry {
  const list = meshes.map((m) => expandInstances(m)).filter((m) => m.indices.length > 0 && m.positions.length > 0);
  const counts = list.map((m) => m.positions.length / 3);
  const any = (pick: (m: MeshData) => unknown): boolean => list.some((m) => pick(m) !== undefined);
  const geo: PlantGeometry = {
    name,
    positions: concatAttr(list.map((m) => m.positions), counts, 3, [0]),
    normals: concatAttr(list.map((m) => m.normals), counts, 3, [0, 0, 1]),
    uv0: concatAttr(list.map((m) => m.uv0), counts, 2, [0]),
    primitives: [],
  };
  if (any((m) => m.uv1)) geo.uv1 = concatAttr(list.map((m) => m.uv1), counts, 2, [0]);
  if (any((m) => m.tangents)) geo.tangents = concatAttr(list.map((m) => m.tangents), counts, 4, [1, 0, 0, 1]);
  if (any((m) => m.colors)) geo.colors = concatAttr(list.map((m) => m.colors), counts, 4, [1, 1, 1, 1]);
  if (any((m) => m.ao)) geo.ao = concatAttr(list.map((m) => m.ao), counts, 1, [1]);
  if (any((m) => m.wind)) {
    geo.wind = {
      pivot: concatAttr(list.map((m) => m.wind?.pivot), counts, 3, [0]),
      weights: concatAttr(list.map((m) => m.wind?.weights), counts, 4, [0]),
    };
  }
  const byMaterial = new Map<string, Uint32Array[]>();
  let base = 0;
  list.forEach((m, i) => {
    const slots = m.slots.length > 0 ? m.slots : [{ materialId: DEFAULT_MATERIAL, indexStart: 0, indexCount: m.indices.length }];
    for (const s of slots) {
      const out = new Uint32Array(s.indexCount);
      for (let k = 0; k < s.indexCount; k++) out[k] = (m.indices[s.indexStart + k] as number) + base;
      const arr = byMaterial.get(s.materialId) ?? [];
      arr.push(out);
      byMaterial.set(s.materialId, arr);
    }
    base += counts[i] as number;
  });
  for (const [materialId, parts] of byMaterial) {
    const total = parts.reduce((s, p) => s + p.length, 0);
    const indices = new Uint32Array(total);
    let o = 0;
    for (const p of parts) {
      indices.set(p, o);
      o += p.length;
    }
    if (total > 0) geo.primitives.push({ materialId, indices });
  }
  return geo;
}

/** One geometry for the whole plant or one per graph node (so engines can address leaves / bark separately). */
export function buildGeometries(entries: readonly NamedMesh[], mode: MergeMode, name: string): PlantGeometry[] {
  const list = mode === 'single' ? [mergeToPlantGeometry(name, entries.map((e) => e.mesh))] : entries.map((e) => mergeToPlantGeometry(e.name, [e.mesh]));
  return list.filter((g) => g.primitives.length > 0);
}

/** Transform in place (the geometry must own its arrays, which `mergeToPlantGeometry` guarantees). */
export function transformGeometry(g: PlantGeometry, t: ExportTransform): void {
  transformPoints(t, g.positions);
  transformDirections(t, g.normals, 3);
  if (g.tangents) transformDirections(t, g.tangents, 4);
  if (g.wind) transformPoints(t, g.wind.pivot);
  if (t.flipWinding) {
    for (const p of g.primitives) {
      const idx = p.indices;
      for (let i = 0; i + 2 < idx.length; i += 3) {
        const tmp = idx[i + 1] as number;
        idx[i + 1] = idx[i + 2] as number;
        idx[i + 2] = tmp;
      }
    }
  }
}

export function geometryStats(list: readonly PlantGeometry[]): GeometryStats {
  let triangles = 0;
  let vertices = 0;
  let drawCalls = 0;
  for (const g of list) {
    vertices += g.positions.length / 3;
    for (const p of g.primitives) {
      triangles += p.indices.length / 3;
      drawCalls += 1;
    }
  }
  return { triangles, vertices, drawCalls };
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export function geometryBounds(list: readonly PlantGeometry[]): Bounds3 {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const g of list) {
    for (let i = 0; i + 2 < g.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = g.positions[i + a] as number;
        if (v < (min[a] as number)) min[a] = v;
        if (v > (max[a] as number)) max[a] = v;
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Distinct material ids used by the geometries. */
export function usedMaterialIds(list: readonly PlantGeometry[]): string[] {
  const ids = new Set<string>();
  for (const g of list) for (const p of g.primitives) ids.add(p.materialId);
  return [...ids];
}
