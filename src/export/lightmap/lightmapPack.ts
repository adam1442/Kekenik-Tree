import type { MeshData } from '@/contracts/mesh';
import { expandInstances } from '@/geometry/instancing';

/** Lightmap UV (UV1) packer: weights per generator, unwrap scale per material, one resolution, one texel density. Pure and deterministic. */

export type LightmapLayout = 'atlas' | 'udim';

export interface LightmapInput {
  /** Stable id of the piece (the producing node). */
  id: string;
  mesh: MeshData;
  /** Lightmap weight of the generator: relative texel density (1 = neutral, 0 = one texel per piece / leaf). */
  weight: number;
  /** Unwrap scale of the material of the piece (1 = neutral); area-weighted over the slots when the piece has several materials. */
  unwrapScale: number;
  /** Every material of the piece is Atlas handling = Force out: its UVs are not touched. */
  forceOut: boolean;
}

export interface LightmapOptions {
  /** Texture edge in texels (Tree > Lightmap > Resolution). */
  resolution: number;
  layout: LightmapLayout;
  /** Empty texels around every island (default 1). */
  gutter?: number;
}

export interface LightmapIsland {
  id: string;
  /** UV rectangle [u0, v0, u1, v1] of the island (inside one tile for UDIM). */
  rect: [number, number, number, number];
  /** UDIM tile number (1001 + u + 10 v), 0 for the atlas layout. */
  tile: number;
  /** 'whole' = one island, 'cells' = a grid of per-piece cells (instanced / weight 0 pieces). */
  kind: 'whole' | 'cells';
  pieces: number;
  /** Texels per metre achieved inside the island (0 for weight 0: one texel per piece). */
  texelsPerMetre: number;
  /** Surface area in m^2. */
  area: number;
  weight: number;
}

export interface LightmapReport {
  resolution: number;
  layout: LightmapLayout;
  /** Texels per metre of a neutral (weight 1, scale 1) island after fitting everything into the resolution. */
  texelsPerMetre: number;
  /** Share of the texture covered by islands (0..1) in the atlas layout. */
  fill: number;
  islands: LightmapIsland[];
  warnings: string[];
}

export interface LightmapResult {
  /** New meshes (instances expanded, `uv1` replaced), index-aligned with the input; forced-out pieces are returned as given. */
  meshes: MeshData[];
  report: LightmapReport;
}

interface Piece {
  /** Vertex indices of the piece. */
  vertices: number[];
  area: number;
}

/** Connected components (shared vertex) of a triangle list: pieces such as single leaf cards. */
function components(mesh: MeshData): Piece[] {
  const n = mesh.positions.length / 3;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    let c = x;
    while (parent[c] !== r) {
      const next = parent[c] as number;
      parent[c] = r;
      c = next;
    }
    return r;
  };
  const used = new Uint8Array(n);
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t] as number;
    const b = mesh.indices[t + 1] as number;
    const c = mesh.indices[t + 2] as number;
    used[a] = used[b] = used[c] = 1;
    parent[find(b)] = find(a);
    parent[find(c)] = find(a);
  }
  const byRoot = new Map<number, Piece>();
  for (let i = 0; i < n; i++) {
    if (!used[i]) continue;
    const r = find(i);
    let p = byRoot.get(r);
    if (!p) {
      p = { vertices: [], area: 0 };
      byRoot.set(r, p);
    }
    p.vertices.push(i);
  }
  const owner = (v: number): Piece | undefined => byRoot.get(find(v));
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const p = owner(mesh.indices[t] as number);
    if (p) p.area += triangleArea(mesh.positions, mesh.indices[t] as number, mesh.indices[t + 1] as number, mesh.indices[t + 2] as number);
  }
  return [...byRoot.values()].sort((a, b) => (a.vertices[0] as number) - (b.vertices[0] as number));
}

function triangleArea(p: Float32Array, a: number, b: number, c: number): number {
  const ux = (p[b * 3] as number) - (p[a * 3] as number);
  const uy = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
  const uz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
  const vx = (p[c * 3] as number) - (p[a * 3] as number);
  const vy = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
  const vz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

export function meshArea(mesh: MeshData): number {
  let s = 0;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) s += triangleArea(mesh.positions, mesh.indices[t] as number, mesh.indices[t + 1] as number, mesh.indices[t + 2] as number);
  return s;
}

/** Area-weighted unwrap scale of a mesh over its material slots. */
export function weightedUnwrapScale(mesh: MeshData, scaleOf: (materialId: string) => number): number {
  if (mesh.slots.length === 0) return 1;
  let sum = 0;
  let total = 0;
  for (const s of mesh.slots) {
    let a = 0;
    for (let k = s.indexStart; k + 2 < s.indexStart + s.indexCount; k += 3) a += triangleArea(mesh.positions, mesh.indices[k] as number, mesh.indices[k + 1] as number, mesh.indices[k + 2] as number);
    sum += a * scaleOf(s.materialId);
    total += a;
  }
  return total > 1e-12 ? sum / total : 1;
}

