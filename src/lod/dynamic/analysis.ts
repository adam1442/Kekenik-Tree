import type { SceneEntry, SceneModel } from '@/contracts/engine';
import type { MeshData } from '@/contracts/mesh';
import { hash01 } from '@/geometry/math3';
import { describeComponents, meshComponents, type ComponentInfo, type MeshComponents } from '@/export/lod/meshOps';
import type { LodGeometryType } from './types';

/**
 * Importance analysis of the Dynamic LOD (pure and deterministic).
 * Every leaf card / branch tube / decoration (a connected mesh component, or one GPU instance) is a "node". Each node gets an
 * exposure score (how much of the sphere of directions around it is open: interior parts are hidden by the canopy) and a
 * survival rank per geometry family (0 = survives longest). The rank combines exposure, size (branches) and the generator Weight.
 */

/** Neutral generator Weight: equal weights never change the ranking. */
export const NEUTRAL_LOD_WEIGHT = 0.5;
/** Exposure below this counts as "interior" in the export report. */
export const INTERIOR_EXPOSURE = 0.3;

const TYPE_OF_GROUP: Record<string, LodGeometryType> = {
  branches: 'branches',
  roots: 'branches',
  caps: 'branches',
  'leaf meshes': 'leaves',
  clusters: 'leaves',
  'fronds/fins': 'fronds',
  decorations: 'decorations',
  meshes: 'decorations',
};

/** Geometry family of a scene entry, or null when Dynamic LOD leaves it alone (ground cards, unknown groups). */
export function lodTypeOf(entry: SceneEntry): LodGeometryType | null {
  if (entry.ground) return null;
  return TYPE_OF_GROUP[entry.statsGroup] ?? null;
}

/** What the LOD transform needs about one scene entry. */
export interface LodEntryPlan {
  type: LodGeometryType;
  instanced: boolean;
  /** First node index of the entry; node = nodeStart + component (or instance) index. */
  nodeStart: number;
  nodeCount: number;
  /** Mesh components (non-instanced entries). */
  comps: MeshComponents | null;
  info: ComponentInfo | null;
  /**
   * "LOD anchor" per vertex (xyz): the point the vertex shrinks towards. Branches: the centre of the vertex's ring (their spine);
   * leaves / decorations: the attachment point.
   */
  anchors: Float32Array | null;
}

export interface DynamicLodModel {
  /** Parallel to `scene.entries`; null = untouched by Dynamic LOD. */
  entries: (LodEntryPlan | null)[];
  nodeCount: number;
  type: Uint8Array;
  /** Open fraction of the directions around the node, 0 (buried) .. 1 (free). */
  exposure: Float32Array;
  /** Survival rank within the geometry family in [0, 1): 0 = the last to go. */
  rank: Float32Array;
  /** Surface area (m²) of the node (m² x instance scale² for instances). */
  area: Float32Array;
  triangles: Uint32Array;
  /** Bounding sphere of everything that takes part. */
  center: [number, number, number];
  radius: number;
  totalTriangles: number;
}

export const TYPE_INDEX: Record<LodGeometryType, number> = { branches: 0, leaves: 1, fronds: 2, decorations: 3 };

export interface NodeGeom {
  cx: number;
  cy: number;
  cz: number;
  /** Bounding-sphere radius. */
  r: number;
  /** Projected area contribution for the occlusion estimate. */
  density: number;
}

const DIRECTIONS: readonly [number, number, number][] = (() => {
  const out: [number, number, number][] = [];
  for (let x = -1; x <= 1; x++) {
    for (let y = -1; y <= 1; y++) {
      for (let z = -1; z <= 1; z++) {
        if (x === 0 && y === 0 && z === 0) continue;
        const l = Math.hypot(x, y, z);
        out.push([x / l, y / l, z / l]);
      }
    }
  }
  return out;
})();

/** Number of probe directions (the 26 neighbours of a cube). */
export const EXPOSURE_DIRECTIONS = DIRECTIONS.length;

/**
 * Exposure of every node: 26 rays from the node centre march through a density grid built from all nodes (projected area per cell);
 * the exposure is the mean transmittance exp(-optical depth) over the rays.
 */
