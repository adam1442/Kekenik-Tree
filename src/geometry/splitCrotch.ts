/**
 * Glue between the skeleton of a split (a parent branch + two lobe branches) and the pure fused crotch mesh
 * (`generators/split/crotchMesh`): finds the lobes, truncates the parent at the start of the shared transition, aligns the ring phase
 * so two vertices sit on the pinch axis, and emits the crotch rings as part of the parent's skin.
 */
import type { Branch, Skeleton } from '@/contracts/skeleton';
import {
  SPLIT_ATTR,
  SPLIT_EXPAND_ATTR,
  SPLIT_SMOOTH_INNER_ATTR,
  SPLIT_SMOOTH_OUTER_ATTR,
  SPLIT_SHAPE_ATTRS,
  NEUTRAL_SPLIT_SHAPE,
  type SplitShape,
  SplitFlag,
  buildCrotchMesh,
  crotchSeamWeight,
  crotchVertexIndex,
  type CrotchMesh,
  type CrotchGridView,
} from '@/generators/split';
import { leanNormal } from '@/generators/skin/seam';
import { cross, dot, len, norm, rotate, sub, type V3 } from './math3';
import type { EndRing } from './ringSnap';
import type { DisplaceOut } from '@/generators/displace';
import type { MeshAccumulator, VertexAttrs } from './meshAccumulator';
import { windPhase1OfTuple, type WindTuple } from './windAttributes';

/** Branch indices of the two lobes of one splitting parent and how much of the parent is kept (points). */
export interface SplitLobeBranches {
  side1: number;
  side2: number;
  /** Number of parent points that stay (the last one is replaced by the start of the shared transition). */
  keep: number;
}

const smooth01 = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Parents (by branch index) that carry a complete split: both lobes present with equal ring counts, attached on the parent. */
export function findSplitLobes(sk: Skeleton): Map<number, SplitLobeBranches> {
  const out = new Map<number, SplitLobeBranches>();
  const flags = sk.attributes.get(SPLIT_ATTR);
  if (!flags) return out;
  const byId = new Map<number, number>();
  sk.branches.forEach((b, i) => byId.set(b.id, i));
  const found = new Map<number, { s1?: number; s2?: number }>();
  sk.branches.forEach((b, i) => {
    const f = Math.round(flags[b.start] ?? 0);
    const side = (f & SplitFlag.Side1) !== 0 ? 1 : (f & SplitFlag.Side2) !== 0 ? 2 : 0;
    if (side === 0 || b.parentBranch < 0 || b.count < 3) return;
    const pi = byId.get(b.parentBranch);
    if (pi === undefined) return;
    const entry = found.get(pi) ?? {};
    if (side === 1) entry.s1 = i;
    else entry.s2 = i;
    found.set(pi, entry);
  });
  for (const [pi, e] of found) {
    if (e.s1 === undefined || e.s2 === undefined) continue;
    const parent = sk.branches[pi] as Branch;
    const l1 = sk.branches[e.s1] as Branch;
    const l2 = sk.branches[e.s2] as Branch;
    if (((flags[parent.start] ?? 0) & SplitFlag.Parent) === 0 || l1.count !== l2.count) continue;
    const idx = l1.parentPoint - parent.start;
    if (idx < 0 || idx + 1 > parent.count - 1 || l1.parentPoint !== l2.parentPoint) continue;
    out.set(pi, { side1: e.s1, side2: e.s2, keep: idx + 2 });
  }
  return out;
}

/** The parent point replacing the last kept one: the start of the transition (ring 0 of both lobes) and its radius. */
export function transitionStart(sk: Skeleton, parent: Branch, lobe: Branch, keep: number): { pos: V3; rad: number } {
  const g = lobe.start * 3;
  const pos: V3 = [sk.position[g] as number, sk.position[g + 1] as number, sk.position[g + 2] as number];
  const i0 = parent.start + keep - 2;
  const a: V3 = [sk.position[i0 * 3] as number, sk.position[i0 * 3 + 1] as number, sk.position[i0 * 3 + 2] as number];
  const b: V3 = [sk.position[(i0 + 1) * 3] as number, sk.position[(i0 + 1) * 3 + 1] as number, sk.position[(i0 + 1) * 3 + 2] as number];
  const seg = len(sub(b, a));
  const f = seg > 1e-12 ? Math.min(1, Math.max(0, len(sub(pos, a)) / seg)) : 0;
  const r0 = sk.radius[i0] as number;
  const r1 = sk.radius[i0 + 1] as number;
  return { pos, rad: r0 + (r1 - r0) * f };
}

