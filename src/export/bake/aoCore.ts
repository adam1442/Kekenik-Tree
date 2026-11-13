import { hash01 } from '@/geometry/math3';
import type { AoVertexMode } from '../types';
import type { PlantGeometry } from '../geometry';

/**
 * Ambient-occlusion baking core (pure, worker-safe). Approach: the surface is voxelised into a coarse density grid
 * (surface area per voxel), then each vertex marches cosine-weighted hemisphere rays through the grid and accumulates
 * the optical thickness. It is an estimate (leaf cards are thin), deterministic and fast; there is no BVH ray caster.
 */

export interface AoField {
  res: number;
  min: [number, number, number];
  cell: number;
  density: Float32Array;
}

export interface AoOptions {
  samples: number;
  /** Occlusion distance in world units. */
  radius: number;
  strength: number;
}

const EXTINCTION = 2.2;

export function buildAoField(positions: Float32Array, indices: Uint32Array, res: number): AoField {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a] as number;
      if (v < (min[a] as number)) min[a] = v;
      if (v > (max[a] as number)) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) return { res: 1, min: [0, 0, 0], cell: 1, density: new Float32Array(1) };
  const extent = Math.max((max[0] as number) - (min[0] as number), (max[1] as number) - (min[1] as number), (max[2] as number) - (min[2] as number), 1e-6);
  const cell = extent / res;
  const density = new Float32Array(res * res * res);
  const P = positions;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = (indices[t] as number) * 3;
    const b = (indices[t + 1] as number) * 3;
    const c = (indices[t + 2] as number) * 3;
    const ux = (P[b] as number) - (P[a] as number);
    const uy = (P[b + 1] as number) - (P[a + 1] as number);
    const uz = (P[b + 2] as number) - (P[a + 2] as number);
    const vx = (P[c] as number) - (P[a] as number);
    const vy = (P[c + 1] as number) - (P[a + 1] as number);
    const vz = (P[c + 2] as number) - (P[a + 2] as number);
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    if (area <= 0) continue;
    const n = Math.min(4096, Math.max(1, Math.ceil((area / (cell * cell)) * 4)));
    const w = area / n / (cell * cell);
    for (let s = 0; s < n; s++) {
      let r1 = hash01(t, s * 2 + 1);
      let r2 = hash01(t, s * 2 + 2);
      if (r1 + r2 > 1) {
        r1 = 1 - r1;
        r2 = 1 - r2;
      }
      const x = (P[a] as number) + ux * r1 + vx * r2;
      const y = (P[a + 1] as number) + uy * r1 + vy * r2;
      const z = (P[a + 2] as number) + uz * r1 + vz * r2;
      const ix = Math.min(res - 1, Math.max(0, Math.floor((x - (min[0] as number)) / cell)));
      const iy = Math.min(res - 1, Math.max(0, Math.floor((y - (min[1] as number)) / cell)));
      const iz = Math.min(res - 1, Math.max(0, Math.floor((z - (min[2] as number)) / cell)));
      const k = (iz * res + iy) * res + ix;
      density[k] = (density[k] as number) + w;
    }
  }
  return { res, min, cell, density };
}

