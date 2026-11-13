import type { SceneEntry, SceneModel, SceneStats } from '@/contracts/engine';
import { meshTriangleCount, meshVertexCount, type MeshData } from '@/contracts/mesh';
import type { LodLevelSettings } from '../types';
import { componentRank, describeComponents, meshComponents, subsetComponents, subsetInstances, type ComponentInfo, type MeshComponents } from './meshOps';

/** Pieces that are thinned out (and enlarged) by LOD generation. Everything else is treated as bark / structure. */
const FOLIAGE_GROUPS = new Set(['leaf meshes', 'fronds/fins', 'decorations', 'meshes', 'clusters']);

export const isFoliageEntry = (e: SceneEntry): boolean => FOLIAGE_GROUPS.has(e.statsGroup);

/** True when the level changes nothing after generation (only the generator detail differs). */
export const isPassThrough = (l: LodLevelSettings): boolean => l.foliageKeep >= 1 && l.minBranchSize <= 0 && l.triangleBudget <= 0;

export function levelKey(l: LodLevelSettings): string {
  return [l.engineLod, l.foliageKeep.toFixed(3), l.keepSilhouette ? 1 : 0, l.minBranchSize.toFixed(2), l.triangleBudget].join(':');
}

/** Vertical extent (Z, scene is Z-up) of the visible geometry. */
export function sceneHeight(scene: SceneModel): { min: number; max: number; height: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const e of scene.entries) {
    const p = e.mesh.positions;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 2; i < p.length; i += 3) {
      const z = p[i] as number;
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    const inst = e.mesh.instanced;
    if (inst && Number.isFinite(lo)) {
      for (let i = 0; i < inst.count; i++) {
        const tz = inst.matrices[i * 16 + 14] as number;
        const reach = Math.max(Math.abs(lo), Math.abs(hi)) * Math.hypot(inst.matrices[i * 16 + 8] as number, inst.matrices[i * 16 + 9] as number, inst.matrices[i * 16 + 10] as number);
        if (tz - reach < min) min = tz - reach;
        if (tz + reach > max) max = tz + reach;
      }
    } else if (Number.isFinite(lo)) {
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0, height: 0 };
  return { min, max, height: max - min };
}

interface Analysis {
  comps: MeshComponents;
  info: ComponentInfo;
}
const analysisCache = new WeakMap<MeshData, Analysis>();

function analyse(mesh: MeshData): Analysis {
  let a = analysisCache.get(mesh);
  if (!a) {
    const comps = meshComponents(mesh);
    a = { comps, info: describeComponents(mesh, comps) };
    analysisCache.set(mesh, a);
  }
  return a;
}

function cullSmall(mesh: MeshData, minDiagonal: number): MeshData {
  if (mesh.instanced || minDiagonal <= 0) return mesh;
  const { comps, info } = analyse(mesh);
  if (comps.count <= 1) return mesh;
  const keep = new Uint8Array(comps.count);
  let kept = 0;
  for (let c = 0; c < comps.count; c++) {
    if ((info.diagonal[c] as number) >= minDiagonal) {
      keep[c] = 1;
      kept++;
    }
  }
  if (kept === comps.count) return mesh;
  if (kept === 0) keep[0] = 1;
  return subsetComponents(mesh, comps, info, keep, null);
}

function thinFoliage(mesh: MeshData, keepFraction: number, silhouette: boolean, seed: number): MeshData {
  if (keepFraction >= 1) return mesh;
  const growth = silhouette ? Math.min(3, 1 / Math.sqrt(Math.max(keepFraction, 0.02))) : 1;
  if (mesh.instanced) return subsetInstances(mesh, keepFraction, growth, seed);
  const { comps, info } = analyse(mesh);
  if (comps.count <= 1) return mesh;
  const keep = new Uint8Array(comps.count);
  let kept = 0;
  for (let c = 0; c < comps.count; c++) {
    if (componentRank(c, seed) < keepFraction) {
      keep[c] = 1;
      kept++;
    }
  }
  if (kept === 0) keep[0] = kept = 1;
  const scale = new Float32Array(comps.count).fill(silhouette ? Math.min(3, 1 / Math.sqrt(kept / comps.count)) : 1);
  return subsetComponents(mesh, comps, info, keep, scale);
}

function statsOf(scene: SceneModel, entries: SceneEntry[]): SceneStats {
  const groups = new Map<string, number>();
  let triangles = 0;
  let vertices = 0;
  for (const e of entries) {
    const t = meshTriangleCount(e.mesh);
    triangles += t;
    vertices += meshVertexCount(e.mesh) * (e.mesh.instanced?.count ?? 1);
    groups.set(e.statsGroup, (groups.get(e.statsGroup) ?? 0) + t);
  }
  return { ...scene.stats, triangles, vertices, groups: [...groups].map(([label, tris]) => ({ label, triangles: tris })) };
}

/**
 * Post-process one generated scene into a LOD: remove small bark pieces, thin out the foliage (deterministic, nested
 * subsets) and enlarge what remains so the silhouette keeps its coverage, then fit an optional triangle budget.
 */
export function applyLodToScene(scene: SceneModel, level: LodLevelSettings, seed: number): SceneModel {
  if (isPassThrough(level)) return scene;
  const height = sceneHeight(scene).height;
  const minDiagonal = (level.minBranchSize / 100) * height;
  const key = levelKey(level);
  const rank = seed ^ 0x51ed27;

  const barked = new Map<SceneEntry, MeshData>();
  let barkTris = 0;
  let foliageTris = 0;
  for (const e of scene.entries) {
    if (isFoliageEntry(e)) {
      foliageTris += meshTriangleCount(e.mesh);
    } else {
      const m = cullSmall(e.mesh, minDiagonal);
      barked.set(e, m);
      barkTris += meshTriangleCount(m);
    }
  }
  let keep = level.foliageKeep;
  if (level.triangleBudget > 0 && foliageTris > 0) keep = Math.min(keep, Math.max(0.02, (level.triangleBudget - barkTris) / foliageTris));

  const entries = scene.entries.map((e): SceneEntry => {
    const mesh = isFoliageEntry(e) ? thinFoliage(e.mesh, keep, level.keepSilhouette, rank) : (barked.get(e) as MeshData);
    return mesh === e.mesh ? e : { ...e, mesh, rev: `${e.rev}|lod${key}` };
  });
  return { ...scene, entries, stats: statsOf(scene, entries) };
}

/** Fraction of the viewport height covered by an object of `height` metres seen from `distance` metres. */
export function screenFraction(distance: number, height: number, fovDeg: number): number {
  const visible = 2 * Math.max(distance, 1e-4) * Math.tan((fovDeg * Math.PI) / 360);
  return Math.min(10, height / visible);
}

export function distanceForFraction(fraction: number, height: number, fovDeg: number): number {
  return height / (2 * Math.max(fraction, 1e-4) * Math.tan((fovDeg * Math.PI) / 360));
}

/** The LOD an engine would show at this screen fraction: the last level whose transition is >= the fraction. */
export function lodForFraction(levels: readonly { transition: number }[], fraction: number): number {
  let pick = 0;
  levels.forEach((l, i) => {
    if (i > 0 && fraction <= l.transition) pick = i;
  });
  return pick;
}
