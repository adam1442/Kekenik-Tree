/**
 * Triangle BVH for the geometry force: closest point, segment / ray hits and an inside test.
 * Pure (no three.js): positions are a flat xyz array, indices a flat triangle list.
 */

export interface ClosestHit {
  /** Squared distance to the surface. */
  dist2: number;
  x: number;
  y: number;
  z: number;
  /** Unit normal of the triangle that owns the closest point (outward by winding). */
  nx: number;
  ny: number;
  nz: number;
}

interface Node {
  min: [number, number, number];
  max: [number, number, number];
  /** Child nodes, or null for a leaf. */
  left: Node | null;
  right: Node | null;
  /** Leaf: range into `order`. */
  from: number;
  to: number;
}

const LEAF_SIZE = 4;

/** Closest point on triangle (a, b, c) to p, written into out[0..2]. Ericson, Real-Time Collision Detection. */
export function closestPointOnTriangle(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
  out: [number, number, number],
): void {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) {
    out[0] = ax; out[1] = ay; out[2] = az;
    return;
  }
  const bpx = px - bx, bpy = py - by, bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) {
    out[0] = bx; out[1] = by; out[2] = bz;
    return;
  }
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    out[0] = ax + abx * v; out[1] = ay + aby * v; out[2] = az + abz * v;
    return;
  }
  const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) {
    out[0] = cx; out[1] = cy; out[2] = cz;
    return;
  }
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    out[0] = ax + acx * w; out[1] = ay + acy * w; out[2] = az + acz * w;
    return;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    out[0] = bx + (cx - bx) * w; out[1] = by + (cy - by) * w; out[2] = bz + (cz - bz) * w;
    return;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  out[0] = ax + abx * v + acx * w;
  out[1] = ay + aby * v + acy * w;
  out[2] = az + abz * v + acz * w;
}

export class TriangleBvh {
  readonly triangleCount: number;
  private readonly pos: Float32Array;
  private readonly idx: Uint32Array;
  private readonly order: Uint32Array;
  private readonly root: Node | null;
  private readonly tmp: [number, number, number] = [0, 0, 0];

  constructor(positions: ArrayLike<number>, indices: ArrayLike<number>) {
    this.pos = Float32Array.from(positions);
    this.idx = Uint32Array.from(indices);
    this.triangleCount = Math.floor(this.idx.length / 3);
    this.order = new Uint32Array(this.triangleCount);
    for (let i = 0; i < this.triangleCount; i++) this.order[i] = i;
    const centroids = new Float64Array(this.triangleCount * 3);
    for (let t = 0; t < this.triangleCount; t++) {
      for (let k = 0; k < 3; k++) {
        const v = (this.idx[t * 3 + k] as number) * 3;
        centroids[t * 3] = (centroids[t * 3] as number) + (this.pos[v] as number) / 3;
        centroids[t * 3 + 1] = (centroids[t * 3 + 1] as number) + (this.pos[v + 1] as number) / 3;
        centroids[t * 3 + 2] = (centroids[t * 3 + 2] as number) + (this.pos[v + 2] as number) / 3;
      }
    }
    this.root = this.triangleCount > 0 ? this.build(0, this.triangleCount, centroids) : null;
  }

