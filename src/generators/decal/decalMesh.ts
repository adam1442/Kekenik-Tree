import { clamp } from '@/core/math';
import { parentSkin, type KnotFrame } from '@/generators/knot';
import { gridShape, shapeFrames, type PlanarShape } from '@/generators/surfaceDetail';

/**
 * Decal patch: a flat grid of cells projected onto the parent's skin (the same parametric skin the knot generator uses).
 * Plane: x runs around the parent, y along it, the decal centre is the origin; the patch is rotated by `rotation`.
 * Every vertex sits at `offset + displacement` along the skin normal. The displacement is `height x map(u, v) x fade`, so it is
 * bounded by |height| and is exactly 0 on the border (the fade) - the border floats `offset` above the bark.
 */
export interface DecalMeshInput {
  frame: KnotFrame;
  /** Extent across (around the parent) and along it, metres. */
  width: number;
  length: number;
  /** Roll of the patch around its centre (radians). */
  rotation: number;
  /** Lift of the whole patch above the skin (z-fighting guard), metres. */
  offset: number;
  /** Signed displacement scale of the height map, metres (0 = flat). */
  height: number;
  /** Height map 0..1 at texture coordinates (0..1); undefined = the material has no height map. */
  heightAt?: (u: number, v: number) => number;
  /** Cells per side of the default grid (>= 1); ignored when `shape` is given. */
  cells: number;
  /** Patch shape (a cutout mesh outline); default is the regular grid. */
  shape?: PlanarShape;
  /** Border fade as a fraction of the patch size (0 = no fade, max 0.5). */
  fade: number;
}

export interface DecalMesh {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  uvs: Float32Array;
  /** Position in the patch normalised to 0..1 (lightmap UV). */
  plane: Float32Array;
  /** Local along-the-parent coordinate of every vertex (metres from the decal centre, after the roll). */
  along: Float32Array;
  /** The skin point under every vertex (displacement and offset 0). */
  skin: Float32Array;
  /** Signed displacement of every vertex above `offset` (|d| <= |height|). */
  displacement: Float32Array;
  indices: Uint32Array;
  cells: number;
  /** Vertex nearest to the middle of the patch. */
  centre: number;
  shape: PlanarShape;
}

const smooth = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/** Edge fade 0..1 from the distance to the patch border (normalised units, see `PlanarShape.edge`). */
export function edgeFade(distance: number, fade: number): number {
  const f = clamp(fade, 0, 0.5);
  if (f <= 1e-6) return 1;
  return smooth(distance / f);
}

/** Edge fade 0..1 at normalised patch coordinates (a, b) of a grid patch. */
export function decalFade(a: number, b: number, fade: number): number {
  return edgeFade(Math.min(a, 1 - a, b, 1 - b), fade);
}

export function buildDecalMesh(inp: DecalMeshInput): DecalMesh {
  const n = Math.max(1, Math.round(inp.cells));
  const shape = inp.shape ?? gridShape(n, n);
  const count = shape.count;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const plane = new Float32Array(count * 2);
  const along = new Float32Array(count);
  const skin = new Float32Array(count * 3);
  const displacement = new Float32Array(count);
  const surface = parentSkin(inp.frame);
  const out = new Float64Array(7);
  const surfaceNormal = new Float32Array(count * 3);
  const cosR = Math.cos(inp.rotation);
  const sinR = Math.sin(inp.rotation);

  for (let k = 0; k < count; k++) {
    const a = shape.a[k] as number;
    const b = shape.b[k] as number;
    const px = (a - 0.5) * inp.width;
    const py = (b - 0.5) * inp.length;
    const x = cosR * px - sinR * py;
    const y = sinR * px + cosR * py;
    const u = shape.u[k] as number;
    const v = shape.v[k] as number;
    const hv = inp.heightAt && inp.height !== 0 ? inp.height * clamp(inp.heightAt(u, v), 0, 1) * edgeFade(shape.edge[k] as number, inp.fade) : 0;
    surface.at(x, y, 0, out);
    skin[k * 3] = out[0] as number;
    skin[k * 3 + 1] = out[1] as number;
    skin[k * 3 + 2] = out[2] as number;
    surface.at(x, y, inp.offset + hv, out);
    positions[k * 3] = out[0] as number;
    positions[k * 3 + 1] = out[1] as number;
    positions[k * 3 + 2] = out[2] as number;
    surfaceNormal[k * 3] = out[3] as number;
    surfaceNormal[k * 3 + 1] = out[4] as number;
    surfaceNormal[k * 3 + 2] = out[5] as number;
    uvs[k * 2] = u;
    uvs[k * 2 + 1] = v;
    plane[k * 2] = a;
    plane[k * 2 + 1] = b;
    along[k] = y;
    displacement[k] = hv;
  }
  const { normals, tangents } = shapeFrames(shape, positions, surfaceNormal);

  // Vertex nearest to the middle of the patch (the instance anchor of the node).
  let centre = 0;
  let bestD = Infinity;
  for (let k = 0; k < count; k++) {
    const d = Math.hypot((shape.a[k] as number) - 0.5, (shape.b[k] as number) - 0.5);
    if (d < bestD) {
      bestD = d;
      centre = k;
    }
  }
  return { vertexCount: count, positions, normals, tangents, uvs, plane, along, skin, displacement, indices: shape.indices, cells: n, centre, shape };
}

/** Cells per side after Resolution, Dynamic LOD and the Mesh LOD offset (never below 2). */
export function decalCells(base: number, lod: number, keepPerLod: number, lodOffset: number): number {
  const level = clamp(Math.round(lod) + Math.round(lodOffset), 0, 3);
  return Math.max(2, Math.round(base * Math.pow(keepPerLod, level)));
}
