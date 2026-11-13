/**
 * Pure buffer builders for the line / point / normal view modes (no three.js, fully unit-tested).
 * Every function returns tightly packed Float32Arrays that can go straight into a `LineSegmentsGeometry`
 * (`setPositions`, 6 floats per segment) or a `BufferGeometry` position attribute (3 floats per point).
 */

export interface SkeletonLike {
  readonly position: ArrayLike<number>;
  readonly branches: readonly { readonly start: number; readonly count: number; readonly generation: number }[];
}

export interface SegmentBuffers {
  /** 6 floats per segment: ax ay az bx by bz. */
  positions: Float32Array;
  /** 6 floats per segment (same colour for both ends). */
  colors: Float32Array;
  /** Skeleton point index pair of every segment, 2 per segment (for tests and picking). */
  indices: Uint32Array;
  segments: number;
}

/**
 * Centre-line segments of a skeleton: one segment between consecutive points of the SAME branch (never across a branch
 * boundary, so parent links of other branches cannot leak in), coloured by generation.
 */
export function buildSkeletonSegments(sk: SkeletonLike, colorOf: (generation: number) => readonly [number, number, number]): SegmentBuffers {
  let total = 0;
  for (const b of sk.branches) if (b.count >= 2) total += b.count - 1;
  const positions = new Float32Array(total * 6);
  const colors = new Float32Array(total * 6);
  const indices = new Uint32Array(total * 2);
  let s = 0;
  for (const b of sk.branches) {
    if (b.count < 2) continue;
    const [r, g, bl] = colorOf(b.generation);
    for (let k = 1; k < b.count; k++) {
      const i0 = b.start + k - 1;
      const i1 = b.start + k;
      const o = s * 6;
      for (let c = 0; c < 3; c++) {
        positions[o + c] = sk.position[i0 * 3 + c] as number;
        positions[o + 3 + c] = sk.position[i1 * 3 + c] as number;
      }
      colors[o] = colors[o + 3] = r;
      colors[o + 1] = colors[o + 4] = g;
      colors[o + 2] = colors[o + 5] = bl;
      indices[s * 2] = i0;
      indices[s * 2 + 1] = i1;
      s++;
    }
  }
  return { positions, colors, indices, segments: total };
}

export interface ElementOptions {
  /** Column-major 4x4 instance matrices (16 floats each). Absent = identity (one instance). */
  matrices?: ArrayLike<number>;
  instanceCount?: number;
  /** Upper bound of emitted elements: vertices are strided when the mesh is larger. */
  max?: number;
}

export interface NormalBuffers {
  positions: Float32Array;
  segments: number;
  /** Every `stride`-th vertex was drawn. */
  stride: number;
}

/**
 * Vertex normals as short segments `p -> p + n * length` in the space the matrices map to (world space for instanced
 * meshes). Normals are transformed with the cofactor matrix (inverse transpose up to scale) and re-normalised, so
 * rotated, scaled and mirrored instances are correct. Vertices with a zero / non-finite normal are skipped.
 */
