import type { MeshData } from '@/contracts/mesh';
import { cross, dot, len, norm, orthogonalize, rotate, type V3 } from './math3';
import { MeshAccumulator, newVertex, type VertexAttrs } from './meshAccumulator';

/**
 * Frond ribbon mesher: sweeps a flat (or folded / cupped) cross-section along a spine with rotation-minimising frames.
 * Pure and deterministic: the output depends only on the specs and options.
 */

export type RibbonShape = 'flat' | 'vfold' | 'ucurve';
export type TipShape = 'pointed' | 'rounded' | 'blunt';
export type RibbonUvMode = 'stretch' | 'tile';

export interface RibbonSpec {
  /** Spine polyline (>= 2 points, base -> tip). */
  path: V3[];
  /** Desired face direction at the base (made perpendicular to the spine tangent). */
  normalHint: V3;
  /** Full width in metres. */
  width: number;
  /** Width multiplier along the length (the Width curve). */
  widthAt?: (t: number) => number;
  /** Width multiplier at the very base (blends to 1 over the first third). */
  baseWidth: number;
  tipShape: TipShape;
  /** Fraction of the length (0..1) over which the width closes to the tip. */
  tipTaper: number;
  shape: RibbonShape;
  /** Fold / cup angle in radians. */
  foldAngle: number;
  foldAt?: (t: number) => number;
  /** Edge curl (-1..1): edges bend up (+) or down (-). */
  curl: number;
  /** Centre-line crease: V-shaped mid rib, radians. */
  crease: number;
  /** Extra rotation of the ribbon about the spine (radians) and twist along the length (radians, total). */
  roll: number;
  twist: number;
  /** Extra gravity bend (0..1+) and arch (radians of total bend toward / away from the face normal). */
  droop: number;
  arch: number;
  /** Offset of the ribbon along its face normal (negative = sink), metres. */
  offset: number;
  color: V3;
  /** Tip colour multiplier minus 1 (gradient base -> tip, -1..1). */
  colorGradient: number;
  /** 0..1 strength of the baked base darkening. */
  ao: number;
  /** Atlas rectangle [u0, v0, u1, v1]. */
  atlas: [number, number, number, number];
  materialId: string;
  /** Parent wind channels (hierarchy 0..2, phase). */
  wind: [number, number, number, number];
  /** Exponent of the bend-weight ramp along the length (wind weight w2 = t^power). */
  windPower: number;
}

export interface RibbonOptions {
  /** Number of length segments (before adaptive redistribution). */
  lengthSegments: number;
  /** Place more rings where the spine curves. */
  adaptive: boolean;
  /** 1..8 columns across the width (cross-section shapes use at least 2). */
  widthSegments: number;
  /** Emit a flipped copy of every face with inverted normals. */
  duplicateBackFaces: boolean;
  uvMode: RibbonUvMode;
  /** Metres per V tile in 'tile' mode. */
  uvTile: number;
  uvScaleU: number;
  uvScaleV: number;
  uvOffsetU: number;
  uvOffsetV: number;
  defaultMaterial: string;
}

export const DEFAULT_RIBBON_OPTIONS: RibbonOptions = {
  lengthSegments: 6,
  adaptive: true,
  widthSegments: 1,
  duplicateBackFaces: false,
  uvMode: 'stretch',
  uvTile: 1,
  uvScaleU: 1,
  uvScaleV: 1,
  uvOffsetU: 0,
  uvOffsetV: 0,
  defaultMaterial: 'leaf',
};

/** Centre line with frames of one ribbon. All arrays have `n` entries. */
export interface RibbonFrames {
  n: number;
  points: V3[];
  /** Unit tangent. */
  tangents: V3[];
  /** Unit face normal (the side the front face looks to). */
  normals: V3[];
  /** Unit lateral direction (cross(tangent, normal)). */
  sides: V3[];
  /** Arc length from the base (metres) and normalised 0..1. */
  s: number[];
  t: number[];
  length: number;
}

const catmull = (p0: number, p1: number, p2: number, p3: number, f: number): number =>
  0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Resample a polyline into `segments` + 1 points (Catmull-Rom), optionally denser where it turns. */
