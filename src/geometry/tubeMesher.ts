import type { MeshData } from '@/contracts/mesh';
import type { Branch, Skeleton } from '@/contracts/skeleton';
import type { DisplaceDirection, TubeDisplacer } from './displaceMesh';
import { createSectionEvaluator, ROUND_SECTION, type SectionShape } from './crossSection';
import { cross, dot, hash01, len, mul, norm, orthogonalize, perpendicular, rotate, sub, type V3 } from './math3';
import { MeshAccumulator, newVertex, type VertexAttrs } from './meshAccumulator';
import { computeSkeletonWind, WIND_ATTRIBUTES, windPhase1OfTuple, type WindTuple } from './windAttributes';
import { blendWeldWind, parentWindAt, windArraysOf } from './weldWind';
import { ChildPathEvaluator, frameNormalFor, lightingNormal, lightingValue, parentSurfaceFor, solveWeld, squashSurface, weldBlendValue, weldRingCount, type ChildPath, type ParentSurface, type WeldMeshOptions, type WeldResult } from '@/generators/weld';
import { bendPushFactor, leanNormal, seamWeight, squashRadius, SUB_LEVEL_ATTR } from '@/generators/skin';
import { DEFAULT_UV_MAPPING, remapToRect, tubeU, WHOLE_MAP, type UvMapping, type UvRect } from '@/generators/uv';
import { planBranchUv, writeUvAttributes, type UvMaterialOptions, type UvPlan } from './tubeUv';
import { EXTENSION_ATTR, EXTENSION_DISPLACE_ATTR, EXTENSION_GROUP_VALUE, EXTENSION_SMOOTH_ATTR, crotchSeamAmount, crotchSeamWeight, effectiveSplitSides, extensionBlendValue, sharedEndNormal, splitHalfMapping } from '@/generators/split';
import { ringStartAngle, snapRingShifted, snapRingToPolygon } from './ringSnap';
import { createButtressProfile, type ButtressSpec } from './buttress';
import { alignCrotchPhase, blendCrotchWind, buildSplitCrotch, crotchBlend, crotchRing0Normal, emitCrotch, emitCrotchCaps, findSplitLobes, lobeContinuation, lobeEndRing, lobeEndVertexIds, lobeEndWind, publishLobeContinuation, publishLobeEndRings, publishLobeEndVertices, transitionStart, type CrotchBuild, type CrotchCaps, type CrotchDisplaceFn, type CrotchEmit } from './splitCrotch';
import { modifyColor, recordPointColors, recordedPointColor, sampleLut, type VertexColorOptions } from './vertexColor';
import type { BranchDisplacer, BranchDisplaceVertex, DisplaceOut } from '@/generators/displace';

export interface TubeUv {
  /** false = metric (V = metres / uvMetres, tiles by world length), true = V runs 0..1 per branch. */
  normalized: boolean;
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
  /** Swap U and V (rotate the texture 90 degrees). */
  rotate: boolean;
}

export interface TubeOptions {
  maxGeneration: number;
  /** Skip a skeleton branch (by index) without meshing it, e.g. instances hidden in Node mode. */
  skipBranch?: (branchIndex: number) => boolean;
  /** Ring sides of a branch; `maxRadius` is its thickest radius (for sizing sides to the radius, e.g. displacement). */
  /** Radial segments of a branch; `branchIndex` is its index in the skeleton (stored per-branch counts). */
  radialSegments(generation: number, maxRadius: number, branchIndex?: number): number;
  /** Linear RGB colour of a ring. */
  color(generation: number, t: number): [number, number, number];
  /** Metres of branch length per UV v unit. */
  uvMetres: number;
  materialId: string;
  /** Parent skeleton of the generator (junction colour blend, wind inheritance). */
  parent?: Skeleton;
  /** > 0: resample every branch into this many length segments (Catmull-Rom). 0 = one ring per skeleton point. */
  lengthSegments?: number;
  /** 0..1 fraction of rings kept (LOD). */
  segmentKeep?: number;
  section?: SectionShape;
  uv?: Partial<TubeUv>;
  /**
   * Branch UV mapping (UV tab). Absent = the legacy `uv` scale / offset options, which are translated to the same mapping.
   * Written to the skeleton points of every meshed branch so children and extensions can continue it.
   */
  uvMapping?: UvMapping;
  /** Material lists of Branch / Extension (one row per entry, patches use UV Areas); absent = every branch uses `materialId`. */
  uvMaterials?: UvMaterialOptions;
  /** Material that an `Inherited` row resolves to (the parent generator's material). */
  inheritedMaterial?: string;
  /** 1 = smooth normals, < 0.5 = faceted (unwelded quads). */
  smoothing?: number;
  /** 0..1 blend of the normals toward the pure cylindrical normal (hides section detail in lighting). */
  flatten?: number;
  capEnd?: boolean;
  /** 'auto' = close the base of branches that do not start on a parent. */
  capStart?: boolean | 'auto';
  tipRings?: number;
  /** Radius flare where a child meets its parent (fraction of radius) and its length in radii. */
  collarAmount?: number;
  collarLength?: number;
  /** Collar swell: the shoulder where a child leaves its parent is pushed out by this fraction of the child radius (0 = off). */
  collarSwell?: number;
  /** Buttress fins at the base of branches that do not start on a parent (absent = off). */
  buttress?: ButtressSpec;
  /** Degrees of ring twist per metre. */
  twist?: number;
  tintVariance?: number;
  aoStrength?: number;
  /** Generator Vertex Color group (Mode / Color / Variance / Seamless / curves). Absent = the legacy colour path, bit-identical. */
  vertexColor?: VertexColorOptions;
  seed?: number;
  /** Displacement evaluated per ring vertex (metres along `displaceDirection`); normals are built from the displaced rings. */
  displace?: TubeDisplacer;
  displaceDirection?: DisplaceDirection;
  /**
   * Displacement tab of Trunk / Branch / Root: radial, along-spine and normal offsets per ring vertex. Applied after welding
   * (weld rings stay put, the fade starts where they end); normals are built from the displaced rings.
   */
  displaceField?: BranchDisplacer;
  /** > 0: rings are at most this far apart (adaptive subdivision for displacement), capped at 600 rings per branch. */
  maxSegmentLength?: number;
  /** Ring cap per branch for adaptive subdivision (default 600). */
  displaceMaxRings?: number;
  /** Bark: vertex spacing around a branch (metres) and side cap used by the generators to size the rings; the mesher itself does not read them. */
  displaceSideSpacing?: number;
  displaceMaxSides?: number;
  /** Fuse branches whose skeleton `weld` attribute is 1 into their parent's surface (see `generators/weld`). */
  weld?: WeldMeshOptions;
  /** Skin > Radius > Roll in degrees: rotates the rings (section, squash, texture) around the spine. */
  roll?: number;
  /** Skin > Radius > Smooth 0..1: pushes the rings out on bends. */
  smooth?: number;
  /** Skin > Radius > Light seam reduction 0..1: bends normals toward the spine, strongest at the base of a junction. */
  seam?: number;
  /** Skin > Squash: Amount 0..1 and the Rotate angle in radians. */
  squash?: { amount: number; rotate: number };
  /**
   * Skin > Extensions > Blend length (parent radii) / Contrast / Noise: material blend at the base of an extension (or split half) whose
   * material differs from its parent's. Written to the weld blend channels; inherited / equal materials write nothing.
   */
  extensionBlend?: { length: number; contrast: number; noise: number };
}

/** Skeleton attributes written by `emitStructureOutput`: the squash of a branch's own skin (read when a child welds to it). */
export const SQUASH_ATTR = 'skinSquash';
export const SQUASH_ANGLE_ATTR = 'skinSquashAngle';

/** Where a welded child leaves its parent, in the parent's ring frame (for the parent-side texture coordinates). */
interface ParentAttach {
  position: V3;
  axis: V3;
  normal: V3;
  binormal: V3;
  /** Metres along the parent from its base to the attachment, and the parent's total length. */
  along: number;
  length: number;
  radius: number;
  /** Ring angle of the child's own direction (the unwrapped reference of the parent U). */
  childPhi: number;
}

interface BranchWeld {
  result: WeldResult;
  attach: ParentAttach;
  /** Wind (w0, w1, w2, phase, phase1) of the parent skin under every weld vertex (`rings * sides * 5`); null when the parent has none. */
  parentWind: Float32Array | null;
  /** Wind pivot of the parent branch (its base point). */
  parentPivot: V3;
}

interface Samples {
  n: number;
  pos: Float32Array;
  rad: Float32Array;
  /** Fractional local skeleton index of each sample (for attribute lookups). */
  sf: Float32Array;
  s: Float32Array;
  t: Float32Array;
  tan: Float32Array;
  /** Index of the first ring that belongs to the skeleton (1 when a buried junction ring was prepended). */
  first: number;
}

const catmull = (p0: number, p1: number, p2: number, p3: number, f: number): number =>
  0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);

/** Replaces the last point of a truncated branch (a splitting parent ends where the shared transition starts). */
interface TailPoint {
  pos: V3;
  rad: number;
}