interface Slot {
  /** Index into the input list. */
  entry: number;
  /** Island size in texels at density d: w = a * d + b (fixed part b in texels). */
  wa: number;
  wb: number;
  ha: number;
  hb: number;
  x: number;
  y: number;
}

/** Shelf packing (tallest first). Returns the used height, or Infinity when something is wider than the texture. */
function shelfPack(slots: Slot[], size: number, d: number, gutter: number): number {
  const order = slots.map((_, i) => i).sort((p, q) => {
    const a = slots[p] as Slot;
    const b = slots[q] as Slot;
    return b.ha * d + b.hb - (a.ha * d + a.hb) || p - q;
  });
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const i of order) {
    const s = slots[i] as Slot;
    const w = s.wa * d + s.wb + gutter * 2;
    const h = s.ha * d + s.hb + gutter * 2;
    if (w > size + 1e-9) return Infinity;
    if (x + w > size + 1e-9) {
      x = 0;
      y += rowH;
      rowH = 0;
    }
    s.x = x + gutter;
    s.y = y + gutter;
    x += w;
    rowH = Math.max(rowH, h);
  }
  return y + rowH;
}

const clampAspect = (a: number): number => Math.min(16, Math.max(1 / 16, a));

/**
 * Packs the lightmap UVs of all pieces into the chosen resolution. The neutral texel density is the largest one for which every island
 * fits (binary search over a shelf packer); weights and unwrap scales multiply it per piece. Weight 0 pieces (leaves) get one texel each,
 * arranged as a square block of texels. UDIM layout: every piece owns one tile.
 */