export function resamplePath(path: readonly V3[], segments: number, adaptive: boolean): V3[] {
  // Drop coincident points.
  const pts: V3[] = [];
  for (const p of path) if (pts.length === 0 || dist(p, pts[pts.length - 1] as V3) > 1e-7) pts.push(p);
  if (pts.length < 2) return pts.length === 1 ? [pts[0] as V3, [(pts[0] as V3)[0], (pts[0] as V3)[1], (pts[0] as V3)[2] + 1e-4]] : [];
  const n = pts.length;
  const cum: number[] = [0];
  for (let k = 1; k < n; k++) cum.push((cum[k - 1] as number) + dist(pts[k] as V3, pts[k - 1] as V3));
  const total = cum[n - 1] as number;
  const m = Math.max(1, Math.round(segments));
  // Importance F(s): arc length plus a turning-angle term, so rings concentrate on bends.
  const imp: number[] = [0];
  for (let k = 1; k < n; k++) {
    const segLen = (cum[k] as number) - (cum[k - 1] as number);
    let turn = 0;
    if (adaptive && k < n - 1) {
      const a = norm([(pts[k] as V3)[0] - (pts[k - 1] as V3)[0], (pts[k] as V3)[1] - (pts[k - 1] as V3)[1], (pts[k] as V3)[2] - (pts[k - 1] as V3)[2]]);
      const b = norm([(pts[k + 1] as V3)[0] - (pts[k] as V3)[0], (pts[k + 1] as V3)[1] - (pts[k] as V3)[1], (pts[k + 1] as V3)[2] - (pts[k] as V3)[2]]);
      turn = Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
    }
    imp.push((imp[k - 1] as number) + segLen + (adaptive ? total * turn * 0.35 : 0));
  }
  const impTotal = imp[n - 1] as number;
  const P = (k: number, c: 0 | 1 | 2): number => (pts[Math.min(n - 1, Math.max(0, k))] as V3)[c];
  const out: V3[] = [];
  let i = 0;
  for (let q = 0; q <= m; q++) {
    const target = (impTotal * q) / m;
    while (i < n - 2 && (imp[i + 1] as number) < target) i++;
    const span = (imp[i + 1] as number) - (imp[i] as number);
    const f = span > 1e-12 ? Math.min(1, Math.max(0, (target - (imp[i] as number)) / span)) : 0;
    out.push([catmull(P(i - 1, 0), P(i, 0), P(i + 1, 0), P(i + 2, 0), f), catmull(P(i - 1, 1), P(i, 1), P(i + 1, 1), P(i + 2, 1), f), catmull(P(i - 1, 2), P(i, 2), P(i + 1, 2), P(i + 2, 2), f)]);
  }
  out[0] = [P(0, 0), P(0, 1), P(0, 2)];
  out[m] = [P(n - 1, 0), P(n - 1, 1), P(n - 1, 2)];
  return out;
}

/** Applies droop / arch to the resampled spine (length preserving) and builds twisted rotation-minimising frames. */
export function buildRibbonFrames(spec: RibbonSpec, opts: Pick<RibbonOptions, 'lengthSegments' | 'adaptive'>): RibbonFrames | null {
  const base = resamplePath(spec.path, opts.lengthSegments, opts.adaptive);
  const n = base.length;
  if (n < 2) return null;
  const seg: number[] = [];
  const dirs: V3[] = [];
  let length = 0;
  for (let k = 0; k < n - 1; k++) {
    const a = base[k] as V3;
    const b = base[k + 1] as V3;
    const l = dist(a, b);
    seg.push(l);
    length += l;
    dirs.push(l > 1e-12 ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l, (b[2] - a[2]) / l] : (dirs[k - 1] ?? [0, 0, 1]));
  }
  if (length < 1e-9) return null;
  // Initial frame from the facing hint.
  const T0 = dirs[0] as V3;
  const N0 = orthogonalize(spec.normalHint, T0);
  const side0 = cross(T0, N0);
  // Bend: arch rotates the direction about the lateral axis, droop pulls it toward -Z.
  const bent: V3[] = [];
  let acc = 0;
  for (let k = 0; k < n - 1; k++) {
    const tMid = (acc + (seg[k] as number) * 0.5) / length;
    acc += seg[k] as number;
    let d = dirs[k] as V3;
    if (spec.arch !== 0) d = rotate(d, side0, -spec.arch * tMid);
    if (spec.droop !== 0) d = norm([d[0], d[1], d[2] - spec.droop * Math.pow(tMid, 1.4) * 1.6]);
    bent.push(d);
  }
  const points: V3[] = [base[0] as V3];
  for (let k = 0; k < n - 1; k++) {
    const p = points[k] as V3;
    const d = bent[k] as V3;
    points.push([p[0] + d[0] * (seg[k] as number), p[1] + d[1] * (seg[k] as number), p[2] + d[2] * (seg[k] as number)]);
  }
  const tangents: V3[] = [];
  for (let k = 0; k < n; k++) {
    const a = bent[Math.max(0, k - 1)] as V3;
    const b = bent[Math.min(n - 2, k)] as V3;
    tangents.push(norm([a[0] + b[0], a[1] + b[1], a[2] + b[2]], b));
  }
  // Double-reflection RMF.
  const normals: V3[] = [orthogonalize(N0, tangents[0] as V3)];
  for (let k = 1; k < n; k++) {
    const p0 = points[k - 1] as V3;
    const p1 = points[k] as V3;
    const v1: V3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const c1 = dot(v1, v1);
    const prev = normals[k - 1] as V3;
    const t0 = tangents[k - 1] as V3;
    const t1 = tangents[k] as V3;
    if (c1 < 1e-14) {
      normals.push(orthogonalize(prev, t1));
      continue;
    }
    const k1 = (2 / c1) * dot(v1, prev);
    const rL: V3 = [prev[0] - v1[0] * k1, prev[1] - v1[1] * k1, prev[2] - v1[2] * k1];
    const k2 = (2 / c1) * dot(v1, t0);
    const tL: V3 = [t0[0] - v1[0] * k2, t0[1] - v1[1] * k2, t0[2] - v1[2] * k2];
    const v2: V3 = [t1[0] - tL[0], t1[1] - tL[1], t1[2] - tL[2]];
    const c2 = dot(v2, v2);
    if (c2 < 1e-14) normals.push(orthogonalize(rL, t1));
    else {
      const k3 = (2 / c2) * dot(v2, rL);
      normals.push(orthogonalize([rL[0] - v2[0] * k3, rL[1] - v2[1] * k3, rL[2] - v2[2] * k3], t1));
    }
  }
  const s: number[] = [0];
  for (let k = 0; k < n - 1; k++) s.push((s[k] as number) + (seg[k] as number));
  const t = s.map((v) => Math.min(1, Math.max(0, v / length)));
  const sides: V3[] = [];
  for (let k = 0; k < n; k++) {
    const T = tangents[k] as V3;
    const ang = spec.roll + spec.twist * (t[k] as number);
    const nk = ang !== 0 ? rotate(normals[k] as V3, T, ang) : (normals[k] as V3);
    normals[k] = nk;
    sides.push(cross(T, nk));
  }
  return { n, points, tangents, normals, sides, s, t, length };
}