  private build(from: number, to: number, centroids: Float64Array): Node {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let i = from; i < to; i++) {
      const t = this.order[i] as number;
      for (let k = 0; k < 3; k++) {
        const v = (this.idx[t * 3 + k] as number) * 3;
        for (let a = 0; a < 3; a++) {
          const value = this.pos[v + a] as number;
          if (value < (min[a] as number)) min[a] = value;
          if (value > (max[a] as number)) max[a] = value;
        }
      }
    }
    if (to - from <= LEAF_SIZE) return { min, max, left: null, right: null, from, to };
    let axis = 0;
    if ((max[1] as number) - (min[1] as number) > (max[axis] as number) - (min[axis] as number)) axis = 1;
    if ((max[2] as number) - (min[2] as number) > (max[axis] as number) - (min[axis] as number)) axis = 2;
    const slice = Array.from(this.order.subarray(from, to));
    slice.sort((a, b) => (centroids[a * 3 + axis] as number) - (centroids[b * 3 + axis] as number) || a - b);
    this.order.set(slice, from);
    const mid = (from + to) >> 1;
    return { min, max, left: this.build(from, mid, centroids), right: this.build(mid, to, centroids), from, to };
  }

  private static boxDist2(n: Node, x: number, y: number, z: number): number {
    const dx = Math.max(n.min[0] - x, 0, x - n.max[0]);
    const dy = Math.max(n.min[1] - y, 0, y - n.max[1]);
    const dz = Math.max(n.min[2] - z, 0, z - n.max[2]);
    return dx * dx + dy * dy + dz * dz;
  }

  private triangle(t: number): [number, number, number, number, number, number, number, number, number] {
    const i0 = (this.idx[t * 3] as number) * 3;
    const i1 = (this.idx[t * 3 + 1] as number) * 3;
    const i2 = (this.idx[t * 3 + 2] as number) * 3;
    const p = this.pos;
    return [p[i0] as number, p[i0 + 1] as number, p[i0 + 2] as number, p[i1] as number, p[i1 + 1] as number, p[i1 + 2] as number, p[i2] as number, p[i2 + 1] as number, p[i2 + 2] as number];
  }

  /** Closest surface point to (x, y, z); null for an empty mesh. */
  closest(x: number, y: number, z: number, out: ClosestHit): boolean {
    if (!this.root) return false;
    out.dist2 = Infinity;
    const stack: Node[] = [this.root];
    while (stack.length > 0) {
      const n = stack.pop() as Node;
      if (TriangleBvh.boxDist2(n, x, y, z) >= out.dist2) continue;
      if (!n.left || !n.right) {
        for (let i = n.from; i < n.to; i++) {
          const t = this.order[i] as number;
          const v = this.triangle(t);
          closestPointOnTriangle(x, y, z, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], this.tmp);
          const dx = x - (this.tmp[0]);
          const dy = y - (this.tmp[1]);
          const dz = z - (this.tmp[2]);
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < out.dist2) {
            out.dist2 = d2;
            out.x = this.tmp[0];
            out.y = this.tmp[1];
            out.z = this.tmp[2];
            const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
            const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
            let nx = uy * wz - uz * wy;
            let ny = uz * wx - ux * wz;
            let nz = ux * wy - uy * wx;
            const l = Math.hypot(nx, ny, nz) || 1;
            nx /= l; ny /= l; nz /= l;
            out.nx = nx; out.ny = ny; out.nz = nz;
          }
        }
        continue;
      }
      const dl = TriangleBvh.boxDist2(n.left, x, y, z);
      const dr = TriangleBvh.boxDist2(n.right, x, y, z);
      // Visit the nearer child first (it is pushed last).
      if (dl < dr) {
        stack.push(n.right, n.left);
      } else {
        stack.push(n.left, n.right);
      }
    }
    return out.dist2 < Infinity;
  }

  /**
   * Smallest ray parameter t in (0, maxT] where the ray o + t d hits the mesh (d need not be unit, t is in units of d);
   * -1 when it does not. Double-sided.
   */
  raycast(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
    if (!this.root) return -1;
    let best = maxT;
    let found = false;
    const idx = 1 / (dx === 0 ? 1e-30 : dx);
    const idy = 1 / (dy === 0 ? 1e-30 : dy);
    const idz = 1 / (dz === 0 ? 1e-30 : dz);
    const stack: Node[] = [this.root];
    while (stack.length > 0) {
      const n = stack.pop() as Node;
      let t0 = 0;
      let t1 = best;
      const lo = [n.min[0], n.min[1], n.min[2]] as const;
      const hi = [n.max[0], n.max[1], n.max[2]] as const;
      const o = [ox, oy, oz] as const;
      const inv = [idx, idy, idz] as const;
      let miss = false;
      for (let a = 0; a < 3; a++) {
        let ta = (lo[a] - o[a]) * inv[a];
        let tb = (hi[a] - o[a]) * inv[a];
        if (ta > tb) {
          const s = ta;
          ta = tb;
          tb = s;
        }
        t0 = Math.max(t0, ta - 1e-9);
        t1 = Math.min(t1, tb + 1e-9);
        if (t0 > t1) {
          miss = true;
          break;
        }
      }
      if (miss) continue;
      if (!n.left || !n.right) {
        for (let i = n.from; i < n.to; i++) {
          const v = this.triangle(this.order[i] as number);
          const t = rayTriangle(ox, oy, oz, dx, dy, dz, v);
          if (t > 0 && t <= best) {
            best = t;
            found = true;
          }
        }
      } else {
        stack.push(n.left, n.right);
      }
    }
    return found ? best : -1;
  }

  /** Number of surface crossings of the ray (used for the parity inside test; needs a closed mesh). */
  private crossings(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
    if (!this.root) return 0;
    let count = 0;
    const stack: Node[] = [this.root];
    while (stack.length > 0) {
      const n = stack.pop() as Node;
      if (!rayHitsBox(n, ox, oy, oz, dx, dy, dz)) continue;
      if (!n.left || !n.right) {
        for (let i = n.from; i < n.to; i++) {
          if (rayTriangle(ox, oy, oz, dx, dy, dz, this.triangle(this.order[i] as number)) > 0) count++;
        }
      } else {
        stack.push(n.left, n.right);
      }
    }
    return count;
  }

  /** True when the point is inside a closed mesh (parity of two skewed rays, the first one decides ties). */
  inside(x: number, y: number, z: number): boolean {
    const a = this.crossings(x, y, z, 0.5731, 0.3517, 0.7388) % 2 === 1;
    const b = this.crossings(x, y, z, -0.3141, 0.8123, -0.4931) % 2 === 1;
    if (a === b) return a;
    return this.crossings(x, y, z, 0.2113, -0.6791, 0.7031) % 2 === 1;
  }
}

