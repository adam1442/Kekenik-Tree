import { windPhase1Array, type MeshData } from '@/contracts/mesh';
import { expandInstances } from '@/geometry/instancing';
import type { WindParams } from './windParams';
import { windDisplacement } from './windReference';

/**
 * Wind-seam audit (pure, no DOM). Finds places where two vertices of the final plant geometry sit at the same rest position (or
 * nearly so, on different generators) and measures how far apart the CPU reference wind (`windReference.ts`) moves them. A seam
 * that tears in the viewport shows up here as a gap > 0. Used by tests/windSeams.test.ts and available for debugging.
 */

/** A generator's vertex range inside the merged plant geometry. */
export interface WindAuditGroup {
  id: string;
  start: number;
  count: number;
}

/** Merged plant geometry with wind data (what the exporter / viewport upload). */
export interface WindAuditMesh {
  positions: Float32Array;
  /** (w0, w1, w2, phase) per vertex. */
  weights: Float32Array;
  /** Level-1 phase per vertex; absent = `weights[i * 4 + 3]`. */
  phase1?: Float32Array;
  indices?: Uint32Array;
  groups: readonly WindAuditGroup[];
}

export interface WindAuditOptions {
  /** Tree height in metres (scales the wind amplitude); default: the vertical extent of the mesh. */
  height?: number;
  /** Simulation times (seconds * speed); default: `samples` times spread over 12 s. */
  times?: readonly number[];
  samples?: number;
  /** Vertices closer than this coincide (default 1e-4 m). */
  coincident?: number;
  /** Vertices of different groups closer than this are "near contact" (default 2e-3 m). */
  contact?: number;
  /** > 0: also compare every vertex with the surface (triangles) of other groups within this distance (needs `indices`). */
  surface?: number;
  /** Safety cap on the number of audited pairs per category (default 400000). */
  maxPairs?: number;
}

export interface WindAuditWorst {
  position: [number, number, number];
  gap: number;
  /** Group ids of the two vertices (equal for a seam inside one generator). */
  a: string;
  b: string;
  time: number;
  /** (w0, w1, w2, phase, phase1) of the two vertices (the surface pass reports the vertex and the nearest triangle corner). */
  weightsA: number[];
  weightsB: number[];
}

export interface WindAuditPairStat {
  pairs: number;
  maxGap: number;
  worst?: WindAuditWorst;
}

export interface WindAuditResult {
  height: number;
  /** Largest displacement of any audited vertex (sanity: 0 means the wind is off or the weights are all zero). */
  maxDisplacement: number;
  /** Coincident pairs (rest distance < `coincident`), any groups. */
  coincident: { pairs: number; maxGap: number; meanGap: number; worst: WindAuditWorst | null };
  /** Pairs of DIFFERENT groups closer than `contact` (leaf base on twig...): absolute and relative gap. */
  contact: { pairs: number; maxGap: number; meanGap: number; maxRelGap: number; worst: WindAuditWorst | null };
  /** Vertex vs triangle of another group within `surface` (weld rings on the parent skin); empty when `surface` is 0. */
  surface: { pairs: number; maxGap: number; meanGap: number; worst: WindAuditWorst | null };
  /** Max gap per unordered group pair, key `"a|b"` (a <= b); seams inside one generator use `"a|a"`. */
  byGroups: Record<string, WindAuditPairStat>;
}

