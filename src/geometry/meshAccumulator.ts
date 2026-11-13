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