function sampleBranch(sk: Skeleton, b: Branch, o: TubeOptions, junction: boolean, collarAmount: number, tail?: TailPoint): Samples {
  const n = b.count;
  const P = (k: number, c: number): number => {
    const kk = Math.min(n - 1, Math.max(0, k));
    return tail && kk === n - 1 ? (tail.pos[c] as number) : (sk.position[(b.start + kk) * 3 + c] as number);
  };
  const R = (k: number): number => {
    const kk = Math.min(n - 1, Math.max(0, k));
    return tail && kk === n - 1 ? tail.rad : (sk.radius[b.start + kk] as number);
  };
  const keep = Math.min(1, Math.max(0, o.segmentKeep ?? 1));
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const rr: number[] = [];
  const sf: number[] = [];
  let segs = o.lengthSegments ?? 0;
  const cum = [0];
  for (let k = 1; k < n; k++) cum.push((cum[k - 1] as number) + Math.hypot(P(k, 0) - P(k - 1, 0), P(k, 1) - P(k - 1, 1), P(k, 2) - P(k - 1, 2)));
  const branchLen = cum[n - 1] as number;
  const maxLen = o.maxSegmentLength ?? 0;
  const adaptive = maxLen > 0 ? Math.min(Math.max(2, Math.round(o.displaceMaxRings ?? 600)), Math.ceil(branchLen / maxLen)) : 0;
  if (adaptive > segs) segs = adaptive;
  if (segs > 0) {
    const m = (adaptive > 0 && segs === adaptive ? segs : Math.max(1, Math.round(segs * keep))) + 1;
    let i = 0;
    for (let q = 0; q < m; q++) {
      const L = (branchLen * q) / (m - 1);
      while (i < n - 2 && (cum[i + 1] as number) < L) i++;
      const span = (cum[i + 1] as number) - (cum[i] as number);
      const f = span > 1e-12 ? Math.min(1, Math.max(0, (L - (cum[i] as number)) / span)) : 0;
      px.push(catmull(P(i - 1, 0), P(i, 0), P(i + 1, 0), P(i + 2, 0), f));
      py.push(catmull(P(i - 1, 1), P(i, 1), P(i + 1, 1), P(i + 2, 1), f));
      pz.push(catmull(P(i - 1, 2), P(i, 2), P(i + 1, 2), P(i + 2, 2), f));
      rr.push(R(i) + (R(i + 1) - R(i)) * f);
      sf.push(i + f);
    }
  } else {
    const m = Math.max(2, Math.min(n, Math.round(1 + (n - 1) * keep)));
    for (let q = 0; q < m; q++) {
      const k = Math.round((q * (n - 1)) / (m - 1));
      px.push(P(k, 0));
      py.push(P(k, 1));
      pz.push(P(k, 2));
      rr.push(R(k));
      sf.push(k);
    }
  }
  // Drop rings that coincide with their predecessor (zero-length segments produce degenerate triangles).
  const keepIdx: number[] = [0];
  for (let q = 1; q < px.length; q++) {
    const l = keepIdx[keepIdx.length - 1] as number;
    const d = Math.hypot((px[q] as number) - (px[l] as number), (py[q] as number) - (py[l] as number), (pz[q] as number) - (pz[l] as number));
    if (d > 1e-6 || q === px.length - 1) keepIdx.push(q);
  }
  const first = junction ? 1 : 0;
  const count = keepIdx.length + first;
  const pos = new Float32Array(count * 3);
  const rad = new Float32Array(count);
  const sfo = new Float32Array(count);
  keepIdx.forEach((q, k) => {
    const d = k + first;
    pos[d * 3] = px[q] as number;
    pos[d * 3 + 1] = py[q] as number;
    pos[d * 3 + 2] = pz[q] as number;
    rad[d] = Math.max(1e-4, rr[q] as number);
    sfo[d] = sf[q] as number;
  });
  // Tangents (central differences over the real rings).
  const tan = new Float32Array(count * 3);
  for (let k = first; k < count; k++) {
    const a = Math.max(first, k - 1);
    const c = Math.min(count - 1, k + 1);
    const t = norm([pos[c * 3]! - pos[a * 3]!, pos[c * 3 + 1]! - pos[a * 3 + 1]!, pos[c * 3 + 2]! - pos[a * 3 + 2]!]);
    tan[k * 3] = t[0];
    tan[k * 3 + 1] = t[1];
    tan[k * 3 + 2] = t[2];
  }
  if (junction) {
    // A ring buried inside the parent so the child never shows a crack where it leaves the parent surface.
    const r0 = rad[1] as number;
    const back = r0 * 0.8;
    pos[0] = (pos[3] as number) - (tan[3] as number) * back;
    pos[1] = (pos[4] as number) - (tan[4] as number) * back;
    pos[2] = (pos[5] as number) - (tan[5] as number) * back;
    rad[0] = r0 * (1 + collarAmount);
    sfo[0] = 0;
    tan[0] = tan[3] as number;
    tan[1] = tan[4] as number;
    tan[2] = tan[5] as number;
  }
  const s = new Float32Array(count);
  let acc = 0;
  for (let k = 1; k < count; k++) {
    acc += Math.hypot(pos[k * 3]! - pos[(k - 1) * 3]!, pos[k * 3 + 1]! - pos[(k - 1) * 3 + 1]!, pos[k * 3 + 2]! - pos[(k - 1) * 3 + 2]!);
    s[k] = acc;
  }
  const offset = s[first] as number;
  for (let k = 0; k < count; k++) s[k] = (s[k] as number) - offset;
  const total = Math.max(1e-9, (s[count - 1] as number));
  const t = new Float32Array(count);
  for (let k = 0; k < count; k++) t[k] = Math.min(1, Math.max(0, (s[k] as number) / total));
  return { n: count, pos, rad, sf: sfo, s, t, tan, first };
}

/** Parallel-transport (double reflection) frames, optionally snapped to the skeleton's stored RMF normals. */
function buildNormals(sk: Skeleton, b: Branch, sm: Samples, o: TubeOptions): V3[] {
  const nx = sk.attributes.get('rmfNormalX');
  const ny = sk.attributes.get('rmfNormalY');
  const nz = sk.attributes.get('rmfNormalZ');
  const hasRmf = !!nx && !!ny && !!nz;
  const out: V3[] = [];
  const T = (i: number): V3 => [sm.tan[i * 3] as number, sm.tan[i * 3 + 1] as number, sm.tan[i * 3 + 2] as number];
  const Pt = (i: number): V3 => [sm.pos[i * 3] as number, sm.pos[i * 3 + 1] as number, sm.pos[i * 3 + 2] as number];
  const twistRad = ((o.twist ?? 0) * Math.PI) / 180;
  const rollRad = ((o.roll ?? 0) * Math.PI) / 180;
  let prev: V3 | null = null;
  for (let i = 0; i < sm.n; i++) {
    const t = T(i);
    let nrm: V3;
    if (hasRmf && nx && ny && nz) {
      const f = sm.sf[i] as number;
      const i0 = b.start + Math.min(b.count - 1, Math.floor(f));
      const i1 = b.start + Math.min(b.count - 1, Math.floor(f) + 1);
      const fr = f - Math.floor(f);
      const h: V3 = [
        (nx[i0] as number) * (1 - fr) + (nx[i1] as number) * fr,
        (ny[i0] as number) * (1 - fr) + (ny[i1] as number) * fr,
        (nz[i0] as number) * (1 - fr) + (nz[i1] as number) * fr,
      ];
      nrm = orthogonalize(h, t);
    } else if (!prev) {
      nrm = perpendicular(t);
    } else {
      const p0 = Pt(i - 1);
      const p1 = Pt(i);
      const t0 = T(i - 1);
      const v1 = sub(p1, p0);
      const c1 = dot(v1, v1);
      if (c1 < 1e-14) nrm = orthogonalize(prev, t);
      else {
        const rL = sub(prev, mul(v1, (2 / c1) * dot(v1, prev)));
        const tL = sub(t0, mul(v1, (2 / c1) * dot(v1, t0)));
        const v2 = sub(t, tL);
        const c2 = dot(v2, v2);
        nrm = orthogonalize(c2 < 1e-14 ? rL : sub(rL, mul(v2, (2 / c2) * dot(v2, rL))), t);
      }
    }
    prev = nrm;
    out.push(twistRad !== 0 || rollRad !== 0 ? rotate(nrm, t, twistRad * (sm.s[i] as number) + rollRad) : nrm);
  }
  return out;
}

const lerpAttr = (arr: Float32Array | undefined, b: Branch, f: number, fallback: number): number => {
  if (!arr) return fallback;
  const i0 = b.start + Math.min(b.count - 1, Math.floor(f));
  const i1 = b.start + Math.min(b.count - 1, Math.floor(f) + 1);
  const fr = f - Math.floor(f);
  return (arr[i0] as number) * (1 - fr) + (arr[i1] as number) * fr;
};

/** Skeleton attributes written by the weld pass of the generators (`nodes/generators/weldApply.ts`). */
const WELD_ATTR = 'weld';
const WELD_SELF_ATTR = 'weldSelf';

/** Parent branch of `b`: inside the same skeleton for sub-levels of one node, else in the generator's parent skeleton. */
/** Centre and unit direction of the open end an extension grows from (point `point` of `host`), or null when it is not valid. */
/** Polyline length of the skeleton points `first`..`last` (inclusive). */
function pathLength(sk: Skeleton, first: number, last: number): number {
  let total = 0;
  for (let k = first + 1; k <= last; k++) {
    total += Math.hypot(
      (sk.position[k * 3] as number) - (sk.position[(k - 1) * 3] as number),
      (sk.position[k * 3 + 1] as number) - (sk.position[(k - 1) * 3 + 1] as number),
      (sk.position[k * 3 + 2] as number) - (sk.position[(k - 1) * 3 + 2] as number),
    );
  }
  return total;
}

function endAxisAt(host: Skeleton, point: number): { centre: V3; axis: V3 } | null {
  if (point < 0 || point >= host.count) return null;
  const dx = host.direction[point * 3] as number;
  const dy = host.direction[point * 3 + 1] as number;
  const dz = host.direction[point * 3 + 2] as number;
  const l = Math.hypot(dx, dy, dz);
  if (l < 1e-9) return null;
  return {
    centre: [host.position[point * 3] as number, host.position[point * 3 + 1] as number, host.position[point * 3 + 2] as number],
    axis: [dx / l, dy / l, dz / l],
  };
}

/** Smooth shoulder: 1 up to the emergence point, 0 one collar length further (C1 at both ends). */
export function collarSwellBump(x: number): number {
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  return 1 - x * x * (3 - 2 * x);
}

function parentBranchOf(sk: Skeleton, b: Branch, parent: Skeleton | undefined): { sk: Skeleton; branch: Branch } | null {
  const own = (sk.attributes.get(WELD_SELF_ATTR)?.[b.start] ?? 0) > 0;
  const psk = own ? sk : parent;
  if (!psk || b.parentBranch < 0) return null;
  const direct = psk.branches[b.parentBranch];
  const pb = direct && direct.id === b.parentBranch ? direct : psk.branches.find((c) => c.id === b.parentBranch);
  return pb && pb.count >= 2 ? { sk: psk, branch: pb } : null;
}

/** Squash of the parent skin at global point `idx` of `sk` (neutral when the parent has none). */
function parentSquash(sk: Skeleton, idx: number): { amount: number; angle: number } {
  const amount = sk.attributes.get(SQUASH_ATTR)?.[idx] ?? 0;
  return { amount, angle: sk.attributes.get(SQUASH_ANGLE_ATTR)?.[idx] ?? 0 };
}