export function computeExposure(nodes: readonly NodeGeom[]): Float32Array {
  const n = nodes.length;
  const out = new Float32Array(n).fill(1);
  if (n < 2) return out;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const radii: number[] = [];
  for (const g of nodes) {
    minX = Math.min(minX, g.cx);
    minY = Math.min(minY, g.cy);
    minZ = Math.min(minZ, g.cz);
    maxX = Math.max(maxX, g.cx);
    maxY = Math.max(maxY, g.cy);
    maxZ = Math.max(maxZ, g.cz);
    radii.push(g.r);
  }
  radii.sort((a, b) => a - b);
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-6);
  const h = Math.max(extent / 48, (radii[Math.floor(radii.length / 2)] as number) * 1.2, 1e-6);
  const nx = Math.floor((maxX - minX) / h) + 1;
  const ny = Math.floor((maxY - minY) / h) + 1;
  const nz = Math.floor((maxZ - minZ) / h) + 1;
  const grid = new Float32Array(nx * ny * nz);
  const cellOf = (x: number, y: number, z: number): number => {
    const ix = Math.floor((x - minX) / h);
    const iy = Math.floor((y - minY) / h);
    const iz = Math.floor((z - minZ) / h);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return -1;
    return (iz * ny + iy) * nx + ix;
  };
  for (const g of nodes) {
    const c = cellOf(g.cx, g.cy, g.cz);
    if (c >= 0) grid[c] = (grid[c] as number) + g.density / (h * h);
  }
  const maxSteps = Math.ceil(Math.hypot(nx, ny, nz)) + 1;
  for (let i = 0; i < n; i++) {
    const g = nodes[i] as NodeGeom;
    const ownCell = cellOf(g.cx, g.cy, g.cz);
    let sum = 0;
    for (const d of DIRECTIONS) {
      let tau = 0;
      for (let k = 1; k <= maxSteps; k++) {
        const c = cellOf(g.cx + d[0] * h * k, g.cy + d[1] * h * k, g.cz + d[2] * h * k);
        if (c < 0) break;
        if (c !== ownCell) tau += grid[c] as number;
      }
      sum += Math.exp(-0.9 * tau);
    }
    out[i] = sum / DIRECTIONS.length;
  }
  return out;
}

const triArea = (p: Float32Array, a: number, b: number, c: number): number => {
  const ux = (p[b * 3] as number) - (p[a * 3] as number);
  const uy = (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number);
  const uz = (p[b * 3 + 2] as number) - (p[a * 3 + 2] as number);
  const vx = (p[c * 3] as number) - (p[a * 3] as number);
  const vy = (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number);
  const vz = (p[c * 3 + 2] as number) - (p[a * 3 + 2] as number);
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
};

/** Spine anchors of a tube mesh: vertices of one ring share the same V, so the ring centroid is the spine point. */
function ringAnchors(mesh: MeshData, comps: MeshComponents, fallback: Float32Array): Float32Array {
  const n = mesh.positions.length / 3;
  const anchors = new Float32Array(n * 3);
  const group = new Map<number, number>();
  const gid = new Int32Array(n);
  const sums: number[] = [];
  const counts: number[] = [];
  for (let i = 0; i < n; i++) {
    const key = (comps.ids[i] as number) * 1_000_003 + (Math.abs(Math.round((mesh.uv0[i * 2 + 1] ?? 0) * 2000)) % 1_000_003);
    let g = group.get(key);
    if (g === undefined) {
      g = counts.length;
      group.set(key, g);
      counts.push(0);
      sums.push(0, 0, 0);
    }
    gid[i] = g;
    counts[g] = (counts[g] as number) + 1;
    for (let a = 0; a < 3; a++) sums[g * 3 + a] = (sums[g * 3 + a] as number) + (mesh.positions[i * 3 + a] as number);
  }
  for (let i = 0; i < n; i++) {
    const g = gid[i] as number;
    const cnt = counts[g] as number;
    for (let a = 0; a < 3; a++) {
      anchors[i * 3 + a] = cnt >= 3 ? (sums[g * 3 + a] as number) / cnt : (fallback[(comps.ids[i] as number) * 3 + a] as number);
    }
  }
  return anchors;
}