/** Merges named meshes (instances expanded) into one audit mesh; groups follow the order of `parts`. */
export function windAuditMeshFromParts(parts: readonly { id: string; mesh: MeshData }[]): WindAuditMesh {
  const list = parts.map((p) => ({ id: p.id, mesh: expandInstances(p.mesh) })).filter((p) => p.mesh.wind && p.mesh.positions.length > 0);
  const total = list.reduce((s, p) => s + p.mesh.positions.length / 3, 0);
  const idxTotal = list.reduce((s, p) => s + p.mesh.indices.length, 0);
  const positions = new Float32Array(total * 3);
  const weights = new Float32Array(total * 4);
  const phase1 = new Float32Array(total);
  const indices = new Uint32Array(idxTotal);
  const groups: WindAuditGroup[] = [];
  let v = 0;
  let ix = 0;
  for (const p of list) {
    const n = p.mesh.positions.length / 3;
    positions.set(p.mesh.positions, v * 3);
    const w = p.mesh.wind;
    if (w) {
      weights.set(w.weights.subarray(0, n * 4), v * 4);
      phase1.set(windPhase1Array(w).subarray(0, n), v);
    }
    for (let k = 0; k < p.mesh.indices.length; k++) indices[ix + k] = (p.mesh.indices[k] as number) + v;
    groups.push({ id: p.id, start: v, count: n });
    v += n;
    ix += p.mesh.indices.length;
  }
  return { positions, weights, phase1, indices, groups };
}

const DEFAULT_TIMES = 8;

function hashCell(x: number, y: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) | 0;
}