/** Width multiplier at `t` from base width and the tip taper profile (never exactly 0, so tips stay non-degenerate). */
export function ribbonWidthFactor(spec: Pick<RibbonSpec, 'baseWidth' | 'tipShape' | 'tipTaper' | 'widthAt'>, t: number): number {
  const b = Math.min(1, t / 0.35);
  const baseBlend = spec.baseWidth + (1 - spec.baseWidth) * (b * b * (3 - 2 * b));
  let taper = 1;
  const L = Math.min(1, Math.max(0, spec.tipTaper));
  if (L > 1e-6 && t > 1 - L) {
    const x = Math.min(1, (t - (1 - L)) / L);
    taper = spec.tipShape === 'rounded' ? Math.sqrt(Math.max(0, 1 - x * x)) : spec.tipShape === 'blunt' ? 1 - Math.pow(x, 4) : 1 - x;
  }
  const curve = spec.widthAt ? spec.widthAt(t) : 1;
  return Math.max(0.002, baseBlend * taper * Math.max(0, curve));
}

/** Offset of a cross-section point across the width: returns (lateral, height) for x in [-1, 1]. */
export function crossSectionPoint(spec: RibbonSpec, x: number, halfWidth: number, t: number): [number, number] {
  const fold = Math.max(0, spec.foldAngle * (spec.foldAt ? spec.foldAt(t) : 1));
  let lateral = x * halfWidth;
  let height = 0;
  if (spec.shape === 'vfold') {
    lateral = x * halfWidth * Math.cos(Math.min(fold, Math.PI / 2 - 0.01));
    height = Math.abs(x) * halfWidth * Math.sin(Math.min(fold, Math.PI / 2 - 0.01));
  } else if (spec.shape === 'ucurve' && fold > 1e-4) {
    const theta = (x * Math.min(fold, Math.PI * 1.6)) / 2;
    const R = halfWidth / (Math.min(fold, Math.PI * 1.6) / 2);
    lateral = R * Math.sin(theta);
    height = R * (1 - Math.cos(theta));
  }
  if (spec.crease !== 0) height += Math.abs(x) * halfWidth * Math.sin(spec.crease);
  if (spec.curl !== 0) height += spec.curl * halfWidth * Math.pow(Math.abs(x), 4) * 0.8;
  return [lateral, height + spec.offset];
}

export interface RibbonStats {
  ribbons: number;
  skipped: number;
}

