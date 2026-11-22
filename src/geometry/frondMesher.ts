import type { MeshData } from '@/contracts/mesh';
import type { LeafLightingSettings } from '@/contracts/lighting';
import { locateStation, mapToRibs, sampleRib, type Ribs } from './frondRibs';
import { DEFAULT_FROND_WIND, frondWindAt, type FrondWind } from './frondWind';
import { applyLeafLighting, isLightingActive, type FrondLightingExtras, type LightingGroup } from './leafLighting';
import { MeshAccumulator, newVertex, type VertexAttrs } from './meshAccumulator';
import type { V3 } from './math3';

/**
 * Meshes of the Frond generator: a cutout mesh or the plain ribbon grid mapped onto the ribs of `frondRibs.ts`.
 * Pure and deterministic; vertex data is written straight into typed arrays (one scratch record per call).
 */

/** A cutout mesh normalised to the frond frame: u across (-1..1, 0 = spine), v along (0..1), z = relief in widths. */
export interface UnitMesh {
  u: Float32Array;
  v: Float32Array;
  /** Out-of-plane coordinate in units of the full mesh width. */
  z: Float32Array;
  /** Texture coordinates (atlas applied by the cutout builder). */
  uv: Float32Array;
  indices: Uint32Array;
  /** Section id (1..8) per vertex painted in the cutout editor; null when the mesh carries none. */
  section: Uint8Array | null;
  /** Distinct section ids above 1 that occur in `section` (ascending). Section 1 = unpainted. */
  sections: number[];
}

/** Normalises the geometry of a cutout built at unit width / length (x across from the pivot, y along). */
export function unitMeshFromGeometry(m: Pick<MeshData, 'positions' | 'uv0' | 'indices'> & { cutoutSection?: Uint8Array }): UnitMesh | null {
  const n = Math.floor(m.positions.length / 3);
  if (n < 3 || m.indices.length < 3) return null;
  let halfX = 1e-6;
  let yMin = Infinity;
  let yMax = -Infinity;
  for (let i = 0; i < n; i++) {
    halfX = Math.max(halfX, Math.abs(m.positions[i * 3] as number));
    const y = m.positions[i * 3 + 1] as number;
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
  }
  const span = Math.max(1e-6, yMax - yMin);
  const u = new Float32Array(n);
  const v = new Float32Array(n);
  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    u[i] = (m.positions[i * 3] as number) / halfX;
    v[i] = ((m.positions[i * 3 + 1] as number) - yMin) / span;
    z[i] = (m.positions[i * 3 + 2] as number) / (2 * halfX);
  }
  let section: Uint8Array | null = null;
  const sections: number[] = [];
  if (m.cutoutSection && m.cutoutSection.length >= n) {
    section = m.cutoutSection.slice(0, n);
    const seen = new Set<number>();
    for (let i = 0; i < n; i++) {
      const id = section[i] as number;
      if (id > 1 && !seen.has(id)) {
        seen.add(id);
        sections.push(id);
      }
    }
    sections.sort((a, b) => a - b);
    if (sections.length === 0) section = null;
  }
  return { u, v, z, uv: m.uv0.slice(0, n * 2), indices: m.indices, section, sections };
}

export interface FrondUv {
  mode: 'stretch' | 'tile';
  /** Metres per V tile in 'tile' mode. */
  tile: number;
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
}

export const DEFAULT_FROND_UV: FrondUv = { mode: 'stretch', tile: 1, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0 };

