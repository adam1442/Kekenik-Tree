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
}

export const newVertex = (): VertexAttrs => ({
  px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 1, tx: 1, ty: 0, tz: 0, tw: 1,
  u: 0, v: 0, u1: 0, v1: 0, r: 1, g: 1, b: 1, ao: 1,
  pvx: 0, pvy: 0, pvz: 0, w0: 0, w1: 0, w2: 0, w3: 0,
});

const STRIDE = 25;

/**
 * Growable interleaved vertex/index store. Triangles must be appended material-by-material
 * (call `beginSlot` before the first triangle of a material) so slots stay contiguous.
 */
export class MeshAccumulator {
  private data = new Float32Array(STRIDE * 1024);
  private idx = new Uint32Array(3 * 2048);
  private nv = 0;
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
    d[o++] = a.w0; d[o++] = a.w1; d[o++] = a.w2; d[o] = a.w3;
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
    }
    const indices = this.idx.slice(0, this.ni);
    const slots = this.slotList.length > 0 ? this.slotList.map((s) => ({ ...s })) : [{ materialId: defaultMaterial, indexStart: 0, indexCount: this.ni }];
    const mesh: MeshData = { positions, normals, tangents, uv0, uv1, colors, ao, indices, slots };
    if (withWind) mesh.wind = { pivot, weights };
    return mesh;
  }
}