/** Number of vertex columns used for a spec (cross-section shapes need at least 2 segments to bend). */
export const columnsFor = (spec: RibbonSpec, opts: RibbonOptions): number => {
  const w = Math.max(1, Math.min(8, Math.round(opts.widthSegments)));
  const needs = spec.shape !== 'flat' || spec.crease !== 0 || spec.curl !== 0;
  return needs ? Math.max(2, w + (w % 2)) : w;
};

/** Builds one MeshData holding every ribbon. Also returns the frames of the ribbons that were meshed. */
export function buildRibbonMesh(specs: readonly RibbonSpec[], options: Partial<RibbonOptions> = {}): { mesh: MeshData; frames: (RibbonFrames | null)[]; stats: RibbonStats } {
  const o: RibbonOptions = { ...DEFAULT_RIBBON_OPTIONS, ...options };
  const acc = new MeshAccumulator();
  const frames: (RibbonFrames | null)[] = [];
  let skipped = 0;
  const cells = Math.max(1, Math.ceil(Math.sqrt(specs.length)));
  // Material slots must be contiguous: emit ribbons grouped by material (first-appearance order, stable inside a group).
  const groups = new Map<string, number[]>();
  for (let ri = 0; ri < specs.length; ri++) {
    const id = (specs[ri] as RibbonSpec).materialId || o.defaultMaterial;
    const list = groups.get(id);
    if (list) list.push(ri);
    else groups.set(id, [ri]);
  }
  for (let ri = 0; ri < specs.length; ri++) frames.push(buildRibbonFrames(specs[ri] as RibbonSpec, o));
  for (const [material, list] of groups) {
    acc.beginSlot(material);
    for (const ri of list) {
      const fr = frames[ri];
      if (!fr) {
        skipped++;
        continue;
      }
      emitRibbon(acc, specs[ri] as RibbonSpec, fr, o, ri, cells);
    }
  }
  const mesh = acc.build(o.defaultMaterial, true);
  return { mesh, frames, stats: { ribbons: specs.length - skipped, skipped } };
}

function emitRibbon(acc: MeshAccumulator, spec: RibbonSpec, fr: RibbonFrames, o: RibbonOptions, index: number, cells: number): void {
  const W = columnsFor(spec, o);
  const C = W + 1;
  const R = fr.n;
  const pos = new Float32Array(R * C * 3);
  for (let i = 0; i < R; i++) {
    const half = 0.5 * spec.width * ribbonWidthFactor(spec, fr.t[i] as number);
    const P = fr.points[i] as V3;
    const N = fr.normals[i] as V3;
    const B = fr.sides[i] as V3;
    for (let j = 0; j < C; j++) {
      const x = -1 + (2 * j) / W;
      const [lat, h] = crossSectionPoint(spec, x, half, fr.t[i] as number);
      const q = (i * C + j) * 3;
      pos[q] = P[0] + B[0] * lat + N[0] * h;
      pos[q + 1] = P[1] + B[1] * lat + N[1] * h;
      pos[q + 2] = P[2] + B[2] * lat + N[2] * h;
    }
  }
  const at = (i: number, j: number): V3 => {
    const q = (Math.min(R - 1, Math.max(0, i)) * C + Math.min(C - 1, Math.max(0, j))) * 3;
    return [pos[q] as number, pos[q + 1] as number, pos[q + 2] as number];
  };
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const [u0, v0, u1, v1] = spec.atlas;
  const fullAtlas = u0 === 0 && v0 === 0 && u1 === 1 && v1 === 1;
  const tile = o.uvMode === 'tile' && fullAtlas;
  const base = acc.vertexCount;
  const cx = index % cells;
  const cy = Math.floor(index / cells);
  const verts: VertexAttrs[] = [];
  for (let i = 0; i < R; i++) {
    const t = fr.t[i] as number;
    const grad = 1 + spec.colorGradient * t;
    const ao = Math.min(1, Math.max(0.1, 1 - spec.ao * 0.55 * (1 - t) * (1 - t)));
    const w2 = Math.min(1, spec.wind[2] + (1 - spec.wind[2]) * Math.pow(t, Math.max(0.1, spec.windPower)));
    const vCoord = tile ? ((fr.s[i] as number) / Math.max(1e-4, o.uvTile)) * o.uvScaleV + o.uvOffsetV : v0 + (v1 - v0) * t * o.uvScaleV + o.uvOffsetV;
    for (let j = 0; j < C; j++) {
      const dPu = sub(at(i, j + 1), at(i, j - 1));
      const dPv = sub(at(i + 1, j), at(i - 1, j));
      const Nf = fr.normals[i] as V3;
      let n = cross(dPu, dPv);
      if (len(n) < 1e-14) n = Nf;
      n = norm(n, Nf);
      if (dot(n, Nf) < 0) n = [-n[0], -n[1], -n[2]];
      const tg = norm(dPu, fr.sides[i] as V3);
      const bit = cross(n, tg);
      const vx = newVertex();
      const q = (i * C + j) * 3;
      vx.px = pos[q] as number; vx.py = pos[q + 1] as number; vx.pz = pos[q + 2] as number;
      vx.nx = n[0]; vx.ny = n[1]; vx.nz = n[2];
      vx.tx = tg[0]; vx.ty = tg[1]; vx.tz = tg[2];
      vx.tw = dot(bit, dPv) >= 0 ? 1 : -1;
      vx.u = u0 + (u1 - u0) * (j / W) * o.uvScaleU + o.uvOffsetU;
      vx.v = vCoord;
      vx.u1 = (cx + j / W) / cells;
      vx.v1 = (cy + t) / cells;
      vx.r = spec.color[0] * grad * ao; vx.g = spec.color[1] * grad * ao; vx.b = spec.color[2] * grad * ao;
      vx.ao = ao;
      const piv = fr.points[0] as V3;
      vx.pvx = piv[0]; vx.pvy = piv[1]; vx.pvz = piv[2];
      vx.w0 = spec.wind[0]; vx.w1 = spec.wind[1]; vx.w2 = w2; vx.w3 = spec.wind[3];
      verts.push(vx);
    }
  }
  for (const vx of verts) acc.addVertex(vx);
  for (let i = 0; i < R - 1; i++) {
    for (let j = 0; j < W; j++) {
      const a0 = base + i * C + j;
      const a1 = a0 + 1;
      const b0 = a0 + C;
      const b1 = b0 + 1;
      acc.addTriangle(a0, a1, b0);
      acc.addTriangle(a1, b1, b0);
    }
  }
  if (o.duplicateBackFaces) {
    const back = acc.vertexCount;
    for (const vx of verts) acc.addVertex({ ...vx, nx: -vx.nx, ny: -vx.ny, nz: -vx.nz, tw: -vx.tw });
    for (let i = 0; i < R - 1; i++) {
      for (let j = 0; j < W; j++) {
        const a0 = back + i * C + j;
        const a1 = a0 + 1;
        const b0 = a0 + C;
        const b1 = b0 + 1;
        acc.addTriangle(a0, b0, a1);
        acc.addTriangle(a1, b0, b1);
      }
    }
  }
}

