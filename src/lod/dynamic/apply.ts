import type { SceneEntry, SceneModel, SceneStats } from '@/contracts/engine';
import { evaluateCurve } from '@/contracts/curve';
import type { MaterialSlotRange, MeshData } from '@/contracts/mesh';
import { meshTriangleCount, meshVertexCount } from '@/contracts/mesh';
import { subsetComponents } from '@/export/lod/meshOps';
import { INTERIOR_EXPOSURE, TYPE_INDEX, type DynamicLodModel, type LodEntryPlan } from './analysis';
import type { DynamicLodConfig, LodGeometryType } from './types';
import { LOD_GEOMETRY_TYPES } from './types';

/** Width of the shrink band in rank units: a node shrinks from full size to nothing while the kept fraction sweeps over it. */
export const SHRINK_BAND = 0.25;
/** Largest growth of the surviving leaves (Grow Scale). */
export const MAX_GROW = 3;
/** A node scaled below this is removed (its triangles are dropped). */
export const REMOVE_BELOW = 1e-3;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Kept fraction (1 = all, 0 = none) of one geometry family at LOD `value`. */
export function lodKeep(config: DynamicLodConfig, type: LodGeometryType, value: number): number {
  if (value <= 0) return 1;
  return clamp01(evaluateCurve(config[type], clamp01(value)));
}

/**
 * Shrink factor of a node with survival `rank` while `keep` of its family is kept: 1 well inside the kept share, falling
 * continuously to 0 over the shrink band, 0 beyond. Continuous in `keep`, hence in the LOD value.
 */
export function shrinkScale(rank: number, keep: number): number {
  return clamp01((keep * (1 + SHRINK_BAND) - rank) / SHRINK_BAND);
}

/**
 * Per-node scale factor at LOD `value` (0 = removed). Shrinking nodes get smaller, the survivors of leaf-like families
 * grow (Grow Scale curve) so the covered area is kept.
 */
export function lodNodeScales(model: DynamicLodModel, config: DynamicLodConfig, value: number): Float32Array {
  const out = new Float32Array(model.nodeCount).fill(1);
  if (value <= 0 || model.nodeCount === 0) return out;
  const keeps = LOD_GEOMETRY_TYPES.map((t) => lodKeep(config, t, value));
  const total = [0, 0, 0, 0];
  const alive = [0, 0, 0, 0];
  for (let i = 0; i < model.nodeCount; i++) {
    const t = model.type[i] as number;
    const s = shrinkScale(model.rank[i] as number, keeps[t] as number);
    out[i] = s;
    total[t] = (total[t] as number) + (model.area[i] as number);
    alive[t] = (alive[t] as number) + (model.area[i] as number) * s * s;
  }
  const grow = clamp01(evaluateCurve(config.growScale, clamp01(value)));
  const growth = [1, 1, 1, 1];
  for (const t of [TYPE_INDEX.leaves, TYPE_INDEX.fronds]) {
    const full = Math.min(MAX_GROW, Math.sqrt((total[t] as number) / Math.max(alive[t] as number, 1e-12)));
    growth[t] = 1 + grow * (Math.max(1, full) - 1);
  }
  for (let i = 0; i < model.nodeCount; i++) {
    const t = model.type[i] as number;
    if (t === TYPE_INDEX.leaves || t === TYPE_INDEX.fronds) out[i] = (out[i] as number) * (growth[t] as number);
  }
  return out;
}

export interface DynamicLodReport {
  value: number;
  triangles: number;
  fullTriangles: number;
  removedTriangles: number;
  /** Share (0..1) of the removed triangles that belonged to interior (hidden) nodes. */
  interiorRemovedShare: number;
  /** Nodes removed / total per geometry family. */
  perType: { type: LodGeometryType; removed: number; total: number }[];
}

/** Triangle statistics of a LOD value, without touching any mesh (cheap enough to update live). */
export function lodReport(model: DynamicLodModel, scales: Float32Array, value: number): DynamicLodReport {
  let triangles = 0;
  let removedTriangles = 0;
  let interiorRemoved = 0;
  const removed = [0, 0, 0, 0];
  const count = [0, 0, 0, 0];
  for (let i = 0; i < model.nodeCount; i++) {
    const t = model.type[i] as number;
    const tris = model.triangles[i] as number;
    count[t] = (count[t] as number) + 1;
    if ((scales[i] as number) <= REMOVE_BELOW) {
      removedTriangles += tris;
      removed[t] = (removed[t] as number) + 1;
      if ((model.exposure[i] as number) < INTERIOR_EXPOSURE) interiorRemoved += tris;
    } else {
      triangles += tris;
    }
  }
  return {
    value,
    triangles,
    fullTriangles: model.totalTriangles,
    removedTriangles,
    interiorRemovedShare: removedTriangles > 0 ? interiorRemoved / removedTriangles : 0,
    perType: LOD_GEOMETRY_TYPES.map((type, k) => ({ type, removed: removed[k] as number, total: count[k] as number })),
  };
}