function rayHitsBox(n: Node, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): boolean {
  let t0 = 0;
  let t1 = Infinity;
  const o = [ox, oy, oz] as const;
  const d = [dx, dy, dz] as const;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / (d[a] === 0 ? 1e-30 : d[a]);
    let ta = ((n.min[a] as number) - o[a]) * inv;
    let tb = ((n.max[a] as number) - o[a]) * inv;
    if (ta > tb) {
      const s = ta;
      ta = tb;
      tb = s;
    }
    t0 = Math.max(t0, ta - 1e-9);
    t1 = Math.min(t1, tb + 1e-9);
    if (t0 > t1) return false;
  }
  return true;
}

/** Möller-Trumbore; returns t > 0 or -1. */
function rayTriangle(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, v: readonly number[]): number {
  const e1x = (v[3] as number) - (v[0] as number), e1y = (v[4] as number) - (v[1] as number), e1z = (v[5] as number) - (v[2] as number);
  const e2x = (v[6] as number) - (v[0] as number), e2y = (v[7] as number) - (v[1] as number), e2z = (v[8] as number) - (v[2] as number);
  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const tx = ox - (v[0] as number), ty = oy - (v[1] as number), tz = oz - (v[2] as number);
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const w = (dx * qx + dy * qy + dz * qz) * inv;
  if (w < 0 || u + w > 1) return -1;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t > 1e-9 ? t : -1;
}

/** Brute-force closest point (reference for tests). */
export function closestBrute(positions: ArrayLike<number>, indices: ArrayLike<number>, x: number, y: number, z: number): { dist2: number; x: number; y: number; z: number } {
  let best = { dist2: Infinity, x: 0, y: 0, z: 0 };
  const out: [number, number, number] = [0, 0, 0];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = (indices[t] as number) * 3;
    const b = (indices[t + 1] as number) * 3;
    const c = (indices[t + 2] as number) * 3;
    closestPointOnTriangle(x, y, z, positions[a] as number, positions[a + 1] as number, positions[a + 2] as number, positions[b] as number, positions[b + 1] as number, positions[b + 2] as number, positions[c] as number, positions[c + 1] as number, positions[c + 2] as number, out);
    const d2 = (x - out[0]) ** 2 + (y - out[1]) ** 2 + (z - out[2]) ** 2;
    if (d2 < best.dist2) best = { dist2: d2, x: out[0], y: out[1], z: out[2] };
  }
  return best;
}