/** Runs the audit. */
export function auditWindSeams(mesh: WindAuditMesh, wind: WindParams, options: WindAuditOptions = {}): WindAuditResult {
  const n = Math.floor(mesh.positions.length / 3);
  const pos = mesh.positions;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const z = pos[i * 3 + 2] as number;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
  }
  const height = Math.max(0.5, options.height ?? (n > 0 ? zMax - Math.min(0, zMin) : 1));
  const samples = Math.max(1, options.samples ?? DEFAULT_TIMES);
  const times = options.times ?? Array.from({ length: samples }, (_, k) => 0.37 + (k * 11.6) / samples);
  const co = options.coincident ?? 1e-4;
  const contact = Math.max(co, options.contact ?? 2e-3);
  const surfaceDist = options.surface ?? 0;
  const maxPairs = options.maxPairs ?? 400000;

  const groupOf = new Uint16Array(n);
  mesh.groups.forEach((g, gi) => groupOf.fill(gi, g.start, g.start + g.count));
  const idOf = (v: number): string => mesh.groups[groupOf[v] as number]?.id ?? '?';

  const hasTime = times.length > 0;
  /** Displacement of vertex `v` at every time (3 floats per time); recomputed on demand (cheap, keeps memory flat on big plants). */
  const dispOf = (v: number): Float64Array => {
    const out = new Float64Array(times.length * 3);
    const w = mesh.weights;
    const wv = { position: [pos[v * 3] as number, pos[v * 3 + 1] as number, pos[v * 3 + 2] as number] as const, weights: [w[v * 4] as number, w[v * 4 + 1] as number, w[v * 4 + 2] as number, w[v * 4 + 3] as number] as const, phase1: mesh.phase1 ? (mesh.phase1[v] as number) : (w[v * 4 + 3] as number) };
    times.forEach((t, k) => {
      const d = windDisplacement(wind, wv, t, height);
      out[k * 3] = d[0];
      out[k * 3 + 1] = d[1];
      out[k * 3 + 2] = d[2];
    });
    for (let k = 0; k < out.length; k += 3) res.maxDisplacement = Math.max(res.maxDisplacement, Math.hypot(out[k] as number, out[k + 1] as number, out[k + 2] as number));
    return out;
  };
  const gapBetween = (a: Float64Array, b: Float64Array): { gap: number; at: number; mag: number } => {
    let gap = 0;
    let at = 0;
    let mag = 0;
    for (let k = 0; k < times.length; k++) {
      const g = Math.hypot((a[k * 3] as number) - (b[k * 3] as number), (a[k * 3 + 1] as number) - (b[k * 3 + 1] as number), (a[k * 3 + 2] as number) - (b[k * 3 + 2] as number));
      if (g > gap) {
        gap = g;
        at = k;
      }
      mag = Math.max(mag, Math.hypot(a[k * 3] as number, a[k * 3 + 1] as number, a[k * 3 + 2] as number), Math.hypot(b[k * 3] as number, b[k * 3 + 1] as number, b[k * 3 + 2] as number));
    }
    return { gap, at, mag };
  };

  const weightsOf = (v: number): number[] => [
    mesh.weights[v * 4] as number,
    mesh.weights[v * 4 + 1] as number,
    mesh.weights[v * 4 + 2] as number,
    mesh.weights[v * 4 + 3] as number,
    mesh.phase1 ? (mesh.phase1[v] as number) : (mesh.weights[v * 4 + 3] as number),
  ];
  const res: WindAuditResult = {
    height,
    maxDisplacement: 0,
    coincident: { pairs: 0, maxGap: 0, meanGap: 0, worst: null },
    contact: { pairs: 0, maxGap: 0, meanGap: 0, maxRelGap: 0, worst: null },
    surface: { pairs: 0, maxGap: 0, meanGap: 0, worst: null },
    byGroups: {},
  };
  if (n === 0 || !hasTime) return res;
  const sums = { coincident: 0, contact: 0, surface: 0 };
  const note = (key: 'coincident' | 'contact' | 'surface', gap: number, at: number, a: number, b: number, p: [number, number, number]): void => {
    const s = res[key];
    s.pairs++;
    sums[key] += gap;
    if (gap >= s.maxGap || !s.worst) {
      s.maxGap = gap;
      s.worst = { position: p, gap, a: idOf(a), b: idOf(b), time: times[at] as number, weightsA: weightsOf(a), weightsB: weightsOf(b) };
    }
    const ia = idOf(a);
    const ib = idOf(b);
    const gk = ia <= ib ? `${ia}|${ib}` : `${ib}|${ia}`;
    const stat = res.byGroups[gk] ?? (res.byGroups[gk] = { pairs: 0, maxGap: 0 });
    stat.pairs++;
    if (gap > stat.maxGap || !stat.worst) {
      stat.maxGap = Math.max(gap, stat.maxGap);
      stat.worst = { position: p, gap, a: ia, b: ib, time: times[at] as number, weightsA: weightsOf(a), weightsB: weightsOf(b) };
    }
  };

  // Spatial hash of all vertices; cell size = the contact radius, so neighbours are in the 27 surrounding cells.
  const cell = contact;
  const grid = new Map<number, number[]>();
  const cellOf = (v: number): [number, number, number] => [Math.floor((pos[v * 3] as number) / cell), Math.floor((pos[v * 3 + 1] as number) / cell), Math.floor((pos[v * 3 + 2] as number) / cell)];
  for (let v = 0; v < n; v++) {
    const [cx, cy, cz] = cellOf(v);
    const k = hashCell(cx, cy, cz);
    const list = grid.get(k);
    if (list) list.push(v);
    else grid.set(k, [v]);
  }
  const co2 = co * co;
  const ct2 = contact * contact;
  let budget = maxPairs;
  for (let v = 0; v < n && budget > 0; v++) {
    const [cx, cy, cz] = cellOf(v);
    const px = pos[v * 3] as number;
    const py = pos[v * 3 + 1] as number;
    const pz = pos[v * 3 + 2] as number;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = grid.get(hashCell(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const u of list) {
            if (u <= v) continue;
            const d2 = ((pos[u * 3] as number) - px) ** 2 + ((pos[u * 3 + 1] as number) - py) ** 2 + ((pos[u * 3 + 2] as number) - pz) ** 2;
            if (d2 >= ct2) continue;
            const gv = groupOf[v] as number;
            const gu = groupOf[u] as number;
            if (d2 < co2) {
              const g = gapBetween(dispOf(v), dispOf(u));
              note('coincident', g.gap, g.at, v, u, [px, py, pz]);
              budget--;
            } else if (gv !== gu) {
              const g = gapBetween(dispOf(v), dispOf(u));
              note('contact', g.gap, g.at, v, u, [px, py, pz]);
              const rel = g.gap / Math.max(g.mag, 1e-6);
              if (rel > res.contact.maxRelGap) res.contact.maxRelGap = rel;
              budget--;
            }
          }
        }
      }
    }
  }

  if (surfaceDist > 0 && mesh.indices) auditSurface(mesh, n, surfaceDist, groupOf, dispOf, gapBetween, note, times, maxPairs);

  for (const key of ['coincident', 'contact', 'surface'] as const) if (res[key].pairs > 0) res[key].meanGap = sums[key] / res[key].pairs;
  return res;
}