/** Orthonormal right-handed basis at the base of a ribbon: z = tangent, y = face normal, x = lateral. */
export interface RibbonBasis {
  origin: V3;
  x: V3;
  y: V3;
  z: V3;
}

export function ribbonBasis(fr: RibbonFrames): RibbonBasis {
  const z = fr.tangents[0] as V3;
  const y = fr.normals[0] as V3;
  return { origin: fr.points[0] as V3, x: cross(y, z), y, z };
}

/** Frames expressed in a basis (positions relative to its origin). */
export function toLocalFrames(fr: RibbonFrames, b: RibbonBasis): RibbonFrames {
  const dir = (v: V3): V3 => [dot(v, b.x), dot(v, b.y), dot(v, b.z)];
  return {
    ...fr,
    points: fr.points.map((p) => dir([p[0] - b.origin[0], p[1] - b.origin[1], p[2] - b.origin[2]])),
    tangents: fr.tangents.map(dir),
    normals: fr.normals.map(dir),
    sides: fr.sides.map(dir),
  };
}

/** True when two frame sets describe the same shape within `tol` metres (both must be expressed in local bases). */
export function framesMatch(a: RibbonFrames, b: RibbonFrames, tol: number): boolean {
  if (a.n !== b.n) return false;
  for (let i = 0; i < a.n; i++) {
    if (dist(a.points[i] as V3, b.points[i] as V3) > tol) return false;
    if (dist(a.normals[i] as V3, b.normals[i] as V3) > 1e-3) return false;
  }
  return true;
}

/** Meshes a single ribbon from precomputed frames (used for the GPU-instanced path). */
export function buildRibbonFromFrames(spec: RibbonSpec, frames: RibbonFrames, options: Partial<RibbonOptions> = {}): MeshData {
  const o: RibbonOptions = { ...DEFAULT_RIBBON_OPTIONS, ...options };
  const acc = new MeshAccumulator();
  acc.beginSlot(spec.materialId || o.defaultMaterial);
  emitRibbon(acc, spec, frames, o, 0, 1);
  return acc.build(o.defaultMaterial, true);
}