function instancedMesh(mesh: MeshData, plan: LodEntryPlan, scales: Float32Array): MeshData {
  const inst = mesh.instanced;
  if (!inst) return mesh;
  const kept: number[] = [];
  for (let k = 0; k < inst.count; k++) if ((scales[plan.nodeStart + k] as number) > REMOVE_BELOW) kept.push(k);
  const matrices = new Float32Array(kept.length * 16);
  kept.forEach((src, dst) => {
    const s = scales[plan.nodeStart + src] as number;
    for (let k = 0; k < 16; k++) matrices[dst * 16 + k] = inst.matrices[src * 16 + k] as number;
    if (s !== 1) for (let k = 0; k < 12; k++) matrices[dst * 16 + k] = (matrices[dst * 16 + k] as number) * s;
  });
  return { ...mesh, instanced: { count: kept.length, matrices } };
}

/** Viewport path: new positions + a filtered index list; every other buffer is shared with the source mesh. */
function fastMesh(mesh: MeshData, plan: LodEntryPlan, scales: Float32Array): MeshData {
  const comps = plan.comps;
  const anchors = plan.anchors;
  if (!comps || !anchors) return mesh;
  const n = mesh.positions.length / 3;
  const positions = new Float32Array(mesh.positions);
  for (let i = 0; i < n; i++) {
    const s = scales[plan.nodeStart + (comps.ids[i] as number)] as number;
    if (s === 1) continue;
    for (let a = 0; a < 3; a++) {
      const b = anchors[i * 3 + a] as number;
      positions[i * 3 + a] = b + ((mesh.positions[i * 3 + a] as number) - b) * s;
    }
  }
  const indices: number[] = [];
  const slots: MaterialSlotRange[] = [];
  const source: MaterialSlotRange[] = mesh.slots.length > 0 ? mesh.slots : [{ materialId: 'default', indexStart: 0, indexCount: mesh.indices.length }];
  for (const slot of source) {
    const start = indices.length;
    for (let i = slot.indexStart; i + 2 < slot.indexStart + slot.indexCount; i += 3) {
      const a = mesh.indices[i] as number;
      if ((scales[plan.nodeStart + (comps.ids[a] as number)] as number) <= REMOVE_BELOW) continue;
      indices.push(a, mesh.indices[i + 1] as number, mesh.indices[i + 2] as number);
    }
    if (indices.length > start) slots.push({ materialId: slot.materialId, indexStart: start, indexCount: indices.length - start });
  }
  const { parts: _parts, collision: _collision, ...rest } = mesh;
  void _parts;
  void _collision;
  return { ...rest, positions, indices: Uint32Array.from(indices), slots };
}

/** Export path: the same transform with the removed vertices dropped. */
function compactMesh(mesh: MeshData, plan: LodEntryPlan, scales: Float32Array): MeshData {
  const comps = plan.comps;
  const info = plan.info;
  if (!comps || !info || !plan.anchors) return mesh;
  const keep = new Uint8Array(comps.count);
  const scale = new Float32Array(comps.count);
  for (let c = 0; c < comps.count; c++) {
    const s = scales[plan.nodeStart + c] as number;
    scale[c] = s;
    keep[c] = s > REMOVE_BELOW ? 1 : 0;
  }
  return subsetComponents(mesh, comps, info, keep, scale, plan.anchors);
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

export interface ApplyOptions {
  /** Drop the vertices of removed nodes (export). The viewport keeps the buffers and only filters the indices. */
  compact?: boolean;
}

/**
 * Apply Dynamic LOD `value` to the scene the model was analysed from. Value 0 returns the scene itself (bit-identical);
 * otherwise only positions / indices change, no graph evaluation is needed.
 */
export function applyDynamicLod(scene: SceneModel, model: DynamicLodModel, config: DynamicLodConfig, value: number, options: ApplyOptions = {}): SceneModel {
  if (value <= 0) return scene;
  const scales = lodNodeScales(model, config, value);
  const tag = `|dlod${value.toFixed(4)}`;
  const entries = scene.entries.map((e, i): SceneEntry => {
    const plan = model.entries[i];
    if (!plan) return e;
    const mesh = plan.instanced ? instancedMesh(e.mesh, plan, scales) : options.compact ? compactMesh(e.mesh, plan, scales) : fastMesh(e.mesh, plan, scales);
    return mesh === e.mesh ? e : { ...e, mesh, rev: `${e.rev}${tag}` };
  });
  return { ...scene, entries, stats: statsOf(scene, entries) };
}
