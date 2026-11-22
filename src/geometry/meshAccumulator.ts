import type { MaterialSlotRange, MeshData } from '@/contracts/mesh';

/** One vertex worth of every channel the builders write. */
export interface VertexAttrs {
  px: number; py: number; pz: number;
  nx: number; ny: number; nz: number;
  /** Tangent xyz + handedness. */
  tx: number; ty: number; tz: number; tw: number;
  u: number; v: number;
  u1: number; v1: number;
  r: number; g: number; b: number;
  ao: number;
  /** Wind pivot. */
  pvx: number; pvy: number; pvz: number;
  /** Wind weights (hierarchy 0..2, phase). */
  w0: number; w1: number; w2: number; w3: number;
  /** Weld blend (R13): blend 0 parent .. 1 child, parent UV, contrast, noise, active flag (0 = vertex is not blended). */
  wb: number; wu: number; wv: number; wc: number; wn: number; wa: number;
}

export const newVertex = (): VertexAttrs => ({
  px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1, tx: 1, ty: 0, tz: 0, tw: 1,
  u: 0, v: 0, u1: 0, v1: 0, r: 1, g: 1, b: 1, ao: 1,
  pvx: 0, pvy: 0, pvz: 0, w0: 0, w1: 0, w2: 0, w3: 0,
  wb: 0, wu: 0, wv: 0, wc: 0, wn: 0, wa: 0,
});

const STRIDE = 31;

/**
 * Growable interleaved vertex/index store. Triangles must be appended material-by-material
 * (call `beginSlot` before the first triangle of a material) so slots stay contiguous.
 */
export class MeshAccumulator {
  private data = new Float32Array(STRIDE * 1024);
  private idx = new Uint32Array(3 * 2048);
  private nv = 0;
  /** True once a vertex with the weld blend flag was added. */
  private weldUsed = false;
  private ni = 0;
  private readonly slotList: MaterialSlotRange[] = [];

  get vertexCount(): number {
    return this.nv;
  }
  get triangleCount(): number {
    return this.ni / 3;
  }

  beginSlot(materialId: string): void {
    this.closeSlot();
    this.slotList.push({ materialId, indexStart: this.ni, indexCount: 0 });
  }

  private closeSlot(): void {
    const last = this.slotList[this.slotList.length - 1];
    if (last) last.indexCount = this.ni - last.indexStart;
  }