export interface FrondSpec {
  ribs: Ribs;
  materialId: string;
  /** Mesh mapped onto the ribs; null = plain ribbon grid. */
  mesh: UnitMesh | null;
  /** Vertex columns across the ribbon (even). */
  columns: number;
  /** Mirror across the spine (Flip). */
  flip: boolean;
  /** Duplicate the geometry for the back (Two sided). */
  twoSided: boolean;
  atlas: [number, number, number, number];
  color: [number, number, number];
  colorGradient: number;
  ao: number;
  wind: [number, number, number, number];
  windPower: number;
  /** Wind Weight / Cross / Boost / Ribs; absent = the plain `t^windPower` bend. */
  windSet?: FrondWind;
  /** Section Variance: ribs of every painted section id (index = id); a missing entry uses `ribs`. */
  sectionRibs?: readonly (Ribs | null | undefined)[];
  /** Lighting inputs of this frond (null = none). */
  light?: FrondLight | null;
  /** Scale of the mesh z (Scale > Height). */
  heightScale: number;
  /** Strength of the relief (Height > Amount). */
  heightAmount: number;
  /** Height-map displacement in metres (Height > Offset). */
  heightOffset: number;
  /** Height map of the material (uv -> 0..1, 0.5 = no change). */
  heightMap: ((u: number, v: number) => number) | null;
}

/** Per-frond inputs of the Lighting pass. */
export interface FrondLight {
  /** Parent puffiness anchor point (null = none). */
  anchor: V3 | null;
  /** Fixed direction of the Surface X / Y / Z anchors (null = none). */
  surface: V3 | null;
  /** Resolved Up / Right / Out rotation in radians. */
  adjust: V3;
}

export interface FrondMeshOptions {
  uv: FrondUv;
  defaultMaterial: string;
  /** Lighting settings (applied when they change any normal). */
  lighting: LeafLightingSettings;
  /** Frond Alignment / Spread. */
  lightingExtras: FrondLightingExtras;
}

interface Local {
  pos: Float32Array;
  ref: Float32Array;
  uv: Float32Array;
  along: Float32Array;
  across: Float32Array;
  station: Int32Array;
  indices: Uint32Array;
  /** Section id per vertex (mapped meshes with Section Variance only). */
  section: Uint8Array | null;
}

const ribsOf = (s: FrondSpec, section: number): Ribs => (section > 1 ? s.sectionRibs?.[section] : undefined) ?? s.ribs;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

function ribbonLocal(s: FrondSpec, uv: FrondUv): Local {
  const R = s.ribs.count;
  const W = Math.max(2, s.columns);
  const C = W + 1;
  const n = R * C;
  const L: Local = {
    pos: new Float32Array(n * 3),
    ref: new Float32Array(n * 3),
    uv: new Float32Array(n * 2),
    along: new Float32Array(n),
    across: new Float32Array(n),
    station: new Int32Array(n),
    indices: new Uint32Array((R - 1) * W * 6),
    section: null,
  };
  const [u0, v0, u1, v1] = s.atlas;
  const full = u0 === 0 && v0 === 0 && u1 === 1 && v1 === 1;
  const tile = uv.mode === 'tile' && full;
  for (let i = 0; i < R; i++) {
    const t = s.ribs.t[i] as number;
    const vCoord = tile ? ((s.ribs.s[i] as number) / Math.max(1e-4, uv.tile)) * uv.scaleV + uv.offsetV : v0 + (v1 - v0) * t * uv.scaleV + uv.offsetV;
    for (let j = 0; j < C; j++) {
      const q = i * C + j;
      const u = -1 + (2 * j) / W;
      sampleRib(s.ribs, i, u, L.pos, q * 3);
      L.ref[q * 3] = s.ribs.normal[i * 3] as number;
      L.ref[q * 3 + 1] = s.ribs.normal[i * 3 + 1] as number;
      L.ref[q * 3 + 2] = s.ribs.normal[i * 3 + 2] as number;
      L.uv[q * 2] = u0 + (u1 - u0) * (j / W) * uv.scaleU + uv.offsetU;
      L.uv[q * 2 + 1] = vCoord;
      L.along[q] = t;
      L.across[q] = u;
      L.station[q] = i;
    }
  }
  let o = 0;
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < W; j++) {
      const a0 = i * C + j;
      const b0 = a0 + C;
      L.indices[o++] = a0;
      L.indices[o++] = a0 + 1;
      L.indices[o++] = b0;
      L.indices[o++] = a0 + 1;
      L.indices[o++] = b0 + 1;
      L.indices[o++] = b0;
    }
  }
  return L;
}

