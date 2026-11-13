import { evaluateCurve, type Curve } from '@/contracts/curve';
import type { DisplacementDef } from '@/contracts/material';
import type { MeshData } from '@/contracts/mesh';
import { getHeightMips, sampleHeightMips, type HeightField } from '@/materials/displacement';
import { recomputeNormalsAndTangents, weldKeys } from './meshNormals';

/** Displacement direction: along the (smooth) surface normal or away from the mesh / branch axis. */
export type DisplaceDirection = 'normal' | 'radial';

/** Continuous LOD (0 = highest): the amount fades out between LOD 1 and LOD 3. */
export const lodDisplacementFactor = (lod: number): number => Math.min(1, Math.max(0, (3 - lod) / 2));

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Maps 2D tile coordinates (a around, b along) to texture coordinates for a rotation that is a multiple of 90 degrees. */
export function rotateTileCoords(a: number, b: number, quarterTurns: number): [number, number] {
  switch (((quarterTurns % 4) + 4) % 4) {
    case 1:
      return [b, a];
    case 2:
      return [-a, -b];
    case 3:
      return [-b, a];
    default:
      return [a, b];
  }
}

/** Rotation in degrees -> quarter turns (snapped, so the wrap-around of the texture stays continuous over seams). */
export const quarterTurnsOf = (degrees: number): number => Math.round(degrees / 90);

/** Mip level that matches the texel size to the vertex spacing: `texelsPerVertex` texels covered by one vertex step. */
export const mipLevelFor = (texelsPerVertex: number, lod: number): number => Math.log2(Math.max(1, texelsPerVertex)) + Math.max(0, lod) * 0.75;

export interface DisplaceOptions {
  /** Maximum displacement in metres. */
  amount: number;
  /** Uniform UV tiling of the displacement image; rounded to an integer when `lockSeams` so tube seams stay closed. */
  scale: number;
  scaleU?: number;
  scaleV?: number;
  /** Added to the normalised height before scaling. */
  offset: number;
  /** true (default): 0.5 grey = no displacement (height - 0.5 + offset); false: height + offset (pushes out only). */
  midGrey?: boolean;
  /** Continuous LOD (0 = highest). */
  lod: number;
  /** Apply the LOD fade of the amount (default true). */
  lodFade?: boolean;
  /** Rotation of the image in degrees (snapped to 90 degree steps while seams are locked). */
  rotation?: number;
  direction?: DisplaceDirection;
  /** Weight of vertices on open mesh borders (0 = they stay put, so adjoining meshes never crack). Default 0. */
  borderWeight?: number;
  lockSeams?: boolean;
  /** Optional per-vertex amount weight 0..1. */
  weights?: Float32Array;
}

/**
 * Moves vertices by the sampled height. Pure and deterministic (a function of UV and position only):
 *  - duplicated seam vertices (same position) receive the identical displacement, so seams stay watertight,
 *  - open borders are pinned (`borderWeight`), so a displaced mesh never cracks against its neighbour,
 *  - normals and tangents are recomputed afterwards from the displaced welded surface (unit length, no NaN).
 * Skips instanced meshes and meshes without uv0.
 */