export interface CrotchAlignment {
  /** Parent vertex number that sits on the pinch axis (outline column 0 = parent vertex `phase`). */
  phase: number;
  /** Roll (radians) applied to the last ring, spread over the preceding rings. */
  roll: number;
  /** Unit divergence axis (towards lobe 1). */
  divergence: V3;
}

/**
 * Phase alignment: the parent's ring frame is rolled by less than one vertex spacing (smoothly over the last rings, never snapping
 * the divergence axis to a vertex) so a pair of opposite vertices lies exactly on the pinch axis `divergence x tangent`.
 * `frames` (ring normals) are modified in place.
 */
export function alignCrotchPhase(tan: Float32Array, frames: V3[], count: number, lobeEnd1: V3, lobeEnd2: V3, sides: number): CrotchAlignment {
  const last = count - 1;
  const T: V3 = [tan[last * 3] as number, tan[last * 3 + 1] as number, tan[last * 3 + 2] as number];
  const diff = sub(lobeEnd1, lobeEnd2);
  const d = norm(sub(diff, [T[0] * dot(diff, T), T[1] * dot(diff, T), T[2] * dot(diff, T)]), [1, 0, 0]);
  const y0 = cross(d, T);
  const N = frames[last] as V3;
  const B = cross(T, N);
  const phi = Math.atan2(dot(y0, B), dot(y0, N));
  const step = (2 * Math.PI) / sides;
  const jStar = Math.round(phi / step);
  const roll = phi - jStar * step;
  const ia = Math.max(0, last - 8);
  for (let i = ia; i <= last; i++) {
    const w = smooth01((i - ia) / Math.max(1, last - ia));
    const Ti: V3 = [tan[i * 3] as number, tan[i * 3 + 1] as number, tan[i * 3 + 2] as number];
    frames[i] = rotate(frames[i] as V3, Ti, roll * w);
  }
  return { phase: ((jStar % sides) + sides) % sides, roll, divergence: d };
}

export interface CrotchBuild {
  mesh: CrotchMesh;
  phase: number;
  sides: number;
  /** Distance of every crotch ring from ring 0 along the shared axis (metres). */
  arc: Float64Array;
}

/** One crotch vertex handed to the displacement callback. */
export interface CrotchDisplaceSample {
  ring: number;
  rings: number;
  /** Outline column (0 .. N - 1). */
  column: number;
  /** Parent vertex number the column continues (`(column + phase) mod N`): the pattern coordinate of the parent. */
  parentVertex: number;
  /** Distance of the ring from ring 0 along the shared axis (metres). */
  arc: number;
  /** Half the column belongs to (0 = columns 0 .. N / 2 - 1). */
  lobe: 0 | 1;
}

export type CrotchDisplaceFn = (sample: CrotchDisplaceSample, out: DisplaceOut) => void;

/**
 * Displaces crotch rings 1 .. last in place. Every vertex moves along its outward outline normal (ring tangent x axis, away from the
 * ring centroid) and along the shared axis; ring 0 is the parent's already displaced ring and never moves. All offsets are evaluated
 * on the undisplaced positions, so the result does not depend on the visiting order.
 */
