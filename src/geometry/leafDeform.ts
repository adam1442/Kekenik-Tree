import type { SimplexNoise } from '@/core/noise';
import type { Frame } from './rigid';
import { cross, dot, len, norm, type V3 } from './math3';

/**
 * Per-leaf vertex deformation (Leaf > Deformation tab). Everything works in the leaf-local frame:
 * X = across the blade, Y = growth (base -> tip), Z = face normal, origin = the attachment pivot.
 * Every operation maps the origin to itself, so the pivot (and with it the attachment of the leaf to its parent) stays put.
 */
export interface LeafDeform {
  /** Reference length of the leaf (metres): Curl / Twist angles are totals over this length, noise is sampled per length. */
  length: number;
  /** Local scale per axis. */
  scale: V3;
  /** Fold angle (radians): both halves rotate about the local Y axis, + = up (toward +Z), - = down. */
  fold: number;
  /** Curl (radians over `length`): bends the blade around the local X axis. */
  curl: number;
  /** Twist (radians over `length`): rotation about the local Y axis, growing with the distance from the X axis. */
  twist: number;
  /** Vertex noise amplitude (metres). */
  vertexAmount: number;
  /** Vertex noise tightness: cycles per leaf length (higher = more localized). */
  vertexTightness: number;
  noise: SimplexNoise | null;
  /** Per-leaf shift inside the noise field (deterministic, derived from the leaf's random stream). */
  noiseOffset: V3;
  /** Height displacement along the normal (metres) and the map sampler (uv -> 0..1, 0.5 = no displacement). */
  height: number;
  heightSample: ((u: number, v: number) => number) | null;
  /** Cards with fewer vertices are subdivided until they have about this many (0 = never subdivide). */
  minVertices: number;
}

export const NEUTRAL_DEFORM: Readonly<Omit<LeafDeform, 'length'>> = {
  scale: [1, 1, 1],
  fold: 0,
  curl: 0,
  twist: 0,
  vertexAmount: 0,
  vertexTightness: 2,
  noise: null,
  noiseOffset: [0, 0, 0],
  height: 0,
  heightSample: null,
  minVertices: 0,
};

/** Upper bound of subdivision passes per card (each pass splits every triangle in four). */
export const MAX_SUBDIVISION_PASSES = 3;

/**
 * Number of midpoint subdivision passes that bring a mesh of `vertexCount` vertices / `triangleCount` triangles
 * up to about `minVertices` vertices (0 when it already has enough or `minVertices` is 0).
 */
export function subdivisionPasses(vertexCount: number, triangleCount: number, minVertices: number): number {
  let v = vertexCount;
  let t = triangleCount;
  let passes = 0;
  while (passes < MAX_SUBDIVISION_PASSES && v < minVertices && t > 0) {
    v += v + t - 1; // a pass adds one vertex per edge (Euler: E = V + T - 1 for a disc)
    t *= 4;
    passes += 1;
  }
  return passes;
}

/** Local orthonormal frame of a leaf card. */
export interface LeafLocalFrame {
  origin: V3;
  x: V3;
  y: V3;
  z: V3;
}

/** Frame of a card from its growth axis and side vector (z = side x axis, the face normal). */
export function leafLocalFrame(origin: V3, axis: V3, side: V3): LeafLocalFrame {
  const y = norm(axis, [0, 1, 0]);
  const z = norm(cross(side, y), [0, 0, 1]);
  const x = norm(cross(y, z), [1, 0, 0]);
  return { origin, x, y, z };
}

export const hasHeight = (d: LeafDeform): boolean => d.height !== 0 && d.heightSample !== null;
export const hasVertexNoise = (d: LeafDeform): boolean => d.vertexAmount !== 0 && d.noise !== null;
export const hasShapeDeform = (d: LeafDeform): boolean =>
  d.fold !== 0 || d.curl !== 0 || d.twist !== 0 || hasVertexNoise(d) || d.scale[0] !== 1 || d.scale[1] !== 1 || d.scale[2] !== 1;

/** true when the deformation changes anything. */
export const isDeformActive = (d: LeafDeform): boolean => hasShapeDeform(d) || hasHeight(d);

/** Radians below which a curl is treated as straight (avoids dividing by ~0). */
const STRAIGHT = 1e-6;

function noiseVector(d: LeafDeform, p: V3): V3 {
  const noise = d.noise as SimplexNoise;
  const k = d.vertexTightness / Math.max(1e-6, d.length);
  const qx = p[0] * k + d.noiseOffset[0];
  const qy = p[1] * k + d.noiseOffset[1];
  const qz = p[2] * k + d.noiseOffset[2];
  return [noise.noise3(qx, qy, qz), noise.noise3(qx + 31.7, qy - 17.3, qz + 5.9), noise.noise3(qx - 12.1, qy + 44.3, qz - 27.7)];
}

/**
 * Deforms a point given in leaf-local coordinates (metres). Order: Scale, Fold, Twist, Curl, Vertex noise.
 * The origin is a fixed point of every step.
 */
