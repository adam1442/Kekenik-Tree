import type { CutoutMesh, CutoutMeshRef, MaterialDef } from '@/contracts/material';
import type { ListItem, NodeParams } from '@/contracts/params';
import type { Rng } from '@/core/rng';
import { getMaterialSource, pickFromSet, type MaterialSource } from './materialSource';

/** Mesh selector values stored in a material slot row (anything else is a specific mesh id or name). */
export const MESH_ANY = 'any';
export const MESH_PRIMARY = 'primary';
export const MESH_NOT_PRIMARY = 'notPrimary';
/** Legacy value: "no cutout, use the generator's own geometry". */
export const MESH_NONE = 'none';

/** How a generator chooses one of a material's meshes: a keyword or a specific mesh id. */
export type MeshSelectMode = string;

/** One row of a node's Material list. */
export interface MaterialSlotRow {
  /** Material id, Material Set id, or '' for None. */
  material: string;
  /** `any` / `primary` / `notPrimary` / mesh id (or name). */
  mesh: string;
  /** Relative pick weight (>= 0). */
  weight: number;
}

export const DEFAULT_MATERIAL_SLOT: Readonly<MaterialSlotRow> = { material: '', mesh: MESH_ANY, weight: 1 };

type MeshOwner = Pick<MaterialDef, 'id'> & { meshes?: readonly CutoutMeshRef[] };

// ---- mesh ownership / ordering --------------------------------------------------------------------------------------

/**
 * Refs of the meshes a material owns, in order (index 0 = Primary). Valid stored refs keep their order; cutouts that
 * belong to the material (`materialId`) but are not referenced yet are appended in library order. This is also the
 * migration of projects saved before materials owned an ordered mesh list.
 */
export function ownedMeshRefs(material: MeshOwner, cutouts: readonly CutoutMesh[]): CutoutMeshRef[] {
  const owned = new Set<string>();
  for (const c of cutouts) if (c.materialId === material.id) owned.add(c.id);
  const out: CutoutMeshRef[] = [];
  const seen = new Set<string>();
  for (const r of material.meshes ?? []) {
    if (owned.has(r.id) && !seen.has(r.id)) {
      out.push({ id: r.id });
      seen.add(r.id);
    }
  }
  for (const c of cutouts) {
    if (c.materialId === material.id && !seen.has(c.id)) {
      out.push({ id: c.id });
      seen.add(c.id);
    }
  }
  return out;
}