export function buildNormalSegments(positions: ArrayLike<number>, normals: ArrayLike<number>, length: number, opts: ElementOptions = {}): NormalBuffers {
  const vCount = Math.min(Math.floor(positions.length / 3), Math.floor(normals.length / 3));
  const instances = opts.matrices ? Math.max(0, opts.instanceCount ?? Math.floor(opts.matrices.length / 16)) : 1;
  const total = vCount * instances;
  const max = Math.max(1, opts.max ?? 60000);
  const stride = Math.max(1, Math.ceil(total / max));
  const out = new Float32Array(Math.ceil(total / stride) * 6);
  let n = 0;
  let counter = 0;
  for (let inst = 0; inst < instances; inst++) {
    const m = opts.matrices;
    const o = inst * 16;
    for (let i = 0; i < vCount; i++, counter++) {
      if (counter % stride !== 0) continue;
      const px = positions[i * 3] as number;
      const py = positions[i * 3 + 1] as number;
      const pz = positions[i * 3 + 2] as number;
      let nx = normals[i * 3] as number;
      let ny = normals[i * 3 + 1] as number;
      let nz = normals[i * 3 + 2] as number;
      let wx = px;
      let wy = py;
      let wz = pz;
      if (m) {
        const a = (k: number): number => m[o + k] as number;
        wx = a(0) * px + a(4) * py + a(8) * pz + a(12);
        wy = a(1) * px + a(5) * py + a(9) * pz + a(13);
        wz = a(2) * px + a(6) * py + a(10) * pz + a(14);
        // cofactor of the upper 3x3 (columns c0 = (a0,a1,a2), c1 = (a4,a5,a6), c2 = (a8,a9,a10))
        const c0x = a(5) * a(10) - a(6) * a(9);
        const c0y = a(6) * a(8) - a(4) * a(10);
        const c0z = a(4) * a(9) - a(5) * a(8);
        const c1x = a(2) * a(9) - a(1) * a(10);
        const c1y = a(0) * a(10) - a(2) * a(8);
        const c1z = a(1) * a(8) - a(0) * a(9);
        const c2x = a(1) * a(6) - a(2) * a(5);
        const c2y = a(2) * a(4) - a(0) * a(6);
        const c2z = a(0) * a(5) - a(1) * a(4);
        const tx = c0x * nx + c1x * ny + c2x * nz;
        const ty = c0y * nx + c1y * ny + c2y * nz;
        const tz = c0z * nx + c1z * ny + c2z * nz;
        nx = tx;
        ny = ty;
        nz = tz;
      }
      const l = Math.hypot(nx, ny, nz);
      if (!(l > 1e-12) || !Number.isFinite(l) || !Number.isFinite(wx + wy + wz)) continue;
      const k = length / l;
      const w = n * 6;
      out[w] = wx;
      out[w + 1] = wy;
      out[w + 2] = wz;
      out[w + 3] = wx + nx * k;
      out[w + 4] = wy + ny * k;
      out[w + 5] = wz + nz * k;
      n++;
    }
  }
  return { positions: n * 6 === out.length ? out : out.slice(0, n * 6), segments: n, stride };
}

export interface PointBuffers {
  positions: Float32Array;
  count: number;
  stride: number;
}

/** Vertex positions (transformed by the instance matrices when given), strided to at most `max` points. */
export function buildPointPositions(positions: ArrayLike<number>, opts: ElementOptions = {}): PointBuffers {
  const vCount = Math.floor(positions.length / 3);
  const instances = opts.matrices ? Math.max(0, opts.instanceCount ?? Math.floor(opts.matrices.length / 16)) : 1;
  const total = vCount * instances;
  const max = Math.max(1, opts.max ?? 120000);
  const stride = Math.max(1, Math.ceil(total / max));
  const out = new Float32Array(Math.ceil(total / stride) * 3);
  let n = 0;
  let counter = 0;
  for (let inst = 0; inst < instances; inst++) {
    const m = opts.matrices;
    const o = inst * 16;
    for (let i = 0; i < vCount; i++, counter++) {
      if (counter % stride !== 0) continue;
      const px = positions[i * 3] as number;
      const py = positions[i * 3 + 1] as number;
      const pz = positions[i * 3 + 2] as number;
      if (m) {
        const a = (k: number): number => m[o + k] as number;
        out[n * 3] = a(0) * px + a(4) * py + a(8) * pz + a(12);
        out[n * 3 + 1] = a(1) * px + a(5) * py + a(9) * pz + a(13);
        out[n * 3 + 2] = a(2) * px + a(6) * py + a(10) * pz + a(14);
      } else {
        out[n * 3] = px;
        out[n * 3 + 1] = py;
        out[n * 3 + 2] = pz;
      }
      n++;
    }
  }
  return { positions: out.slice(0, n * 3), count: n, stride };
}