function mappedLocal(s: FrondSpec, m: UnitMesh): Local {
  const n = m.u.length;
  const L: Local = {
    pos: new Float32Array(n * 3),
    ref: new Float32Array(n * 3),
    uv: m.uv.slice(0, n * 2),
    along: new Float32Array(n),
    across: new Float32Array(n),
    station: new Int32Array(n),
    indices: m.indices.slice(),
    section: s.sectionRibs && m.section ? m.section : null,
  };
  let maxHalf = 0;
  for (let i = 0; i < s.ribs.count; i++) maxHalf = Math.max(maxHalf, s.ribs.halfWidth[i] as number);
  const zScale = 2 * maxHalf * s.heightScale * s.heightAmount;
  for (let i = 0; i < n; i++) {
    const u = (s.flip ? -1 : 1) * (m.u[i] as number);
    const v = clamp01(m.v[i] as number);
    const rb = L.section ? ribsOf(s, L.section[i] as number) : s.ribs;
    mapToRibs(rb, u, v, L.pos, i * 3, L.ref, i * 3);
    const z = (m.z[i] as number) * zScale;
    if (z !== 0) {
      L.pos[i * 3] = (L.pos[i * 3] as number) + (L.ref[i * 3] as number) * z;
      L.pos[i * 3 + 1] = (L.pos[i * 3 + 1] as number) + (L.ref[i * 3 + 1] as number) * z;
      L.pos[i * 3 + 2] = (L.pos[i * 3 + 2] as number) + (L.ref[i * 3 + 2] as number) * z;
    }
    L.along[i] = v;
    L.across[i] = u;
    L.station[i] = locateStation(rb, v).i;
  }
  return L;
}

/** Height-map displacement along the face normal (mid grey = no change). */
function applyHeightMap(s: FrondSpec, L: Local): void {
  if (!s.heightMap || s.heightOffset === 0) return;
  const n = L.along.length;
  const k = s.heightOffset * s.heightAmount;
  for (let i = 0; i < n; i++) {
    const d = (s.heightMap(L.uv[i * 2] as number, L.uv[i * 2 + 1] as number) - 0.5) * 2 * k;
    L.pos[i * 3] = (L.pos[i * 3] as number) + (L.ref[i * 3] as number) * d;
    L.pos[i * 3 + 1] = (L.pos[i * 3 + 1] as number) + (L.ref[i * 3 + 1] as number) * d;
    L.pos[i * 3 + 2] = (L.pos[i * 3 + 2] as number) + (L.ref[i * 3 + 2] as number) * d;
  }
}

/**
 * Orients every triangle toward the face normal of its ribs (so Flip and Roll never leave back-facing triangles) and
 * returns area-weighted vertex normals.
 */
function shade(L: Local): Float32Array {
  const n = L.along.length;
  const normals = new Float32Array(n * 3);
  const idx = L.indices;
  const p = L.pos;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] as number;
    const b = idx[t + 1] as number;
    const c = idx[t + 2] as number;
    const e1x = (p[b * 3] as number) - (p[a * 3] as number);
    const e1y = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
    const e1z = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
    const e2x = (p[c * 3] as number) - (p[a * 3] as number);
    const e2y = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
    const e2z = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const rx = (L.ref[a * 3] as number) + (L.ref[b * 3] as number) + (L.ref[c * 3] as number);
    const ry = (L.ref[a * 3 + 1] as number) + (L.ref[b * 3 + 1] as number) + (L.ref[c * 3 + 1] as number);
    const rz = (L.ref[a * 3 + 2] as number) + (L.ref[b * 3 + 2] as number) + (L.ref[c * 3 + 2] as number);
    if (nx * rx + ny * ry + nz * rz < 0) {
      idx[t + 1] = c;
      idx[t + 2] = b;
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const v of [a, b, c]) {
      normals[v * 3] = (normals[v * 3] as number) + nx;
      normals[v * 3 + 1] = (normals[v * 3 + 1] as number) + ny;
      normals[v * 3 + 2] = (normals[v * 3 + 2] as number) + nz;
    }
  }
  for (let i = 0; i < n; i++) {
    const x = normals[i * 3] as number;
    const y = normals[i * 3 + 1] as number;
    const z = normals[i * 3 + 2] as number;
    const l = Math.hypot(x, y, z);
    if (l < 1e-14) {
      normals[i * 3] = L.ref[i * 3] as number;
      normals[i * 3 + 1] = L.ref[i * 3 + 1] as number;
      normals[i * 3 + 2] = L.ref[i * 3 + 2] as number;
    } else {
      normals[i * 3] = x / l;
      normals[i * 3 + 1] = y / l;
      normals[i * 3 + 2] = z / l;
    }
  }
  return normals;
}

