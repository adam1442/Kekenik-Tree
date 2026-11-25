import { getNumber, type NodeParams } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { materialHeightDef } from './displacement';
import { displacementStamp, getHeightMips, hasDisplacementSource, sampleHeightMips, type HeightField } from '@/materials/displacement';
import { getMaterialSource } from '@/materials/materialSource';
import { parentWind } from './foliageCommon';
import { cutoutShape, shapeSampleAt, type PlanarShape } from '@/generators/surfaceDetail';
import type { AttachmentBuilder } from '@/geometry/attachments';
import { MeshAccumulator, type VertexAttrs } from '@/geometry/meshAccumulator';
import type { PickedMaterialMesh } from '@/materials/meshSelection';
import { norm, type V3 } from '@/geometry/math3';
import { IndexBucket } from './knot';

/** Upper bounds of decals / fins per node (a decal is a few hundred triangles, a fin a few dozen). */
export const MAX_DECALS = 4000;
export const MAX_FINS = 12000;

export type Wind5 = [number, number, number, number, number];

/**
 * Wind of the parent along a line parallel to its axis: `samples + 1` tuples between metres `y0` and `y1` from the attach
 * point (`parentWind` interpolates exactly like the parent's own rings), read back with {@link windAtY}.
 */
export interface WindProfile {
  y0: number;
  y1: number;
  tuples: Wind5[];
}

export function windProfile(parent: Skeleton, point: number, salt: number, axisPoint: ArrayLike<number>, tangent: ArrayLike<number>, y0: number, y1: number, samples: number): WindProfile {
  const n = Math.max(1, Math.round(samples));
  const tuples: Wind5[] = [];
  for (let i = 0; i <= n; i++) {
    const y = y0 + ((y1 - y0) * i) / n;
    const at = [(axisPoint[0] as number) + (tangent[0] as number) * y, (axisPoint[1] as number) + (tangent[1] as number) * y, (axisPoint[2] as number) + (tangent[2] as number) * y];
    tuples.push(parentWind(parent, point, salt, at));
  }
  return { y0, y1, tuples };
}

export function windAtY(profile: WindProfile, y: number): Wind5 {
  const n = profile.tuples.length - 1;
  const span = profile.y1 - profile.y0;
  const f = span > 1e-12 ? Math.min(n, Math.max(0, ((y - profile.y0) / span) * n)) : 0;
  const i = Math.min(n - 1, Math.floor(f));
  const a = profile.tuples[Math.max(0, i)] as Wind5;
  if (n < 1) return a;
  const b = profile.tuples[i + 1] as Wind5;
  const t = f - i;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t, a[4] + (b[4] - a[4]) * t];
}

/** Mip chain of the Height map of a material (its Height texture or the alpha of its normal map), or null. */
export function heightChainOf(materialId: string): readonly HeightField[] | null {
  const def = materialHeightDef(materialId);
  if (!def || !hasDisplacementSource(def.assetId)) return null;
  return getHeightMips(def);
}

/** Cache-key extra: changes when a Height image of any material (or its decoding) changes. */
export function surfaceHeightKey(p: NodeParams): string {
  if (getNumber(p, 'decalHeight', 0) === 0) return '';
  const parts: string[] = [];
  for (const m of getMaterialSource()?.materials() ?? []) {
    const def = materialHeightDef(m.id);
    if (def) parts.push(`${m.id}:${displacementStamp(def)}`);
  }
  return parts.join('|');
}

/** Height sampler of a patch at `cells` cells per side (coarser mip when the grid is coarser than the image). */
export function heightSampler(chain: readonly HeightField[] | null, cells: number): ((u: number, v: number) => number) | undefined {
  if (!chain || chain.length === 0) return undefined;
  const level = Math.max(0, Math.log2(Math.max(1, (chain[0] as HeightField).width / Math.max(1, cells))));
  return (u, v) => sampleHeightMips(chain, u, v, level);
}

/** Vertex tint: the Vertex Color property (RGB). */
export function surfaceTint(p: NodeParams): [number, number, number] {
  const c = (p.vertexColor?.value as number[] | undefined) ?? [1, 1, 1, 1];
  return [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1];
}