export function displaceMeshData(mesh: MeshData, def: DisplacementDef, opts: DisplaceOptions): MeshData {
  const lodFactor = opts.lodFade === false ? 1 : lodDisplacementFactor(opts.lod);
  const amount = opts.amount * lodFactor;
  const n = mesh.positions.length / 3;
  if (amount === 0 || mesh.instanced || n === 0 || mesh.uv0.length < n * 2) return mesh;
  const chain = getHeightMips(def);
  if (!chain) return mesh;
  const base = chain[0] as HeightField;
  const lock = opts.lockSeams !== false;
  const tilesU = lock ? Math.max(1, Math.round(opts.scale * (opts.scaleU ?? 1))) : Math.max(0.01, opts.scale * (opts.scaleU ?? 1));
  const tilesV = lock ? Math.max(1, Math.round(opts.scale * (opts.scaleV ?? 1))) : Math.max(0.01, opts.scale * (opts.scaleV ?? 1));
  const turns = lock ? quarterTurnsOf(opts.rotation ?? 0) : 0;
  const midGrey = opts.midGrey !== false;
  const radial = opts.direction === 'radial';

  const keys = weldKeys(mesh.positions, n);
  const border = borderVertices(mesh, keys);
  const raw = new Float32Array(n);
  const level = mipLevelFor((base.width * tilesU) / Math.max(1, Math.sqrt(n) * 0.5), opts.lod);
  for (let i = 0; i < n; i++) {
    const [tu, tv] = rotateTileCoords((mesh.uv0[i * 2] as number) * tilesU, (mesh.uv0[i * 2 + 1] as number) * tilesV, turns);
    const h = sampleHeightMips(chain, tu, tv, level) - (midGrey ? 0.5 : 0) + opts.offset;
    const w = (opts.weights ? (opts.weights[i] as number) : 1) * (border[i] ? opts.borderWeight ?? 0 : 1);
    raw[i] = h * w;
  }
  // Weld: vertices that share a position share one displacement (average of the group).
  const groupSum = new Map<number, { sum: number; count: number }>();
  for (let i = 0; i < n; i++) {
    const k = keys[i] as number;
    const g = groupSum.get(k);
    if (g) {
      g.sum += raw[i] as number;
      g.count += 1;
    } else groupSum.set(k, { sum: raw[i] as number, count: 1 });
  }

  const pos = new Float32Array(mesh.positions);
  let cx = 0;
  let cy = 0;
  let cz = 0;
  if (radial) {
    for (let i = 0; i < n; i++) {
      cx += mesh.positions[i * 3] as number;
      cy += mesh.positions[i * 3 + 1] as number;
      cz += mesh.positions[i * 3 + 2] as number;
    }
    cx /= n;
    cy /= n;
    cz /= n;
  }
  // Welded smooth normals give every duplicate of a vertex the same displacement direction.
  const smoothNormals = radial ? null : recomputeNormalsAndTangents(mesh, { tangents: false }).normals;
  for (let i = 0; i < n; i++) {
    const g = groupSum.get(keys[i] as number) as { sum: number; count: number };
    const d = (g.sum / g.count) * amount;
    let dx: number;
    let dy: number;
    let dz: number;
    if (smoothNormals) {
      dx = smoothNormals[i * 3] as number;
      dy = smoothNormals[i * 3 + 1] as number;
      dz = smoothNormals[i * 3 + 2] as number;
    } else {
      dx = (mesh.positions[i * 3] as number) - cx;
      dy = (mesh.positions[i * 3 + 1] as number) - cy;
      dz = (mesh.positions[i * 3 + 2] as number) - cz;
      const l = Math.hypot(dx, dy, dz) || 1;
      dx /= l;
      dy /= l;
      dz /= l;
    }
    pos[i * 3] = (pos[i * 3] as number) + dx * d;
    pos[i * 3 + 1] = (pos[i * 3 + 1] as number) + dy * d;
    pos[i * 3 + 2] = (pos[i * 3 + 2] as number) + dz * d;
  }
  const moved: MeshData = { ...mesh, positions: pos };
  const fixed = recomputeNormalsAndTangents(moved, { tangents: true });
  moved.normals = fixed.normals;
  if (fixed.tangents) moved.tangents = fixed.tangents;
  return moved;
}

