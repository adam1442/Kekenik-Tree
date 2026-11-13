import type {
  CutoutMesh,
  DisplacementDef,
  MaskDef,
  MaterialDef,
  MaterialSetDef,
  UVAreaDef,
} from '@/contracts/material';
import type { AssetEntry } from '@/contracts/project';
import { uid } from '@/core/id';
import { ATTACH_VERSION, ensureCutoutAttachmentData } from './cutouts/frame';
import { createDefaultCutoutMesh, createDefaultUVArea, createReferenceClusterCutout } from './cutouts/ops';
import { createDisplacementDef } from './displacement';
import { createMaskDef } from './masks';
import type { MaterialSource } from './materialSource';
import { createMaterialDef } from './shadingMath';

/** Project data the library edits (a subset of `ProjectMeta`; arrays are replaced, never mutated across snapshots). */
export interface LibraryMeta {
  materials: MaterialDef[];
  materialSets?: MaterialSetDef[];
  masks?: MaskDef[];
  displacements?: DisplacementDef[];
  cutoutMeshes?: CutoutMesh[];
  uvAreas?: UVAreaDef[];
  assets: AssetEntry[];
}

export type LibraryKind = 'materials' | 'materialSets' | 'masks' | 'displacements' | 'meshes' | 'uvAreas';
export type LibraryChange = { kind: LibraryKind | 'all' | 'season' };

type Entry = { id: string; name: string };

interface Snapshot {
  materials: MaterialDef[];
  materialSets: MaterialSetDef[];
  masks: MaskDef[];
  displacements: DisplacementDef[];
  cutoutMeshes: CutoutMesh[];
  uvAreas: UVAreaDef[];
}

/** Optional undo integration (the app passes `app.undo`). */
export interface LibraryHistory {
  execute(cmd: { label: string; do(): void; undo(): void; merge?(next: unknown): boolean }): void;
}

const KINDS: LibraryKind[] = ['materials', 'materialSets', 'masks', 'displacements', 'meshes', 'uvAreas'];
const MERGE_WINDOW_MS = 700;

export function defaultMaterials(): MaterialDef[] {
  const bark = createMaterialDef('bark', 'Bark');
  bark.slots.gloss = { scalar: 0.05 };
  bark.variationAmount = 0;
  const leaf = createMaterialDef('leaf', 'Leaf');
  leaf.twoSided = true;
  leaf.slots.gloss = { scalar: 0.2 };
  leaf.slots.subsurface = { color: [0.55, 0.75, 0.25, 1] };
  leaf.slots.subsurfacePercent = { scalar: 0.35 };
  const cluster = createMaterialDef('cluster', 'Cluster');
  cluster.twoSided = true;
  cluster.slots.gloss = { scalar: 0.1 };
  cluster.slots.subsurface = { color: [0.55, 0.75, 0.25, 1] };
  cluster.slots.subsurfacePercent = { scalar: 0.3 };
  return [bark, leaf, cluster];
}

export function defaultCutoutMeshes(): CutoutMesh[] {
  return [createReferenceClusterCutout('cutout_needle_1', 'Needle_Cluster_1 Cutout', 'cluster', 4)];
}

/**
 * Project-level library of materials, material sets, masks and displacements. Implements `MaterialSource` so node
 * evaluation can resolve material references. All edits go through `edit()` which snapshots for undo and notifies.
 */
export class MaterialLibrary implements MaterialSource {
  private getMeta: () => LibraryMeta | undefined = () => undefined;
  private history: LibraryHistory | null = null;
  private readonly listeners = new Set<(c: LibraryChange) => void>();
  private seasonValue = 0.5;

  bind(getMeta: () => LibraryMeta | undefined, history: LibraryHistory | null): void {
    this.getMeta = getMeta;
    this.history = history;
    this.emit({ kind: 'all' });
  }

