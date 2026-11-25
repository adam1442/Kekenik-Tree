import type { MeshData } from '@/contracts/mesh';
import { summarize, type Summary } from './stats';

/**
 * Surface roughness numbers of a (bark) triangle mesh. Everything is measured on the welded surface (UV / normal seams are merged
 * by position) and on FACE normals, so it describes the geometry, not the shading.
 */
export interface SurfaceMetrics {
  vertices: number;
  triangles: number;
  /** Edges shared by exactly two triangles (the ones a dihedral angle exists for). */
  edges: number;
  /** Dihedral angle statistics in degrees (0 = flat, 180 = folded back). */
  dihedral: { mean: number; p50: number; p95: number; max: number };
  /** Fraction of edges whose dihedral angle is below `softAngleDeg` (1 = every edge is smooth: "soft tube"). */
  softnessIndex: number;
  softAngleDeg: number;
  /** Per patch of about `patchSize` metres: 1 - |mean face normal| (0 = flat patch, grows with bumpiness). */
  normalVariance: { patches: number; mean: number; p95: number };
  patchSize: number;
  /** Edge length statistics in metres. */
  edgeLength: Summary;
  /** Welded vertices per metre of the given axis polyline (0 when no axis is given). */
  verticesPerMetre: number;
}

export interface SurfaceOptions {
  /** Edges below this dihedral angle count as soft (default 3 degrees). */
  softAngleDeg?: number;
  /** Patch edge length for the normal variance (default 0.1 m). */
  patchSize?: number;
  /** Weld tolerance in metres (default 1e-5). */
  weldTolerance?: number;
  /** Centre line (xyz triples) + radius per point of the trunk: verticesPerMetre counts vertices within 1.5 radii of it. */
  axis?: { points: ArrayLike<number>; radius: ArrayLike<number> };
}

const DEG = 180 / Math.PI;

/** Welds the vertices of one or several meshes by position; returns welded positions and the welded triangle list. */
export function weldMeshes(input: MeshData | readonly MeshData[], tolerance = 1e-5): { positions: Float64Array; triangles: Uint32Array } {
  const list = Array.isArray(input) ? (input as readonly MeshData[]) : [input as MeshData];
  const cell = new Map<string, number>();
  const pos: number[] = [];
  const tris: number[] = [];
  for (const m of list) {
    const map = new Int32Array(m.positions.length / 3);
    for (let i = 0; i < map.length; i++) {
      const x = m.positions[i * 3] as number;
      const y = m.positions[i * 3 + 1] as number;
      const z = m.positions[i * 3 + 2] as number;
      const key = `${Math.round(x / tolerance)},${Math.round(y / tolerance)},${Math.round(z / tolerance)}`;
      let w = cell.get(key);
      if (w === undefined) {
        w = pos.length / 3;
        cell.set(key, w);
        pos.push(x, y, z);
      }
      map[i] = w;
    }
    for (let t = 0; t + 2 < m.indices.length; t += 3) {
      const a = map[m.indices[t] as number] as number;
      const b = map[m.indices[t + 1] as number] as number;
      const c = map[m.indices[t + 2] as number] as number;
      if (a !== b && b !== c && a !== c) tris.push(a, b, c);
    }
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris) };
}