  addVertex(a: VertexAttrs): number {
    if ((this.nv + 1) * STRIDE > this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    const d = this.data;
    let o = this.nv * STRIDE;
    d[o++] = a.px; d[o++] = a.py; d[o++] = a.pz;
    d[o++] = a.nx; d[o++] = a.ny; d[o++] = a.nz;
    d[o++] = a.tx; d[o++] = a.ty; d[o++] = a.tz; d[o++] = a.tw;
    d[o++] = a.u; d[o++] = a.v; d[o++] = a.u1; d[o++] = a.v1;
    d[o++] = a.r; d[o++] = a.g; d[o++] = a.b; d[o++] = a.ao;
    d[o++] = a.pvx; d[o++] = a.pvy; d[o++] = a.pvz;
    d[o++] = a.w0; d[o++] = a.w1; d[o++] = a.w2; d[o++] = a.w3;
    d[o++] = a.wb; d[o++] = a.wu; d[o++] = a.wv; d[o++] = a.wc; d[o++] = a.wn; d[o] = a.wa;
    if (a.wa > 0) this.weldUsed = true;
    return this.nv++;
  }

  addTriangle(a: number, b: number, c: number): void {
    if (this.ni + 3 > this.idx.length) {
      const next = new Uint32Array(this.idx.length * 2);
      next.set(this.idx);
      this.idx = next;
    }
    this.idx[this.ni++] = a;
    this.idx[this.ni++] = b;
    this.idx[this.ni++] = c;
  }

  /**
   * Mirror the vertices `[from, vertexCount)` across the plane through `origin` with unit `normal`. Normals and tangents
   * are reflected, the tangent handedness flips. The triangle order is NOT changed, so mirrored geometry has the
   * opposite winding until `fixWinding()` runs.
   */
  mirrorFrom(from: number, origin: readonly [number, number, number], normal: readonly [number, number, number]): void {
    const d = this.data;
    const [nx, ny, nz] = normal;
    for (let i = from; i < this.nv; i++) {
      const o = i * STRIDE;
      const k = ((d[o] as number) - origin[0]) * nx + ((d[o + 1] as number) - origin[1]) * ny + ((d[o + 2] as number) - origin[2]) * nz;
      d[o] = (d[o] as number) - 2 * k * nx;
      d[o + 1] = (d[o + 1] as number) - 2 * k * ny;
      d[o + 2] = (d[o + 2] as number) - 2 * k * nz;
      for (const c of [3, 6]) {
        const m = (d[o + c] as number) * nx + (d[o + c + 1] as number) * ny + (d[o + c + 2] as number) * nz;
        d[o + c] = (d[o + c] as number) - 2 * m * nx;
        d[o + c + 1] = (d[o + c + 1] as number) - 2 * m * ny;
        d[o + c + 2] = (d[o + c + 2] as number) - 2 * m * nz;
      }
      d[o + 9] = -(d[o + 9] as number);
    }
  }

  get indexCount(): number {
    return this.ni;
  }

  /** Calls `fn` for every vertex `[from, vertexCount)` with a reused attribute record; its changes are written back. */
  transformFrom(from: number, fn: (v: VertexAttrs, index: number) => void): void {
    const d = this.data;
    const v = newVertex();
    for (let i = from; i < this.nv; i++) {
      let o = i * STRIDE;
      v.px = d[o++] as number; v.py = d[o++] as number; v.pz = d[o++] as number;
      v.nx = d[o++] as number; v.ny = d[o++] as number; v.nz = d[o++] as number;
      v.tx = d[o++] as number; v.ty = d[o++] as number; v.tz = d[o++] as number; v.tw = d[o++] as number;
      v.u = d[o++] as number; v.v = d[o++] as number; v.u1 = d[o++] as number; v.v1 = d[o++] as number;
      v.r = d[o++] as number; v.g = d[o++] as number; v.b = d[o++] as number; v.ao = d[o++] as number;
      v.pvx = d[o++] as number; v.pvy = d[o++] as number; v.pvz = d[o++] as number;
      v.w0 = d[o++] as number; v.w1 = d[o++] as number; v.w2 = d[o++] as number; v.w3 = d[o++] as number;
      v.wb = d[o++] as number; v.wu = d[o++] as number; v.wv = d[o++] as number; v.wc = d[o++] as number; v.wn = d[o++] as number; v.wa = d[o] as number;
      fn(v, i);
      o = i * STRIDE;
      d[o++] = v.px; d[o++] = v.py; d[o++] = v.pz;
      d[o++] = v.nx; d[o++] = v.ny; d[o++] = v.nz;
      d[o++] = v.tx; d[o++] = v.ty; d[o++] = v.tz; d[o++] = v.tw;
      d[o++] = v.u; d[o++] = v.v; d[o++] = v.u1; d[o++] = v.v1;
      d[o++] = v.r; d[o++] = v.g; d[o++] = v.b; d[o++] = v.ao;
      d[o++] = v.pvx; d[o++] = v.pvy; d[o++] = v.pvz;
      d[o++] = v.w0; d[o++] = v.w1; d[o++] = v.w2; d[o++] = v.w3;
      d[o++] = v.wb; d[o++] = v.wu; d[o++] = v.wv; d[o++] = v.wc; d[o++] = v.wn; d[o] = v.wa;
    }
  }

  /**
   * Splits every triangle of the index range `[fromIndex, indexCount)` into four (edge midpoints are shared, every
   * channel is interpolated linearly). Vertices created are appended; the original triangles are replaced.
   */
  subdivideFrom(fromIndex: number): void {
    const tris: number[] = [];
    for (let i = fromIndex; i < this.ni; i++) tris.push(this.idx[i] as number);
    this.ni = fromIndex;
    const mids = new Map<number, number>();
    const mid = (a: number, b: number): number => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = lo * 4_294_967_296 + hi;
      const known = mids.get(key);
      if (known !== undefined) return known;
      const v = newVertex();
      const make = (i: number): number[] => Array.from(this.data.subarray(i * STRIDE, (i + 1) * STRIDE));
      const A = make(a);
      const B = make(b);
      const m = A.map((x, k) => (x + (B[k] as number)) / 2);
      let o = 0;
      v.px = m[o++] as number; v.py = m[o++] as number; v.pz = m[o++] as number;
      v.nx = m[o++] as number; v.ny = m[o++] as number; v.nz = m[o++] as number;
      v.tx = m[o++] as number; v.ty = m[o++] as number; v.tz = m[o++] as number; v.tw = A[o++] as number;
      v.u = m[o++] as number; v.v = m[o++] as number; v.u1 = m[o++] as number; v.v1 = m[o++] as number;
      v.r = m[o++] as number; v.g = m[o++] as number; v.b = m[o++] as number; v.ao = m[o++] as number;
      v.pvx = m[o++] as number; v.pvy = m[o++] as number; v.pvz = m[o++] as number;
      v.w0 = m[o++] as number; v.w1 = m[o++] as number; v.w2 = m[o++] as number; v.w3 = m[o++] as number;
      v.wb = m[o++] as number; v.wu = m[o++] as number; v.wv = m[o++] as number; v.wc = m[o++] as number; v.wn = m[o++] as number; v.wa = A[o] as number;
      const index = this.addVertex(v);
      mids.set(key, index);
      return index;
    };
    for (let t = 0; t + 2 < tris.length; t += 3) {
      const a = tris[t] as number;
      const b = tris[t + 1] as number;
      const c = tris[t + 2] as number;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      this.addTriangle(a, ab, ca);
      this.addTriangle(ab, b, bc);
      this.addTriangle(ca, bc, c);
      this.addTriangle(ab, bc, ca);
    }
  }