export function applyCrotchDisplacement(grid: CrotchGridView, arc: Float64Array, phase: number, fn: CrotchDisplaceFn): void {
  const { sides: N, rings, positions: P, vertexRing, vertexColumn, vertexCount } = grid;
  const orig = Float32Array.from(P);
  const centre = new Float64Array(rings * 3);
  const count = new Uint32Array(rings);
  for (let v = 0; v < vertexCount; v++) {
    const k = vertexRing[v] as number;
    for (let a = 0; a < 3; a++) centre[k * 3 + a] = (centre[k * 3 + a] as number) + (orig[v * 3 + a] as number);
    count[k] = (count[k] as number) + 1;
  }
  for (let k = 0; k < rings; k++) for (let a = 0; a < 3; a++) centre[k * 3 + a] = (centre[k * 3 + a] as number) / Math.max(1, count[k] as number);
  const at = (v: number): V3 => [orig[v * 3] as number, orig[v * 3 + 1] as number, orig[v * 3 + 2] as number];
  const c = (k: number): V3 => [centre[k * 3] as number, centre[k * 3 + 1] as number, centre[k * 3 + 2] as number];
  const out: DisplaceOut = { radial: 0, along: 0, normal: 0 };
  for (let v = 0; v < vertexCount; v++) {
    const k = vertexRing[v] as number;
    if (k === 0) continue;
    const j = vertexColumn[v] as number;
    const p = at(v);
    const tg = sub(at(crotchVertexIndex(N, rings, k, j + 1)), at(crotchVertexIndex(N, rings, k, j - 1)));
    const axis = norm(sub(c(Math.min(rings - 1, k + 1)), c(Math.max(0, k - 1))), [0, 0, 1]);
    let n = norm(cross(tg, axis), sub(p, c(k)));
    if (dot(n, sub(p, c(k))) < 0) n = [-n[0], -n[1], -n[2]];
    out.radial = 0;
    out.along = 0;
    out.normal = 0;
    fn({ ring: k, rings, column: j, parentVertex: (j + phase) % N, arc: arc[k] as number, lobe: j < N / 2 ? 0 : 1 }, out);
    const d = out.normal + out.radial;
    for (let a = 0; a < 3; a++) P[v * 3 + a] = (p[a] as number) + (n[a] as number) * d + (axis[a] as number) * out.along;
  }
}

/** Builds the crotch mesh from the lobe skeleton paths; `lastRing` = the parent's real last ring (`gp` of ring R - 1). */
export function buildSplitCrotch(
  sk: Skeleton,
  lobes: [Branch, Branch],
  sides: number,
  startTangent: V3,
  align: CrotchAlignment,
  parentRadius: number,
  lastRing: (parentVertex: number) => V3,
  displace?: CrotchDisplaceFn,
): CrotchBuild {
  const [l1, l2] = lobes;
  const c1 = sk.position.subarray(l1.start * 3, (l1.start + l1.count) * 3);
  const c2 = sk.position.subarray(l2.start * 3, (l2.start + l2.count) * 3);
  const tangentAt = (b: Branch, from: number, to: number): V3 =>
    norm(
      [
        (sk.position[(b.start + to) * 3] as number) - (sk.position[(b.start + from) * 3] as number),
        (sk.position[(b.start + to) * 3 + 1] as number) - (sk.position[(b.start + from) * 3 + 1] as number),
        (sk.position[(b.start + to) * 3 + 2] as number) - (sk.position[(b.start + from) * 3 + 2] as number),
      ],
      startTangent,
    );
  const ring0 = new Float64Array(sides * 3);
  for (let j = 0; j < sides; j++) {
    const v = lastRing((j + align.phase) % sides);
    ring0[j * 3] = v[0];
    ring0[j * 3 + 1] = v[1];
    ring0[j * 3 + 2] = v[2];
  }
  const attr = (name: string, b: Branch, fallback: number): number => {
    const v = sk.attributes.get(name)?.[b.start];
    return v !== undefined && v > 0 ? v : fallback;
  };
  const shape: SplitShape = { ...NEUTRAL_SPLIT_SHAPE };
  for (const { key, attr: name } of SPLIT_SHAPE_ATTRS) shape[key] = attr(name, l1, NEUTRAL_SPLIT_SHAPE[key]);
  const arc = new Float64Array(l1.count);
  for (let k = 1; k < l1.count; k++) {
    const mid = (c: ArrayLike<number>, i: number, a: number): number => (c[i * 3 + a] as number);
    let d = 0;
    for (let a = 0; a < 3; a++) {
      const m1 = (mid(c1, k, a) + mid(c2, k, a)) / 2;
      const m0 = (mid(c1, k - 1, a) + mid(c2, k - 1, a)) / 2;
      d += (m1 - m0) * (m1 - m0);
    }
    arc[k] = (arc[k - 1] as number) + Math.sqrt(d);
  }
  const mesh = buildCrotchMesh({
    shape,
    sides,
    rings: l1.count,
    centre1: c1,
    centre2: c2,
    radius0: parentRadius,
    radius1: sk.radius[l1.start + l1.count - 1] as number,
    radius2: sk.radius[l2.start + l2.count - 1] as number,
    expand1: attr(SPLIT_EXPAND_ATTR, l1, 1),
    expand2: attr(SPLIT_EXPAND_ATTR, l2, 1),
    startTangent,
    endTangent1: tangentAt(l1, l1.count - 2, l1.count - 1),
    endTangent2: tangentAt(l2, l2.count - 2, l2.count - 1),
    divergence: align.divergence,
    innerSmooth: attr(SPLIT_SMOOTH_INNER_ATTR, l1, 0),
    outerSmooth: attr(SPLIT_SMOOTH_OUTER_ATTR, l1, 0),
    phase: align.phase,
    ring0Positions: ring0,
    ...(displace ? { displace: (g: CrotchGridView): void => applyCrotchDisplacement(g, arc, align.phase, displace) } : {}),
  });
  return { mesh, phase: align.phase, sides, arc };
}