/** Parent skin at the attachment (`at` = base of the child, on the parent spine), squashed like the parent's own mesh. */
export function squashedParentSurface(surface: ParentSurface, sk: Skeleton, idx: number, at: V3): ParentSurface {
  const sq = parentSquash(sk, idx);
  if (!(sq.amount > 0)) return surface;
  // The base of the child lies on the parent spine: it is the point of the parent axis the rings are measured around.
  const position = at;
  const nx = sk.attributes.get('rmfNormalX');
  const ny = sk.attributes.get('rmfNormalY');
  const nz = sk.attributes.get('rmfNormalZ');
  const rmf: V3 | null = nx && ny && nz ? [nx[idx] as number, ny[idx] as number, nz[idx] as number] : null;
  const normal = frameNormalFor(rmf, surface.axis);
  return squashSurface(surface, { position, normal, amount: sq.amount, angle: sq.angle });
}

/** Solves the weld of branch `b` on its rings; null when the parent is missing or the solver fails (the junction then stays unwelded). */
function solveBranchWeld(
  sk: Skeleton,
  b: Branch,
  sm: Samples,
  frames: V3[],
  sides: number,
  o: TubeOptions,
  section: ReturnType<typeof createSectionEvaluator>,
  sqrtA: number,
  ownWind: readonly Float32Array[],
): BranchWeld | null {
  const w = o.weld;
  const pr = parentBranchOf(sk, b, o.parent);
  if (!w || !pr) return null;
  const start = pr.branch.start;
  const positions = pr.sk.position.subarray(start * 3, (start + pr.branch.count) * 3);
  const radii = pr.sk.radius.subarray(start, start + pr.branch.count);
  const base: [number, number, number] = [sm.pos[0] as number, sm.pos[1] as number, sm.pos[2] as number];
  const hint = Math.min(pr.branch.count - 1, Math.max(0, b.parentPoint - start));
  const parentSides = pr.sk.attributes.get('radialSides')?.[start] ?? 0;
  const raw = parentSurfaceFor(positions, radii, pr.branch.count, base, hint, parentSides, w.forceRays);
  if (!raw) return null;
  const point = start + hint;
  const attachPos: V3 = [pr.sk.position[point * 3] as number, pr.sk.position[point * 3 + 1] as number, pr.sk.position[point * 3 + 2] as number];
  const surface = squashedParentSurface(raw, pr.sk, point, base);
  const nrm = new Float32Array(sm.n * 3);
  for (let i = 0; i < sm.n; i++) {
    const f = frames[i] as V3;
    nrm[i * 3] = f[0];
    nrm[i * 3 + 1] = f[1];
    nrm[i * 3 + 2] = f[2];
  }
  const path: ChildPath = { count: sm.n, pos: sm.pos, rad: sm.rad, nrm, tan: sm.tan, s: sm.s };
  const sq = o.squash;
  const res = solveWeld(path, surface, {
    sides,
    segments: weldRingCount(w.scalar) - 1,
    offset: w.offset * (sm.rad[0] as number),
    spread: w.spread,
    upper: w.upper,
    lower: w.lower,
    aspect: sqrtA,
    section: (a, s) => section.radius(a, s) * (sq ? squashRadius(a, sq.amount, sq.rotate) : 1),
  });
  if (!res.ok) return null;

  // Parent frame for the parent-side texture coordinates.
  const axis: V3 = [surface.axis[0], surface.axis[1], surface.axis[2]];
  const nx = pr.sk.attributes.get('rmfNormalX');
  const ny = pr.sk.attributes.get('rmfNormalY');
  const nz = pr.sk.attributes.get('rmfNormalZ');
  const frame = frameNormalFor(nx && ny && nz ? [nx[point] as number, ny[point] as number, nz[point] as number] : null, axis);
  const binormal = cross(axis, frame);
  let along = 0;
  let length = 0;
  for (let k = 1; k < pr.branch.count; k++) {
    length += Math.hypot(
      (positions[k * 3] as number) - (positions[(k - 1) * 3] as number),
      (positions[k * 3 + 1] as number) - (positions[(k - 1) * 3 + 1] as number),
      (positions[k * 3 + 2] as number) - (positions[(k - 1) * 3 + 2] as number),
    );
    if (k === hint) along = length;
  }
  const t0: V3 = [sm.tan[0] as number, sm.tan[1] as number, sm.tan[2] as number];
  // Wind of the parent skin under every weld vertex (a parent of the same skeleton uses this mesher's own wind channels).
  const wArrays = pr.sk === sk ? ownWind : windArraysOf(pr.sk.attributes);
  let parentWind: Float32Array | null = null;
  if (wArrays) {
    const src = { arrays: wArrays, start, count: pr.branch.count, position: pr.sk.position };
    parentWind = new Float32Array(res.rings * res.sides * 5);
    for (let k = 0; k < res.rings * res.sides; k++) {
      const t = parentWindAt(src, res.positions[k * 3] as number, res.positions[k * 3 + 1] as number, res.positions[k * 3 + 2] as number);
      for (let c = 0; c < 5; c++) parentWind[k * 5 + c] = t[c] as number;
    }
  }
  const parentPivot: V3 = [pr.sk.position[start * 3] as number, pr.sk.position[start * 3 + 1] as number, pr.sk.position[start * 3 + 2] as number];
  return {
    result: res,
    parentWind,
    parentPivot,
    attach: {
      position: attachPos,
      axis,
      normal: frame,
      binormal,
      along,
      length: Math.max(1e-6, length),
      radius: Math.max(1e-6, surface.radius),
      childPhi: Math.atan2(dot(t0, binormal), dot(t0, frame)),
    },
  };
}

/**
 * Replaces the rings of the weld part (everything up to the end of the weld) by the weld rings. The weld ring centres
 * are evaluated on the child path at the mean arc length of each ring; their vertices are overridden by the solver.
 */
function spliceWeld(sm: Samples, frames: V3[], w: WeldResult): { sm: Samples; frames: V3[] } {
  let k0 = 1;
  while (k0 < sm.n - 1 && (sm.s[k0] as number) < w.sEnd + 0.25 * ((sm.s[k0] as number) - (sm.s[k0 - 1] as number))) k0++;
  const keep = sm.n - k0;
  const count = w.rings + keep;
  const pos = new Float32Array(count * 3);
  const rad = new Float32Array(count);
  const sfo = new Float32Array(count);
  const tan = new Float32Array(count * 3);
  const s = new Float32Array(count);
  const t = new Float32Array(count);
  const outFrames: V3[] = [];
  const nrm = new Float32Array(sm.n * 3);
  for (let i = 0; i < sm.n; i++) {
    const f = frames[i] as V3;
    nrm.set(f, i * 3);
  }
  const ev = new ChildPathEvaluator({ count: sm.n, pos: sm.pos, rad: sm.rad, nrm, tan: sm.tan, s: sm.s });
  for (let i = 0; i < w.rings; i++) {
    const si = w.ringS[i] as number;
    ev.at(si);
    pos.set([ev.px, ev.py, ev.pz], i * 3);
    rad[i] = Math.max(1e-4, ev.r);
    tan.set([ev.tx, ev.ty, ev.tz], i * 3);
    s[i] = si;
    let k = 0;
    while (k < sm.n - 2 && (sm.s[k + 1] as number) <= si) k++;
    const span = (sm.s[k + 1] as number) - (sm.s[k] as number);
    const fr = span > 1e-12 ? Math.min(1, Math.max(0, (si - (sm.s[k] as number)) / span)) : 0;
    sfo[i] = (sm.sf[k] as number) + ((sm.sf[k + 1] as number) - (sm.sf[k] as number)) * fr;
    outFrames.push([ev.nx, ev.ny, ev.nz]);
  }
  for (let q = 0; q < keep; q++) {
    const d = w.rings + q;
    const k = k0 + q;
    pos.set(sm.pos.subarray(k * 3, k * 3 + 3), d * 3);
    tan.set(sm.tan.subarray(k * 3, k * 3 + 3), d * 3);
    rad[d] = sm.rad[k] as number;
    sfo[d] = sm.sf[k] as number;
    s[d] = sm.s[k] as number;
    outFrames.push(frames[k] as V3);
  }
  const total = Math.max(1e-9, s[count - 1] as number);
  for (let i = 0; i < count; i++) t[i] = Math.min(1, Math.max(0, (s[i] as number) / total));
  return { sm: { n: count, pos, rad, sf: sfo, s, t, tan, first: 0 }, frames: outFrames };
}

/** The mapping the legacy `uv` options (scale, offset, normalized) describe, so old callers and saved projects map identically. */
function legacyUvMapping(uv: TubeUv): UvMapping {
  return {
    ...DEFAULT_UV_MAPPING,
    rotate: uv.rotate,
    uAbsolute: 0,
    uRelative: uv.normalized ? 0 : uv.scaleU,
    fractional: uv.normalized ? { enabled: true, auto: false, value: uv.scaleU } : DEFAULT_UV_MAPPING.fractional,
    uOffset: uv.offsetU,
    vStyle: uv.normalized ? 'relative' : 'absolute',
    vScale: uv.scaleV,
    vOffset: uv.offsetV,
  };
}

/**
 * Skeleton -> tube mesh. Rotation-minimising frames (continuous twist), analytic smooth normals + tangents,
 * metric UV0 (tiling by world length), unique UV1 cells, baked AO / colour, wind attributes, closed tips and bases,
 * buried + flared collars at junctions. Deterministic: depends only on the skeleton and the options.
 */