export function packLightmap(inputs: readonly LightmapInput[], options: LightmapOptions): LightmapResult {
  const size = Math.max(4, Math.round(options.resolution));
  const gutter = options.gutter ?? 1;
  const warnings: string[] = [];
  const meshes: MeshData[] = inputs.map((i) => i.mesh);
  interface Work { index: number; mesh: MeshData; pieces: Piece[]; area: number; scale: number; cells: boolean; aspect: number; uMin: number; vMin: number; uExt: number; vExt: number }
  const work: Work[] = [];
  inputs.forEach((inp, index) => {
    if (inp.forceOut || inp.mesh.indices.length === 0) return;
    const mesh = expandInstances(inp.mesh);
    const n = mesh.positions.length / 3;
    const pieces = components(mesh);
    const instanced = inp.mesh.instanced !== undefined;
    const cells = inp.weight <= 0 || instanced;
    const area = pieces.reduce((s, p) => s + p.area, 0);
    let uMin = Infinity;
    let vMin = Infinity;
    let uMax = -Infinity;
    let vMax = -Infinity;
    const uv = mesh.uv1;
    for (let i = 0; i < n; i++) {
      const u = uv ? (uv[i * 2] as number) : 0;
      const v = uv ? (uv[i * 2 + 1] as number) : 0;
      uMin = Math.min(uMin, u);
      vMin = Math.min(vMin, v);
      uMax = Math.max(uMax, u);
      vMax = Math.max(vMax, v);
    }
    const uExt = Math.max(1e-9, uMax - uMin);
    const vExt = Math.max(1e-9, vMax - vMin);
    work.push({ index, mesh, pieces, area, scale: Math.max(0.01, inp.unwrapScale), cells, aspect: clampAspect(uExt / vExt), uMin, vMin, uExt, vExt });
  });

  const slots: Slot[] = work.map((w) => {
    const input = inputs[w.index] as LightmapInput;
    const k = Math.ceil(Math.sqrt(Math.max(1, w.pieces.length)));
    if (w.cells && input.weight <= 0) return { entry: w.index, wa: 0, wb: k, ha: 0, hb: k, x: 0, y: 0 };
    const density = Math.max(0, input.weight) * w.scale;
    if (w.cells) {
      const side = k * Math.sqrt(w.area / Math.max(1, w.pieces.length)) * density;
      return { entry: w.index, wa: side, wb: 0, ha: side, hb: 0, x: 0, y: 0 };
    }
    const side = Math.sqrt(w.area) * density;
    return { entry: w.index, wa: side * Math.sqrt(w.aspect), wb: 0, ha: side / Math.sqrt(w.aspect), hb: 0, x: 0, y: 0 };
  });

  const islands: LightmapIsland[] = [];
  let neutral = 0;
  let fill = 0;
  const layoutUdim = options.layout === 'udim';

  if (!layoutUdim && slots.length > 0) {
    // Largest neutral density that fits: bracket, then bisect.
    let lo = 0;
    let hi = size;
    while (shelfPack(slots, size, hi, gutter) <= size && hi < 1e6) hi *= 2;
    if (shelfPack(slots, size, 0, gutter) > size) warnings.push('Lightmap: the one-texel pieces alone do not fit the resolution; raise Tree > Lightmap > Resolution. UVs were packed at the minimum density and may leave [0, 1].');
    else for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (shelfPack(slots, size, mid, gutter) <= size) lo = mid;
      else hi = mid;
    }
    neutral = lo;
    shelfPack(slots, size, neutral, gutter);
  }

  work.forEach((w, k) => {
    const input = inputs[w.index] as LightmapInput;
    const slot = slots[k] as Slot;
    const udimIndex = k;
    const d = layoutUdim ? 0 : neutral;
    let px = 0;
    let py = 0;
    let pw = 0;
    let ph = 0;
    let texelsPerMetre: number;
    if (layoutUdim) {
      // One tile per piece: scale the island to fill the tile minus the gutter.
      const g = gutter / size;
      pw = (1 - 2 * g) * (w.aspect >= 1 ? 1 : w.aspect);
      ph = (1 - 2 * g) * (w.aspect >= 1 ? 1 / w.aspect : 1);
      px = g;
      py = g;
      texelsPerMetre = w.area > 0 ? (size * Math.sqrt(pw * ph)) / Math.sqrt(w.area) : 0;
      if (w.cells && input.weight <= 0) texelsPerMetre = 0;
    } else {
      pw = (slot.wa * d + slot.wb) / size;
      ph = (slot.ha * d + slot.hb) / size;
      px = slot.x / size;
      py = slot.y / size;
      texelsPerMetre = w.cells && input.weight <= 0 ? 0 : Math.max(0, input.weight) * w.scale * d;
    }
    const tileU = layoutUdim ? udimIndex % 10 : 0;
    const tileV = layoutUdim ? Math.floor(udimIndex / 10) : 0;
    const out = new Float32Array((w.mesh.positions.length / 3) * 2);
    const uv = w.mesh.uv1;
    const n = w.mesh.positions.length / 3;
    if (!w.cells) {
      for (let i = 0; i < n; i++) {
        const lu = uv ? ((uv[i * 2] as number) - w.uMin) / w.uExt : 0;
        const lv = uv ? ((uv[i * 2 + 1] as number) - w.vMin) / w.vExt : 0;
        out[i * 2] = tileU + px + lu * pw;
        out[i * 2 + 1] = tileV + py + lv * ph;
      }
    } else {
      const k2 = Math.ceil(Math.sqrt(Math.max(1, w.pieces.length)));
      w.pieces.forEach((piece, pi) => {
        const cx = pi % k2;
        const cy = Math.floor(pi / k2);
        const cw = pw / k2;
        const ch = ph / k2;
        if (input.weight <= 0) {
          // One texel: every vertex of the piece sits at the centre of its texel.
          for (const v of piece.vertices) {
            out[v * 2] = tileU + px + (cx + 0.5) * cw;
            out[v * 2 + 1] = tileV + py + (cy + 0.5) * ch;
          }
          return;
        }
        let u0 = Infinity;
        let v0 = Infinity;
        let u1 = -Infinity;
        let v1 = -Infinity;
        for (const v of piece.vertices) {
          const u = uv ? (uv[v * 2] as number) : 0;
          const t = uv ? (uv[v * 2 + 1] as number) : 0;
          u0 = Math.min(u0, u);
          v0 = Math.min(v0, t);
          u1 = Math.max(u1, u);
          v1 = Math.max(v1, t);
        }
        const eu = Math.max(1e-9, u1 - u0);
        const ev = Math.max(1e-9, v1 - v0);
        for (const v of piece.vertices) {
          const u = uv ? (uv[v * 2] as number) : 0;
          const t = uv ? (uv[v * 2 + 1] as number) : 0;
          out[v * 2] = tileU + px + (cx + 0.02 + 0.96 * ((u - u0) / eu)) * cw;
          out[v * 2 + 1] = tileV + py + (cy + 0.02 + 0.96 * ((t - v0) / ev)) * ch;
        }
      });
    }
    meshes[w.index] = { ...w.mesh, uv1: out };
    fill += pw * ph;
    islands.push({ id: input.id, rect: [tileU + px, tileV + py, tileU + px + pw, tileV + py + ph], tile: layoutUdim ? 1001 + tileU + 10 * tileV : 0, kind: w.cells ? 'cells' : 'whole', pieces: w.pieces.length, texelsPerMetre, area: w.area, weight: input.weight });
  });

  return {
    meshes,
    report: { resolution: size, layout: options.layout, texelsPerMetre: layoutUdim ? Math.max(0, ...islands.map((i) => i.texelsPerMetre)) : neutral, fill: layoutUdim ? 0 : fill, islands, warnings },
  };
}