type NoteFn = (key: 'coincident' | 'contact' | 'surface', gap: number, at: number, a: number, b: number, p: [number, number, number]) => void;

/**
 * Vertices of one group lying on (within `dist` of) a triangle of another group: the gap between the vertex displacement and the
 * barycentric interpolation of the triangle's vertex displacements. This is the weld seam (child rings on the parent's skin).
 */
function auditSurface(
  mesh: WindAuditMesh,
  n: number,
  dist: number,
  groupOf: Uint16Array,
  dispOf: (v: number) => Float64Array,
  gapBetween: (a: Float64Array, b: Float64Array) => { gap: number; at: number; mag: number },
  note: NoteFn,
  times: readonly number[],
  maxPairs: number,
): void {
  const pos = mesh.positions;
  const idx = mesh.indices as Uint32Array;
  const tris = Math.floor(idx.length / 3);
  const cell = Math.max(dist * 2, 0.04);
  let entries = 0;
  const grid = new Map<number, number[]>();
  const put = (cx: number, cy: number, cz: number, t: number): void => {
    const k = hashCell(cx, cy, cz);
    const l = grid.get(k);
    if (l) l.push(t);
    else grid.set(k, [t]);
  };
  for (let t = 0; t < tris; t++) {
    let lo: [number, number, number] = [Infinity, Infinity, Infinity];
    let hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let c = 0; c < 3; c++) {
      const v = idx[t * 3 + c] as number;
      lo = [Math.min(lo[0], pos[v * 3] as number), Math.min(lo[1], pos[v * 3 + 1] as number), Math.min(lo[2], pos[v * 3 + 2] as number)];
      hi = [Math.max(hi[0], pos[v * 3] as number), Math.max(hi[1], pos[v * 3 + 1] as number), Math.max(hi[2], pos[v * 3 + 2] as number)];
    }
    const x0 = Math.floor((lo[0] - dist) / cell);
    const x1 = Math.floor((hi[0] + dist) / cell);
    const y0 = Math.floor((lo[1] - dist) / cell);
    const y1 = Math.floor((hi[1] + dist) / cell);
    const z0 = Math.floor((lo[2] - dist) / cell);
    const z1 = Math.floor((hi[2] + dist) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 400 || entries > 6000000) continue;
    entries += (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) put(x, y, z, t);
  }
  let budget = maxPairs;
  const d2max = dist * dist;
  const seen = new Set<number>();
  for (let v = 0; v < n && budget > 0; v++) {
    const px = pos[v * 3] as number;
    const py = pos[v * 3 + 1] as number;
    const pz = pos[v * 3 + 2] as number;
    const list = grid.get(hashCell(Math.floor(px / cell), Math.floor(py / cell), Math.floor(pz / cell)));
    if (!list) continue;
    seen.clear();
    let best: { d2: number; a: number; b: number; c: number; u: number; w: number } | null = null;
    for (const t of list) {
      if (seen.has(t)) continue;
      seen.add(t);
      const a = idx[t * 3] as number;
      const b = idx[t * 3 + 1] as number;
      const c = idx[t * 3 + 2] as number;
      const g = groupOf[v] as number;
      if (groupOf[a] === g || groupOf[b] === g || groupOf[c] === g) continue;
      if (a === v || b === v || c === v) continue;
      const hit = closestOnTriangle(pos, px, py, pz, a, b, c);
      if (hit.d2 <= d2max && (!best || hit.d2 < best.d2)) best = { d2: hit.d2, a, b, c, u: hit.u, w: hit.w };
    }
    if (!best) continue;
    const da = dispOf(best.a);
    const db = dispOf(best.b);
    const dc = dispOf(best.c);
    const mix = new Float64Array(times.length * 3);
    const wa = 1 - best.u - best.w;
    for (let k = 0; k < mix.length; k++) mix[k] = (da[k] as number) * wa + (db[k] as number) * best.u + (dc[k] as number) * best.w;
    const g = gapBetween(dispOf(v), mix);
    note('surface', g.gap, g.at, v, best.a, [px, py, pz]);
    budget--;
  }
}