export function buildTubeMesh(sk: Skeleton, opts: TubeOptions): MeshData {
  const acc = new MeshAccumulator();
  acc.beginSlot(opts.materialId);
  const section = createSectionEvaluator(opts.section ?? ROUND_SECTION);
  const aspect = Math.max(0.05, opts.section?.aspect ?? 1);
  const sqrtA = Math.sqrt(aspect);
  const uvo: TubeUv = { normalized: false, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotate: false, ...opts.uv };
  const uvMap: UvMapping = opts.uvMapping ?? legacyUvMapping(uvo);
  const uvRotate = opts.uvMapping ? uvMap.rotate : uvo.rotate;
  let slotMaterial = opts.materialId;
  const setSlot = (material: string): void => {
    if (material === slotMaterial) return;
    acc.beginSlot(material);
    slotMaterial = material;
  };
  const branchMaterials = new Map<number, string>();
  const smooth = (opts.smoothing ?? 1) >= 0.5;
  const flatten = Math.min(1, Math.max(0, opts.flatten ?? 0));
  const collarAmountOpt = Math.max(0, opts.collarAmount ?? 0.3);
  const collarLength = Math.max(0.1, opts.collarLength ?? 1.5);
  const collarSwell = Math.min(1, Math.max(0, opts.collarSwell ?? 0));
  const tipRings = Math.max(1, Math.round(opts.tipRings ?? 2));
  const aoStrength = Math.min(1, Math.max(0, opts.aoStrength ?? 0.6));
  const seed = opts.seed ?? 0;
  /** Final colour per skeleton point: children with a seamless Vertex Color continue the parent's colour from here. */
  const pointColors = recordPointColors(sk);
  const windArr = WIND_ATTRIBUTES.map((k) => sk.attributes.get(k));
  const wind = windArr.every((w) => w) ? (windArr as Float32Array[]) : computeSkeletonWind(sk, opts.parent ?? null, seed);
  const nb = sk.branches.length;
  const cells = Math.max(1, Math.ceil(Math.sqrt(nb)));
  // Splits: the parent and both halves are ONE skin. The parent is cut where the shared transition starts, the crotch rings are
  // emitted with the parent, and the lobe branches only plan their UV attributes (for the extensions that continue them).
  const splitParents = findSplitLobes(sk);
  const fusedLobes = new Set<number>();
  const halfParent = new Map<number, number>();
  for (const [parentIdx, sp] of splitParents) {
    halfParent.set(sp.side1, parentIdx);
    halfParent.set(sp.side2, parentIdx);
  }
  // U mapping of the halves (tiles, first U, V at the open end): written to the lobe points so extensions continue it.
  const lobeUv = new Map<number, { uTiles: number; uStart: number; vEnd: number }>();

  for (let bi = 0; bi < nb; bi++) {
    let b = sk.branches[bi] as Branch;
    if (b.generation > opts.maxGeneration || b.count < 2 || opts.skipBranch?.(bi) === true) continue;
    const isFusedLobe = fusedLobes.has(bi);
    const splitHere = splitParents.get(bi);
    let tail: TailPoint | undefined;
    const lobePair: [Branch, Branch] | null =
      splitHere && opts.skipBranch?.(splitHere.side1) !== true && opts.skipBranch?.(splitHere.side2) !== true
        ? [sk.branches[splitHere.side1] as Branch, sk.branches[splitHere.side2] as Branch]
        : null;
    if (splitHere && lobePair) {
      tail = transitionStart(sk, b, lobePair[0], splitHere.keep);
      b = { ...b, count: splitHere.keep };
    }
    let maxR = 0;
    for (let k = 0; k < b.count; k++) maxR = Math.max(maxR, sk.radius[b.start + k] as number);
    let sides = Math.max(3, Math.round(opts.radialSegments(b.generation, maxR, bi)));
    // T09: an extension that continues a split half has exactly the half's ring count (N / 2 of the parent's real N) at every LOD and
    // displacement subdivision, whatever its own Resolution says.
    if (b.parentPoint >= 0 && (sk.attributes.get(EXTENSION_ATTR)?.[b.start] ?? 0) > 0) {
      const hostSk = (sk.attributes.get(SUB_LEVEL_ATTR)?.[b.start] ?? 0) > 0 ? sk : (opts.parent ?? null);
      const ringOfHalf = hostSk ? lobeEndRing(hostSk, b.parentBranch) : undefined;
      if (ringOfHalf && ringOfHalf.length >= 9) sides = Math.round(ringOfHalf.length / 3);
    }
    // A splitting parent needs an even radial count (two arcs of N / 2 + 1 vertices); below 6 the lobe rings would be digons.
    if (tail) sides = effectiveSplitSides(sides);
    const V = sides + 1;
    // Extensions (and the sides of a split) continue their parent's end: no buried ring, no collar, no base cap.
    const attached = b.parentPoint >= 0;
    const extensionValue = attached ? (sk.attributes.get(EXTENSION_ATTR)?.[b.start] ?? 0) : 0;
    const isExtension = extensionValue > 0;
    const extensionSmooth = isExtension ? Math.min(1, Math.max(0, sk.attributes.get(EXTENSION_SMOOTH_ATTR)?.[b.start] ?? 0)) : 0;
    const junction = attached && !isExtension;
    const displaceScale = isExtension ? Math.max(0, sk.attributes.get(EXTENSION_DISPLACE_ATTR)?.[b.start] ?? 1) : 1;
    let collarAmount = junction ? collarAmountOpt : 0;
    let sm: Samples | null = null;
    let frames: V3[] = [];
    // Welded junction: the weld rings replace the buried ring and the collar (Spread takes the collar's role).
    let weld: WeldResult | null = null;
    let attach: ParentAttach | null = null;
    let weldWind: { wind: Float32Array; pivot: V3 } | null = null;
    if (junction && opts.weld && (sk.attributes.get(WELD_ATTR)?.[b.start] ?? 0) === 1) {
      const plain = sampleBranch(sk, b, opts, false, 0, tail);
      if (plain.n >= 2) {
        const plainFrames = buildNormals(sk, b, plain, opts);
        const solved = solveBranchWeld(sk, b, plain, plainFrames, sides, opts, section, sqrtA, wind);
        weld = solved ? solved.result : null;
        attach = solved ? solved.attach : null;
        weldWind = solved && solved.parentWind ? { wind: solved.parentWind, pivot: solved.parentPivot } : null;
        if (weld) {
          const spliced = spliceWeld(plain, plainFrames, weld);
          sm = spliced.sm;
          frames = spliced.frames;
          collarAmount = 0;
        }
      }
    }
    if (!sm) {
      sm = sampleBranch(sk, b, opts, junction, collarAmount, tail);
      if (sm.n >= 2) frames = buildNormals(sk, b, sm, opts);
    }
    if (sm.n < 2) continue;
    let rMaxPlan = 0;
    for (let i = 0; i < sm.n; i++) rMaxPlan = Math.max(rMaxPlan, sm.rad[i] as number);
    const host = (sk.attributes.get(SUB_LEVEL_ATTR)?.[b.start] ?? 0) > 0 ? sk : (opts.parent ?? null);
    // Siblings on one open end (Count 3+) lean towards the normal of the end's own cylinder: its axis is the parent's last point
    const endAxis = extensionValue >= EXTENSION_GROUP_VALUE && host ? endAxisAt(host, b.parentPoint) : null;
    const parentMaterial = (host === sk ? branchMaterials.get(b.parentBranch) : undefined) ?? opts.inheritedMaterial ?? opts.materialId;
    const plan: UvPlan = planBranchUv({
      mapping: uvMap,
      ...(opts.uvMaterials ? { materials: opts.uvMaterials } : {}),
      sk,
      b,
      host,
      isExtension,
      sm,
      frames,
      weldRings: weld ? weld.rings : 0,
      rMax: rMaxPlan,
      metresPerTile: Math.max(1e-4, opts.uvMetres),
      seed,
      fallbackMaterial: opts.materialId,
      inheritedMaterial: parentMaterial,
    });
    const half = lobeUv.get(bi);
    if (half && !plan.patch && plan.vRing.length > 0) {
      // Each half carries half of the parent's U tiles; V starts where the crotch ends (no jump at the first child ring).
      plan.uTiles = half.uTiles;
      plan.uOffset = half.uStart;
      const shift = half.vEnd - (plan.vRing[plan.vRing.length - 1] as number);
      for (let i = 0; i < plan.vRing.length; i++) plan.vRing[i] = (plan.vRing[i] as number) + shift;
    }
    sm = plan.sm;
    frames = plan.frames;
    branchMaterials.set(bi, plan.materials[0] as string);
    writeUvAttributes(sk, b, plan);
    if (isFusedLobe) continue;
    // Crotch phase alignment: roll the last rings (less than one vertex spacing) so two opposite vertices sit on the pinch axis.
    let align: ReturnType<typeof alignCrotchPhase> | null = null;
    if (tail && lobePair && sm.n >= 3) {
      const e1 = sk.position.subarray((lobePair[0].start + lobePair[0].count - 1) * 3, (lobePair[0].start + lobePair[0].count) * 3);
      const e2 = sk.position.subarray((lobePair[1].start + lobePair[1].count - 1) * 3, (lobePair[1].start + lobePair[1].count) * 3);
      align = alignCrotchPhase(sm.tan, frames, sm.n, [e1[0] as number, e1[1] as number, e1[2] as number], [e2[0] as number, e2[1] as number, e2[2] as number], sides);
    }
    const R = sm.n;
    const weldRings = weld ? weld.rings : 0;
    const r0 = sm.rad[sm.first] as number;
    // Collar swell: a smooth shoulder around the child's emergence point (the parent's skin is built by its own node).
    const swellAmount = junction && !weld ? collarSwell * r0 : 0;
    const swellStart = swellAmount > 0 ? (parentBranchOf(sk, b, opts.parent)?.sk.radius[b.parentPoint] ?? r0) : 0;
    const fins = opts.buttress && !attached ? createButtressProfile(opts.buttress, seed + b.id * 17, sides) : null;
    const finFloor = sm.pos[sm.first * 3 + 2] as number;
    const squash = opts.squash && opts.squash.amount > 0 ? opts.squash : null;
    const smoothAmount = Math.min(1, Math.max(0, opts.smooth ?? 0));
    const seamAmount = junction ? Math.min(1, Math.max(0, opts.seam ?? 0)) : 0;
    // Weld texture blend: the value of every ring (0 at the parent side .. 1 up the child).
    const blendOpt = weld && attach ? (opts.weld?.blend ?? null) : null;
    const blendVals = new Float32Array(blendOpt && weld ? R : 0);
    if (blendOpt && weld) {
      const rEnd = sm.rad[Math.min(R - 1, weldRings)] as number;
      for (let i = 0; i < R; i++) blendVals[i] = weldBlendValue(sm.s[i] as number, sm.s[0] as number, weld.sEnd, rEnd, blendOpt.texture);
    }
    // Extension material blend: ramp 0 -> 1 over `length` parent radii from the first ring, only when the material differs.
    const extBlend = isExtension && !isFusedLobe && !blendOpt && opts.extensionBlend && plan.materials[0] !== parentMaterial ? opts.extensionBlend : null;
    const extVals = new Float32Array(extBlend ? R : 0);
    const extActive = new Uint8Array(extBlend ? R : 0);
    if (extBlend) {
      const sFirst = sm.s[sm.first] as number;
      const rFirst = sm.rad[sm.first] as number;
      for (let i = 0; i < R; i++) {
        extVals[i] = i < sm.first ? 0 : extensionBlendValue(sm.s[i] as number, sFirst, rFirst, extBlend.length);
        extActive[i] = i === 0 || (extVals[i - 1] as number) < 0.999 ? 1 : 0;
      }
    }
    let rMax = 0;
    for (let i = 0; i < R; i++) rMax = Math.max(rMax, sm.rad[i] as number);
    const uTiles = plan.uTiles;
    const tintMul = 1 + (hash01(b.id + 1, seed) * 2 - 1) * (opts.tintVariance ?? 0) * 0.5;
    const parentT = junction && opts.parent && b.parentPoint < opts.parent.count ? (opts.parent.t[b.parentPoint] as number) : 0.5;
    const parentColor = junction && opts.parent ? opts.color(Math.max(0, b.generation - 1), parentT) : null;
    const vc = opts.vertexColor;
    const vcHash = hash01(b.id + 101, seed);
    const vcParentAmount = vc && junction && opts.parent ? sampleLut(vc.parentCurve, parentT) : 1;
    const parentFinal = vc?.seamless && junction && opts.parent ? recordedPointColor(opts.parent, b.parentPoint) : null;
    const branchTint = hash01(b.id + 17, seed);
    const cx = bi % cells;
    const cy = Math.floor(bi / cells);

    // --- ring positions
    const dv: BranchDisplaceVertex = {
      u: 0, s: 0, t: 0, sEnd: 0, radius: 0, circumference: 2 * Math.PI * rMax, sides, junction,
      uvU: 0, uvV: 0, uTiles, length: Math.max(1e-6, (sm.s[R - 1] as number) - (sm.s[sm.first] as number)), baseRadius: r0, sFree: 0, branch: b.id,
    };
    const dOut: DisplaceOut = { radial: 0, along: 0, normal: 0 };
    let sOff = 0;
    if (opts.displaceField) {
      // Bark lineage: a split half / extension keeps its host's pattern seed and continues its arc length.
      const hp = halfParent.get(bi);
      const hostBranch = !hp && isExtension && host && b.parentBranch >= 0 ? host.branches[b.parentBranch] : undefined;
      if (hp !== undefined) {
        const par = sk.branches[hp] as Branch;
        dv.lineage = par.id;
        dv.continued = true;
        sOff = pathLength(sk, par.start, par.start + Math.max(1, (splitParents.get(hp)?.keep ?? par.count) - 1));
      } else if (hostBranch && b.parentPoint >= hostBranch.start && b.parentPoint < hostBranch.start + hostBranch.count) {
        dv.lineage = hostBranch.id;
        dv.continued = true;
        sOff = pathLength(host as Skeleton, hostBranch.start, b.parentPoint);
      } else if (isExtension) dv.continued = true;
    }
    // T09: an extension that continues a displaced split half carries the splitting parent's pattern frame (lineage, arc length,
    // circumference, U) and does not fade in: its first ring IS the crotch's open-end ring.
    const halfCont = opts.displaceField && isExtension && host && !weld ? lobeContinuation(host, b.parentBranch) : undefined;
    const cont = halfCont && halfCont.displaced ? halfCont : undefined;
    let sShift = 0;
    let uBase = 0;
    let uSpan = 1;
    if (cont) {
      dv.lineage = cont.lineage;
      dv.branch = cont.branch;
      dv.circumference = cont.circumference;
      dv.uTiles = cont.uTiles;
      dv.continued = false;
      sOff = cont.sOff;
      sShift = cont.sEnd - (sm.s[sm.first] as number);
      uBase = cont.u0;
      uSpan = cont.span;
    }
    // T09: the extension's frames are rolled so its ring vertex 0 lies on the half's end-ring vertex 0 (same winding): vertex j of the
    // extension then IS vertex j of the half (positions, U and pattern match; the ring can be shared by index).
    const endRingPre = isExtension && host && !weld && !plan.patch ? lobeEndRing(host, b.parentPoint >= 0 ? b.parentBranch : -1) : undefined;
    let shiftValid = false;
    if (endRingPre && sm.n > 0) {
      const f0 = frames[sm.first] as V3;
      const tf: V3 = [sm.tan[sm.first * 3] as number, sm.tan[sm.first * 3 + 1] as number, sm.tan[sm.first * 3 + 2] as number];
      const roll = ringStartAngle(endRingPre, sides, [sm.pos[sm.first * 3] as number, sm.pos[sm.first * 3 + 1] as number, sm.pos[sm.first * 3 + 2] as number], f0, cross(tf, f0));
      if (roll !== null) {
        for (let i = 0; i < sm.n; i++) {
          frames[i] = rotate(frames[i] as V3, [sm.tan[i * 3] as number, sm.tan[i * 3 + 1] as number, sm.tan[i * 3 + 2] as number], roll);
        }
        shiftValid = true;
      }
    }
    const displaced = opts.displace !== undefined || opts.displaceField !== undefined;
    const weldEndS = weld ? weld.sEnd : 0;
    const gp = new Float32Array(R * V * 3);
    const dirs = new Float32Array(R * V * 3);
    for (let i = 0; i < R; i++) {
      if (weld && i < weldRings) {
        for (let j = 0; j < V; j++) {
          const src = (i * sides + (j % sides)) * 3;
          const o = (i * V + j) * 3;
          gp[o] = weld.positions[src] as number;
          gp[o + 1] = weld.positions[src + 1] as number;
          gp[o + 2] = weld.positions[src + 2] as number;
          dirs[o] = weld.dirs[src] as number;
          dirs[o + 1] = weld.dirs[src + 1] as number;
          dirs[o + 2] = weld.dirs[src + 2] as number;
        }
        continue;
      }
      const N = frames[i] as V3;
      const Tn: V3 = [sm.tan[i * 3] as number, sm.tan[i * 3 + 1] as number, sm.tan[i * 3 + 2] as number];
      const B = cross(Tn, N);
      const s = sm.s[i] as number;
      const collar = 1 + collarAmount * Math.exp(-Math.max(0, s) / (collarLength * r0));
      let radius = (i === 0 && junction ? (sm.rad[0] as number) : (sm.rad[i] as number) * collar);
      if (swellAmount > 0 && !(i === 0 && junction)) radius += swellAmount * collarSwellBump((s - swellStart) / (collarLength * r0));
      let slope = 0;
      if (displaced && opts.displaceDirection !== 'radial') {
        const a = Math.max(0, i - 1);
        const c = Math.min(R - 1, i + 1);
        const ds = (sm.s[c] as number) - (sm.s[a] as number);
        slope = ds > 1e-9 ? ((sm.rad[c] as number) - (sm.rad[a] as number)) / ds : 0;
      }
      if (displaced) {
        dv.s = s + sShift;
        dv.t = sm.t[i] as number;
        // A splitting parent has no tip: its last ring continues into the crotch, so the tip fade must not zero it.
        dv.sEnd = tail ? 1e9 : (sm.s[R - 1] as number) - s;
        dv.radius = radius;
        dv.sFree = s - weldEndS;
        dv.uvV = plan.vRing[i] as number;
        dv.sLineage = s + sShift + sOff;
      }
      // Smooth: on a bend the ring plane cuts the tube obliquely, so the section stretches by 1 / cos(half the turn) in the bend plane.
      let bendK = 0;
      let ex = 0;
      let ey = 0;
      let ez = 0;
      if (smoothAmount > 0 && i > 0 && i < R - 1) {
        const d1 = sub([sm.pos[i * 3] as number, sm.pos[i * 3 + 1] as number, sm.pos[i * 3 + 2] as number], [sm.pos[(i - 1) * 3] as number, sm.pos[(i - 1) * 3 + 1] as number, sm.pos[(i - 1) * 3 + 2] as number]);
        const d2 = sub([sm.pos[(i + 1) * 3] as number, sm.pos[(i + 1) * 3 + 1] as number, sm.pos[(i + 1) * 3 + 2] as number], [sm.pos[i * 3] as number, sm.pos[i * 3 + 1] as number, sm.pos[i * 3 + 2] as number]);
        const l1 = len(d1);
        const l2 = len(d2);
        if (l1 > 1e-9 && l2 > 1e-9) {
          const turn = sub(mul(d2, 1 / l2), mul(d1, 1 / l1));
          const flat = sub(turn, mul(Tn, dot(turn, Tn)));
          const fl = len(flat);
          if (fl > 1e-6) {
            bendK = smoothAmount * (bendPushFactor(dot(d1, d2) / (l1 * l2)) - 1);
            ex = flat[0] / fl;
            ey = flat[1] / fl;
            ez = flat[2] / fl;
          }
        }
      }
      for (let j = 0; j < V; j++) {
        const a = (2 * Math.PI * (j % sides)) / sides;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const ox = N[0] * c * sqrtA + B[0] * sn / sqrtA;
        const oy = N[1] * c * sqrtA + B[1] * sn / sqrtA;
        const oz = N[2] * c * sqrtA + B[2] * sn / sqrtA;
        let m = section.radius(a, s) * radius;
        if (squash) m *= squashRadius(a, squash.amount, squash.rotate);
        const fin = fins ? fins(a, s, sm.rad[sm.first] as number) : 0;
        m += fin;
        const o = (i * V + j) * 3;
        let dd = 0;
        let radialD = 0;
        let alongD = 0;
        if (displaced) {
          dv.u = cont ? (uBase + (uSpan * (j % sides)) / sides) % 1 : (j % sides) / sides;
          if (opts.displace) dd = opts.displace(dv) * displaceScale;
          if (opts.displaceField) {
            dv.uvU = dv.u * dv.uTiles + (cont ? cont.uOffset : plan.uOffset);
            opts.displaceField(dv, dOut);
            dd += dOut.normal * displaceScale;
            radialD = dOut.radial * displaceScale;
            alongD = dOut.along * displaceScale;
          }
        }
        const dl = Math.hypot(ox, oy, oz) || 1;
        if (bendK > 0) {
          const inPlane = (ox * ex + oy * ey + oz * ez) / dl;
          m *= 1 + bendK * inPlane * inPlane;
        }
        gp[o] = (sm.pos[i * 3] as number) + ox * m + (ox / dl - Tn[0] * slope) * dd + (ox / dl) * radialD + Tn[0] * alongD;
        gp[o + 1] = (sm.pos[i * 3 + 1] as number) + oy * m + (oy / dl - Tn[1] * slope) * dd + (oy / dl) * radialD + Tn[1] * alongD;
        gp[o + 2] = (sm.pos[i * 3 + 2] as number) + oz * m + (oz / dl - Tn[2] * slope) * dd + (oz / dl) * radialD + Tn[2] * alongD;
        if (fin > 0 && (gp[o + 2] as number) < finFloor) {
          // Fins never dig below the base of the trunk (the wind anchor is 0 on the ground): take the part that does back.
          const zNo = (gp[o + 2] as number) - oz * fin;
          const keepFin = zNo > finFloor ? (zNo - finFloor) / (zNo - (gp[o + 2] as number)) : 0;
          gp[o] = (gp[o] as number) - ox * fin * (1 - keepFin);
          gp[o + 1] = (gp[o + 1] as number) - oy * fin * (1 - keepFin);
          gp[o + 2] = (gp[o + 2] as number) - oz * fin * (1 - keepFin);
        }
        dirs[o] = ox / dl;
        dirs[o + 1] = oy / dl;
        dirs[o + 2] = oz / dl;
      }
    }

    // An extension / cap of a split half starts exactly on the half's real end ring (no gap at the junction)
    let ringMatchesHalf = false;
    const endRing = isExtension && host ? lobeEndRing(host, b.parentPoint >= 0 ? b.parentBranch : -1) : undefined;
    if (endRing && !weld && sides >= 3) {
      const o = sm.first * V * 3;
      const radiusFirst = Math.max(1e-6, sm.rad[sm.first] as number);
      const exact = shiftValid && snapRingShifted(gp, o, sides, endRing, 0, radiusFirst);
      if (exact || snapRingToPolygon(gp, o, sides, endRing, radiusFirst)) {
        gp[o + sides * 3] = gp[o] as number;
        gp[o + sides * 3 + 1] = gp[o + 1] as number;
        gp[o + sides * 3 + 2] = gp[o + 2] as number;
        // Vertex j of the snapped ring is vertex j of the half's end ring (no cyclic shift / flip): only then can the ids be shared.
        ringMatchesHalf = exact;
      }
    }

    // --- fused crotch (pair-of-pants): built from the lobe paths and the parent's real last ring
    let crotch: CrotchBuild | null = null;
    if (tail && lobePair && align) {
      const lastIdx = R - 1;
      const t0: V3 = [sm.tan[lastIdx * 3] as number, sm.tan[lastIdx * 3 + 1] as number, sm.tan[lastIdx * 3 + 2] as number];
      const parentRad = Math.max(1e-4, sm.rad[lastIdx] as number);
      const sLastRing0 = sm.s[lastIdx] as number;
      // T09: the crotch rings are displaced with the parent's own coordinates (lineage, arc length, circumference, U), so the pattern
      // flows from the parent's last ring around both lobes into the halves. Outline column j continues parent vertex j + phase.
      const crotchDisplace: CrotchDisplaceFn | undefined =
        displaced
          ? (smp, out) => {
              const lobeEndRadius = sk.radius[lobePair[smp.lobe].start + lobePair[smp.lobe].count - 1] as number;
              const w = crotchBlend(smp.ring / Math.max(1, smp.rings - 1));
              const sHere = sLastRing0 + smp.arc;
              dv.u = (uBase + (uSpan * smp.parentVertex) / sides) % 1;
              dv.s = sHere + sShift;
              dv.t = sm.t[lastIdx] as number;
              dv.sEnd = 1e9;
              dv.radius = parentRad + (lobeEndRadius - parentRad) * w;
              dv.sFree = sHere - weldEndS;
              dv.uvV = plan.vAt(sHere);
              dv.sLineage = sHere + sShift + sOff;
              let dd = 0;
              out.radial = 0;
              out.along = 0;
              out.normal = 0;
              if (opts.displace) dd = opts.displace(dv) * displaceScale;
              if (opts.displaceField) {
                dv.uvU = dv.u * dv.uTiles + (cont ? cont.uOffset : plan.uOffset);
                opts.displaceField(dv, dOut);
                dd += dOut.normal * displaceScale;
                out.radial = dOut.radial * displaceScale;
                out.along = dOut.along * displaceScale;
              }
              out.normal = dd;
            }
          : undefined;
      crotch = buildSplitCrotch(
        sk,
        lobePair,
        sides,
        t0,
        align,
        parentRad,
        (p) => {
          const o = (lastIdx * V + p) * 3;
          return [gp[o] as number, gp[o + 1] as number, gp[o + 2] as number];
        },
        crotchDisplace,
      );
      if (opts.displaceField || opts.displace) {
        const arcEnd = crotch.arc[crotch.mesh.rings - 1] as number;
        for (let lobe = 0; lobe < 2; lobe++) {
          publishLobeContinuation(sk, (lobePair as [Branch, Branch])[lobe].id, {
            lineage: dv.lineage ?? b.id,
            branch: dv.branch,
            circumference: dv.circumference,
            uTiles: dv.uTiles,
            uOffset: cont ? cont.uOffset : plan.uOffset,
            sEnd: sLastRing0 + arcEnd + sShift,
            sOff,
            u0: (uBase + uSpan * (align.phase / sides + (lobe === 1 ? 0.5 : 0))) % 1,
            span: uSpan * 0.5,
            displaced: crotchDisplace !== undefined,
          });
        }
      }
      fusedLobes.add(splitParents.get(bi)?.side1 ?? -1);
      fusedLobes.add(splitParents.get(bi)?.side2 ?? -1);
      const endWind = (lb: Branch): WindTuple => [0, 1, 2, 3, 4].map((c) => (wind[c] as Float32Array)[lb.start + lb.count - 1] as number) as WindTuple;
      publishLobeEndRings(sk, crotch, [lobePair[0].id, lobePair[1].id], [endWind(lobePair[0]), endWind(lobePair[1])]);
    }

    // --- per-vertex attributes (smooth normals from the ring grid)
    const grid: VertexAttrs[] = new Array<VertexAttrs>(R * V);
    const gp3 = (i: number, j: number): V3 => {
      const o = (i * V + j) * 3;
      return [gp[o] as number, gp[o + 1] as number, gp[o + 2] as number];
    };
    const crotchSeam = crotch ? { amount: crotchSeamAmount(opts.seam), radius: Math.max(1e-4, sm.rad[R - 1] as number) } : null;
    const sLastRing = sm.s[R - 1] as number;
    // The first ring of an extension / cap of a split half is the half's end ring: it takes that ring's wind exactly.
    const endWindHere = endRing && !weld ? lobeEndWind(host as Skeleton, b.parentPoint >= 0 ? b.parentBranch : -1) : undefined;
    const basePivot: V3 = [sm.pos[sm.first * 3] as number, sm.pos[sm.first * 3 + 1] as number, sm.pos[sm.first * 3 + 2] as number];
    for (let i = 0; i < R; i++) {
      const s = sm.s[i] as number;
      const t = sm.t[i] as number;
      const f = sm.sf[i] as number;
      let col = opts.color(b.generation, t);
      if (vc) col = modifyColor(col, vc, sampleLut(vc.profile, t) * vcParentAmount, vcHash);
      if (parentColor && !parentFinal) {
        const w = 0.7 * Math.exp(-Math.max(0, s) / (collarLength * r0 * 1.5));
        col = [col[0] + (parentColor[0] - col[0]) * w, col[1] + (parentColor[1] - col[1]) * w, col[2] + (parentColor[2] - col[2]) * w];
      }
      let ao = 1;
      if (junction) ao -= aoStrength * 0.6 * Math.exp(-Math.max(0, s) / (r0 * 2.5));
      else if (b.generation === 0) ao -= aoStrength * 0.35 * Math.exp(-s / (r0 * 4));
      ao -= aoStrength * 0.12 * Math.min(1, b.generation / 3);
      ao = Math.min(1, Math.max(0.15, ao));
      const shade = tintMul * ao;
      let ringR = col[0] * shade;
      let ringG = col[1] * shade;
      let ringB = col[2] * shade;
      if (parentFinal) {
        const k = Math.exp(-Math.max(0, s) / (collarLength * r0 * 1.5));
        ringR += (parentFinal[0] - ringR) * k;
        ringG += (parentFinal[1] - ringG) * k;
        ringB += (parentFinal[2] - ringB) * k;
      }
      const pointIndex = b.start + Math.min(b.count - 1, Math.max(0, Math.round(f)));
      pointColors[pointIndex * 3] = ringR;
      pointColors[pointIndex * 3 + 1] = ringG;
      pointColors[pointIndex * 3 + 2] = ringB;
      const w0 = lerpAttr(wind[0], b, f, 0);
      const w1 = lerpAttr(wind[1], b, f, 0);
      const w2 = lerpAttr(wind[2], b, f, 0);
      const w3 = lerpAttr(wind[3], b, f, 0);
      // The level-1 phase is a per-level constant: take the nearest point's value, never interpolate it (no wrap-around artefacts)
      const w4 = (wind[4] as Float32Array)[b.start + Math.min(b.count - 1, Math.round(f))] as number;
      const vBase = plan.vRing[i] as number;
      const ringRect = plan.patch ? (plan.rects[plan.patch.patch[i] as number] ?? plan.rects[0]) : undefined;
      for (let j = 0; j < V; j++) {
        const jm = j % sides;
        const jp = (jm + 1) % sides;
        const jq = (jm + sides - 1) % sides;
        const i1 = Math.max(0, i - 1);
        const i2 = Math.min(R - 1, i + 1);
        const dPu = sub(gp3(i, jp), gp3(i, jq));
        const dPv = sub(gp3(i2, jm), gp3(i1, jm));
        const o = (i * V + j) * 3;
        const d: V3 = [dirs[o] as number, dirs[o + 1] as number, dirs[o + 2] as number];
        let n = cross(dPu, dPv);
        if (len(n) < 1e-14) n = d;
        n = norm(n, d);
        if (dot(n, d) < 0) n = mul(n, -1);
        if (flatten > 0) n = norm([n[0] + (d[0] - n[0]) * flatten, n[1] + (d[1] - n[1]) * flatten, n[2] + (d[2] - n[2]) * flatten], d);
        const onWeld = weld !== null && i < weldRings;
        if (weld && onWeld) {
          // Normals fade from the parent's skin normal (ring 0) to the child's own normal over the weld rings.
          const bw = weld.blend[i] as number;
          const pi = (i * sides + jm) * 3;
          n = norm([
            n[0] + ((weld.parentNormals[pi] as number) - n[0]) * bw,
            n[1] + ((weld.parentNormals[pi + 1] as number) - n[1]) * bw,
            n[2] + ((weld.parentNormals[pi + 2] as number) - n[2]) * bw,
          ], d);
        }
        const spineDir: V3 = [sm.tan[i * 3] as number, sm.tan[i * 3 + 1] as number, sm.tan[i * 3 + 2] as number];
        const blendHere = blendOpt ? (blendVals[i] as number) : 1;
        if (blendOpt && blendHere < 1) n = lightingNormal(n, spineDir, d, lightingValue(blendOpt.lighting, blendHere));
        if (seamAmount > 0) n = leanNormal(n, spineDir, seamWeight(s, r0, seamAmount));
        if (extensionSmooth > 0) n = leanNormal(n, endAxis ? sharedEndNormal(gp3(i, jm), endAxis.centre, endAxis.axis, d) : d, seamWeight(s, r0, extensionSmooth));
        if (crotchSeam) n = leanNormal(n, spineDir, crotchSeamWeight(Math.max(0, sLastRing - s), crotchSeam.radius, crotchSeam.amount));
        const tg = norm(dPu, perpendicular(n));
        const bit = cross(n, tg);
        const vHere = onWeld && weld ? plan.vAt(weld.vs[i * sides + jm] as number) : vBase;
        let u = tubeU(j / sides, uTiles, plan.uOffset, plan.twist, vHere);
        let v = vHere;
        if (ringRect) [u, v] = remapToRect(ringRect, j / sides, vHere);
        const vx = newVertex();
        vx.px = gp[o] as number; vx.py = gp[o + 1] as number; vx.pz = gp[o + 2] as number;
        vx.nx = n[0]; vx.ny = n[1]; vx.nz = n[2];
        vx.tx = tg[0]; vx.ty = tg[1]; vx.tz = tg[2];
        vx.tw = dot(bit, dPv) >= 0 ? 1 : -1;
        vx.u = uvRotate ? v : u;
        vx.v = uvRotate ? u : v;
        vx.u1 = (cx + j / sides) / cells;
        vx.v1 = (cy + t) / cells;
        vx.r = ringR; vx.g = ringG; vx.b = ringB;
        vx.ao = ao;
        vx.bt = branchTint;
        vx.pvx = basePivot[0]; vx.pvy = basePivot[1]; vx.pvz = basePivot[2];
        vx.w0 = w0; vx.w1 = w1; vx.w2 = w2; vx.w3 = w3; vx.w4 = w4;
        if (endWindHere && i === sm.first) {
          vx.w0 = endWindHere[0]; vx.w1 = endWindHere[1]; vx.w2 = endWindHere[2]; vx.w3 = endWindHere[3]; vx.w4 = windPhase1OfTuple(endWindHere);
        }
        if (weld && weldWind && onWeld) {
          // Weld rings sit on the parent's skin: they move like the parent vertex under them and fade into the child's own wind
          // with the same curve as the normals (ring 0 = the parent exactly).
          const bw = weld.blend[i] as number;
          const k = (i * sides + jm) * 5;
          const pw = weldWind.wind;
          const bl = blendWeldWind([pw[k] as number, pw[k + 1] as number, pw[k + 2] as number, pw[k + 3] as number, pw[k + 4] as number], [w0, w1, w2, w3, w4], bw);
          vx.w0 = bl[0]; vx.w1 = bl[1]; vx.w2 = bl[2]; vx.w3 = bl[3]; vx.w4 = bl[4] as number;
          vx.pvx = basePivot[0] + (weldWind.pivot[0] - basePivot[0]) * bw;
          vx.pvy = basePivot[1] + (weldWind.pivot[1] - basePivot[1]) * bw;
          vx.pvz = basePivot[2] + (weldWind.pivot[2] - basePivot[2]) * bw;
        }
        if (blendOpt && attach) {
          // Parent-side UV: the vertex projected into the parent's ring frame (angle unwrapped around the child's direction).
          const rx = (gp[o] as number) - attach.position[0];
          const ry = (gp[o + 1] as number) - attach.position[1];
          const rz = (gp[o + 2] as number) - attach.position[2];
          const al = rx * attach.axis[0] + ry * attach.axis[1] + rz * attach.axis[2];
          const qx = rx - al * attach.axis[0];
          const qy = ry - al * attach.axis[1];
          const qz = rz - al * attach.axis[2];
          let dphi = Math.atan2(qx * attach.binormal[0] + qy * attach.binormal[1] + qz * attach.binormal[2], qx * attach.normal[0] + qy * attach.normal[1] + qz * attach.normal[2]) - attach.childPhi;
          dphi -= Math.round(dphi / (2 * Math.PI)) * 2 * Math.PI;
          const pTiles = plan.parentTiles(attach.radius);
          const pu = (((attach.childPhi + dphi) / (2 * Math.PI)) * pTiles + plan.uOffset) * blendOpt.textureScale;
          const alongP = attach.along + al;
          const pv = plan.parentV(alongP, attach.length, attach.radius) * blendOpt.textureScale;
          vx.wb = blendHere;
          vx.wu = uvRotate ? pv : pu;
          vx.wv = uvRotate ? pu : pv;
          vx.wc = blendOpt.contrast;
          vx.wn = blendOpt.noise;
          vx.wa = 1;
        }
        if (extBlend) {
          const pTiles = plan.parentTiles(r0);
          const pu = tubeU(j / sides, pTiles, plan.uOffset, plan.twist, vHere);
          vx.wb = extVals[i] as number;
          vx.wu = uvRotate ? vHere : pu;
          vx.wv = uvRotate ? pu : vHere;
          vx.wc = extBlend.contrast;
          vx.wn = extBlend.noise;
          vx.wa = extActive[i] as number;
        }
        grid[i * V + j] = vx;
      }
    }

    // The parent's last ring is the first ring of the crotch: its normals lean to the crotch side so no line shows at the join.
    if (crotch) {
      for (let j = 0; j < V; j++) {
        const g = grid[(R - 1) * V + j] as VertexAttrs;
        const lastDir: V3 = [sm.tan[(R - 1) * 3] as number, sm.tan[(R - 1) * 3 + 1] as number, sm.tan[(R - 1) * 3 + 2] as number];
        const cn = leanNormal(crotchRing0Normal(crotch, j), lastDir, crotchSeam ? crotchSeamWeight(0, crotchSeam.radius, crotchSeam.amount) : 0);
        const n = norm([g.nx + cn[0], g.ny + cn[1], g.nz + cn[2]], [g.nx, g.ny, g.nz]);
        g.nx = n[0]; g.ny = n[1]; g.nz = n[2];
      }
    }

    let gridIds: Uint32Array | null = null;
    // --- body triangles (a patch seam is a doubled ring: the quads between the two copies are not drawn)
    const patchOf = (ring: number): number => (plan.patch ? (plan.patch.patch[ring] as number) : 0);
    const materialOf = (patch: number): string => plan.materials[patch] ?? (plan.materials[0] as string);
    setSlot(materialOf(0));
    if (smooth) {
      // T09: the first ring of an extension that continues a split half of this very mesh IS the half's open-end ring: it uses the
      // crotch's vertices by index (positions, normals and UVs continuous, no duplicates); anything else keeps the positional snap.
      const sharedIds =
        isExtension && endRing && ringMatchesHalf && host === sk && !weld && !plan.patch && !extBlend && sm.first === 0
          ? lobeEndVertexIds(sk, b.parentBranch, acc)
          : undefined;
      const shared = sharedIds && sharedIds.length === V ? sharedIds : undefined;
      const vid = new Uint32Array(grid.length);
      gridIds = vid;
      for (let k = 0; k < grid.length; k++) vid[k] = shared && k < V ? (shared[k] as number) : acc.addVertex(grid[k] as VertexAttrs);
      // UV seams: at a whole U tile border the quads on the left of the column use a doubled vertex (same position, normal and wind,
      // U = the integer border), so every tile is a separate island while the surface stays closed in position.
      const left = vid.slice();
      if (plan.createSeams && !plan.patch) {
        for (let i = shared ? 1 : 0; i < R; i++) {
          for (let j = 1; j < sides; j++) {
            const g = grid[i * V + j] as VertexAttrs;
            const uTile = uvRotate ? g.v : g.u;
            if (Math.abs(uTile - Math.round(uTile)) < 1e-6) left[i * V + j] = acc.addVertex(g);
          }
        }
      }
      for (let i = 0; i < R - 1; i++) {
        if (plan.patch && plan.patch.seamStart[i + 1] === 1) continue;
        if (plan.patch) setSlot(materialOf(patchOf(i + 1)));
        for (let j = 0; j < sides; j++) {
          const a0 = vid[i * V + j] as number;
          const a1 = left[i * V + j + 1] as number;
          const b0 = vid[(i + 1) * V + j] as number;
          const b1 = left[(i + 1) * V + j + 1] as number;
          acc.addTriangle(a0, a1, b0);
          acc.addTriangle(a1, b1, b0);
        }
      }
    } else {
      for (let i = 0; i < R - 1; i++) {
        if (plan.patch && plan.patch.seamStart[i + 1] === 1) continue;
        if (plan.patch) setSlot(materialOf(patchOf(i + 1)));
        for (let j = 0; j < sides; j++) {
          const q = [grid[i * V + j], grid[i * V + j + 1], grid[(i + 1) * V + j], grid[(i + 1) * V + j + 1]] as VertexAttrs[];
          const e1: V3 = [q[1]!.px - q[0]!.px, q[1]!.py - q[0]!.py, q[1]!.pz - q[0]!.pz];
          const e2: V3 = [q[2]!.px - q[0]!.px, q[2]!.py - q[0]!.py, q[2]!.pz - q[0]!.pz];
          const avg: V3 = [q[0]!.nx + q[1]!.nx, q[0]!.ny + q[1]!.ny, q[0]!.nz + q[1]!.nz];
          let fn = norm(cross(e1, e2), avg);
          if (dot(fn, avg) < 0) fn = mul(fn, -1);
          const ids = q.map((src) => acc.addVertex({ ...src, nx: fn[0], ny: fn[1], nz: fn[2] }));
          acc.addTriangle(ids[0] as number, ids[1] as number, ids[2] as number);
          acc.addTriangle(ids[1] as number, ids[3] as number, ids[2] as number);
        }
      }
    }

    // --- fused crotch rings (continue the parent's UV: V by arc length, every vertex keeps its U)
    if (crotch) {
      const cb = crotch;
      const lastRing = grid.slice((R - 1) * V, R * V);
      const sLast = sm.s[R - 1] as number;
      const lastRect = plan.patch ? (plan.rects[plan.patch.patch[R - 1] as number] ?? plan.rects[0]) : undefined;
      const lobeEnd = (b2: Branch): { c: V3; t: V3 } => {
        const e = (b2.start + b2.count - 1) * 3;
        const q = (b2.start + b2.count - 2) * 3;
        return {
          c: [sk.position[e] as number, sk.position[e + 1] as number, sk.position[e + 2] as number],
          t: norm([(sk.position[e] as number) - (sk.position[q] as number), (sk.position[e + 1] as number) - (sk.position[q + 1] as number), (sk.position[e + 2] as number) - (sk.position[q + 2] as number)]),
        };
      };
      const [e1, e2] = [lobeEnd((lobePair as [Branch, Branch])[0]), lobeEnd((lobePair as [Branch, Branch])[1])];
      const lobeCaps: CrotchCaps = {
        centre: [e1.c, e2.c],
        direction: [e1.t, e2.t],
        radius: [sk.radius[(lobePair as [Branch, Branch])[0].start + (lobePair as [Branch, Branch])[0].count - 1] as number, sk.radius[(lobePair as [Branch, Branch])[1].start + (lobePair as [Branch, Branch])[1].count - 1] as number],
        rings: tipRings,
        rotate: uvRotate,
        tipSlope: plan.tipSlope,
        confined: plan.confined,
      };
      const crotchEmit: CrotchEmit = {
        build: cb,
        lastRing,
        uv: (code, ring) => {
          const vHere = ring === 0 ? (plan.vRing[R - 1] as number) : plan.vAt(sLast + (cb.arc[ring] as number));
          let u = tubeU(code / sides, uTiles, plan.uOffset, plan.twist, vHere);
          let v = vHere;
          if (lastRect) [u, v] = remapToRect(lastRect, code / sides, vHere);
          return uvRotate ? [v, u] : [u, v];
        },
        u1: (code) => (cx + code / sides) / cells,
        // Wind: from the parent's last ring into each half's own weights (the halves inherit the parent's wind at the fork)
        wind: (ring, lobe) => {
          const pr = lastRing[0] as VertexAttrs;
          const lb = (lobePair as [Branch, Branch])[lobe];
          const at = lb.start + Math.min(lb.count - 1, ring);
          const half: WindTuple = [0, 1, 2, 3, 4].map((c) => ((wind[c] as Float32Array)[at] as number)) as WindTuple;
          return blendCrotchWind([pr.w0, pr.w1, pr.w2, pr.w3, pr.w4], half, ring, cb.mesh.rings);
        },
        // T09: the vertex colour blends from the parent's last ring into each half's own colour with the crotch smoothstep.
        color: (ring, lobe) => {
          const pr = lastRing[0] as VertexAttrs;
          const lb = (lobePair as [Branch, Branch])[lobe];
          const own = opts.color(lb.generation, 0);
          const shade = tintMul * pr.ao;
          const w = crotchBlend(ring / Math.max(1, cb.mesh.rings - 1));
          return [pr.r + (own[0] * shade - pr.r) * w, pr.g + (own[1] * shade - pr.g) * w, pr.b + (own[2] * shade - pr.b) * w];
        },
        ...(gridIds ? { ring0Id: (code: number): number => (gridIds as Uint32Array)[(R - 1) * V + code] as number } : {}),
        ...(crotchSeam ? { seam: crotchSeam } : {}),
      };
      // The halves continue the crotch: half of the U tiles each, V from the end of the shared body.
      const sides1 = splitParents.get(bi);
      if (sides1 && !plan.patch) {
        const vEnd = plan.vAt(sLast + (cb.arc[cb.mesh.rings - 1] as number));
        const m1 = splitHalfMapping(uTiles, plan.uOffset, cb.phase, sides, 1);
        const m2 = splitHalfMapping(uTiles, plan.uOffset, cb.phase, sides, 2);
        if (m1) lobeUv.set(sides1.side1, { ...m1, vEnd });
        if (m2) lobeUv.set(sides1.side2, { ...m2, vEnd });
      }
      publishLobeEndVertices(sk, [(lobePair as [Branch, Branch])[0].id, (lobePair as [Branch, Branch])[1].id], emitCrotch(acc, crotchEmit));
      if (opts.capEnd !== false) emitCrotchCaps(acc, crotchEmit, lobeCaps);
    }

    // --- tip dome
    if (opts.capEnd !== false && !crotch) {
      setSlot(materialOf(plan.materials.length - 1));
      emitTipDome(acc, grid, sm, R, V, sides, tipRings, { rotate: uvRotate, tipSlope: plan.tipSlope, confined: plan.confined });
    }
    // --- flat base cap
    const capStart = opts.capStart === undefined || opts.capStart === 'auto' ? !attached : opts.capStart;
    if (capStart) {
      setSlot(materialOf(0));
      emitBaseCap(acc, grid, sm, V, sides, plan.patch ? (plan.rects[0] ?? WHOLE_MAP) : WHOLE_MAP);
    }
  }
  return acc.build(opts.materialId, true);
}