export function surfaceMetrics(input: MeshData | readonly MeshData[], options: SurfaceOptions = {}): SurfaceMetrics {
  const softAngleDeg = options.softAngleDeg ?? 3;
  const patchSize = options.patchSize ?? 0.1;
  const { positions: pos, triangles: tri } = weldMeshes(input, options.weldTolerance ?? 1e-5);
  const nv = pos.length / 3;
  const nt = tri.length / 3;
  const fn = new Float64Array(nt * 3);
  const valid = new Uint8Array(nt);
  const edgeFaces = new Map<number, number[]>();
  const edgeLengths = new Map<number, number>();
  const base = nv + 1;
  for (let t = 0; t < nt; t++) {
    const a = tri[t * 3] as number;
    const b = tri[t * 3 + 1] as number;
    const c = tri[t * 3 + 2] as number;
    const ux = (pos[b * 3] as number) - (pos[a * 3] as number);
    const uy = (pos[b * 3 + 1] as number) - (pos[a * 3 + 1] as number);
    const uz = (pos[b * 3 + 2] as number) - (pos[a * 3 + 2] as number);
    const vx = (pos[c * 3] as number) - (pos[a * 3] as number);
    const vy = (pos[c * 3 + 1] as number) - (pos[a * 3 + 1] as number);
    const vz = (pos[c * 3 + 2] as number) - (pos[a * 3 + 2] as number);
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-18) continue;
    valid[t] = 1;
    fn[t * 3] = nx / l;
    fn[t * 3 + 1] = ny / l;
    fn[t * 3 + 2] = nz / l;
    const ends: [number, number][] = [[a, b], [b, c], [c, a]];
    for (const [p, q] of ends) {
      const key = p < q ? p * base + q : q * base + p;
      const list = edgeFaces.get(key);
      if (list) list.push(t);
      else {
        edgeFaces.set(key, [t]);
        edgeLengths.set(key, Math.hypot((pos[p * 3] as number) - (pos[q * 3] as number), (pos[p * 3 + 1] as number) - (pos[q * 3 + 1] as number), (pos[p * 3 + 2] as number) - (pos[q * 3 + 2] as number)));
      }
    }
  }

  const angles: number[] = [];
  let soft = 0;
  for (const faces of edgeFaces.values()) {
    if (faces.length !== 2) continue;
    const f0 = faces[0] as number;
    const f1 = faces[1] as number;
    const d = (fn[f0 * 3] as number) * (fn[f1 * 3] as number) + (fn[f0 * 3 + 1] as number) * (fn[f1 * 3 + 1] as number) + (fn[f0 * 3 + 2] as number) * (fn[f1 * 3 + 2] as number);
    const ang = Math.acos(Math.min(1, Math.max(-1, d))) * DEG;
    angles.push(ang);
    if (ang < softAngleDeg) soft++;
  }
  const dih = summarize(angles);

  // Normal variance per patch (triangle centroids binned into patchSize cells)
  const patches = new Map<string, { n: number; x: number; y: number; z: number }>();
  for (let t = 0; t < nt; t++) {
    if (!valid[t]) continue;
    const a = tri[t * 3] as number;
    const b = tri[t * 3 + 1] as number;
    const c = tri[t * 3 + 2] as number;
    const cx = ((pos[a * 3] as number) + (pos[b * 3] as number) + (pos[c * 3] as number)) / 3;
    const cy = ((pos[a * 3 + 1] as number) + (pos[b * 3 + 1] as number) + (pos[c * 3 + 1] as number)) / 3;
    const cz = ((pos[a * 3 + 2] as number) + (pos[b * 3 + 2] as number) + (pos[c * 3 + 2] as number)) / 3;
    const key = `${Math.floor(cx / patchSize)},${Math.floor(cy / patchSize)},${Math.floor(cz / patchSize)}`;
    const p = patches.get(key) ?? { n: 0, x: 0, y: 0, z: 0 };
    p.n++;
    p.x += fn[t * 3] as number;
    p.y += fn[t * 3 + 1] as number;
    p.z += fn[t * 3 + 2] as number;
    patches.set(key, p);
  }
  const variances: number[] = [];
  for (const p of patches.values()) if (p.n >= 4) variances.push(1 - Math.hypot(p.x, p.y, p.z) / p.n);
  const nvar = summarize(variances);

  let perMetre = 0;
  const axis = options.axis;
  if (axis && axis.points.length >= 6) {
    let length = 0;
    for (let i = 3; i + 2 < axis.points.length; i += 3) {
      length += Math.hypot((axis.points[i] as number) - (axis.points[i - 3] as number), (axis.points[i + 1] as number) - (axis.points[i - 2] as number), (axis.points[i + 2] as number) - (axis.points[i - 1] as number));
    }
    let maxR = 0;
    for (let i = 0; i < axis.radius.length; i++) maxR = Math.max(maxR, axis.radius[i] as number);
    const near = nearAxisCounter(axis.points, 1.5 * maxR);
    let count = 0;
    for (let v = 0; v < nv; v++) if (near(pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number)) count++;
    perMetre = length > 0 ? count / length : 0;
  }

  return {
    vertices: nv,
    triangles: nt,
    edges: angles.length,
    dihedral: { mean: dih.mean, p50: dih.p50, p95: dih.p95, max: dih.max },
    softnessIndex: angles.length > 0 ? soft / angles.length : 0,
    softAngleDeg,
    normalVariance: { patches: variances.length, mean: nvar.mean, p95: nvar.p95 },
    patchSize,
    edgeLength: summarize(Array.from(edgeLengths.values())),
    verticesPerMetre: perMetre,
  };
}

function nearAxisCounter(points: ArrayLike<number>, radius: number): (x: number, y: number, z: number) => boolean {
  const n = Math.floor(points.length / 3);
  return (x, y, z) => {
    for (let i = 0; i + 1 < n; i++) {
      const ax = points[i * 3] as number;
      const ay = points[i * 3 + 1] as number;
      const az = points[i * 3 + 2] as number;
      const dx = (points[i * 3 + 3] as number) - ax;
      const dy = (points[i * 3 + 4] as number) - ay;
      const dz = (points[i * 3 + 5] as number) - az;
      const l2 = dx * dx + dy * dy + dz * dz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / l2)) : 0;
      if (Math.hypot(x - ax - dx * t, y - ay - dy * t, z - az - dz * t) <= radius) return true;
    }
    return false;
  };
}
