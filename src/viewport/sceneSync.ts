import { BufferAttribute, BufferGeometry, Box3, Group, InstancedMesh, Material, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import type { SceneModel } from '@/contracts/engine';
import type { MeshData } from '@/contracts/mesh';
import { createDefaultMaterialResolver, type MaterialResolver } from './defaultMaterials';
import { getMaterialResolver } from '@/materials/materialResolver';
import { meshDataToGeometry } from './meshDataToGeometry';
import { getWindSystem, type WindSystem } from './wind/windSystem';
import {
  buildSkeletonDebugPiece,
  createSkeletonDebugMaterials,
  type SkeletonDebugPiece,
  type SkeletonDebugVisibility,
} from './skeletonDebug';
import type { ContentStats, ViewportContent } from './types';
import { isNodeVisible, type ViewFilter } from './viewState';

type SceneEntry = SceneModel['entries'][number];

interface Piece {
  mesh: Mesh;
  rev: string;
  materialKey: string;
  /** Latest scene entry (needed to rebuild materials when the library changes). */
  entry?: SceneEntry;
  /** BackSide twin that renders the Back material (non-instanced meshes only). */
  back?: Mesh;
  backKey?: string;
}

const EMPTY_BOUNDS = (): Box3 => new Box3(new Vector3(-1, -1, 0), new Vector3(1, 1, 2));

/** Can `md` be written into `geo`'s existing buffers (same layout and sizes)? */
function canReuse(geo: BufferGeometry, md: MeshData): boolean {
  const same = (name: string, arr: Float32Array | undefined): boolean => {
    const a = geo.getAttribute(name);
    return arr === undefined ? a === undefined : a !== undefined && a.array.length === arr.length;
  };
  return (
    same('position', md.positions) &&
    same('normal', md.normals) &&
    same('uv', md.uv0) &&
    same('uv1', md.uv1) &&
    same('tangent', md.tangents) &&
    same('color', md.colors) &&
    same('ao', md.ao) &&
    same('windPivot', md.wind?.pivot) &&
    same('windWeights', md.wind?.weights) &&
    geo.index !== null &&
    geo.index.array.length === md.indices.length
  );
}

/** Overwrite the buffers in place (three.js re-uploads with bufferSubData, the GL buffers are reused). */
function writeInto(geo: BufferGeometry, md: MeshData): void {
  const put = (name: string, arr: Float32Array | undefined): void => {
    const a = arr ? (geo.getAttribute(name) as BufferAttribute) : undefined;
    if (a && arr) {
      a.array = arr;
      a.needsUpdate = true;
    }
  };
  put('position', md.positions);
  put('normal', md.normals);
  put('uv', md.uv0);
  put('uv1', md.uv1);
  put('tangent', md.tangents);
  put('color', md.colors);
  put('ao', md.ao);
  put('windPivot', md.wind?.pivot);
  put('windWeights', md.wind?.weights);
  const idx = geo.index as BufferAttribute;
  idx.array = md.indices;
  idx.needsUpdate = true;
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
}

/** Mesh (or InstancedMesh for the GPU-instancing path) for one graph node. */
function createMesh(geo: BufferGeometry, material: Material | Material[], md: MeshData): Mesh {
  if (!md.instanced) return new Mesh(geo, material);
  const im = new InstancedMesh(geo, material, md.instanced.count);
  im.instanceMatrix.array.set(md.instanced.matrices);
  im.instanceMatrix.needsUpdate = true;
  im.frustumCulled = false;
  im.computeBoundingBox();
  return im;
}

function applyGroups(geo: BufferGeometry, md: MeshData): void {
  geo.clearGroups();
  if (md.slots.length > 1) md.slots.forEach((s, i) => geo.addGroup(s.indexStart, s.indexCount, i));
}

/**
 * Incremental bridge between engine output (SceneModel) and three.js. One Mesh per graph node, keyed by node id and a
 * revision token: unchanged nodes are not touched, changed nodes reuse their GPU buffers when the layout is identical,
 * removed nodes are disposed. Geometry is tagged with `userData.nodeId` (selection highlight, picking).
 *
 * Also manages per-node `SkeletonDebugPiece` instances for Skeleton view mode (generation-colored lines, points,
 * radius circles, and RMF normal/binormal/tangent frames).
 */
export class SceneSync {
  readonly root = new Group();
  readonly skeletonRoot = new Group();
  readonly bounds = EMPTY_BOUNDS();
  stats: ContentStats = { groups: [], triangles: 0, vertices: 0, bones: 0, skeletonBranches: 0, skeletonPoints: 0 };
  readonly content: ViewportContent;

  private readonly pieces = new Map<string, Piece>();
  private readonly skelPieces = new Map<string, SkeletonDebugPiece>();
  /** Selected node ids (skeleton debug highlight only; the viewport outline lives in `overlays/overlaySystem.ts`). */
  private selection = new Set<string>();
  private skelVis: SkeletonDebugVisibility = {
    showLines: true,
    showPoints: true,
    showRadii: true,
    showFrames: false,
  };
  private readonly skelMaterials = createSkeletonDebugMaterials();
  private readonly hiddenMaterial = new MeshBasicMaterial({ visible: false });
  private filter: ViewFilter | null = null;
  private disposed = false;
  private readonly unsubMaterials: (() => void) | undefined;

  constructor(
    private readonly materials: MaterialResolver = typeof document === 'undefined' ? createDefaultMaterialResolver() : getMaterialResolver(),
    private readonly wind: WindSystem = getWindSystem(),
  ) {
    this.unsubMaterials = this.materials.onChange?.(() => this.refreshMaterials());
    this.root.name = 'Plant';
    this.skeletonRoot.name = 'PlantSkeleton';
    this.skeletonRoot.visible = false;
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the content object exposes live state of this instance
    const self = this;
    this.content = {
      root: this.root,
      skeleton: this.skeletonRoot,
      bounds: this.bounds,
      get stats(): ContentStats {
        return self.stats;
      },
      dispose: () => this.dispose(),
    };
  }

  /** Apply a new scene. Returns true when anything visible changed. */
  update(scene: SceneModel): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const e of scene.entries) {
      seen.add(e.nodeId);
      const materialKey = this.keyOf(e.mesh);
      let piece = this.pieces.get(e.nodeId);
      if (!piece) {
        const geo = meshDataToGeometry(e.mesh);
        applyGroups(geo, e.mesh);
        const mesh = createMesh(geo, this.materialsFor(e.mesh), e.mesh);
        mesh.userData.nodeId = e.nodeId;
        mesh.userData.baseMaterial = mesh.material;
        this.wind.decorateMesh(mesh, e.wind);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.root.add(mesh);
        piece = { mesh, rev: e.rev, materialKey };
        this.pieces.set(e.nodeId, piece);
        changed = true;
      } else if (piece.rev !== e.rev && (piece.mesh instanceof InstancedMesh) !== (e.mesh.instanced !== undefined)) {
        // Switching between baked and GPU-instanced output: rebuild the scene object.
        piece.mesh.removeFromParent();
        piece.mesh.geometry.dispose();
        this.pieces.delete(e.nodeId);
        const geo = meshDataToGeometry(e.mesh);
        applyGroups(geo, e.mesh);
        const mesh = createMesh(geo, this.materialsFor(e.mesh), e.mesh);
        mesh.userData.nodeId = e.nodeId;
        mesh.userData.baseMaterial = mesh.material;
        this.wind.decorateMesh(mesh, e.wind);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.root.add(mesh);
        this.pieces.set(e.nodeId, { mesh, rev: e.rev, materialKey });
        changed = true;
      } else if (piece.rev !== e.rev) {
        const old = piece.mesh.geometry;
        if (piece.mesh instanceof InstancedMesh && e.mesh.instanced) {
          const im = piece.mesh;
          if (im.count !== e.mesh.instanced.count) {
            im.dispose();
            const fresh = createMesh(old, im.material, e.mesh) as InstancedMesh;
            im.removeFromParent();
            fresh.userData = im.userData;
            this.wind.decorateMesh(fresh, e.wind);
            fresh.castShadow = true;
            fresh.receiveShadow = true;
            this.root.add(fresh);
            piece.mesh = fresh;
          } else {
            im.instanceMatrix.array.set(e.mesh.instanced.matrices);
            im.instanceMatrix.needsUpdate = true;
            im.computeBoundingBox();
          }
        }
        if (canReuse(old, e.mesh)) writeInto(old, e.mesh);
        else {
          const geo = meshDataToGeometry(e.mesh);
          piece.mesh.geometry = geo;
          old.dispose();
        }
        applyGroups(piece.mesh.geometry, e.mesh);
        if (piece.materialKey !== materialKey) {
          piece.mesh.material = this.materialsFor(e.mesh);
          piece.mesh.userData.baseMaterial = piece.mesh.material;
          piece.mesh.userData.windBase = undefined;
          this.wind.decorateMesh(piece.mesh, e.wind);
          piece.materialKey = materialKey;
        }
        piece.rev = e.rev;
        changed = true;
      }
    }
    for (const e of scene.entries) {
      const live = this.pieces.get(e.nodeId);
      if (!live) continue;
      this.wind.decorateMesh(live.mesh, e.wind);
      live.entry = e;
      this.syncBack(live, e);
    }
    this.wind.setSceneWind(scene.wind ?? null);
    for (const [id, piece] of this.pieces) {
      if (seen.has(id)) continue;
      piece.mesh.removeFromParent();
      piece.mesh.geometry.dispose();
      this.pieces.delete(id);
      changed = true;
    }

    const seenLines = new Set<string>();
    for (const sk of scene.skeletons) {
      seenLines.add(sk.nodeId);
      const existing = this.skelPieces.get(sk.nodeId);
      if (existing && existing.rev === sk.rev) continue;
      if (existing) {
        existing.dispose();
      }
      const nextPiece = buildSkeletonDebugPiece(sk.nodeId, sk.skeleton, sk.rev, this.skelMaterials);
      nextPiece.applyVisibility(this.skelVis, this.selection.has(sk.nodeId));
      this.skeletonRoot.add(nextPiece.group);
      this.skelPieces.set(sk.nodeId, nextPiece);
      changed = true;
    }
    for (const [id, sp] of this.skelPieces) {
      if (seenLines.has(id)) continue;
      sp.dispose();
      this.skelPieces.delete(id);
      changed = true;
    }

    this.applyFilter();
    if (changed) {
      this.recomputeBounds();
    }
    this.stats = {
      groups: scene.stats.groups,
      triangles: scene.stats.triangles,
      vertices: scene.stats.vertices,
      bones: scene.stats.bones,
      skeletonBranches: scene.stats.skeletonBranches ?? 0,
      skeletonPoints: scene.stats.skeletonPoints ?? 0,
    };
    return changed;
  }

  /** Edit > Visibility / Isolate: hide whole node families (mesh + skeleton lines) without touching the data. */
  setFilter(filter: ViewFilter | null): void {
    this.filter = filter;
    this.applyFilter();
  }

  private applyFilter(): void {
    const f = this.filter;
    for (const [id, piece] of this.pieces) {
      const hidden = f !== null && !isNodeVisible(f, id, piece.entry?.type);
      piece.mesh.userData.ktHidden = hidden;
      piece.mesh.visible = !hidden;
    }
    for (const [id, sp] of this.skelPieces) {
      const type = this.pieces.get(id)?.entry?.type;
      sp.group.visible = f === null || isNodeVisible(f, id, type);
    }
  }

  /** Toggle skeleton debug sub-layers (points, radius circles, RMF normal frames) with zero geometry rebuild. */
  setSkeletonDebugOptions(vis: Partial<SkeletonDebugVisibility>): void {
    this.skelVis = { ...this.skelVis, ...vis };
    for (const [id, sp] of this.skelPieces) {
      sp.applyVisibility(this.skelVis, this.selection.has(id));
    }
  }

  /** Highlight the geometry and skeleton of the given graph nodes. */
  setSelection(ids: readonly string[]): void {
    this.selection = new Set(ids);
    for (const [id, sp] of this.skelPieces) {
      sp.applyVisibility(this.skelVis, this.selection.has(id));
    }
  }

  /** The renderable object of a node (plain or instanced), used by the overlay outline pass. */
  getMesh(nodeId: string): Mesh | undefined {
    return this.pieces.get(nodeId)?.mesh;
  }

  hasGeometry(nodeId: string): boolean {
    return this.pieces.has(nodeId);
  }

  pieceCount(): number {
    return this.pieces.size;
  }

  private keyOf(md: MeshData): string {
    return md.slots.map((s) => `${s.materialId}:${this.materials.backKey?.(s.materialId) ?? ''}`).join('|');
  }

  /** Re-resolve materials of every piece (after the material library changed structurally, e.g. a Back material). */
  refreshMaterials(): void {
    for (const piece of this.pieces.values()) {
      const e = piece.entry;
      if (!e) continue;
      const key = this.keyOf(e.mesh);
      if (key !== piece.materialKey) {
        piece.mesh.material = this.materialsFor(e.mesh);
        piece.mesh.userData.baseMaterial = piece.mesh.material;
        piece.mesh.userData.windBase = undefined;
        this.wind.decorateMesh(piece.mesh, e.wind);
        piece.materialKey = key;
      }
      this.syncBack(piece, e);
    }
  }

  /** Keep the Back-material twin (BackSide mesh sharing the geometry) in sync with the front mesh. */
  private syncBack(piece: Piece, e: SceneEntry): void {
    const backs = e.mesh.slots.map((s) => this.materials.resolveBack?.(s.materialId) ?? null);
    const wanted = !e.mesh.instanced && backs.some((b) => b !== null);
    const key = wanted ? backs.map((b) => b?.uuid ?? '-').join('|') : '';
    if (!wanted) {
      if (piece.back) {
        piece.back.removeFromParent();
        piece.back = undefined;
        piece.backKey = undefined;
      }
      return;
    }
    if (piece.back && piece.backKey === key && piece.back.geometry === piece.mesh.geometry) return;
    piece.back?.removeFromParent();
    const mats = backs.map((b) => b ?? this.hiddenMaterial);
    const back = new Mesh(piece.mesh.geometry, mats.length > 1 ? mats : (mats[0] as Material));
    back.userData.nodeId = e.nodeId;
    back.userData.baseMaterial = back.material;
    back.userData.isBackFace = true;
    back.castShadow = true;
    back.receiveShadow = true;
    this.wind.decorateMesh(back, e.wind);
    piece.mesh.add(back);
    piece.back = back;
    piece.backKey = key;
  }

  private materialsFor(md: MeshData): Material | Material[] {
    if (md.slots.length > 1) return md.slots.map((s) => this.materials.resolve(s.materialId));
    return this.materials.resolve(md.slots[0]?.materialId ?? 'default');
  }

  private recomputeBounds(): void {
    this.bounds.makeEmpty();
    for (const { mesh } of this.pieces.values()) {
      const bb = mesh instanceof InstancedMesh ? mesh.boundingBox : mesh.geometry.boundingBox;
      if (bb) this.bounds.union(bb);
    }
    for (const sp of this.skelPieces.values()) {
      if (!sp.bounds.isEmpty()) this.bounds.union(sp.bounds);
    }
    if (this.bounds.isEmpty()) this.bounds.copy(EMPTY_BOUNDS());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const p of this.pieces.values()) p.mesh.geometry.dispose();
    for (const sp of this.skelPieces.values()) sp.dispose();
    this.pieces.clear();
    this.skelPieces.clear();
    this.root.clear();
    this.skeletonRoot.clear();
    this.skelMaterials.dispose();
    this.hiddenMaterial.dispose();
    this.unsubMaterials?.();
    this.materials.dispose();
  }
}
