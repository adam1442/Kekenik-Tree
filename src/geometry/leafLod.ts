import type { CutoutMesh, LodLevel } from '@/contracts/material';
import { evaluateCurve, type Curve } from '@/contracts/curve';

/** Mesh LOD slots in order of detail. */
export const MESH_LODS: readonly LodLevel[] = ['high', 'med', 'low'];

/** Highest LOD index of the engine (0 = highest detail). The Resolution curves use x = lod / MAX_LOD. */
export const MAX_LOD = 3;

/** Normalised position of a (continuous) LOD on the Resolution curves: 0 = highest detail, 1 = lowest. */
export const lodPosition = (lod: number): number => Math.min(1, Math.max(0, lod / MAX_LOD));

/** Legacy / default mapping of the engine LOD to a mesh LOD index (0 High, 1 Med, 2 Low). */
export function defaultMeshLodIndex(lod: number): number {
  if (lod <= 0.5) return 0;
  if (lod <= 1.5) return 1;
  return 2;
}

/** Factor applied to the size of a leaf for `lod`: `1 + percent / 100` of the "Size increase %" curve (never below 5 %). */
export function sizeIncreaseFactor(curve: Curve | null, lod: number): number {
  const percent = curve ? evaluateCurve(curve, lodPosition(lod)) : 12 * Math.min(MAX_LOD, Math.max(0, lod));
  return Math.max(0.05, 1 + percent / 100);
}

/** Mesh LOD slots of a cutout that hold usable geometry (a generated outline variant or an imported mesh). */
export function filledMeshLods(cutout: Pick<CutoutMesh, 'lods'> | null | undefined): LodLevel[] {
  const lods = cutout?.lods;
  if (!lods) return [];
  return MESH_LODS.filter((level) => {
    const v = lods[level];
    if (!v) return false;
    if (v.importedMesh) return v.importedMesh.positions.length >= 9;
    return v.vertices.length >= 6 && v.indices.length >= 3;
  });
}

export interface MeshLodRequest {
  /** Active (viewport / export) LOD, 0 = highest detail. */
  lod: number;
  /** "Mesh LOD" curve (value 0 = High, 1 = Med, 2 = Low, rounded); null = default mapping. */
  curve: Curve | null;
  /** "Mesh LOD offset": shifts the chosen LOD toward lower (+) or higher (-) detail. */
  offset: number;
  /** Slots of the chosen mesh that hold geometry. */
  filled: readonly LodLevel[];
}

export interface MeshLodChoice {
  level: LodLevel;
  /** The offset was not applied because fewer than two slots are filled. */
  offsetIgnored: boolean;
}

/**
 * Chooses the mesh LOD slot: curve (or default mapping) at the active LOD, plus the offset clamped to High..Low.
 * The offset needs two or more filled slots; an empty slot falls back to the nearest filled one (finer wins ties).
 * Without any filled slot the plain level is returned (the cutout builder rebuilds missing variants itself).
 */
export function chooseMeshLod(req: MeshLodRequest): MeshLodChoice {
  const raw = req.curve ? evaluateCurve(req.curve, lodPosition(req.lod)) : defaultMeshLodIndex(req.lod);
  const base = clampIndex(Math.round(raw + 1e-6));
  const offset = Math.round(req.offset);
  const usable = req.filled.length >= 2;
  const wanted = usable ? clampIndex(base + offset) : base;
  const offsetIgnored = !usable && offset !== 0;
  if (req.filled.length === 0) return { level: MESH_LODS[wanted] as LodLevel, offsetIgnored };
  let best = wanted;
  let bestDist = Infinity;
  for (let i = 0; i < MESH_LODS.length; i++) {
    if (!req.filled.includes(MESH_LODS[i] as LodLevel)) continue;
    const dist = Math.abs(i - wanted);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return { level: MESH_LODS[best] as LodLevel, offsetIgnored };
}

const clampIndex = (i: number): number => Math.min(MESH_LODS.length - 1, Math.max(0, i));
