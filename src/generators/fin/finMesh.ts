import { clamp } from '@/core/math';
import { parentSkin, type KnotFrame, type KnotNoiseSource } from '@/generators/knot';
import { gridShape, shapeFrames, type PlanarShape } from '@/generators/surfaceDetail';
import { cross, dot, norm, rotate, type V3 } from '@/geometry/math3';

export type FinStyle = 'perpendicular' | 'along-spine' | 'up';

export interface FinMeshInput {
  frame: KnotFrame;
  /** Width along the base line and length away from the surface (metres, before the Scale X / Y). */
  width: number;
  length: number;
  style: FinStyle;
  /** Angle between the surface and the flap at its base (radians; 90 degrees stands straight out). */
  startAngle: number;
  /** Turn of the flap around the surface normal (radians). */
  roll: number;
  /** Mirrors the flap (U flipped, fold / curl reversed). */
  flip: boolean;
  /** Fold of the two halves towards each other at the tip (radians). */
  fold: number;
  /** Bend of the length axis at the tip (radians, towards the flap's face). */
  curl: number;
  noise: { amount: number; scale: number; source: KnotNoiseSource; offset: readonly [number, number] };
  /** Scale of the flap's width (X), length (Y) and thickness / bending (Z) axes. */
  scale: readonly [number, number, number];
  /** Normals bend towards the surface normal (0..1). */
  puffiness: number;
  /** Extra blend of the normals towards the surface normal at the base, fading out along the length (0..1). */
  matchSurface: number;
  /** Width and length cells (>= 1). */
  segmentsWidth: number;
  segmentsLength: number;
  /** Flap shape (a cutout mesh outline); default is the regular `segmentsWidth x segmentsLength` grid. */
  shape?: PlanarShape;
  /** World up (+Z in this project). */
  up?: V3;
}

export interface FinMesh {
  vertexCount: number;
  positions: Float32Array;
  normals: Float32Array;
  tangents: Float32Array;
  uvs: Float32Array;
  plane: Float32Array;
  /** 0 at the base ring, 1 at the tip, per vertex. */
  t: Float32Array;
  /** Skin point under the base of every vertex (equal to its position on the base ring, where t = 0). Grid: the base ring is [0, segmentsWidth]. */
  baseSkin: Float32Array;
  /** Axis offset along the parent (metres from the attach point) of the base point of every vertex (for wind sampling). */
  baseAlong: Float32Array;
  indices: Uint32Array;
  segmentsWidth: number;
  segmentsLength: number;
  /** Vertex at the middle of the base line and vertex at the middle of the free tip. */
  mid: number;
  tip: number;
  shape: PlanarShape;
}

const UP: V3 = [0, 0, 1];

/**
 * Thin flap on the parent skin. The base ring lies exactly on the skin (every base vertex is a skin point), the flap then
 * leaves along `cos(start) * e + sin(start) * n` (e = in-plane direction of the style, n = surface normal), is curled along
 * its length, folded about its centre line and displaced by seeded noise. Fold, curl and noise grow with the distance from
 * the base so the base never leaves the skin.
 */