/** Cutout meshes of a material in Primary-first order. */
export function ownedMeshes(material: MeshOwner, cutouts: readonly CutoutMesh[]): CutoutMesh[] {
  const byId = new Map(cutouts.map((c) => [c.id, c]));
  const out: CutoutMesh[] = [];
  for (const r of ownedMeshRefs(material, cutouts)) {
    const c = byId.get(r.id);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Makes every `MaterialDef.meshes` list consistent with `cutouts` (drops refs to missing / foreign meshes, appends
 * unreferenced owned meshes). Mutates only what changed; returns true when something changed.
 */
export function reconcileMaterialMeshes(materials: MaterialDef[], cutouts: readonly CutoutMesh[]): boolean {
  let changed = false;
  for (const m of materials) {
    const next = ownedMeshRefs(m, cutouts);
    const cur: readonly CutoutMeshRef[] | null = Array.isArray(m.meshes) ? m.meshes : null;
    if (!cur || cur.length !== next.length || cur.some((r, i) => r.id !== (next[i] as CutoutMeshRef).id)) {
      m.meshes = next;
      changed = true;
    }
  }
  return changed;
}

// ---- selection ------------------------------------------------------------------------------------------------------

/**
 * Chooses one mesh of `material`.
 *
 * - `any`: uniform among all meshes. - `primary`: index 0. - `notPrimary`: uniform among index >= 1, primary when
 * there is only one mesh. - anything else: that mesh id (falls back to primary when the id is not owned).
 *
 * One RNG draw is consumed only when there is a real choice (more than one candidate), so projects whose materials
 * have a single mesh keep exactly the random stream they had before materials owned several meshes.
 */
export function selectMesh(material: { meshes: readonly CutoutMeshRef[] }, mode: MeshSelectMode, rng: Rng): CutoutMeshRef | null {
  const list = material.meshes;
  if (list.length === 0) return null;
  const pick = (from: number): CutoutMeshRef | null => {
    const count = list.length - from;
    if (count <= 1) return list[from] ?? null;
    return list[from + Math.min(count - 1, Math.floor(rng.next() * count))] ?? null;
  };
  if (mode === MESH_PRIMARY) return list[0] ?? null;
  if (mode === MESH_ANY) return pick(0);
  if (mode === MESH_NOT_PRIMARY) return list.length === 1 ? (list[0] ?? null) : pick(1);
  return list.find((r) => r.id === mode) ?? list[0] ?? null;
}

const clampWeight = (w: number): number => Math.max(0, Number.isFinite(w) ? w : 0);

/** Index chosen by `r` in [0, 1) with probability weight / sum(weights); -1 when every weight is 0. */
export function pickWeightedIndex(weights: readonly number[], r: number): number {
  let total = 0;
  for (const w of weights) total += clampWeight(w);
  if (total <= 0) return -1;
  let acc = 0;
  let last = -1;
  for (let i = 0; i < weights.length; i++) {
    const w = clampWeight(weights[i] as number);
    if (w <= 0) continue;
    last = i;
    acc += w / total;
    if (r < acc) return i;
  }
  return last;
}

/** Probability (0..1) of each row = weight / sum(weights). */
export function slotProbabilities(rows: readonly Pick<MaterialSlotRow, 'weight'>[]): number[] {
  const w = rows.map((r) => clampWeight(r.weight));
  const total = w.reduce((a, b) => a + b, 0);
  return w.map((x) => (total > 0 ? x / total : 0));
}

// ---- node-side list ---------------------------------------------------------------------------------------------------

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * Reads a node's material list. A node saved before the list existed only has the single `material` param: it becomes
 * a one-row list. Never returns an empty list.
 */
export function readMaterialSlots(params: NodeParams, listId = 'leafTypes', legacyId = 'material'): MaterialSlotRow[] {
  const raw = params[listId]?.value;
  if (Array.isArray(raw)) {
    const rows: MaterialSlotRow[] = [];
    for (const it of raw as ListItem[]) {
      if (typeof it !== 'object' || it === null) continue;
      rows.push({
        material: typeof it.material === 'string' ? it.material : '',
        mesh: typeof it.mesh === 'string' && it.mesh ? it.mesh : MESH_ANY,
        weight: Math.max(0, num(it.weight, 1)),
      });
    }
    if (rows.length > 0) return rows;
  }
  const legacy = params[legacyId]?.value;
  return [{ ...DEFAULT_MATERIAL_SLOT, material: typeof legacy === 'string' ? legacy : '' }];
}

/** Migration helper: writes the one-row list when `params` still only has the legacy `material` param. */
export function migrateLegacyMaterialParam(params: NodeParams, listId = 'leafTypes', legacyId = 'material'): NodeParams {
  if (Array.isArray(params[listId]?.value)) return params;
  const legacy = params[legacyId]?.value;
  if (typeof legacy !== 'string') return params;
  const out: NodeParams = { ...params };
  out[listId] = { value: [{ material: legacy, mesh: MESH_ANY, weight: 1 }] };
  delete out[legacyId];
  return out;
}

// ---- resolution -----------------------------------------------------------------------------------------------------

/**
 * Concrete material id of a slot: a plain material (no RNG draw), or a member of a Material Set chosen by weight and
 * season (one draw). '' stays '' (None). `season` is 0..1 (Lighting panel); sets apply their season response to it.
 */
export function resolveMaterial(slot: Pick<MaterialSlotRow, 'material'>, season: number, rng: Rng, src: MaterialSource | null = getMaterialSource()): string {
  const ref = slot.material;
  if (!ref || !src) return ref;
  const materials = src.materials();
  if (materials.some((m) => m.id === ref)) return ref;
  const set = src.sets().find((s) => s.id === ref) ?? (materials.some((m) => m.name === ref) ? undefined : src.sets().find((s) => s.name === ref));
  if (set) return pickFromSet(set, materials, season, rng) ?? ref;
  return materials.find((m) => m.name === ref)?.id ?? ref;
}

export interface PickContext {
  rng: Rng;
  /** Material id used when the chosen row is None (and for rendering the unit-square placeholder). */
  fallbackMaterial: string;
  /** 0..1; defaults to the source's global season. */
  season?: number;
  src?: MaterialSource | null;
}

export interface PickedMaterialMesh {
  /** Resolved material definition, null when it is not in the library (legacy placeholder ids). */
  material: MaterialDef | null;
  /** Resolved material id to render with (the fallback id for a None row). */
  materialId: string;
  /** Chosen cutout mesh; null = unit-square placeholder. */
  meshAsset: CutoutMesh | null;
  /** High / Med / Low variants of the chosen mesh; null with the placeholder. */
  lodMeshes: CutoutMesh['lods'] | null;
  /** Index of the chosen list row. */
  row: number;
}

const KEYWORDS = new Set([MESH_ANY, MESH_PRIMARY, MESH_NOT_PRIMARY, MESH_NONE]);

/**
 * The one shared selection used by Leaf, Frond, Mesh generator and Decoration: weighted row (one draw) -> material
 * (Material Sets: one more draw) -> mesh of that material per the row's Mesh selector.
 */
export function pickMaterialMesh(list: readonly MaterialSlotRow[], ctx: PickContext): PickedMaterialMesh {
  const src = ctx.src === undefined ? getMaterialSource() : ctx.src;
  const rows = list.length > 0 ? list : [DEFAULT_MATERIAL_SLOT];
  const draw = ctx.rng.next();
  let idx = pickWeightedIndex(
    rows.map((x) => x.weight),
    draw,
  );
  if (idx < 0) idx = 0;
  const row = rows[idx] as MaterialSlotRow;
  const season = ctx.season ?? src?.season() ?? 0.5;
  const materialId = resolveMaterial(row, season, ctx.rng, src) || ctx.fallbackMaterial;
  const material = src?.materials().find((m) => m.id === materialId) ?? null;
  const cutouts = src?.cutoutMeshes?.() ?? [];

  let meshAsset: CutoutMesh | null = null;
  if (row.mesh !== MESH_NONE && cutouts.length > 0) {
    // A specific mesh (id or legacy name) wins, even when it was assigned by drag & drop from another material.
    const specific = KEYWORDS.has(row.mesh) ? undefined : cutouts.find((c) => c.id === row.mesh || c.name === row.mesh);
    if (specific) meshAsset = specific;
    else {
      const refs = ownedMeshRefs(material ?? { id: materialId }, cutouts);
      const ref = selectMesh({ meshes: refs }, row.mesh, ctx.rng);
      meshAsset = ref ? (cutouts.find((c) => c.id === ref.id) ?? null) : null;
    }
  }
  return { material, materialId, meshAsset, lodMeshes: meshAsset ? meshAsset.lods : null, row: idx };
}

// ---- UI option lists --------------------------------------------------------------------------------------------------

export interface ChoiceOption {
  value: string;
  label: string;
}

/** Material dropdown of a slot row: None, every material, then Material Sets. */
export function materialChoices(src: Pick<MaterialSource, 'materials' | 'sets'>): ChoiceOption[] {
  return [
    { value: '', label: 'None' },
    ...src.materials().map((m) => ({ value: m.id, label: m.name })),
    ...src.sets().map((s) => ({ value: s.id, label: `Set: ${s.name}` })),
  ];
}

/**
 * Mesh dropdown of a slot row: Any / Primary / Not primary plus the material's named meshes (a Material Set or None
 * only offers the keywords because the member is chosen at generation time). `current` is kept selectable even when
 * it no longer belongs to the material, so a stored value is never silently rewritten.
 */
export function meshChoices(materialRef: string, src: Pick<MaterialSource, 'materials' | 'sets'> & { cutoutMeshes?(): readonly CutoutMesh[] }, current = MESH_ANY): ChoiceOption[] {
  const out: ChoiceOption[] = [
    { value: MESH_ANY, label: 'Any' },
    { value: MESH_PRIMARY, label: 'Primary' },
    { value: MESH_NOT_PRIMARY, label: 'Not primary' },
  ];
  const cutouts = src.cutoutMeshes?.() ?? [];
  const material = src.materials().find((m) => m.id === materialRef);
  if (material) for (const c of ownedMeshes(material, cutouts)) out.push({ value: c.id, label: c.name });
  if (!out.some((o) => o.value === current)) {
    const c = cutouts.find((x) => x.id === current || x.name === current);
    if (c) out.push({ value: c.id, label: c.name });
  }
  return out;
}