/** Vertices that lie on an edge used by exactly one triangle (after welding by position). */
function borderVertices(mesh: MeshData, keys: Uint32Array): Uint8Array {
  const n = mesh.positions.length / 3;
  const edgeCount = new Map<string, number>();
  const idx = mesh.indices;
  const edgeKey = (a: number, b: number): string => {
    const ka = keys[a] as number;
    const kb = keys[b] as number;
    return ka < kb ? `${ka}_${kb}` : `${kb}_${ka}`;
  };
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const k = edgeKey(idx[t + e] as number, idx[t + ((e + 1) % 3)] as number);
      edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1);
    }
  }
  const out = new Uint8Array(n);
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e] as number;
      const b = idx[t + ((e + 1) % 3)] as number;
      if (edgeCount.get(edgeKey(a, b)) === 1) {
        out[a] = 1;
        out[b] = 1;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Tube displacer: evaluated per ring vertex inside the tube mesher, so normals are built from displaced rings.   */
/* ------------------------------------------------------------------------------------------------------------ */

/** Data handed to a tube displacer for one ring vertex (the object is reused between calls). */
export interface TubeDisplaceVertex {
  /** 0..1 around the circumference (seamless: the seam vertex has the same value as the first). */
  u: number;
  /** Metres along the branch from its first real ring (negative inside a buried junction ring). */
  s: number;
  /** 0..1 along the branch. */
  t: number;
  /** Metres to the branch tip. */
  sEnd: number;
  /** Local tube radius before displacement. */
  radius: number;
  /** Circumference of the thickest ring of the branch (metres). */
  circumference: number;
  sides: number;
  junction: boolean;
}

export type TubeDisplacer = (v: TubeDisplaceVertex) => number;

export interface TubeDisplaceSpec {
  def: DisplacementDef;
  /** Metres. */
  amount: number;
  /** Extra amount as a fraction of the local radius. */
  radiusAmount: number;
  amountCurve?: Curve;
  bias: number;
  midGrey: boolean;
  scaleU: number;
  scaleV: number;
  /** 'world': one image tile covers `tileSize` metres (no stretching); 'normalized': scale tiles per branch. */
  tiling: 'world' | 'normalized';
  tileSize: number;
  rotation: number;
  lockSeams: boolean;
  /** Fade lengths in radii at a junction base / at the tip (0 = none). */
  fadeBase: number;
  fadeTip: number;
  lod: number;
  lodFade: boolean;
}

/** null when nothing would move (no image, zero amount, LOD fully faded). */
export function createTubeDisplacer(spec: TubeDisplaceSpec): TubeDisplacer | null {
  const chain = getHeightMips(spec.def);
  const lodFactor = spec.lodFade ? lodDisplacementFactor(spec.lod) : 1;
  if (!chain || lodFactor <= 0 || (spec.amount === 0 && spec.radiusAmount === 0)) return null;
  const base = chain[0] as HeightField;
  const turns = spec.lockSeams ? quarterTurnsOf(spec.rotation) : 0;
  const tileSize = Math.max(1e-4, spec.tileSize);
  return (v) => {
    let tilesU = spec.tiling === 'world' ? (v.circumference * spec.scaleU) / tileSize : spec.scaleU;
    if (spec.lockSeams) tilesU = Math.max(1, Math.round(tilesU));
    const b = spec.tiling === 'world' ? (v.s * spec.scaleV) / tileSize : v.t * spec.scaleV;
    const level = mipLevelFor((base.width * tilesU) / Math.max(3, v.sides), spec.lod);
    const [tu, tv] = rotateTileCoords(v.u * tilesU, b, turns);
    const h = sampleHeightMips(chain, tu, tv, level) - (spec.midGrey ? 0.5 : 0) + spec.bias;
    let amount = spec.amount + spec.radiusAmount * v.radius;
    if (spec.amountCurve) amount *= evaluateCurve(spec.amountCurve, v.t);
    let fade = 1;
    if (spec.fadeTip > 0) fade *= smooth01(v.sEnd / (spec.fadeTip * Math.max(1e-4, v.radius)));
    if (v.junction && spec.fadeBase > 0) fade *= smooth01(v.s / (spec.fadeBase * Math.max(1e-4, v.radius)));
    return h * amount * fade * lodFactor;
  };
}
