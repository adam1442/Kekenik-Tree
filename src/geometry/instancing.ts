import type { MeshData } from '@/contracts/mesh';
import { meshVertexCount } from '@/contracts/mesh';
import type { V3 } from './math3';

/** Column-major 4x4 from an orthonormal basis (x, y, z), uniform scale and translation. */
export function composeMatrix(pos: V3, x: V3, y: V3, z: V3, scale: number, out: Float32Array, offset: number): void {
  const m = out;
  m[offset] = x[0] * scale; m[offset + 1] = x[1] * scale; m[offset + 2] = x[2] * scale; m[offset + 3] = 0;
  m[offset + 4] = y[0] * scale; m[offset + 5] = y[1] * scale; m[offset + 6] = y[2] * scale; m[offset + 7] = 0;
  m[offset + 8] = z[0] * scale; m[offset + 9] = z[1] * scale; m[offset + 10] = z[2] * scale; m[offset + 11] = 0;
  m[offset + 12] = pos[0]; m[offset + 13] = pos[1]; m[offset + 14] = pos[2]; m[offset + 15] = 1;
}

export interface PlaceOptions {
  /** rgb multiplier per instance (3 floats each). */
  tints?: Float32Array;
  /** wind weights per instance (4 floats each); default (0, 0, 1, 0). */
  wind?: Float32Array;
}