  /**
   * Recomputes smooth normals of the vertices `[fromVertex, vertexCount)` from the triangles of `[fromIndex, indexCount)`
   * (area weighted). A new normal keeps the side of the old one; tangents are re-orthogonalised to it.
   */
  recomputeNormalsFrom(fromVertex: number, fromIndex: number): void {
    const d = this.data;
    const n = this.nv - fromVertex;
    if (n <= 0) return;
    const acc = new Float64Array(n * 3);
    for (let t = fromIndex; t + 2 < this.ni; t += 3) {
      const a = (this.idx[t] as number) * STRIDE;
      const b = (this.idx[t + 1] as number) * STRIDE;
      const c = (this.idx[t + 2] as number) * STRIDE;
      const e1x = (d[b] as number) - (d[a] as number);
      const e1y = (d[b + 1] as number) - (d[a + 1] as number);
      const e1z = (d[b + 2] as number) - (d[a + 2] as number);
      const e2x = (d[c] as number) - (d[a] as number);
      const e2y = (d[c + 1] as number) - (d[a + 1] as number);
      const e2z = (d[c + 2] as number) - (d[a + 2] as number);
      const gx = e1y * e2z - e1z * e2y;
      const gy = e1z * e2x - e1x * e2z;
      const gz = e1x * e2y - e1y * e2x;
      for (let k = 0; k < 3; k++) {
        const vi = (this.idx[t + k] as number) - fromVertex;
        if (vi < 0 || vi >= n) continue;
        acc[vi * 3] = (acc[vi * 3] as number) + gx;
        acc[vi * 3 + 1] = (acc[vi * 3 + 1] as number) + gy;
        acc[vi * 3 + 2] = (acc[vi * 3 + 2] as number) + gz;
      }
    }
    for (let i = 0; i < n; i++) {
      const o = (fromVertex + i) * STRIDE;
      let nx = acc[i * 3] as number;
      let ny = acc[i * 3 + 1] as number;
      let nz = acc[i * 3 + 2] as number;
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-18) continue;
      nx /= l; ny /= l; nz /= l;
      if (nx * (d[o + 3] as number) + ny * (d[o + 4] as number) + nz * (d[o + 5] as number) < 0) {
        nx = -nx; ny = -ny; nz = -nz;
      }
      d[o + 3] = nx; d[o + 4] = ny; d[o + 5] = nz;
      const tx = d[o + 6] as number;
      const ty = d[o + 7] as number;
      const tz = d[o + 8] as number;
      const k = tx * nx + ty * ny + tz * nz;
      const ox = tx - nx * k;
      const oy = ty - ny * k;
      const oz = tz - nz * k;
      const ol = Math.hypot(ox, oy, oz);
      if (ol > 1e-9) {
        d[o + 6] = ox / ol; d[o + 7] = oy / ol; d[o + 8] = oz / ol;
      }
    }
  }

  /** Flip every triangle whose winding disagrees with its (summed) vertex normals. Returns the number of flipped triangles. */
  fixWinding(): number {
    const d = this.data;
    const idx = this.idx;
    let flipped = 0;
    for (let t = 0; t + 2 < this.ni; t += 3) {
      const a = (idx[t] as number) * STRIDE;
      const b = (idx[t + 1] as number) * STRIDE;
      const c = (idx[t + 2] as number) * STRIDE;
      const e1x = (d[b] as number) - (d[a] as number);
      const e1y = (d[b + 1] as number) - (d[a + 1] as number);
      const e1z = (d[b + 2] as number) - (d[a + 2] as number);
      const e2x = (d[c] as number) - (d[a] as number);
      const e2y = (d[c + 1] as number) - (d[a + 1] as number);
      const e2z = (d[c + 2] as number) - (d[a + 2] as number);
      const gx = e1y * e2z - e1z * e2y;
      const gy = e1z * e2x - e1x * e2z;
      const gz = e1x * e2y - e1y * e2x;
      const sx = (d[a + 3] as number) + (d[b + 3] as number) + (d[c + 3] as number);
      const sy = (d[a + 4] as number) + (d[b + 4] as number) + (d[c + 4] as number);
      const sz = (d[a + 5] as number) + (d[b + 5] as number) + (d[c + 5] as number);
      if (gx * sx + gy * sy + gz * sz < 0) {
        const tmp = idx[t + 1] as number;
        idx[t + 1] = idx[t + 2] as number;
        idx[t + 2] = tmp;
        flipped += 1;
      }
    }
    return flipped;
  }

  build(defaultMaterial: string, withWind: boolean): MeshData {
    this.closeSlot();
    const n = this.nv;
    const positions = new Float32Array(n * 3);
    const normals = new Float32Array(n * 3);
    const tangents = new Float32Array(n * 4);
    const uv0 = new Float32Array(n * 2);
    const uv1 = new Float32Array(n * 2);
    const colors = new Float32Array(n * 4);
    const ao = new Float32Array(n);
    const pivot = new Float32Array(withWind ? n * 3 : 0);
    const weights = new Float32Array(withWind ? n * 4 : 0);
    const weldOn = this.weldUsed;
    const wBlend = new Float32Array(weldOn ? n : 0);
    const wUv = new Float32Array(weldOn ? n * 2 : 0);
    const wStyle = new Float32Array(weldOn ? n * 3 : 0);
    const d = this.data;
    for (let i = 0; i < n; i++) {
      const o = i * STRIDE;
      positions[i * 3] = d[o] as number;
      positions[i * 3 + 1] = d[o + 1] as number;
      positions[i * 3 + 2] = d[o + 2] as number;
      normals[i * 3] = d[o + 3] as number;
      normals[i * 3 + 1] = d[o + 4] as number;
      normals[i * 3 + 2] = d[o + 5] as number;
      tangents[i * 4] = d[o + 6] as number;
      tangents[i * 4 + 1] = d[o + 7] as number;
      tangents[i * 4 + 2] = d[o + 8] as number;
      tangents[i * 4 + 3] = d[o + 9] as number;
      uv0[i * 2] = d[o + 10] as number;
      uv0[i * 2 + 1] = d[o + 11] as number;
      uv1[i * 2] = d[o + 12] as number;
      uv1[i * 2 + 1] = d[o + 13] as number;
      colors[i * 4] = d[o + 14] as number;
      colors[i * 4 + 1] = d[o + 15] as number;
      colors[i * 4 + 2] = d[o + 16] as number;
      colors[i * 4 + 3] = 1;
      ao[i] = d[o + 17] as number;
      if (withWind) {
        pivot[i * 3] = d[o + 18] as number;
        pivot[i * 3 + 1] = d[o + 19] as number;
        pivot[i * 3 + 2] = d[o + 20] as number;
        weights[i * 4] = d[o + 21] as number;
        weights[i * 4 + 1] = d[o + 22] as number;
        weights[i * 4 + 2] = d[o + 23] as number;
        weights[i * 4 + 3] = d[o + 24] as number;
      }
      if (weldOn) {
        wBlend[i] = d[o + 25] as number;
        wUv[i * 2] = d[o + 26] as number;
        wUv[i * 2 + 1] = d[o + 27] as number;
        wStyle[i * 3] = d[o + 28] as number;
        wStyle[i * 3 + 1] = d[o + 29] as number;
        wStyle[i * 3 + 2] = d[o + 30] as number;
      }
    }
    const indices = this.idx.slice(0, this.ni);
    const slots = this.slotList.length > 0 ? this.slotList.map((s) => ({ ...s })) : [{ materialId: defaultMaterial, indexStart: 0, indexCount: this.ni }];
    const mesh: MeshData = { positions, normals, tangents, uv0, uv1, colors, ao, indices, slots };
    if (withWind) mesh.wind = { pivot, weights };
    if (weldOn) mesh.weld = { blend: wBlend, parentUv: wUv, style: wStyle };
    return mesh;
  }
}