  onChange(fn: (c: LibraryChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(c: LibraryChange): void {
    this.listeners.forEach((l) => l(c));
  }

  /** Meta of the active document with defaults guaranteed. */
  private meta(): LibraryMeta {
    const m = this.getMeta();
    if (!m) {
      return {
        materials: defaultMaterials(),
        materialSets: [],
        masks: [],
        displacements: [],
        cutoutMeshes: defaultCutoutMeshes(),
        uvAreas: [],
        assets: [],
      };
    }
    if (m.materials.length === 0) m.materials = defaultMaterials();
    m.materialSets ??= [];
    m.masks ??= [];
    m.displacements ??= [];
    if (!m.cutoutMeshes || m.cutoutMeshes.length === 0) {
      m.cutoutMeshes = defaultCutoutMeshes();
    }
    m.uvAreas ??= [];
    // Projects authored before attachment frames get the fallback axis / ordered anchors silently.
    for (const c of m.cutoutMeshes) if (c.attachVersion !== ATTACH_VERSION) ensureCutoutAttachmentData(c);
    return m;
  }

  materials(): MaterialDef[] {
    return this.meta().materials;
  }
  sets(): MaterialSetDef[] {
    return this.meta().materialSets as MaterialSetDef[];
  }
  masks(): MaskDef[] {
    return this.meta().masks as MaskDef[];
  }
  displacements(): DisplacementDef[] {
    return this.meta().displacements as DisplacementDef[];
  }
  cutoutMeshes(): CutoutMesh[] {
    return this.meta().cutoutMeshes as CutoutMesh[];
  }
  uvAreas(): UVAreaDef[] {
    return this.meta().uvAreas as UVAreaDef[];
  }
  assets(): AssetEntry[] {
    return this.meta().assets;
  }
  season(): number {
    return this.seasonValue;
  }
  setSeason(v: number): void {
    this.seasonValue = Math.min(1, Math.max(0, v));
    this.emit({ kind: 'season' });
  }

  material(id: string | null | undefined): MaterialDef | undefined {
    return id ? this.materials().find((m) => m.id === id) : undefined;
  }

  cutoutMesh(id: string | null | undefined): CutoutMesh | undefined {
    return id ? this.cutoutMeshes().find((c) => c.id === id || c.name === id) : undefined;
  }

  cutoutsForMaterial(materialId: string): CutoutMesh[] {
    return this.cutoutMeshes().filter((c) => c.materialId === materialId);
  }

  uvAreasForMaterial(materialId: string): UVAreaDef[] {
    return this.uvAreas().filter((u) => u.materialId === materialId);
  }

  private snapshot(): Snapshot {
    const m = this.meta();
    return structuredClone({
      materials: m.materials,
      materialSets: m.materialSets ?? [],
      masks: m.masks ?? [],
      displacements: m.displacements ?? [],
      cutoutMeshes: m.cutoutMeshes ?? [],
      uvAreas: m.uvAreas ?? [],
    });
  }

  private restore(s: Snapshot): void {
    const m = this.getMeta();
    if (!m) return;
    const c = structuredClone(s);
    m.materials = c.materials;
    m.materialSets = c.materialSets;
    m.masks = c.masks;
    m.displacements = c.displacements;
    m.cutoutMeshes = c.cutoutMeshes;
    m.uvAreas = c.uvAreas;
    this.emit({ kind: 'all' });
  }

  /**
   * Run `mutator` on the live data, publish the change and register one undo step. Edits sharing `mergeKey` that happen
   * within 700 ms collapse into one step (slider drags).
   */
  edit(label: string, kind: LibraryKind, mutator: () => void, mergeKey?: string): void {
    const before = this.snapshot();
    mutator();
    const after = this.snapshot();
    this.emit({ kind });
    if (!this.history) return;
    // The mutation is already applied: the first do() is a no-op (UndoStack.execute calls it), redo restores `after`.
    let applied = false;
    let finalAfter = after;
    let lastAt = performance.now();
    const cmd = {
      label,
      do: (): void => {
        if (!applied) applied = true;
        else this.restore(finalAfter);
      },
      undo: (): void => this.restore(before),
      merge: (next: unknown): boolean => {
        const n = next as { mergeKey?: string; after?: Snapshot; at?: number };
        if (mergeKey === undefined || n.mergeKey !== mergeKey || !n.after || n.at === undefined || n.at - lastAt > MERGE_WINDOW_MS) return false;
        finalAfter = n.after;
        lastAt = n.at;
        return true;
      },
      mergeKey,
      after,
      at: lastAt,
    };
    this.history.execute(cmd);
  }

  // ---- generic collection ops ------------------------------------------------------------------------------------

  private list(kind: LibraryKind): Entry[] {
    return (
      kind === 'materials'
        ? this.materials()
        : kind === 'materialSets'
          ? this.sets()
          : kind === 'masks'
            ? this.masks()
            : kind === 'displacements'
              ? this.displacements()
              : kind === 'meshes'
                ? this.cutoutMeshes()
                : this.uvAreas()
    ) as Entry[];
  }

  uniqueName(kind: LibraryKind, base: string): string {
    const names = new Set(this.list(kind).map((e) => e.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} ${n}`)) n++;
    return `${base} ${n}`;
  }

  add(kind: LibraryKind, materialId?: string): string {
    const id = uid(
      kind === 'materials'
        ? 'mat'
        : kind === 'materialSets'
          ? 'mset'
          : kind === 'masks'
            ? 'mask'
            : kind === 'displacements'
              ? 'disp'
              : kind === 'meshes'
                ? 'cut'
                : 'uva',
    );
    const label = {
      materials: 'Material',
      materialSets: 'Set',
      masks: 'Mask',
      displacements: 'Displacement',
      meshes: 'Mesh',
      uvAreas: 'UV Area',
    }[kind];
    const defaultBase =
      kind === 'masks'
        ? 'Mask_1'
        : kind === 'displacements'
          ? 'Displacement_1'
          : kind === 'materialSets'
            ? 'Set_1'
            : kind === 'meshes'
              ? 'Cutout_1'
              : kind === 'uvAreas'
                ? 'Area_1'
                : 'Material_1';
    const name = this.uniqueName(kind, defaultBase);
    const targetMatId = materialId ?? this.materials().find((m) => m.id === 'leaf')?.id ?? this.materials()[0]?.id ?? 'leaf';
    this.edit(`Add ${label}`, kind, () => {
      const m = this.meta();
      if (kind === 'materials') m.materials = [...m.materials, createMaterialDef(id, name)];
      else if (kind === 'materialSets') m.materialSets = [...this.sets(), { id, name, overrideSeason: false, season: null, members: [] }];
      else if (kind === 'masks') m.masks = [...this.masks(), createMaskDef(id, name)];
      else if (kind === 'displacements') m.displacements = [...this.displacements(), createDisplacementDef(id, name)];
      else if (kind === 'meshes') m.cutoutMeshes = [...this.cutoutMeshes(), createDefaultCutoutMesh(id, name, targetMatId)];
      else m.uvAreas = [...this.uvAreas(), createDefaultUVArea(id, name, targetMatId, this.uvAreasForMaterial(targetMatId).length)];
    });
    return id;
  }

  duplicate(kind: LibraryKind, id: string): string | null {
    const src = this.list(kind).find((e) => e.id === id);
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = uid('dup');
    copy.name = this.uniqueName(kind, `${src.name} copy`);
    this.edit('Duplicate', kind, () => {
      const m = this.meta();
      const arr = [...this.list(kind), copy];
      if (kind === 'materials') m.materials = arr as MaterialDef[];
      else if (kind === 'materialSets') m.materialSets = arr as MaterialSetDef[];
      else if (kind === 'masks') m.masks = arr as MaskDef[];
      else if (kind === 'displacements') m.displacements = arr as DisplacementDef[];
      else if (kind === 'meshes') m.cutoutMeshes = arr as CutoutMesh[];
      else m.uvAreas = arr as UVAreaDef[];
    });
    return copy.id;
  }

  /** Insert a deserialised entry (paste). Gets a fresh id and a unique name. */
  insert(kind: LibraryKind, entry: Entry): string {
    const copy = structuredClone(entry);
    copy.id = uid('paste');
    copy.name = this.uniqueName(kind, copy.name);
    this.edit('Paste', kind, () => {
      const m = this.meta();
      const arr = [...this.list(kind), copy];
      if (kind === 'materials') m.materials = arr as MaterialDef[];
      else if (kind === 'materialSets') m.materialSets = arr as MaterialSetDef[];
      else if (kind === 'masks') m.masks = arr as MaskDef[];
      else if (kind === 'displacements') m.displacements = arr as DisplacementDef[];
      else if (kind === 'meshes') m.cutoutMeshes = arr as CutoutMesh[];
      else m.uvAreas = arr as UVAreaDef[];
    });
    return copy.id;
  }

  remove(kind: LibraryKind, id: string): void {
    if (kind === 'materials' && this.materials().length <= 1) return;
    if (kind === 'meshes' && this.cutoutMeshes().length <= 1) return;
    this.edit('Delete', kind, () => {
      const m = this.meta();
      const arr = this.list(kind).filter((e) => e.id !== id);
      if (kind === 'materials') {
        m.materials = arr as MaterialDef[];
        for (const mat of m.materials) if (mat.backMaterialId === id) mat.backMaterialId = null;
        m.materialSets = this.sets().map((s) => ({ ...s, members: s.members.filter((x) => x.materialId !== id) }));
      } else if (kind === 'materialSets') m.materialSets = arr as MaterialSetDef[];
      else if (kind === 'masks') m.masks = arr as MaskDef[];
      else if (kind === 'displacements') m.displacements = arr as DisplacementDef[];
      else if (kind === 'meshes') m.cutoutMeshes = arr as CutoutMesh[];
      else m.uvAreas = arr as UVAreaDef[];
    });
  }

  rename(kind: LibraryKind, id: string, name: string): void {
    const n = name.trim();
    if (!n) return;
    this.edit('Rename', kind, () => {
      const e = this.list(kind).find((x) => x.id === id);
      if (e) e.name = n;
    });
  }

  move(kind: LibraryKind, id: string, delta: number): void {
    const arr = this.list(kind);
    const i = arr.findIndex((e) => e.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= arr.length) return;
    this.edit('Reorder', kind, () => {
      const a = this.list(kind);
      const [item] = a.splice(i, 1);
      a.splice(j, 0, item as Entry);
    });
  }

  /** Search by name (case-insensitive substring). */
  search(kind: LibraryKind, query: string): Entry[] {
    const q = query.trim().toLowerCase();
    return this.list(kind).filter((e) => e.name.toLowerCase().includes(q));
  }

  /** Re-publish everything (document switched / project loaded). */
  refresh(): void {
    this.emit({ kind: 'all' });
  }

  allKinds(): readonly LibraryKind[] {
    return KINDS;
  }
}

let shared: MaterialLibrary | null = null;
export function getMaterialLibrary(): MaterialLibrary {
  shared ??= new MaterialLibrary();
  return shared;
}
