import type { CutoutMesh } from '@/contracts/material';
import { clamp } from '@/core/math';
import { perpendicular } from '@/geometry/math3';
import { buildCutoutGeometry } from '@/materials/cutouts/buildCutoutGeometry';
import { buildCutoutFrame, placedMetric } from '@/materials/cutouts/frame';

/**
 * Planar shape shared by the Decal and Fin generators: a triangulated patch in normalised plane coordinates (a across,
 * b along, both 0..1) with texture coordinates, a distance to the patch border and optional anchors.
 * The default shape is a regular grid; a cutout mesh gives its tight outline (refined so that it can follow a curved skin).
 * The generators map every vertex (a, b) onto the parent skin, so grid and cutout go through the very same code.
 */
export interface ShapeAnchor {
  a: number;
  b: number;
  /** Direction in the (a, b) plane (already divided by the extent of the shape, so it is a derivative). */
  dir: readonly [number, number];
  scale: number;
  id: string;
  index: number;
  axisT: number;
  tags: readonly string[];
}

export interface PlanarShape {
  count: number;
  a: Float32Array;
  b: Float32Array;
  /** Texture coordinates (the material is covered once by a grid; a cutout keeps its own UV layout). */
  u: Float32Array;
  v: Float32Array;
  /** Distance of every vertex to the nearest border edge in (a, b) units (0 on the border). */
  edge: Float32Array;
  /** Counter-clockwise in the (a, b) plane. */
  indices: Uint32Array;
  anchors: ShapeAnchor[];
  /** Texture U range (for mirroring a flipped patch). */
  uRange: readonly [number, number];
  /** True for the regular `(cellsA + 1) x (cellsB + 1)` grid (row-major, `k = j * (cellsA + 1) + i`). */
  grid: boolean;
}

/** Regular grid of `cellsA x cellsB` cells; `edge` is the distance to the nearest side of the unit square. */
export function gridShape(cellsA: number, cellsB: number): PlanarShape {
  const A = Math.max(1, Math.round(cellsA));
  const B = Math.max(1, Math.round(cellsB));
  const count = (A + 1) * (B + 1);
  const a = new Float32Array(count);
  const b = new Float32Array(count);
  const edge = new Float32Array(count);
  for (let j = 0; j <= B; j++) {
    for (let i = 0; i <= A; i++) {
      const k = j * (A + 1) + i;
      a[k] = i / A;
      b[k] = j / B;
      edge[k] = Math.min(a[k] as number, 1 - (a[k] as number), b[k] as number, 1 - (b[k] as number));
    }
  }
  const indices = new Uint32Array(A * B * 6);
  let t = 0;
  for (let j = 0; j < B; j++) {
    for (let i = 0; i < A; i++) {
      const v00 = j * (A + 1) + i;
      const v01 = v00 + (A + 1);
      indices.set([v00, v00 + 1, v01 + 1, v00, v01 + 1, v01], t);
      t += 6;
    }
  }
  return { count, a, b, u: a, v: b, edge, indices, anchors: [], uRange: [0, 1], grid: true };
}

const area2 = (s: { a: Float32Array; b: Float32Array }, i: number, j: number, k: number): number =>
  ((s.a[j] as number) - (s.a[i] as number)) * ((s.b[k] as number) - (s.b[i] as number)) - ((s.a[k] as number) - (s.a[i] as number)) * ((s.b[j] as number) - (s.b[i] as number));

/** One uniform midpoint split of every triangle (shared edge midpoints, so the mesh stays watertight). */
function splitAll(s: PlanarShape): PlanarShape {
  const tris = s.indices.length / 3;
  const mids = new Map<number, number>();
  const a = Array.from(s.a);
  const b = Array.from(s.b);
  const u = Array.from(s.u);
  const v = Array.from(s.v);
  const mid = (i: number, j: number): number => {
    const key = Math.min(i, j) * s.count + Math.max(i, j);
    const hit = mids.get(key);
    if (hit !== undefined) return hit;
    const n = a.length;
    a.push(((s.a[i] as number) + (s.a[j] as number)) / 2);
    b.push(((s.b[i] as number) + (s.b[j] as number)) / 2);
    u.push(((s.u[i] as number) + (s.u[j] as number)) / 2);
    v.push(((s.v[i] as number) + (s.v[j] as number)) / 2);
    mids.set(key, n);
    return n;
  };
  const out: number[] = [];
  for (let t = 0; t < tris; t++) {
    const i = s.indices[t * 3] as number;
    const j = s.indices[t * 3 + 1] as number;
    const k = s.indices[t * 3 + 2] as number;
    const ij = mid(i, j);
    const jk = mid(j, k);
    const ki = mid(k, i);
    out.push(i, ij, ki, ij, j, jk, ki, jk, k, ij, jk, ki);
  }
  return { ...s, count: a.length, a: Float32Array.from(a), b: Float32Array.from(b), u: Float32Array.from(u), v: Float32Array.from(v), edge: new Float32Array(a.length), indices: Uint32Array.from(out), grid: false };
}