/** Bake `count` transformed copies of `base` into one MeshData (positions, normals, tangents, UVs, AO, wind pivots). */
export function placeMeshes(base: MeshData, matrices: Float32Array, count: number, opts: PlaceOptions = {}): MeshData {
  const nv = meshVertexCount(base);
  const ni = base.indices.length;
  const positions = new Float32Array(nv * count * 3);
  const normals = new Float32Array(nv * count * 3);
  const tangents = new Float32Array(nv * count * 4);
  const uv0 = new Float32Array(nv * count * 2);
  const uv1 = new Float32Array(nv * count * 2);
  const colors = new Float32Array(nv * count * 4);
  const ao = new Float32Array(nv * count);
  const pivot = new Float32Array(nv * count * 3);
  const weights = new Float32Array(nv * count * 4);
  const indices = new Uint32Array(ni * count);
  const cells = Math.max(1, Math.ceil(Math.sqrt(count)));
  for (let k = 0; k < count; k++) {
    const m = k * 16;
    const m0 = matrices[m] as number, m1 = matrices[m + 1] as number, m2 = matrices[m + 2] as number;
    const m4 = matrices[m + 4] as number, m5 = matrices[m + 5] as number, m6 = matrices[m + 6] as number;
    const m8 = matrices[m + 8] as number, m9 = matrices[m + 9] as number, m10 = matrices[m + 10] as number;
    const tx = matrices[m + 12] as number, ty = matrices[m + 13] as number, tz = matrices[m + 14] as number;
    const sc = Math.hypot(m0, m1, m2) || 1;
    const cx = k % cells;
    const cy = Math.floor(k / cells);
    for (let i = 0; i < nv; i++) {
      const vi = k * nv + i;
      const px = base.positions[i * 3] as number, py = base.positions[i * 3 + 1] as number, pz = base.positions[i * 3 + 2] as number;
      positions[vi * 3] = m0 * px + m4 * py + m8 * pz + tx;
      positions[vi * 3 + 1] = m1 * px + m5 * py + m9 * pz + ty;
      positions[vi * 3 + 2] = m2 * px + m6 * py + m10 * pz + tz;
      const nx = base.normals[i * 3] as number, ny = base.normals[i * 3 + 1] as number, nz = base.normals[i * 3 + 2] as number;
      normals[vi * 3] = (m0 * nx + m4 * ny + m8 * nz) / sc;
      normals[vi * 3 + 1] = (m1 * nx + m5 * ny + m9 * nz) / sc;
      normals[vi * 3 + 2] = (m2 * nx + m6 * ny + m10 * nz) / sc;
      const bt = base.tangents;
      const bx = bt ? (bt[i * 4] as number) : 1, by = bt ? (bt[i * 4 + 1] as number) : 0, bz = bt ? (bt[i * 4 + 2] as number) : 0;
      tangents[vi * 4] = (m0 * bx + m4 * by + m8 * bz) / sc;
      tangents[vi * 4 + 1] = (m1 * bx + m5 * by + m9 * bz) / sc;
      tangents[vi * 4 + 2] = (m2 * bx + m6 * by + m10 * bz) / sc;
      tangents[vi * 4 + 3] = bt ? (bt[i * 4 + 3] as number) : 1;
      uv0[vi * 2] = base.uv0[i * 2] as number;
      uv0[vi * 2 + 1] = base.uv0[i * 2 + 1] as number;
      const b1u = base.uv1 ? (base.uv1[i * 2] as number) : (base.uv0[i * 2] as number);
      const b1v = base.uv1 ? (base.uv1[i * 2 + 1] as number) : (base.uv0[i * 2 + 1] as number);
      uv1[vi * 2] = (cx + b1u) / cells;
      uv1[vi * 2 + 1] = (cy + b1v) / cells;
      const aoV = base.ao ? (base.ao[i] as number) : 1;
      ao[vi] = aoV;
      const tr = opts.tints ? (opts.tints[k * 3] as number) : 1;
      const tg = opts.tints ? (opts.tints[k * 3 + 1] as number) : 1;
      const tb = opts.tints ? (opts.tints[k * 3 + 2] as number) : 1;
      colors[vi * 4] = (base.colors ? (base.colors[i * 4] as number) : 1) * tr;
      colors[vi * 4 + 1] = (base.colors ? (base.colors[i * 4 + 1] as number) : 1) * tg;
      colors[vi * 4 + 2] = (base.colors ? (base.colors[i * 4 + 2] as number) : 1) * tb;
      colors[vi * 4 + 3] = 1;
      pivot[vi * 3] = tx; pivot[vi * 3 + 1] = ty; pivot[vi * 3 + 2] = tz;
      weights[vi * 4] = opts.wind ? (opts.wind[k * 4] as number) : 0;
      weights[vi * 4 + 1] = opts.wind ? (opts.wind[k * 4 + 1] as number) : 0;
      weights[vi * 4 + 2] = opts.wind ? (opts.wind[k * 4 + 2] as number) : 1;
      weights[vi * 4 + 3] = opts.wind ? (opts.wind[k * 4 + 3] as number) : 0;
    }
    for (let i = 0; i < ni; i++) indices[k * ni + i] = (base.indices[i] as number) + k * nv;
  }
  if (base.slots.length <= 1) {
    return {
      positions, normals, tangents, uv0, uv1, colors, ao, indices,
      wind: { pivot, weights },
      slots: [{ materialId: base.slots[0]?.materialId ?? 'default', indexStart: 0, indexCount: indices.length }],
    };
  }
  // Several materials: re-order indices so each material stays contiguous across all instances.
  const slotRanges = base.slots;
  const ordered = new Uint32Array(indices.length);
  const outSlots: { materialId: string; indexStart: number; indexCount: number }[] = [];
  let o = 0;
  for (const s of slotRanges) {
    const start = o;
    for (let k = 0; k < count; k++) {
      for (let i = 0; i < s.indexCount; i++) ordered[o++] = (indices[k * ni + s.indexStart + i] as number);
    }
    outSlots.push({ materialId: s.materialId, indexStart: start, indexCount: o - start });
  }
  return { positions, normals, tangents, uv0, uv1, colors, ao, indices: ordered, wind: { pivot, weights }, slots: outSlots };
}

/** Expand a GPU-instanced MeshData into plain geometry (exporters / non-instancing consumers). */
export function expandInstances(m: MeshData): MeshData {
  if (!m.instanced) return m;
  const base: MeshData = { ...m };
  delete base.instanced;
  return placeMeshes(base, m.instanced.matrices, m.instanced.count);
}