/** Cutout-mesh shape of a picked Material / Mesh row (null = the row has no mesh: the generator builds its own grid). */
export function pickedShape(type: PickedMaterialMesh, lod: number, width: number, length: number, cellsA: number, cellsB: number): PlanarShape | undefined {
  return (type.meshAsset ? cutoutShape(type.meshAsset, lod, width, length, cellsA, cellsB) : null) ?? undefined;
}

/** Triangle lists of the pieces of one node, one slot per material. */
export class SlotBuckets {
  private readonly map = new Map<string, IndexBucket>();

  push(material: string, base: number, indices: ArrayLike<number>): void {
    let bucket = this.map.get(material);
    if (!bucket) {
      bucket = new IndexBucket();
      this.map.set(material, bucket);
    }
    for (let k = 0; k < indices.length; k++) bucket.push(base + (indices[k] as number));
  }

  /** Writes the slots into `acc` (call once, after every vertex was added). */
  flush(acc: MeshAccumulator): void {
    for (const [material, b] of this.map) {
      acc.beginSlot(material);
      for (let k = 0; k + 2 < b.length; k += 3) acc.addTriangle(b.data[k] as number, b.data[k + 1] as number, b.data[k + 2] as number);
    }
  }
}

/** Geometry of one patch / flap as produced by `buildDecalMesh` / `buildFinMesh`. */
export interface PieceMesh {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  uvs: Float32Array;
  plane: Float32Array;
}

/**
 * Appends the vertices of a piece to `acc` (position, normal, tangent, UV0 and the lightmap UV1 cell); the caller's
 * `perVertex` fills the rest (colour, AO, wind pivot and weights). Returns the index of the first vertex.
 */
export function emitPiece(acc: MeshAccumulator, vx: VertexAttrs, mesh: PieceMesh, cell: { x: number; y: number; count: number }, perVertex: (i: number, vx: VertexAttrs) => void): number {
  const base = acc.vertexCount;
  for (let i = 0; i < mesh.vertexCount; i++) {
    vx.px = mesh.positions[i * 3] as number;
    vx.py = mesh.positions[i * 3 + 1] as number;
    vx.pz = mesh.positions[i * 3 + 2] as number;
    vx.nx = mesh.normals[i * 3] as number;
    vx.ny = mesh.normals[i * 3 + 1] as number;
    vx.nz = mesh.normals[i * 3 + 2] as number;
    vx.tx = mesh.tangents[i * 3] as number;
    vx.ty = mesh.tangents[i * 3 + 1] as number;
    vx.tz = mesh.tangents[i * 3 + 2] as number;
    vx.tw = 1;
    vx.u = mesh.uvs[i * 2] as number;
    vx.v = mesh.uvs[i * 2 + 1] as number;
    vx.u1 = (cell.x + (mesh.plane[i * 2] as number)) / cell.count;
    vx.v1 = (cell.y + (mesh.plane[i * 2 + 1] as number)) / cell.count;
    perVertex(i, vx);
    acc.addVertex(vx);
  }
  return base;
}

/**
 * Exports the anchors of a cutout shape that was mapped onto the skin (positions on the mapped mesh, direction along the
 * cutout's growth axis), so a Leaf / Mesh node below a Decal or Fin with a cutout can be planted on them.
 */
export function addShapeAnchors(att: AttachmentBuilder, shape: PlanarShape, mesh: Pick<PieceMesh, 'positions' | 'normals'>): void {
  for (const an of shape.anchors) {
    const f = shapeSampleAt(shape, mesh.positions, mesh.normals, an.a, an.b);
    if (!f) continue;
    const dir = norm([f.dPda[0] * an.dir[0] + f.dPdb[0] * an.dir[1], f.dPda[1] * an.dir[0] + f.dPdb[1] * an.dir[1], f.dPda[2] * an.dir[0] + f.dPdb[2] * an.dir[1]], f.dPdb);
    const up = norm(f.normal, [0, 0, 1]);
    att.addFrame({ position: f.position as V3, direction: dir, up }, an.scale, an.id, an.index, an.axisT, an.tags);
  }
}