/**
 * End rings of the split halves of a skeleton, by lobe branch id. The mesher of the splitting parent publishes them; the mesher of
 * an extension / cap that continues a half reads them (same hand-over as the U attributes: the child is meshed after its parent
 * from the very same skeleton object). A missing entry just means the extension keeps its own regular ring.
 */
const lobeEndRings = new WeakMap<Skeleton, Map<number, EndRing>>();

/** Publishes the real last ring of both halves (N / 2 vertices each, in ring order) of a built crotch. */
export function publishLobeEndRings(sk: Skeleton, build: CrotchBuild, lobeIds: readonly [number, number], winds?: readonly [WindTuple, WindTuple]): void {
  const { mesh } = build;
  const N = mesh.sides;
  const half = N / 2;
  const last = mesh.rings - 1;
  let table = lobeEndRings.get(sk);
  if (!table) {
    table = new Map<number, EndRing>();
    lobeEndRings.set(sk, table);
  }
  for (let lobe = 0; lobe < 2; lobe++) {
    const ring = new Float32Array(half * 3);
    for (let i = 0; i < half; i++) {
      const v = crotchVertexIndex(N, mesh.rings, last, lobe * half + i) * 3;
      ring[i * 3] = mesh.positions[v] as number;
      ring[i * 3 + 1] = mesh.positions[v + 1] as number;
      ring[i * 3 + 2] = mesh.positions[v + 2] as number;
    }
    table.set(lobeIds[lobe] as number, ring);
    const w = winds?.[lobe];
    if (w) {
      let wt = lobeEndWinds.get(sk);
      if (!wt) {
        wt = new Map<number, WindTuple>();
        lobeEndWinds.set(sk, wt);
      }
      wt.set(lobeIds[lobe] as number, w);
    }
  }
}

/** Wind (w0, w1, w2, phase, phase1) of the end ring of a split half: the first ring of an extension / cap copies it exactly. */
const lobeEndWinds = new WeakMap<Skeleton, Map<number, WindTuple>>();

export function lobeEndWind(sk: Skeleton, lobeBranchId: number): WindTuple | undefined {
  return lobeEndWinds.get(sk)?.get(lobeBranchId);
}

/**
 * Pattern frame a half hands to the extension that continues it (T09): the displacement of the extension uses the splitting parent's
 * lineage, arc length, circumference and U coordinate, so the bark flows from the parent through the crotch into the extension.
 */