const longestEdge = (s: PlanarShape, cellsA: number, cellsB: number): number => {
  let m = 0;
  for (let t = 0; t < s.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const i = s.indices[t + e] as number;
      const j = s.indices[t + ((e + 1) % 3)] as number;
      m = Math.max(m, Math.hypot(((s.a[i] as number) - (s.a[j] as number)) * cellsA, ((s.b[i] as number) - (s.b[j] as number)) * cellsB));
    }
  }
  return m;
};

/** Distance of every vertex to the nearest border edge (an edge used by exactly one triangle). */
function borderDistance(s: PlanarShape): Float32Array {
  const use = new Map<number, number>();
  const key = (i: number, j: number): number => Math.min(i, j) * s.count + Math.max(i, j);
  for (let t = 0; t < s.indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = key(s.indices[t + e] as number, s.indices[t + ((e + 1) % 3)] as number);
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  const segs: number[] = [];
  const onBorder = new Uint8Array(s.count);
  for (const [k, n] of use) {
    if (n !== 1) continue;
    const i = Math.floor(k / s.count);
    const j = k - i * s.count;
    segs.push(s.a[i] as number, s.b[i] as number, s.a[j] as number, s.b[j] as number);
    onBorder[i] = 1;
    onBorder[j] = 1;
  }
  const out = new Float32Array(s.count);
  for (let p = 0; p < s.count; p++) {
    if (onBorder[p] === 1) continue;
    const px = s.a[p] as number;
    const py = s.b[p] as number;
    let best = Infinity;
    for (let q = 0; q < segs.length; q += 4) {
      const x0 = segs[q] as number;
      const y0 = segs[q + 1] as number;
      const dx = (segs[q + 2] as number) - x0;
      const dy = (segs[q + 3] as number) - y0;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 1e-18 ? clamp(((px - x0) * dx + (py - y0) * dy) / l2, 0, 1) : 0;
      best = Math.min(best, Math.hypot(px - (x0 + dx * t), py - (y0 + dy * t)));
    }
    out[p] = Number.isFinite(best) ? best : 0;
  }
  return out;
}

/** Hard cap of triangles after the refinement of a cutout. */
export const MAX_SHAPE_TRIANGLES = 6000;

/**
 * Shape of a cutout mesh (its outline and interior triangulation at `lod`, straightened along its axis) normalised into
 * the unit square, refined until no edge is longer than one cell of a `cellsA x cellsB` grid. Imported 3D LOD meshes
 * are flattened (their X / Y plane is used). Returns null when the cutout has no usable geometry.
 */
export function cutoutShape(cutout: CutoutMesh, lod: number, width: number, length: number, cellsA: number, cellsB: number): PlanarShape | null {
  const geo = buildCutoutGeometry(cutout, lod, { width, length, metric: placedMetric(cutout, width, length), applyPanelTransform: false, origin: [0, 0, 0], axis: [0, 1, 0], side: [1, 0, 0] });
  const n = Math.floor(geo.positions.length / 3);
  if (n < 3 || geo.indices.length < 3) return null;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = geo.positions[i * 3] as number;
    const y = geo.positions[i * 3 + 1] as number;
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const sx = x1 - x0;
  const sy = y1 - y0;
  if (!(sx > 1e-9) || !(sy > 1e-9)) return null;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  let uLo = Infinity;
  let uHi = -Infinity;
  for (let i = 0; i < n; i++) {
    a[i] = ((geo.positions[i * 3] as number) - x0) / sx;
    b[i] = ((geo.positions[i * 3 + 1] as number) - y0) / sy;
    u[i] = geo.uv0[i * 2] as number;
    v[i] = geo.uv0[i * 2 + 1] as number;
    uLo = Math.min(uLo, u[i] as number);
    uHi = Math.max(uHi, u[i] as number);
  }
  const indices = Uint32Array.from(geo.indices);
  for (let t = 0; t + 2 < indices.length; t += 3) {
    if (area2({ a, b }, indices[t] as number, indices[t + 1] as number, indices[t + 2] as number) < 0) {
      const k = indices[t + 1] as number;
      indices[t + 1] = indices[t + 2] as number;
      indices[t + 2] = k;
    }
  }
  const frame = buildCutoutFrame(cutout, placedMetric(cutout, width, length));
  const anchors: ShapeAnchor[] = frame.anchors.map((an) => ({
    a: clamp(((an.localPosition[0] as number) - x0) / sx, 0, 1),
    b: clamp(((an.localPosition[1] as number) - y0) / sy, 0, 1),
    dir: [(an.localDirection[0] as number) / sx, (an.localDirection[1] as number) / sy],
    scale: an.scale,
    id: an.id,
    index: an.index,
    axisT: an.axisT,
    tags: an.tags,
  }));
  let shape: PlanarShape = { count: n, a, b, u, v, edge: new Float32Array(n), indices, anchors, uRange: [uLo, uHi], grid: false };
  for (let pass = 0; pass < 5; pass++) {
    if (longestEdge(shape, cellsA, cellsB) <= 1.25 || (shape.indices.length / 3) * 4 > MAX_SHAPE_TRIANGLES) break;
    shape = splitAll(shape);
  }
  shape.edge = borderDistance(shape);
  return shape;
}

/** Per-triangle derivatives of the position with respect to (a, b); null for a degenerate triangle in the plane. */
function triangleBasis(s: PlanarShape, pos: Float32Array, t: number, out: Float64Array): boolean {
  const i = s.indices[t * 3] as number;
  const j = s.indices[t * 3 + 1] as number;
  const k = s.indices[t * 3 + 2] as number;
  const da1 = (s.a[j] as number) - (s.a[i] as number);
  const db1 = (s.b[j] as number) - (s.b[i] as number);
  const da2 = (s.a[k] as number) - (s.a[i] as number);
  const db2 = (s.b[k] as number) - (s.b[i] as number);
  const det = da1 * db2 - da2 * db1;
  if (Math.abs(det) < 1e-14) return false;
  for (let c = 0; c < 3; c++) {
    const e1 = (pos[j * 3 + c] as number) - (pos[i * 3 + c] as number);
    const e2 = (pos[k * 3 + c] as number) - (pos[i * 3 + c] as number);
    out[c] = (e1 * db2 - e2 * db1) / det;
    out[3 + c] = (e2 * da1 - e1 * da2) / det;
  }
  return true;
}

/**
 * Normals and tangents of a mapped shape: area-weighted triangle normals, oriented to the same side as `reference`
 * (the host surface normal), tangents along increasing `a`, orthogonalised to the normal.
 */
export function shapeFrames(s: PlanarShape, pos: Float32Array, reference: Float32Array): { normals: Float32Array; tangents: Float32Array } {
  const nrm = new Float64Array(s.count * 3);
  const tan = new Float64Array(s.count * 3);
  const d = new Float64Array(6);
  for (let t = 0; t < s.indices.length / 3; t++) {
    const i = s.indices[t * 3] as number;
    const j = s.indices[t * 3 + 1] as number;
    const k = s.indices[t * 3 + 2] as number;
    const e1 = [0, 1, 2].map((c) => (pos[j * 3 + c] as number) - (pos[i * 3 + c] as number));
    const e2 = [0, 1, 2].map((c) => (pos[k * 3 + c] as number) - (pos[i * 3 + c] as number));
    const g = [(e1[1] as number) * (e2[2] as number) - (e1[2] as number) * (e2[1] as number), (e1[2] as number) * (e2[0] as number) - (e1[0] as number) * (e2[2] as number), (e1[0] as number) * (e2[1] as number) - (e1[1] as number) * (e2[0] as number)];
    const ok = triangleBasis(s, pos, t, d);
    const dl = ok ? Math.hypot(d[0] as number, d[1] as number, d[2] as number) : 0;
    const weight = Math.hypot(g[0] as number, g[1] as number, g[2] as number);
    for (const vi of [i, j, k]) {
      for (let c = 0; c < 3; c++) {
        nrm[vi * 3 + c] = (nrm[vi * 3 + c] as number) + (g[c] as number);
        if (dl > 0) tan[vi * 3 + c] = (tan[vi * 3 + c] as number) + ((d[c] as number) / dl) * weight;
      }
    }
  }
  const normals = new Float32Array(s.count * 3);
  const tangents = new Float32Array(s.count * 3);
  for (let p = 0; p < s.count; p++) {
    const rx = reference[p * 3] as number;
    const ry = reference[p * 3 + 1] as number;
    const rz = reference[p * 3 + 2] as number;
    let nx = nrm[p * 3] as number;
    let ny = nrm[p * 3 + 1] as number;
    let nz = nrm[p * 3 + 2] as number;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) {
      nx = rx;
      ny = ry;
      nz = rz;
    } else {
      nx /= l;
      ny /= l;
      nz /= l;
      if (nx * rx + ny * ry + nz * rz < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
    }
    normals.set([nx, ny, nz], p * 3);
    let tx = tan[p * 3] as number;
    let ty = tan[p * 3 + 1] as number;
    let tz = tan[p * 3 + 2] as number;
    const k = tx * nx + ty * ny + tz * nz;
    tx -= nx * k;
    ty -= ny * k;
    tz -= nz * k;
    const tl = Math.hypot(tx, ty, tz);
    if (tl > 1e-12) tangents.set([tx / tl, ty / tl, tz / tl], p * 3);
    else tangents.set(perpendicular([nx, ny, nz]), p * 3);
  }
  return { normals, tangents };
}

export interface ShapeSample {
  position: [number, number, number];
  normal: [number, number, number];
  dPda: [number, number, number];
  dPdb: [number, number, number];
}

/** Position, normal and position derivatives of a mapped shape at plane coordinates (a, b) (nearest triangle). */
export function shapeSampleAt(s: PlanarShape, pos: Float32Array, normals: Float32Array, a: number, b: number): ShapeSample | null {
  let best = -1;
  let bestOut = Infinity;
  let bw: [number, number, number] = [1, 0, 0];
  for (let t = 0; t < s.indices.length / 3; t++) {
    const i = s.indices[t * 3] as number;
    const j = s.indices[t * 3 + 1] as number;
    const k = s.indices[t * 3 + 2] as number;
    const det = ((s.a[j] as number) - (s.a[i] as number)) * ((s.b[k] as number) - (s.b[i] as number)) - ((s.a[k] as number) - (s.a[i] as number)) * ((s.b[j] as number) - (s.b[i] as number));
    if (Math.abs(det) < 1e-14) continue;
    const l1 = ((a - (s.a[i] as number)) * ((s.b[k] as number) - (s.b[i] as number)) - ((s.a[k] as number) - (s.a[i] as number)) * (b - (s.b[i] as number))) / det;
    const l2 = (((s.a[j] as number) - (s.a[i] as number)) * (b - (s.b[i] as number)) - (a - (s.a[i] as number)) * ((s.b[j] as number) - (s.b[i] as number))) / det;
    const w: [number, number, number] = [1 - l1 - l2, l1, l2];
    const outside = -Math.min(w[0], w[1], w[2]);
    if (outside < bestOut) {
      bestOut = outside;
      best = t;
      bw = w;
      if (outside <= 0) break;
    }
  }
  if (best < 0) return null;
  const d = new Float64Array(6);
  if (!triangleBasis(s, pos, best, d)) return null;
  const idx = [s.indices[best * 3] as number, s.indices[best * 3 + 1] as number, s.indices[best * 3 + 2] as number];
  const mix = (src: Float32Array): [number, number, number] => {
    const o: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) for (let q = 0; q < 3; q++) o[c] += (bw[q] as number) * (src[(idx[q] as number) * 3 + c] as number);
    return o;
  };
  return { position: mix(pos), normal: mix(normals), dPda: [d[0] as number, d[1] as number, d[2] as number], dPdb: [d[3] as number, d[4] as number, d[5] as number] };
}