export function deformLocalPoint(d: LeafDeform, p: V3): V3 {
  let x = p[0] * d.scale[0];
  let y = p[1] * d.scale[1];
  let z = p[2] * d.scale[2];
  const L = Math.max(1e-6, d.length);

  if (d.fold !== 0) {
    // Both halves tilt about the Y axis by the same angle, mirrored across x = 0.
    z += Math.abs(x) * Math.sin(d.fold);
    x *= Math.cos(d.fold);
  }
  if (d.twist !== 0) {
    const a = (d.twist * y) / L;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const nx = x * c - z * s;
    z = x * s + z * c;
    x = nx;
  }
  if (d.curl !== 0) {
    // Bend around the X axis: the growth line becomes a circular arc (length preserving), z is offset along its normal.
    const k = d.curl / L;
    const a = k * y;
    if (Math.abs(d.curl) > STRAIGHT) {
      const s = Math.sin(a);
      const c = Math.cos(a);
      const ny = s / k - z * s;
      z = (1 - c) / k + z * c;
      y = ny;
    }
  }
  if (hasVertexNoise(d)) {
    const here = noiseVector(d, [x, y, z]);
    const base = noiseVector(d, [0, 0, 0]);
    x += (here[0] - base[0]) * d.vertexAmount;
    y += (here[1] - base[1]) * d.vertexAmount;
    z += (here[2] - base[2]) * d.vertexAmount;
  }
  return [x, y, z];
}

/** World position -> local coordinates of `f`. */
export function toLeafLocal(f: LeafLocalFrame, w: V3): V3 {
  const r: V3 = [w[0] - f.origin[0], w[1] - f.origin[1], w[2] - f.origin[2]];
  return [dot(r, f.x), dot(r, f.y), dot(r, f.z)];
}

/** Local coordinates of `f` -> world position. */
export function fromLeafLocal(f: LeafLocalFrame, p: V3): V3 {
  return [
    f.origin[0] + f.x[0] * p[0] + f.y[0] * p[1] + f.z[0] * p[2],
    f.origin[1] + f.x[1] * p[0] + f.y[1] * p[1] + f.z[1] * p[2],
    f.origin[2] + f.x[2] * p[0] + f.y[2] * p[1] + f.z[2] * p[2],
  ];
}

/** Fraction of the leaf length around the pivot over which Height fades in (keeps the pivot exactly fixed). */
const HEIGHT_FADE = 0.1;

/** Height displacement (local metres) of one vertex: along its local normal, faded in near the pivot. */
export function heightOffset(d: LeafDeform, local: V3, u: number, v: number): number {
  if (!hasHeight(d)) return 0;
  const sample = d.heightSample as (u: number, v: number) => number;
  const r = Math.hypot(local[0], local[1], local[2]) / Math.max(1e-6, d.length * HEIGHT_FADE);
  const w = r >= 1 ? 1 : r * r * (3 - 2 * r);
  return (sample(u, v) - 0.5) * d.height * w;
}

/**
 * Deforms a world-space vertex of a card. `normal` (world, unit) is the undeformed vertex normal used by Height.
 * Returns the new world position.
 */
export function deformWorldVertex(d: LeafDeform, f: LeafLocalFrame, world: V3, normal: V3, u: number, v: number): V3 {
  const local = toLeafLocal(f, world);
  if (hasHeight(d)) {
    const h = heightOffset(d, local, u, v);
    if (h !== 0) {
      const nl: V3 = [dot(normal, f.x), dot(normal, f.y), dot(normal, f.z)];
      local[0] += nl[0] * h;
      local[1] += nl[1] * h;
      local[2] += nl[2] * h;
    }
  }
  return fromLeafLocal(f, deformLocalPoint(d, local));
}

/**
 * Deforms an anchor / attachment frame (Height is ignored: it is a surface detail). The position goes through the
 * deformation, `direction` and `up` follow its local Jacobian, so children attached to the leaf follow the deformed axis.
 */
export function deformFrame(d: LeafDeform, f: LeafLocalFrame, frame: Frame): Frame {
  if (!hasShapeDeform(d)) return frame;
  const eps = Math.max(1e-5, d.length * 1e-3);
  const at = (w: V3): V3 => fromLeafLocal(f, deformLocalPoint(d, toLeafLocal(f, w)));
  const p0 = at(frame.position);
  // Central differences: the position is on the curve, so the Jacobian columns are exact for the pure bends.
  const step = (dir: V3): V3 => {
    const a = at([frame.position[0] + dir[0] * eps, frame.position[1] + dir[1] * eps, frame.position[2] + dir[2] * eps]);
    const b = at([frame.position[0] - dir[0] * eps, frame.position[1] - dir[1] * eps, frame.position[2] - dir[2] * eps]);
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  };
  const dirRaw = step(frame.direction);
  const direction = len(dirRaw) < 1e-12 ? frame.direction : norm(dirRaw, frame.direction);
  const upRaw = step(frame.up);
  const d1 = dot(upRaw, direction);
  const upO: V3 = [upRaw[0] - direction[0] * d1, upRaw[1] - direction[1] * d1, upRaw[2] - direction[2] * d1];
  const up = len(upO) < 1e-12 ? frame.up : norm(upO, frame.up);
  return { position: p0, direction, up };
}
