import type {
  CutoutMesh,
  DisplacementDef,
  MaskDef,
  MaterialDef,
  MaterialSetDef,
  MaterialSetMember,
  UVAreaDef,
} from '@/contracts/material';
import type { Rng } from '@/core/rng';
import { seasonWeight } from './shadingMath';

/**
 * Read-only view of the project's material library for node evaluation (generators are pure functions of their
 * params, this is the one global they may consult). The app installs the source in `materials/library.ts`.
 */
export interface MaterialSource {
  materials(): readonly MaterialDef[];
  sets(): readonly MaterialSetDef[];
  displacements(): readonly DisplacementDef[];
  masks(): readonly MaskDef[];
  /** Optional cutout/mesh list. */
  cutoutMeshes?(): readonly CutoutMesh[];
  /** Optional UV areas list. */
  uvAreas?(): readonly UVAreaDef[];
  /** Global season 0..1 (Lighting panel). */
  season(): number;
}

let source: MaterialSource | null = null;

export function setMaterialSource(next: MaterialSource | null): void {
  source = next;
}

export const getMaterialSource = (): MaterialSource | null => source;

/** Effective weight of one set member at `season` (set override > member curve > material curve), times the member weight. */
export function memberWeight(set: MaterialSetDef, member: MaterialSetMember, materials: readonly MaterialDef[], season: number): number {
  const mat = materials.find((m) => m.id === member.materialId);
  if (!mat) return 0;
  const curve = set.overrideSeason ? set.season : member.season ?? mat.season;
  return Math.max(0, member.weight) * seasonWeight(curve, season);
}

/** Deterministic weighted pick of a member's material id using the caller's seeded RNG (one `next()` draw). */
export function pickFromSet(set: MaterialSetDef, materials: readonly MaterialDef[], season: number, rng: Rng): string | null {
  const weights = set.members.map((m) => memberWeight(set, m, materials, season));
  const total = weights.reduce((a, b) => a + b, 0);
  const r = rng.next();
  if (total <= 0) return null;
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += (weights[i] as number) / total;
    if (r <= acc) return (set.members[i] as MaterialSetMember).materialId;
  }
  return (set.members[set.members.length - 1] as MaterialSetMember).materialId;
}

/**
 * Turns a Material property value (material id, material name, material-set id/name or legacy placeholder ids like
 * `leaf`) into a concrete material id. Set picks consume exactly one RNG draw; plain materials consume none.
 */
export function resolveMaterialRef(ref: string, rng: Rng, src: MaterialSource | null = source): string {
  if (!src || !ref) return ref;
  const materials = src.materials();
  if (materials.some((m) => m.id === ref)) return ref;
  const set = src.sets().find((s) => s.id === ref) ?? (materials.some((m) => m.name === ref) ? undefined : src.sets().find((s) => s.name === ref));
  if (set) return pickFromSet(set, materials, src.season(), rng) ?? ref;
  return materials.find((m) => m.name === ref)?.id ?? ref;
}

/**
 * Resolve a CutoutMesh for a leaf/frond/mesh generator given the resolved `materialId` and the `mesh` field
 * from the Leaf "Type" row (`'any'`, cutout id, or cutout name).
 */
export function resolveCutoutForLeaf(
  materialId: string,
  meshRef: string,
  rng: Rng,
  src: MaterialSource | null = source,
): CutoutMesh | null {
  const list = src?.cutoutMeshes?.() ?? [];
  if (list.length === 0) return null;
  if (meshRef && meshRef !== 'any' && meshRef !== 'none') {
    const direct = list.find((c) => c.id === meshRef || c.name === meshRef);
    if (direct) return direct;
  }
  if (meshRef === 'none') return null;
  const forMaterial = list.filter((c) => c.materialId === materialId);
  if (forMaterial.length === 0) return null;
  if (forMaterial.length === 1) return forMaterial[0] ?? null;
  const idx = Math.min(forMaterial.length - 1, Math.floor(rng.next() * forMaterial.length));
  return forMaterial[idx] ?? null;
}

/**
 * Resolve an active UV Area rectangle `[u0, v0, u1, v1]` for `materialId` (when UV areas are defined for that material).
 */
export function resolveUvAreaRect(
  materialId: string,
  usage: 'any' | 'leaf' | 'bark' | 'cap' | 'frond',
  rng: Rng,
  src: MaterialSource | null = source,
): [number, number, number, number] | null {
  const areas = (src?.uvAreas?.() ?? []).filter(
    (a) => a.materialId === materialId && (a.usage === 'any' || a.usage === usage),
  );
  if (areas.length === 0) return null;
  if (areas.length === 1) return areas[0]!.rect;
  const total = areas.reduce((s, a) => s + Math.max(0, a.weight), 0);
  if (total <= 0) return areas[0]!.rect;
  const r = rng.next() * total;
  let acc = 0;
  for (const a of areas) {
    acc += Math.max(0, a.weight);
    if (r <= acc) return a.rect;
  }
  return areas[areas.length - 1]!.rect;
}