export interface LobeContinuation {
  /** Bark lineage key and the branch id of the pattern noise (the splitting parent's). */
  lineage: number;
  branch: number;
  /** Circumference (metres) and U tile count of the parent's pattern, and its U offset. */
  circumference: number;
  uTiles: number;
  uOffset: number;
  /** Arc length (parent coordinates) at the open end and the lineage offset of the parent. */
  sEnd: number;
  sOff: number;
  /** Pattern U (0..1, parent coordinates, periodic) of the half's first vertex and the span the half's ring covers. */
  u0: number;
  span: number;
  /** true when the crotch's open-end ring really carries the displacement (otherwise the extension keeps its own fade-in). */
  displaced: boolean;
}

const lobeContinuations = new WeakMap<Skeleton, Map<number, LobeContinuation>>();
const lobeEndVertices = new WeakMap<Skeleton, Map<number, { acc: MeshAccumulator; ids: Uint32Array }>>();

export function publishLobeContinuation(sk: Skeleton, lobeBranchId: number, c: LobeContinuation): void {
  let t = lobeContinuations.get(sk);
  if (!t) {
    t = new Map<number, LobeContinuation>();
    lobeContinuations.set(sk, t);
  }
  t.set(lobeBranchId, c);
}

export function lobeContinuation(sk: Skeleton, lobeBranchId: number): LobeContinuation | undefined {
  return lobeContinuations.get(sk)?.get(lobeBranchId);
}

/** Publishes the vertex ids of the open-end rings (see {@link CrotchEndIds}) so an extension in the same accumulator can share them. */
export function publishLobeEndVertices(sk: Skeleton, lobeIds: readonly [number, number], ends: CrotchEndIds): void {
  let t = lobeEndVertices.get(sk);
  if (!t) {
    t = new Map<number, { acc: MeshAccumulator; ids: Uint32Array }>();
    lobeEndVertices.set(sk, t);
  }
  t.set(lobeIds[0], { acc: ends.acc, ids: ends.ids[0] });
  t.set(lobeIds[1], { acc: ends.acc, ids: ends.ids[1] });
}

/** Vertex ids (`half + 1`, the last is the seam copy) of the half's open-end ring when the crotch was emitted into `acc`. */
export function lobeEndVertexIds(sk: Skeleton, lobeBranchId: number, acc: MeshAccumulator): Uint32Array | undefined {
  const hit = lobeEndVertices.get(sk)?.get(lobeBranchId);
  return hit && hit.acc === acc ? hit.ids : undefined;
}

/** The published end ring of a split half (branch id), if its parent was meshed from this skeleton. */
export function lobeEndRing(sk: Skeleton, lobeBranchId: number): EndRing | undefined {
  return lobeEndRings.get(sk)?.get(lobeBranchId);
}

/** Parent-ring column of the crotch's ring 0 for parent vertex `p` (0 .. N). */
const columnOfParent = (p: number, phase: number, sides: number): number => (((p % sides) - phase) % sides + sides) % sides;

/** Smooth normal at ring 0 for parent vertex `p`: used to blend the parent's last-ring normals (no seam where the crotch starts). */
export function crotchRing0Normal(build: CrotchBuild, p: number): V3 {
  const v = crotchVertexIndex(build.sides, build.mesh.rings, 0, columnOfParent(p, build.phase, build.sides)) * 3;
  const n = build.mesh.normals;
  return [n[v] as number, n[v + 1] as number, n[v + 2] as number];
}

