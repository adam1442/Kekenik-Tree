import type { MeshData } from '@/contracts/mesh';

/** Quantisation of positions used to weld duplicated vertices (UV seams, hard edges): 0.01 mm. */
const QUANT = 1e5;

/** Integer key per vertex: vertices at the same position (within 0.01 mm) share a key. */
export function weldKeys(positions: Float32Array, n: number): Uint32Array {
  const map = new Map<string, number>();
  const out = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.round((positions[i * 3] as number) * QUANT)},${Math.round((positions[i * 3 + 1] as number) * QUANT)},${Math.round((positions[i * 3 + 2] as number) * QUANT)}`;
    let id = map.get(k);
    if (id === undefined) {
      id = map.size;
      map.set(k, id);
    }
    out[i] = id;
  }
  return out;
}

export interface RecomputeOptions {
  /** Also rebuild tangents (xyz + handedness) from the UV derivatives. Default true. */
  tangents?: boolean;
}

/**
 * Area-weighted smooth normals over the *welded* surface (so UV seams get identical normals), and optional tangents
 * from uv0. All outputs are unit length and finite (degenerate triangles are skipped, fallbacks are used).
 */
export function recomputeNormalsAndTangents(mesh: MeshData, opts: RecomputeOptions = {}): { normals: Float32Array; tangents?: Float32Array } {
  const n = mesh.positions.length / 3;
  const keys = weldKeys(mesh.positions, n);
  let groups = 1;
  for (let i = 0; i < n; i++) if ((keys[i] as number) + 1 > groups) groups = (keys[i] as number) + 1;
  const acc = new Float64Array(groups * 3);
  const tacc = new Float64Array(n * 3);
  const bacc = new Float64Array(n * 3);
  const idx = mesh.indices;
  const P = mesh.positions;
  const UV = mesh.uv0;
  const wantT = opts.tangents !== false && UV.length >= n * 2;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] as number;
    const b = idx[t + 1] as number;
    const c = idx[t + 2] as number;
    const e1x = (P[b * 3] as number) - (P[a * 3] as number);
    const e1y = (P[b * 3 + 1] as number) - (P[a * 3 + 1] as number);
    const e1z = (P[b * 3 + 2] as number) - (P[a * 3 + 2] as number);
    const e2x = (P[c * 3] as number) - (P[a * 3] as number);
    const e2y = (P[c * 3 + 1] as number) - (P[a * 3 + 1] as number);
    const e2z = (P[c * 3 + 2] as number) - (P[a * 3 + 2] as number);
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) {
      const g = (keys[v] as number) * 3;
      acc[g] = (acc[g] as number) + nx;
      acc[g + 1] = (acc[g + 1] as number) + ny;
      acc[g + 2] = (acc[g + 2] as number) + nz;
    }
    if (wantT) {
      const du1 = (UV[b * 2] as number) - (UV[a * 2] as number);
      const dv1 = (UV[b * 2 + 1] as number) - (UV[a * 2 + 1] as number);
      const du2 = (UV[c * 2] as number) - (UV[a * 2] as number);
      const dv2 = (UV[c * 2 + 1] as number) - (UV[a * 2 + 1] as number);
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) > 1e-14) {
        const r = 1 / det;
        const tx = (e1x * dv2 - e2x * dv1) * r;
        const ty = (e1y * dv2 - e2y * dv1) * r;
        const tz = (e1z * dv2 - e2z * dv1) * r;
        const bx = (e2x * du1 - e1x * du2) * r;
        const by = (e2y * du1 - e1y * du2) * r;
        const bz = (e2z * du1 - e1z * du2) * r;
        for (const v of [a, b, c]) {
          tacc[v * 3] = (tacc[v * 3] as number) + tx;
          tacc[v * 3 + 1] = (tacc[v * 3 + 1] as number) + ty;
          tacc[v * 3 + 2] = (tacc[v * 3 + 2] as number) + tz;
          bacc[v * 3] = (bacc[v * 3] as number) + bx;
          bacc[v * 3 + 1] = (bacc[v * 3 + 1] as number) + by;
          bacc[v * 3 + 2] = (bacc[v * 3 + 2] as number) + bz;
        }
      }
    }
  }
  const normals = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const g = (keys[i] as number) * 3;
    let x = acc[g] as number;
    let y = acc[g + 1] as number;
    let z = acc[g + 2] as number;
    let l = Math.hypot(x, y, z);
    if (l < 1e-20) {
      x = mesh.normals[i * 3] as number;
      y = mesh.normals[i * 3 + 1] as number;
      z = mesh.normals[i * 3 + 2] as number;
      l = Math.hypot(x, y, z);
    }
    if (l < 1e-20 || !Number.isFinite(l)) {
      x = 0;
      y = 0;
      z = 1;
      l = 1;
    }
    normals[i * 3] = x / l;
    normals[i * 3 + 1] = y / l;
    normals[i * 3 + 2] = z / l;
  }
  if (!wantT) return { normals };
  const tangents = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const nx = normals[i * 3] as number;
    const ny = normals[i * 3 + 1] as number;
    const nz = normals[i * 3 + 2] as number;
    let tx = tacc[i * 3] as number;
    let ty = tacc[i * 3 + 1] as number;
    let tz = tacc[i * 3 + 2] as number;
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d;
    ty -= ny * d;
    tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-20 || !Number.isFinite(l)) {
      // Any vector perpendicular to the normal.
      if (Math.abs(nx) < 0.9) {
        tx = 0;
        ty = nz;
        tz = -ny;
      } else {
        tx = -nz;
        ty = 0;
        tz = nx;
      }
      l = Math.hypot(tx, ty, tz) || 1;
    }
    tx /= l;
    ty /= l;
    tz /= l;
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    const hand = cx * (bacc[i * 3] as number) + cy * (bacc[i * 3 + 1] as number) + cz * (bacc[i * 3 + 2] as number);
    tangents[i * 4] = tx;
    tangents[i * 4 + 1] = ty;
    tangents[i * 4 + 2] = tz;
    tangents[i * 4 + 3] = hand < 0 ? -1 : 1;
  }
  return { normals, tangents };
}