/** Analyse a generated scene. Deterministic: the same scene always gives the same exposure, ranks and anchors. */
export function analyseScene(scene: SceneModel, seed = 0): DynamicLodModel {
  const plans: (LodEntryPlan | null)[] = scene.entries.map(() => null);
  const areaList: number[] = [];
  const triList: number[] = [];
  const typeList: number[] = [];
  const allGeoms: NodeGeom[] = [];
  const sizeList: number[] = [];
  const weightList: number[] = [];
  let totalTriangles = 0;

  scene.entries.forEach((e, entryIndex) => {
    const type = lodTypeOf(e);
    const mesh = e.mesh;
    if (!type || mesh.indices.length === 0) return;
    const weight = e.lodWeight ?? NEUTRAL_LOD_WEIGHT;
    const nodeStart = allGeoms.length;
    const geoms: NodeGeom[] = [];
    if (mesh.instanced) {
      const inst = mesh.instanced;
      let lx0 = Infinity;
      let ly0 = Infinity;
      let lz0 = Infinity;
      let lx1 = -Infinity;
      let ly1 = -Infinity;
      let lz1 = -Infinity;
      for (let i = 0; i < mesh.positions.length; i += 3) {
        lx0 = Math.min(lx0, mesh.positions[i] as number);
        lx1 = Math.max(lx1, mesh.positions[i] as number);
        ly0 = Math.min(ly0, mesh.positions[i + 1] as number);
        ly1 = Math.max(ly1, mesh.positions[i + 1] as number);
        lz0 = Math.min(lz0, mesh.positions[i + 2] as number);
        lz1 = Math.max(lz1, mesh.positions[i + 2] as number);
      }
      let baseArea = 0;
      for (let i = 0; i + 2 < mesh.indices.length; i += 3) baseArea += triArea(mesh.positions, mesh.indices[i] as number, mesh.indices[i + 1] as number, mesh.indices[i + 2] as number);
      const lc: [number, number, number] = [(lx0 + lx1) / 2, (ly0 + ly1) / 2, (lz0 + lz1) / 2];
      const lr = Math.hypot(lx1 - lx0, ly1 - ly0, lz1 - lz0) / 2;
      const tris = mesh.indices.length / 3;
      for (let k = 0; k < inst.count; k++) {
        const m = inst.matrices;
        const o = k * 16;
        const col = (c: number): number => Math.hypot(m[o + c * 4] as number, m[o + c * 4 + 1] as number, m[o + c * 4 + 2] as number);
        const sx = col(0);
        const sy = col(1);
        const sz = col(2);
        const cx = (m[o] as number) * lc[0] + (m[o + 4] as number) * lc[1] + (m[o + 8] as number) * lc[2] + (m[o + 12] as number);
        const cy = (m[o + 1] as number) * lc[0] + (m[o + 5] as number) * lc[1] + (m[o + 9] as number) * lc[2] + (m[o + 13] as number);
        const cz = (m[o + 2] as number) * lc[0] + (m[o + 6] as number) * lc[1] + (m[o + 10] as number) * lc[2] + (m[o + 14] as number);
        const area = baseArea * Math.max(sx * sy, sy * sz, sx * sz);
        geoms.push({ cx, cy, cz, r: lr * Math.max(sx, sy, sz), density: area });
        areaList.push(area);
        triList.push(tris);
        sizeList.push(lr * Math.max(sx, sy, sz) * 2);
      }
      plans[entryIndex] = { type, instanced: true, nodeStart, nodeCount: inst.count, comps: null, info: null, anchors: null };
    } else {
      const comps = meshComponents(mesh);
      const info = describeComponents(mesh, comps);
      const k = comps.count;
      const mins = new Float64Array(k * 3).fill(Infinity);
      const maxs = new Float64Array(k * 3).fill(-Infinity);
      const area = new Float64Array(k);
      const nv = mesh.positions.length / 3;
      for (let i = 0; i < nv; i++) {
        const c = comps.ids[i] as number;
        for (let a = 0; a < 3; a++) {
          const v = mesh.positions[i * 3 + a] as number;
          if (v < (mins[c * 3 + a] as number)) mins[c * 3 + a] = v;
          if (v > (maxs[c * 3 + a] as number)) maxs[c * 3 + a] = v;
        }
      }
      for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
        const a = mesh.indices[i] as number;
        const c = comps.ids[a] as number;
        area[c] = (area[c] as number) + triArea(mesh.positions, a, mesh.indices[i + 1] as number, mesh.indices[i + 2] as number);
      }
      const centroids = new Float32Array(k * 3);
      for (let c = 0; c < k; c++) {
        const cx = ((mins[c * 3] as number) + (maxs[c * 3] as number)) / 2;
        const cy = ((mins[c * 3 + 1] as number) + (maxs[c * 3 + 1] as number)) / 2;
        const cz = ((mins[c * 3 + 2] as number) + (maxs[c * 3 + 2] as number)) / 2;
        centroids[c * 3] = cx;
        centroids[c * 3 + 1] = cy;
        centroids[c * 3 + 2] = cz;
        const diag = info.diagonal[c] as number;
        const projected = type === 'branches' ? (area[c] as number) * 0.5 : (area[c] as number);
        geoms.push({ cx, cy, cz, r: diag / 2, density: projected });
        areaList.push(area[c] as number);
        triList.push(info.triangles[c] as number);
        sizeList.push(diag);
      }
      let anchors: Float32Array;
      if (type === 'branches') {
        anchors = ringAnchors(mesh, comps, centroids);
      } else {
        anchors = new Float32Array(nv * 3);
        for (let i = 0; i < nv; i++) {
          const c = comps.ids[i] as number;
          for (let a = 0; a < 3; a++) anchors[i * 3 + a] = info.base[c * 3 + a] as number;
        }
      }
      plans[entryIndex] = { type, instanced: false, nodeStart, nodeCount: k, comps, info, anchors };
    }
    for (const g of geoms) {
      allGeoms.push(g);
      typeList.push(TYPE_INDEX[type]);
      weightList.push(weight);
    }
  });

  const nodeCount = allGeoms.length;
  for (const t of triList) totalTriangles += t;
  const exposure = computeExposure(allGeoms);
  const rank = new Float32Array(nodeCount);
  const rankSeed = (seed ^ 0x51ed27) >>> 0;
  for (let t = 0; t < 4; t++) {
    const members: number[] = [];
    for (let i = 0; i < nodeCount; i++) if (typeList[i] === t) members.push(i);
    if (members.length === 0) continue;
    // Branches: bigger pieces matter more (percentile of the bounding diagonal) besides being exposed.
    const bySize = [...members].sort((a, b) => (sizeList[a] as number) - (sizeList[b] as number) || a - b);
    const sizePct = new Map<number, number>();
    bySize.forEach((node, i) => sizePct.set(node, members.length > 1 ? i / (members.length - 1) : 1));
    const scores = new Map<number, number>();
    for (const node of members) {
      const base = t === 0 ? 0.4 * (exposure[node] as number) + 0.6 * (sizePct.get(node) as number) : (exposure[node] as number);
      scores.set(node, base + ((weightList[node] as number) - NEUTRAL_LOD_WEIGHT) * 1.5 + 1e-4 * hash01(node, rankSeed));
    }
    const order = [...members].sort((a, b) => (scores.get(b) as number) - (scores.get(a) as number) || a - b);
    order.forEach((node, i) => {
      rank[node] = i / order.length;
    });
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const g of allGeoms) {
    minX = Math.min(minX, g.cx - g.r);
    minY = Math.min(minY, g.cy - g.r);
    minZ = Math.min(minZ, g.cz - g.r);
    maxX = Math.max(maxX, g.cx + g.r);
    maxY = Math.max(maxY, g.cy + g.r);
    maxZ = Math.max(maxZ, g.cz + g.r);
  }
  const has = nodeCount > 0;
  return {
    entries: plans,
    nodeCount,
    type: Uint8Array.from(typeList),
    exposure,
    rank,
    area: Float32Array.from(areaList),
    triangles: Uint32Array.from(triList),
    center: has ? [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2] : [0, 0, 0],
    radius: has ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 : 0,
    totalTriangles,
  };
}