export interface CrotchEmit {
  build: CrotchBuild;
  /** Vertices of the parent's last ring (one per parent vertex number 0 .. N, N = the seam copy; normals already blended). */
  lastRing: VertexAttrs[];
  /** Final (u, v) of a corner with the given U code at the given crotch ring. */
  uv(code: number, ring: number): [number, number];
  /** Unique-cell texture coordinate u1 for a U code. */
  u1(code: number): number;
  /** Vertex id of the parent's last ring for a U code (smooth skins): crotch ring 0 then shares those vertices instead of duplicating them. */
  ring0Id?(code: number): number;
  /** Light seam reduction: normals of the crotch rings lean toward the axis (`amount` 0..1, `radius` = parent radius). */
  seam?: { amount: number; radius: number };
  /**
   * Wind channels (w0, w1, w2, phase) of crotch ring `ring` on half `lobe` (0 = columns 0 .. N/2 - 1, 1 = the rest). Default: every ring
   * copies the parent's last ring. Ring 0 always keeps the parent's values; the last ring must equal the half's end so an extension
   * that continues it moves with it.
   */
  wind?(ring: number, lobe: 0 | 1): WindTuple;
  /** Vertex colour of crotch ring `ring` on half `lobe` (T09: blended from the parent's last ring to the lobe's own colour). */
  color?(ring: number, lobe: 0 | 1): readonly [number, number, number];
}

/** Vertex ids of the open-end ring of each half as the crotch emitted them: `half + 1` entries (the last one is the seam copy). */
export interface CrotchEndIds {
  acc: MeshAccumulator;
  ids: [Uint32Array, Uint32Array];
}

/** Smoothstep used for the crotch geometry and for the wind blend from the parent's last ring to the half's own wind. */
export const crotchBlend = smooth01;

/** Wind of crotch ring `ring` (of `rings`): blends the parent's last-ring wind into the half's wind with the crotch smoothstep. */
export function blendCrotchWind(
  parentRing: WindTuple,
  half: WindTuple,
  ring: number,
  rings: number,
): [number, number, number, number, number] {
  const w = ring <= 0 ? 0 : ring >= rings - 1 ? 1 : smooth01(ring / (rings - 1));
  const m = (a: number, b: number): number => a + (b - a) * w;
  // Phases are per-level constants (never interpolated): the level-1 phase is the half's own, which equals the parent's at the fork.
  return [m(parentRing[0], half[0]), m(parentRing[1], half[1]), m(parentRing[2], half[2]), m(parentRing[3], half[3]), windPhase1OfTuple(half)];
}

/**
 * Emits the crotch rings as new vertices (ring 0 duplicates the parent's last ring: same position, same blended normal) and the
 * triangles that connect them. Corners that share a vertex but need a different U (seam, crotch) get their own copy.
 */