/** AO (1 = open, 0 = fully occluded) for vertices [from, to). Writes into `out[from..to)`. */
export function computeAoRange(field: AoField, positions: Float32Array, normals: Float32Array, from: number, to: number, opts: AoOptions, out: Float32Array): void {
  const { res, min, cell, density } = field;
  const steps = Math.max(2, Math.min(48, Math.ceil(opts.radius / cell)));
  const stepLen = opts.radius / steps;
  const start = Math.min(opts.radius * 0.5, cell * 1.5);
  for (let i = from; i < to; i++) {
    const px = positions[i * 3] as number;
    const py = positions[i * 3 + 1] as number;
    const pz = positions[i * 3 + 2] as number;
    let nx = normals[i * 3] as number;
    let ny = normals[i * 3 + 1] as number;
    let nz = normals[i * 3 + 2] as number;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    // Tangent frame.
    const ax = Math.abs(nz) < 0.9 ? 0 : 1;
    const az = Math.abs(nz) < 0.9 ? 1 : 0;
    let tx = ny * az - nz * 0;
    let ty = nz * ax - nx * az;
    let tz = nx * 0 - ny * ax;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;
    let occ = 0;
    for (let s = 0; s < opts.samples; s++) {
      const u1 = (s + 0.5) / opts.samples;
      const phi = 2 * Math.PI * hash01(i, s + 17);
      const r = Math.sqrt(u1);
      const cx = r * Math.cos(phi);
      const cy = r * Math.sin(phi);
      const cz = Math.sqrt(1 - u1);
      const dx = tx * cx + bx * cy + nx * cz;
      const dy = ty * cx + by * cy + ny * cz;
      const dz = tz * cx + bz * cy + nz * cz;
      let optical = 0;
      for (let k = 0; k < steps; k++) {
        const d = start + (k + 0.5) * stepLen;
        const ix = Math.floor((px + dx * d - (min[0] as number)) / cell);
        const iy = Math.floor((py + dy * d - (min[1] as number)) / cell);
        const iz = Math.floor((pz + dz * d - (min[2] as number)) / cell);
        if (ix < 0 || iy < 0 || iz < 0 || ix >= res || iy >= res || iz >= res) continue;
        optical += (density[(iz * res + iy) * res + ix] as number) * (1 - d / (opts.radius + start)) * (stepLen / cell);
      }
      occ += 1 - Math.exp(-EXTINCTION * optical);
    }
    out[i] = Math.min(1, Math.max(0, 1 - (opts.strength * occ) / opts.samples));
  }
}

/** Write baked AO (for `count` vertices starting at `offset` in `baked`) into the geometry's `ao` and, optionally, colours. */
export function applyAoToGeometry(g: PlantGeometry, baked: Float32Array, offset: number, mode: AoVertexMode): void {
  const n = g.positions.length / 3;
  const ao = new Float32Array(n);
  for (let i = 0; i < n; i++) ao[i] = (baked[offset + i] as number) * (g.ao ? (g.ao[i] as number) : 1);
  g.ao = ao;
  if (mode === 'off') return;
  const colors = g.colors && mode === 'multiply' ? g.colors : new Float32Array(n * 4).fill(1);
  for (let i = 0; i < n; i++) {
    const v = baked[offset + i] as number;
    if (mode === 'multiply') {
      colors[i * 4] = (colors[i * 4] as number) * v;
      colors[i * 4 + 1] = (colors[i * 4 + 1] as number) * v;
      colors[i * 4 + 2] = (colors[i * 4 + 2] as number) * v;
    } else {
      colors[i * 4] = v;
      colors[i * 4 + 1] = v;
      colors[i * 4 + 2] = v;
      colors[i * 4 + 3] = 1;
    }
  }
  g.colors = colors;
}

/** Concatenate the geometries (for one shared occupancy grid) and return the offsets of each. */
export function concatForBake(list: readonly PlantGeometry[]): { positions: Float32Array; normals: Float32Array; indices: Uint32Array; offsets: number[] } {
  const vertexTotal = list.reduce((s, g) => s + g.positions.length / 3, 0);
  const indexTotal = list.reduce((s, g) => s + g.primitives.reduce((a, p) => a + p.indices.length, 0), 0);
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  const offsets: number[] = [];
  let v = 0;
  let o = 0;
  for (const g of list) {
    offsets.push(v);
    positions.set(g.positions, v * 3);
    normals.set(g.normals, v * 3);
    for (const p of g.primitives) {
      for (let i = 0; i < p.indices.length; i++) indices[o++] = (p.indices[i] as number) + v;
    }
    v += g.positions.length / 3;
  }
  return { positions, normals, indices, offsets };
}