/** Everything the Lighting pass needs to know about one emitted copy of a frond. */
function lightGroup(s: FrondSpec, L: Local, light: FrondLight, vertexStart: number, indexStart: number, indexCount: number): LightingGroup {
  const n = L.along.length;
  const along = new Float32Array(n * 3);
  const away = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const rb = L.section ? ribsOf(s, L.section[i] as number) : s.ribs;
    const st = (L.station[i] as number) * 3;
    const tx = rb.tangent[st] as number;
    const ty = rb.tangent[st + 1] as number;
    const tz = rb.tangent[st + 2] as number;
    along[i * 3] = tx;
    along[i * 3 + 1] = ty;
    along[i * 3 + 2] = tz;
    // Away from the spine: the offset of the vertex from its station point without the part along the spine.
    let dx = (L.pos[i * 3] as number) - (rb.point[st] as number);
    let dy = (L.pos[i * 3 + 1] as number) - (rb.point[st + 1] as number);
    let dz = (L.pos[i * 3 + 2] as number) - (rb.point[st + 2] as number);
    const k = dx * tx + dy * ty + dz * tz;
    dx -= tx * k;
    dy -= ty * k;
    dz -= tz * k;
    let l = Math.hypot(dx, dy, dz);
    if (l < 1e-7) {
      // On the spine: use the side direction of the nearest half instead.
      const sg = (L.across[i] as number) < 0 ? -1 : 1;
      dx = sg * (rb.side[st] as number);
      dy = sg * (rb.side[st + 1] as number);
      dz = sg * (rb.side[st + 2] as number);
      l = Math.hypot(dx, dy, dz) || 1;
    }
    away[i * 3] = dx / l;
    away[i * 3 + 1] = dy / l;
    away[i * 3 + 2] = dz / l;
  }
  const mid = (s.ribs.count >> 1) * 3;
  const r = s.ribs;
  return {
    vertexStart,
    vertexCount: n,
    indexStart,
    indexCount,
    anchor: light.anchor,
    surface: light.surface,
    frame: {
      x: [r.side[mid] as number, r.side[mid + 1] as number, r.side[mid + 2] as number],
      y: [r.tangent[mid] as number, r.tangent[mid + 1] as number, r.tangent[mid + 2] as number],
      z: [r.normal[mid] as number, r.normal[mid + 1] as number, r.normal[mid + 2] as number],
    },
    adjust: light.adjust,
    spine: { along, away },
  };
}