export function emitCrotch(acc: MeshAccumulator, ctx: CrotchEmit): CrotchEndIds {
  const { mesh } = ctx.build;
  const N = mesh.sides;
  const P = mesh.positions;
  const ids = new Map<number, number>();
  const ref = ctx.lastRing[0] as VertexAttrs;
  const ringPos = (k: number, j: number): V3 => {
    const v = crotchVertexIndex(N, mesh.rings, k, j) * 3;
    return [P[v] as number, P[v + 1] as number, P[v + 2] as number];
  };
  // Axis direction of every ring (centroid difference) for the light seam reduction.
  const axis = new Float64Array(mesh.rings * 3);
  if (ctx.seam) {
    const centre = (k: number): V3 => {
      let x = 0, y = 0, z = 0;
      for (let j = 0; j < N; j++) {
        const p = ringPos(k, j);
        x += p[0]; y += p[1]; z += p[2];
      }
      return [x / N, y / N, z / N];
    };
    for (let k = 0; k < mesh.rings; k++) {
      const t = norm(sub(centre(Math.min(mesh.rings - 1, k + 1)), centre(Math.max(0, k - 1))), [0, 0, 1]);
      axis[k * 3] = t[0]; axis[k * 3 + 1] = t[1]; axis[k * 3 + 2] = t[2];
    }
  }
  const arcEnd = ctx.build.arc[mesh.rings - 1] as number;
  const make = (vertex: number, code: number, corner: number): number => {
    const k = mesh.vertexRing[vertex] as number;
    if (k === 0 && ctx.ring0Id) return ctx.ring0Id(code);
    const fan = mesh.cornerFan[corner] as number;
    const key = (vertex * (N + 2) + code) * 7 + fan;
    const hit = ids.get(key);
    if (hit !== undefined) return hit;
    const j = mesh.vertexColumn[vertex] as number;
    const at = vertex * 3;
    let n: V3 = fan > 0 ? [mesh.cornerNormals[corner * 3] as number, mesh.cornerNormals[corner * 3 + 1] as number, mesh.cornerNormals[corner * 3 + 2] as number] : [mesh.normals[at] as number, mesh.normals[at + 1] as number, mesh.normals[at + 2] as number];
    if (k === 0) {
      const src = ctx.lastRing[code] as VertexAttrs;
      n = [src.nx, src.ny, src.nz];
    } else if (ctx.seam) {
      const w = crotchSeamWeight(ctx.build.arc[k] as number, ctx.seam.radius, ctx.seam.amount, arcEnd);
      n = leanNormal(n, [axis[k * 3] as number, axis[k * 3 + 1] as number, axis[k * 3 + 2] as number], w);
    }
    // Tangent along the ring (increasing column) and handedness against the direction along the axis.
    const dPu = sub(ringPos(k, j + 1), ringPos(k, j - 1));
    const dPv = sub(ringPos(Math.min(mesh.rings - 1, k + 1), j), ringPos(Math.max(0, k - 1), j));
    const tg = norm(sub(dPu, [n[0] * dot(dPu, n), n[1] * dot(dPu, n), n[2] * dot(dPu, n)]), [1, 0, 0]);
    const bit = cross(n, tg);
    const [u, v] = ctx.uv(code, k);
    const wv = k > 0 && ctx.wind ? ctx.wind(k, j < N / 2 ? 0 : 1) : undefined;
    const col = k > 0 && ctx.color ? ctx.color(k, j < N / 2 ? 0 : 1) : undefined;
    const vx: VertexAttrs = {
      ...ref,
      ...(wv ? windOf(wv) : {}),
      ...(col ? { r: col[0], g: col[1], b: col[2] } : {}),
      px: P[at] as number, py: P[at + 1] as number, pz: P[at + 2] as number,
      ao: ref.ao * (mesh.valleyAo[vertex] as number),
      nx: n[0], ny: n[1], nz: n[2],
      tx: tg[0], ty: tg[1], tz: tg[2], tw: dot(bit, dPv) >= 0 ? 1 : -1,
      u, v,
      u1: ctx.u1(code),
    };
    const id = acc.addVertex(vx);
    ids.set(key, id);
    return id;
  };
  const half = N / 2;
  const lastRow = (mesh.rings - 2) * N;
  const starts = new Uint32Array(N);
  const finishes = new Uint32Array(N);
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = make(mesh.indices[t] as number, mesh.cornerU[t] as number, t);
    const b = make(mesh.indices[t + 1] as number, mesh.cornerU[t + 1] as number, t + 1);
    const c = make(mesh.indices[t + 2] as number, mesh.cornerU[t + 2] as number, t + 2);
    acc.addTriangle(a, b, c);
    const quad = Math.floor(t / 6) - lastRow;
    if (quad >= 0 && quad < N) {
      // Quad [a0, a1, b0 | a1, b1, b0]: b0 / b1 are the open-end ring vertices of columns `quad` / `quad + 1`.
      if (t % 6 === 0) starts[quad] = c;
      else finishes[quad] = b;
    }
  }
  const lobeIds = (lobe: 0 | 1): Uint32Array => {
    const out = new Uint32Array(half + 1);
    for (let i = 0; i < half; i++) out[i] = starts[lobe * half + i] as number;
    out[half] = finishes[lobe * half + half - 1] as number;
    return out;
  };
  return { acc, ids: [lobeIds(0), lobeIds(1)] };
}

const windOf = (w: WindTuple): Pick<VertexAttrs, 'w0' | 'w1' | 'w2' | 'w3' | 'w4'> => ({ w0: w[0], w1: w[1], w2: w[2], w3: w[3], w4: windPhase1OfTuple(w) });

export interface CrotchCaps {
  /** Centre and unit direction of each lobe's open end (the last ring of the lobe paths). */
  centre: [V3, V3];
  direction: [V3, V3];
  radius: [number, number];
  rings: number;
  rotate: boolean;
  tipSlope: number;
  confined: boolean;
}