function emitTipDome(
  acc: MeshAccumulator,
  grid: VertexAttrs[],
  sm: Samples,
  R: number,
  V: number,
  sides: number,
  rings: number,
  uv: { rotate: boolean; tipSlope: number; confined: boolean },
): void {
  const last = R - 1;
  const P: V3 = [sm.pos[last * 3] as number, sm.pos[last * 3 + 1] as number, sm.pos[last * 3 + 2] as number];
  const T: V3 = [sm.tan[last * 3] as number, sm.tan[last * 3 + 1] as number, sm.tan[last * 3 + 2] as number];
  const rEnd = sm.rad[last] as number;
  const h = Math.max(rEnd * 0.6, 1e-4);
  const ref = grid[last * V] as VertexAttrs;
  const vStep = uv.tipSlope * h;
  const apexShift = uv.confined ? 0 : 0.5;
  let prev: number[] = [];
  for (let k = 0; k < rings; k++) {
    const phi = (k / rings) * (Math.PI / 2);
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    const cur: number[] = [];
    for (let j = 0; j < V; j++) {
      const src = grid[last * V + j] as VertexAttrs;
      const rel: V3 = [src.px - P[0], src.py - P[1], src.pz - P[2]];
      const rl = len(rel) || 1;
      const rad: V3 = [rel[0] / rl, rel[1] / rl, rel[2] / rl];
      const n = norm([rad[0] * c * h + T[0] * sn * rl, rad[1] * c * h + T[1] * sn * rl, rad[2] * c * h + T[2] * sn * rl], T);
      const vv: VertexAttrs = {
        ...src,
        px: P[0] + rel[0] * c + T[0] * sn * h,
        py: P[1] + rel[1] * c + T[1] * sn * h,
        pz: P[2] + rel[2] * c + T[2] * sn * h,
        nx: n[0], ny: n[1], nz: n[2],
        v: uv.rotate ? src.v : src.v + vStep * (k / rings),
        u: uv.rotate ? src.u + vStep * (k / rings) : src.u,
        ao: src.ao,
      };
      cur.push(acc.addVertex(vv));
    }
    if (prev.length) {
      for (let j = 0; j < sides; j++) {
        acc.addTriangle(prev[j] as number, prev[j + 1] as number, cur[j] as number);
        acc.addTriangle(prev[j + 1] as number, cur[j + 1] as number, cur[j] as number);
      }
    }
    prev = cur;
  }
  const apex = acc.addVertex({
    ...ref,
    px: P[0] + T[0] * h, py: P[1] + T[1] * h, pz: P[2] + T[2] * h,
    nx: T[0], ny: T[1], nz: T[2],
    u: uv.rotate ? ref.u + vStep : ref.u + apexShift,
    v: uv.rotate ? ref.v + apexShift : ref.v + vStep,
    tw: 1,
  });
  for (let j = 0; j < sides; j++) acc.addTriangle(prev[j] as number, prev[j + 1] as number, apex);
}

function emitBaseCap(acc: MeshAccumulator, grid: VertexAttrs[], sm: Samples, V: number, sides: number, rect: UvRect): void {
  const P: V3 = [sm.pos[0] as number, sm.pos[1] as number, sm.pos[2] as number];
  const T: V3 = [sm.tan[0] as number, sm.tan[1] as number, sm.tan[2] as number];
  const ref = grid[0] as VertexAttrs;
  const [cu, cv] = remapToRect(rect, 0.5, 0.5);
  const center = acc.addVertex({ ...ref, px: P[0], py: P[1], pz: P[2], nx: -T[0], ny: -T[1], nz: -T[2], u: cu, v: cv, tw: 1 });
  const ring: number[] = [];
  for (let j = 0; j < V; j++) {
    const src = grid[j] as VertexAttrs;
    const a = (2 * Math.PI * (j % sides)) / sides;
    const [ru, rv] = remapToRect(rect, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a));
    ring.push(acc.addVertex({ ...src, nx: -T[0], ny: -T[1], nz: -T[2], u: ru, v: rv }));
  }
  for (let j = 0; j < sides; j++) acc.addTriangle(center, ring[j + 1] as number, ring[j] as number);
}
