/** MeshData — engine-agnostic triangle mesh produced by mesh builders and consumed by viewport/export. */

export interface MaterialSlotRange {
  /** MaterialDef id. */
  materialId: string;
  /** Offset into `indices`. */
  indexStart: number;
  indexCount: number;
}

/** Per-vertex wind data. */
export interface WindVertexAttributes {
  /** Pivot the vertex rotates around (xyz per vertex). */
  pivot: Float32Array;
  /** (hierarchy0, hierarchy1, hierarchy2, phase) per vertex. */
  weights: Float32Array;
}

/** Per-vertex texture blending between a welded child and its parent (Skin > Welding > Blend). */
export interface WeldBlendAttributes {
  /** 0 on the parent side of the weld .. 1 on the child (one per vertex). */
  blend: Float32Array;
  /** UV the parent's bark has at the vertex (uv per vertex). */
  parentUv: Float32Array;
  /** (contrast, noise, active) per vertex; active 0 = the vertex is not blended. */
  style: Float32Array;
}

/**
 * True GPU-instancing payload. When present, `MeshData` holds ONE copy of the geometry and the
 * viewport draws it with a THREE.InstancedMesh; exporters expand it with `expandInstances` (geometry/instancing.ts).
 */
export interface InstancedMeshPayload {
  count: number;
  /** 16 floats per instance, column-major (three.js Matrix4 layout). */
  matrices: Float32Array;
}

/**
 * Index table of a batched mesh: part `i` (one leaf of a Batched Leaf node) owns vertices
 * `[vertexStart[i], vertexStart[i] + vertexCount[i])` and indices `[indexStart[i], indexStart[i] + indexCount[i])`.
 * Rows are sorted by `indexStart`, so a triangle resolves to its source by binary search.
 */
export interface MeshPartTable {
  count: number;
  /** Stable source key (the instance key of the placement) of every part. */
  key: Uint32Array;
  /** Index of the part's branch in the generator's output skeleton (-1 = unknown). */
  branch: Int32Array;
  /** Index into `MeshData.slots` (one slot per material). */
  slot: Uint32Array;
  vertexStart: Uint32Array;
  vertexCount: Uint32Array;
  indexStart: Uint32Array;
  indexCount: Uint32Array;
}

export interface MeshData {
  positions: Float32Array; // xyz
  normals: Float32Array; // xyz
  /** xyzw, w = handedness. Optional until a normal map is used. */
  tangents?: Float32Array;
  uv0: Float32Array; // uv
  uv1?: Float32Array; // uv (lightmap / atlas)
  /** rgba per vertex. */
  colors?: Float32Array;
  indices: Uint32Array;
  wind?: WindVertexAttributes;
  /** Weld texture blend channels (bark shader); absent when no vertex is blended. */
  weld?: WeldBlendAttributes;
  /** Baked ambient-occlusion estimate per vertex (0 dark .. 1 open). Also multiplied into `colors`. */
  ao?: Float32Array;
  instanced?: InstancedMeshPayload;
  /** Present on batched meshes: which source (leaf) every vertex / index range comes from. */
  parts?: MeshPartTable;
  slots: MaterialSlotRange[];
}

export const meshVertexCount = (m: MeshData): number => m.positions.length / 3;
/** Triangles drawn, counting GPU instances. */
export const meshTriangleCount = (m: MeshData): number => (m.indices.length / 3) * (m.instanced?.count ?? 1);

export function emptyMeshData(): MeshData {
  return {
    positions: new Float32Array(0),
    normals: new Float32Array(0),
    uv0: new Float32Array(0),
    indices: new Uint32Array(0),
    slots: [],
  };
}

function concat<T extends Float32Array | Uint32Array>(parts: T[], ctor: { new (n: number): T }): T {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new ctor(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Concatenate meshes. Optional channels are kept only if every input has them. */
export function mergeMeshData(list: readonly MeshData[]): MeshData {
  if (list.length === 0) return emptyMeshData();
  const indexParts: Uint32Array[] = [];
  const slots: MaterialSlotRange[] = [];
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const m of list) {
    const idx = new Uint32Array(m.indices.length);
    for (let i = 0; i < idx.length; i++) idx[i] = (m.indices[i] as number) + vertexOffset;
    indexParts.push(idx);
    for (const s of m.slots) slots.push({ ...s, indexStart: s.indexStart + indexOffset });
    vertexOffset += meshVertexCount(m);
    indexOffset += m.indices.length;
  }
  const all = <K extends 'tangents' | 'uv1' | 'colors' | 'ao'>(key: K): Float32Array[] | null => {
    const parts: Float32Array[] = [];
    for (const m of list) {
      const v = m[key];
      if (!v) return null;
      parts.push(v);
    }
    return parts;
  };
  const tangents = all('tangents');
  const uv1 = all('uv1');
  const colors = all('colors');
  const ao = all('ao');
  const windParts = list.map((m) => m.wind);
  const out: MeshData = {
    positions: concat(list.map((m) => m.positions), Float32Array),
    normals: concat(list.map((m) => m.normals), Float32Array),
    uv0: concat(list.map((m) => m.uv0), Float32Array),
    indices: concat(indexParts, Uint32Array),
    slots,
  };
  if (tangents) out.tangents = concat(tangents, Float32Array);
  if (uv1) out.uv1 = concat(uv1, Float32Array);
  if (colors) out.colors = concat(colors, Float32Array);
  if (ao) out.ao = concat(ao, Float32Array);
  if (list.some((m) => m.weld)) {
    const fill = (pick: (w: WeldBlendAttributes) => Float32Array, per: number): Float32Array =>
      concat(list.map((m) => (m.weld ? pick(m.weld) : new Float32Array(meshVertexCount(m) * per))), Float32Array);
    out.weld = { blend: fill((w) => w.blend, 1), parentUv: fill((w) => w.parentUv, 2), style: fill((w) => w.style, 3) };
  }
  if (windParts.every((w) => w !== undefined)) {
    out.wind = {
      pivot: concat(windParts.map((w) => (w as NonNullable<typeof w>).pivot), Float32Array),
      weights: concat(windParts.map((w) => (w as NonNullable<typeof w>).weights), Float32Array),
    };
  }
  return out;
}
