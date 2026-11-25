import type { V3 } from '@/geometry/math3';
import type { Collider } from './types';

/** Oriented box: centre, three orthonormal axes, half extents along them. */
export interface Obb {
  c: V3;
  axes: [V3, V3, V3];
  h: V3;
}

/** Collision bounds of a leaf in its rest pose. */
export interface LeafBounds {
  obb: Obb;
  /** Circumscribed sphere centre (= box centre) and radius. */
  radius: number;
  /** Radius of the test sphere before the Sphere threshold: mean of the two largest half extents. */
  testRadius: number;
  /** Unit direction of the thinnest box axis (the face normal), oriented with the vertex normals when known. */
  normal: V3;
}

/** Eigenvectors of a symmetric 3x3 matrix (Jacobi). Returns unit columns sorted by descending eigenvalue. */
export function eigenAxes(m: readonly number[]): [V3, V3, V3] {
  const a = [m[0] as number, m[1] as number, m[2] as number, m[3] as number, m[4] as number, m[5] as number, m[6] as number, m[7] as number, m[8] as number];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[1] as number) + Math.abs(a[2] as number) + Math.abs(a[5] as number);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q] as number;
      if (Math.abs(apq) < 1e-30) continue;
      const theta = ((a[q * 3 + q] as number) - (a[p * 3 + p] as number)) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p] as number;
        const akq = a[k * 3 + q] as number;
        a[k * 3 + p] = c * akp - s * akq;
        a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k] as number;
        const aqk = a[q * 3 + k] as number;
        a[p * 3 + k] = c * apk - s * aqk;
        a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p] as number;
        const vkq = v[k * 3 + q] as number;
        v[k * 3 + p] = c * vkp - s * vkq;
        v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const cols: { val: number; vec: V3 }[] = [0, 1, 2].map((i) => ({ val: a[i * 4] as number, vec: [v[i] as number, v[3 + i] as number, v[6 + i] as number] as V3 }));
  cols.sort((x, y) => y.val - x.val);
  return [cols[0]!.vec, cols[1]!.vec, cols[2]!.vec];
}

/** Bounds of a leaf's vertices (PCA box). `flat` projects onto the XY plane first. */
export function leafBounds(c: Collider, flat = false): LeafBounds {
  const { positions, vertexStart, vertexCount, normals } = c.shape;
  const n = Math.max(1, vertexCount);
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (let i = 0; i < vertexCount; i++) {
    const o = (vertexStart + i) * 3;
    mx += positions[o] as number;
    my += positions[o + 1] as number;
    mz += flat ? 0 : (positions[o + 2] as number);
  }
  mx /= n;
  my /= n;
  mz /= n;
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < vertexCount; i++) {
    const o = (vertexStart + i) * 3;
    const x = (positions[o] as number) - mx;
    const y = (positions[o + 1] as number) - my;
    const z = flat ? 0 : (positions[o + 2] as number) - mz;
    cov[0] = (cov[0] as number) + x * x;
    cov[1] = (cov[1] as number) + x * y;
    cov[2] = (cov[2] as number) + x * z;
    cov[4] = (cov[4] as number) + y * y;
    cov[5] = (cov[5] as number) + y * z;
    cov[8] = (cov[8] as number) + z * z;
  }
  cov[3] = cov[1] as number;
  cov[6] = cov[2] as number;
  cov[7] = cov[5] as number;
  const axes = eigenAxes(cov);
  const lo: number[] = [Infinity, Infinity, Infinity];
  const hi: number[] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertexCount; i++) {
    const o = (vertexStart + i) * 3;
    const x = (positions[o] as number) - mx;
    const y = (positions[o + 1] as number) - my;
    const z = flat ? 0 : (positions[o + 2] as number) - mz;
    for (let k = 0; k < 3; k++) {
      const ax = axes[k] as V3;
      const d = x * ax[0] + y * ax[1] + z * ax[2];
      if (d < (lo[k] as number)) lo[k] = d;
      if (d > (hi[k] as number)) hi[k] = d;
    }
  }
  if (vertexCount === 0) {
    for (let k = 0; k < 3; k++) {
      lo[k] = 0;
      hi[k] = 0;
    }
  }
  const mid = [0, 1, 2].map((k) => ((lo[k] as number) + (hi[k] as number)) / 2);
  const h: V3 = [((hi[0] as number) - (lo[0] as number)) / 2, ((hi[1] as number) - (lo[1] as number)) / 2, ((hi[2] as number) - (lo[2] as number)) / 2];
  const centre: V3 = [
    mx + (axes[0] as V3)[0] * (mid[0] as number) + (axes[1] as V3)[0] * (mid[1] as number) + (axes[2] as V3)[0] * (mid[2] as number),
    my + (axes[0] as V3)[1] * (mid[0] as number) + (axes[1] as V3)[1] * (mid[1] as number) + (axes[2] as V3)[1] * (mid[2] as number),
    mz + (axes[0] as V3)[2] * (mid[0] as number) + (axes[1] as V3)[2] * (mid[1] as number) + (axes[2] as V3)[2] * (mid[2] as number),
  ];
  let normal: V3 = axes[2] as V3;
  if (normals && vertexCount > 0) {
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < vertexCount; i++) {
      const o = (vertexStart + i) * 3;
      nx += normals[o] as number;
      ny += normals[o + 1] as number;
      nz += flat ? 0 : (normals[o + 2] as number);
    }
    if (nx * normal[0] + ny * normal[1] + nz * normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
  }
  return { obb: { c: centre, axes, h }, radius: Math.hypot(h[0], h[1], h[2]), testRadius: (h[0] + h[1]) / 2, normal };
}