/** Closest point of triangle (a, b, c) to p: squared distance and barycentric weights of b and c. */
function closestOnTriangle(pos: Float32Array, px: number, py: number, pz: number, a: number, b: number, c: number): { d2: number; u: number; w: number } {
  const ax = pos[a * 3] as number, ay = pos[a * 3 + 1] as number, az = pos[a * 3 + 2] as number;
  const e1x = (pos[b * 3] as number) - ax, e1y = (pos[b * 3 + 1] as number) - ay, e1z = (pos[b * 3 + 2] as number) - az;
  const e2x = (pos[c * 3] as number) - ax, e2y = (pos[c * 3 + 1] as number) - ay, e2z = (pos[c * 3 + 2] as number) - az;
  const wx = px - ax, wy = py - ay, wz = pz - az;
  const d11 = e1x * e1x + e1y * e1y + e1z * e1z;
  const d22 = e2x * e2x + e2y * e2y + e2z * e2z;
  const d12 = e1x * e2x + e1y * e2y + e1z * e2z;
  const dw1 = wx * e1x + wy * e1y + wz * e1z;
  const dw2 = wx * e2x + wy * e2y + wz * e2z;
  const den = d11 * d22 - d12 * d12;
  let u = 0;
  let w = 0;
  if (Math.abs(den) > 1e-20) {
    u = (d22 * dw1 - d12 * dw2) / den;
    w = (d11 * dw2 - d12 * dw1) / den;
  }
  // Clamp into the triangle (projection on the nearest edge when outside).
  if (u < 0 || w < 0 || u + w > 1) {
    let best = { d2: Infinity, u: 0, w: 0 };
    const edges: [number, number, number, number][] = [[0, 0, 1, 0], [0, 0, 0, 1], [1, 0, 0, 1]];
    for (const [su, sw, tu, tw] of edges) {
      const dx = (tu - su) * e1x + (tw - sw) * e2x;
      const dy = (tu - su) * e1y + (tw - sw) * e2y;
      const dz = (tu - su) * e1z + (tw - sw) * e2z;
      const qx = wx - (su * e1x + sw * e2x), qy = wy - (su * e1y + sw * e2y), qz = wz - (su * e1z + sw * e2z);
      const l2 = dx * dx + dy * dy + dz * dz;
      const t = l2 > 1e-20 ? Math.min(1, Math.max(0, (qx * dx + qy * dy + qz * dz) / l2)) : 0;
      const cu = su + (tu - su) * t;
      const cw = sw + (tw - sw) * t;
      const rx = wx - (cu * e1x + cw * e2x), ry = wy - (cu * e1y + cw * e2y), rz = wz - (cu * e1z + cw * e2z);
      const d2 = rx * rx + ry * ry + rz * rz;
      if (d2 < best.d2) best = { d2, u: cu, w: cw };
    }
    return best;
  }
  const rx = wx - (u * e1x + w * e2x), ry = wy - (u * e1y + w * e2y), rz = wz - (u * e1z + w * e2z);
  return { d2: rx * rx + ry * ry + rz * rz, u, w };
}