export function buildFinMesh(inp: FinMeshInput): FinMesh {
  const W = Math.max(1, Math.round(inp.segmentsWidth));
  const L = Math.max(1, Math.round(inp.segmentsLength));
  const shape = inp.shape ?? gridShape(W, L);
  const count = shape.count;
  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const plane = new Float32Array(count * 2);
  const tAttr = new Float32Array(count);
  const baseSkin = new Float32Array(count * 3);
  const baseAlong = new Float32Array(count);
  const hostNormals = new Float32Array(count * 3);
  const surface = parentSkin(inp.frame);
  const out = new Float64Array(7);

  // Frame at the attach point.
  surface.at(0, 0, 0, out);
  const n0: V3 = [out[3] as number, out[4] as number, out[5] as number];
  const c0 = norm(cross(inp.frame.tangent as V3, n0), [1, 0, 0]);
  const t0 = norm(cross(n0, c0), [0, 1, 0]);
  let e: V3;
  if (inp.style === 'along-spine') e = t0;
  else if (inp.style === 'up') {
    const up = inp.up ?? UP;
    const k = dot(up, n0);
    const proj: V3 = [up[0] - n0[0] * k, up[1] - n0[1] * k, up[2] - n0[2] * k];
    e = Math.hypot(proj[0], proj[1], proj[2]) < 0.2 ? t0 : norm(proj, t0);
  } else e = c0;
  e = rotate(e, n0, inp.roll);
  const b = norm(cross(n0, e), t0);
  const sign = inp.flip ? -1 : 1;
  const a = clamp(inp.startAngle, 0, Math.PI);
  const d = norm([e[0] * Math.cos(a) + n0[0] * Math.sin(a), e[1] * Math.cos(a) + n0[1] * Math.sin(a), e[2] * Math.cos(a) + n0[2] * Math.sin(a)], n0);
  const nf = norm(cross(b, d), n0);
  const [sx, sy, sz] = inp.scale;
  const width = inp.width * sx;
  const length = inp.length * sy;
  // Direction of the base line in the skin plane (x around, y along the parent).
  const bx = dot(b, c0);
  const by = dot(b, t0);

  // Length profile: curl rotates the length direction about the base line towards the face (closed form of the arc).
  const curl = inp.curl * sign;
  const alongOf = (t: number): number => (Math.abs(curl) < 1e-6 ? length * t : (length * Math.sin(curl * t)) / curl);
  const outOf = (t: number): number => (Math.abs(curl) < 1e-6 ? 0 : (length * (1 - Math.cos(curl * t))) / curl);

  const fold = inp.fold * sign;
  const [no0, no1] = inp.noise.offset;
  const [uLo, uHi] = shape.uRange;
  for (let k = 0; k < count; k++) {
    const pa = shape.a[k] as number;
    const t = shape.b[k] as number;
    const s = (pa - 0.5) * width;
    surface.at(s * bx, s * by, 0, out);
    const bp: V3 = [out[0] as number, out[1] as number, out[2] as number];
    baseSkin.set(bp, k * 3);
    hostNormals.set([out[3] as number, out[4] as number, out[5] as number], k * 3);
    baseAlong[k] = s * by;
    // Fold: the halves turn about the centre line by fold * t (distance from the centre shrinks, the edge lifts).
    const af = fold * t;
    const lat = Math.abs(s) * (Math.cos(af) - 1) * Math.sign(s);
    const lift = Math.abs(s) * Math.sin(af);
    let ob = lat;
    let od = alongOf(t);
    let onf = outOf(t) * sz + lift * sz;
    if (inp.noise.amount !== 0 && t > 0) {
      const nx = pa * inp.noise.scale + no0;
      const ny = t * inp.noise.scale + no1;
      const amp = inp.noise.amount * t;
      ob += amp * inp.noise.source.noise2(nx, ny) * sx;
      od += amp * inp.noise.source.noise2(nx + 31.7, ny + 11.3) * sy;
      onf += amp * inp.noise.source.noise2(nx + 57.1, ny + 83.9) * sz;
    }
    positions[k * 3] = bp[0] + b[0] * ob + d[0] * od + nf[0] * onf;
    positions[k * 3 + 1] = bp[1] + b[1] * ob + d[1] * od + nf[1] * onf;
    positions[k * 3 + 2] = bp[2] + b[2] * ob + d[2] * od + nf[2] * onf;
    const u = shape.u[k] as number;
    uvs[k * 2] = inp.flip ? uLo + uHi - u : u;
    uvs[k * 2 + 1] = shape.v[k] as number;
    plane[k * 2] = pa;
    plane[k * 2 + 1] = t;
    tAttr[k] = t;
  }

  // Normals: triangle normals facing away from the host surface, then softened (puffiness / match surface).
  const { normals, tangents } = shapeFrames(shape, positions, hostNormals);
  const puff = clamp(inp.puffiness, 0, 1);
  const match = clamp(inp.matchSurface, 0, 1);
  for (let k = 0; k < count; k++) {
    const w = clamp(puff + match * (1 - (tAttr[k] as number)), 0, 1);
    if (w <= 0) continue;
    const nrm: V3 = [normals[k * 3] as number, normals[k * 3 + 1] as number, normals[k * 3 + 2] as number];
    const m = norm([nrm[0] * (1 - w) + (hostNormals[k * 3] as number) * w, nrm[1] * (1 - w) + (hostNormals[k * 3 + 1] as number) * w, nrm[2] * (1 - w) + (hostNormals[k * 3 + 2] as number) * w], nrm);
    normals.set(m, k * 3);
  }

  // Vertex at the middle of the base line and the one at the middle of the tip.
  let mid = 0;
  let tip = 0;
  let bestMid = Infinity;
  let bestTip = Infinity;
  for (let k = 0; k < count; k++) {
    const off = Math.abs((shape.a[k] as number) - 0.5);
    const t = tAttr[k] as number;
    if (t + off * 1e-3 < bestMid) {
      bestMid = t + off * 1e-3;
      mid = k;
    }
    if (1 - t + off * 1e-3 < bestTip) {
      bestTip = 1 - t + off * 1e-3;
      tip = k;
    }
  }
  return { vertexCount: count, positions, normals, tangents, uvs, plane, t: tAttr, baseSkin, baseAlong, indices: shape.indices, segmentsWidth: W, segmentsLength: L, mid, tip, shape };
}

/** Width and length cells after Dynamic LOD (never below 1 x 2). */
export function finSegments(width: number, length: number, lod: number, keepPerLod: number): { width: number; length: number } {
  const k = Math.pow(keepPerLod, clamp(Math.round(lod), 0, 3));
  return { width: Math.max(1, Math.round(width * k)), length: Math.max(2, Math.round(length * k)) };
}