/**
 * Closes the two open ends with the same dome the tube mesher puts on a tip, so a split without an Extend parent has no holes. An
 * extension that continues the open end covers the dome exactly like it covered the old lobe tip.
 */
export function emitCrotchCaps(acc: MeshAccumulator, ctx: CrotchEmit, caps: CrotchCaps): void {
  const { mesh } = ctx.build;
  const N = mesh.sides;
  const last = mesh.rings - 1;
  const half = N / 2;
  const ref = ctx.lastRing[0] as VertexAttrs;
  for (const lobe of [0, 1] as const) {
    const P = caps.centre[lobe];
    const T = caps.direction[lobe];
    const h = Math.max(caps.radius[lobe] * 0.6, 1e-4);
    const vStep = caps.tipSlope * h;
    const columnOf = (i: number): number => (lobe === 0 ? i : half + i);
    const cache = new Map<number, number>();
    const domeVertex = (k: number, i: number, code: number): number => {
      const key = (k * (half + 1) + i) * (N + 2) + code;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const base = crotchVertexIndex(N, mesh.rings, last, columnOf(i)) * 3;
      const rel: V3 = [(mesh.positions[base] as number) - P[0], (mesh.positions[base + 1] as number) - P[1], (mesh.positions[base + 2] as number) - P[2]];
      const rl = len(rel) || 1;
      const rad: V3 = [rel[0] / rl, rel[1] / rl, rel[2] / rl];
      const phi = (k / caps.rings) * (Math.PI / 2);
      const c = Math.cos(phi);
      const sn = Math.sin(phi);
      const n = norm([rad[0] * c * h + T[0] * sn * rl, rad[1] * c * h + T[1] * sn * rl, rad[2] * c * h + T[2] * sn * rl], T);
      const [u0, v0] = ctx.uv(code, last);
      const id = acc.addVertex({
        ...ref,
        ...(ctx.wind ? windOf(ctx.wind(last, lobe)) : {}),
        px: P[0] + rel[0] * c + T[0] * sn * h,
        py: P[1] + rel[1] * c + T[1] * sn * h,
        pz: P[2] + rel[2] * c + T[2] * sn * h,
        nx: n[0], ny: n[1], nz: n[2],
        u: caps.rotate ? u0 + vStep * (k / caps.rings) : u0,
        v: caps.rotate ? v0 : v0 + vStep * (k / caps.rings),
        u1: ctx.u1(code),
      });
      cache.set(key, id);
      return id;
    };
    const codes = (i: number): [number, number] => {
      let a = columnOf(i) + ctx.build.phase;
      if (a >= N) a -= N;
      return [a, a + 1];
    };
    let apex = -1;
    for (let i = 0; i < half; i++) {
      const [ca, cb] = codes(i);
      for (let k = 0; k < caps.rings - 1; k++) {
        const p0 = domeVertex(k, i, ca);
        const p1 = domeVertex(k, i + 1, cb);
        const q0 = domeVertex(k + 1, i, ca);
        const q1 = domeVertex(k + 1, i + 1, cb);
        acc.addTriangle(p0, p1, q0);
        acc.addTriangle(p1, q1, q0);
      }
      if (apex < 0) {
        const [u0, v0] = ctx.uv(ca, last);
        apex = acc.addVertex({
          ...ref,
          ...(ctx.wind ? windOf(ctx.wind(last, lobe)) : {}),
          px: P[0] + T[0] * h, py: P[1] + T[1] * h, pz: P[2] + T[2] * h,
          nx: T[0], ny: T[1], nz: T[2],
          u: caps.rotate ? u0 + vStep : u0 + (caps.confined ? 0 : 0.5),
          v: caps.rotate ? v0 + (caps.confined ? 0 : 0.5) : v0 + vStep,
          u1: ctx.u1(ca),
          tw: 1,
        });
      }
      acc.addTriangle(domeVertex(caps.rings - 1, i, ca), domeVertex(caps.rings - 1, i + 1, cb), apex);
    }
  }
}