function emit(acc: MeshAccumulator, s: FrondSpec, uvOpt: FrondUv, vx: VertexAttrs, index: number, cells: number, groups: LightingGroup[] | null): void {
  const L = s.mesh ? mappedLocal(s, s.mesh) : ribbonLocal(s, uvOpt);
  applyHeightMap(s, L);
  const normals = shade(L);
  const n = L.along.length;
  const cx = index % cells;
  const cy = Math.floor(index / cells);
  const pivot = s.ribs.point;
  const copies = s.twoSided ? 2 : 1;
  const wind = s.windSet ?? { ...DEFAULT_FROND_WIND, power: s.windPower };
  const w = [0, 0, 0, 0];
  for (let side = 0; side < copies; side++) {
    const back = side === 1;
    const base = acc.vertexCount;
    const firstIndex = acc.indexCount;
    for (let i = 0; i < n; i++) {
      const t = L.along[i] as number;
      const grad = 1 + s.colorGradient * t;
      const ao = Math.min(1, Math.max(0.1, 1 - s.ao * 0.55 * (1 - t) * (1 - t)));
      const sign = back ? -1 : 1;
      vx.px = L.pos[i * 3] as number;
      vx.py = L.pos[i * 3 + 1] as number;
      vx.pz = L.pos[i * 3 + 2] as number;
      vx.nx = sign * (normals[i * 3] as number);
      vx.ny = sign * (normals[i * 3 + 1] as number);
      vx.nz = sign * (normals[i * 3 + 2] as number);
      // Tangent: the across direction of the station, made perpendicular to the normal.
      const st = (L.station[i] as number) * 3;
      const sideRibs = L.section ? ribsOf(s, L.section[i] as number) : s.ribs;
      let tx = sideRibs.side[st] as number;
      let ty = sideRibs.side[st + 1] as number;
      let tz = sideRibs.side[st + 2] as number;
      const d = tx * vx.nx + ty * vx.ny + tz * vx.nz;
      tx -= vx.nx * d;
      ty -= vx.ny * d;
      tz -= vx.nz * d;
      const tl = Math.hypot(tx, ty, tz) || 1;
      vx.tx = tx / tl;
      vx.ty = ty / tl;
      vx.tz = tz / tl;
      vx.tw = (s.flip ? -1 : 1) * sign;
      vx.u = L.uv[i * 2] as number;
      vx.v = L.uv[i * 2 + 1] as number;
      vx.u1 = (cx + (L.across[i] as number) * 0.5 + 0.5) / cells;
      vx.v1 = (cy + t) / cells;
      vx.r = s.color[0] * grad * ao;
      vx.g = s.color[1] * grad * ao;
      vx.b = s.color[2] * grad * ao;
      vx.ao = ao;
      vx.pvx = pivot[0] as number;
      vx.pvy = pivot[1] as number;
      vx.pvz = pivot[2] as number;
      frondWindAt(s.wind, t, L.across[i] as number, wind, w);
      vx.w0 = w[0] as number;
      vx.w1 = w[1] as number;
      vx.w2 = w[2] as number;
      vx.w3 = w[3] as number;
      acc.addVertex(vx);
    }
    const idx = L.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = base + (idx[t] as number);
      const b = base + (idx[t + 1] as number);
      const c = base + (idx[t + 2] as number);
      if (back) acc.addTriangle(a, c, b);
      else acc.addTriangle(a, b, c);
    }
    if (groups && s.light) groups.push(lightGroup(s, L, s.light, base, firstIndex, acc.indexCount - firstIndex));
  }
}

/** Builds one MeshData holding every frond (grouped by material, stable inside a group). */
export function buildFrondMesh(specs: readonly FrondSpec[], options: Partial<FrondMeshOptions> = {}): MeshData {
  const uv = options.uv ?? DEFAULT_FROND_UV;
  const fallback = options.defaultMaterial ?? 'leaf';
  const acc = new MeshAccumulator();
  const groups = new Map<string, number[]>();
  specs.forEach((s, i) => {
    const id = s.materialId || fallback;
    const list = groups.get(id);
    if (list) list.push(i);
    else groups.set(id, [i]);
  });
  const cells = Math.max(1, Math.ceil(Math.sqrt(specs.length)));
  const vx = newVertex();
  const lit = options.lighting !== undefined && isLightingActive(options.lighting, { frond: options.lightingExtras });
  const lightGroups: LightingGroup[] | null = lit ? [] : null;
  for (const [material, list] of groups) {
    acc.beginSlot(material);
    for (const i of list) emit(acc, specs[i] as FrondSpec, uv, vx, i, cells, lightGroups);
  }
  const mesh = acc.build(fallback, true);
  if (lightGroups && options.lighting && lightGroups.length > 0) applyLeafLighting(mesh, options.lighting, { groups: lightGroups, frond: options.lightingExtras });
  return mesh;
}
