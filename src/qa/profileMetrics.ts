import type { MeshData } from '@/contracts/mesh';
import type { Branch, Skeleton } from '@/contracts/skeleton';
import { SPINE_ORIGIN_ATTR, SPLIT_ATTR, SpineOrigin, SplitFlag } from '@/generators/split';
import { fitCircle, isoperimetric, pointInPolygon, polygonArea, resampleClosed, centroidOfPoints, type P2 } from './outline';
import { cross3, distanceToPolyline, dot3, len3, planeBasis, planeSection, selectTriangles, sub3, toPlane, unit3, type SectionLoop, type V3 } from './section';
import { mean, polynomialResiduals, rms } from './stats';

/** Profile of one branch measured on the real surface: cross-sections perpendicular to the skeleton at evenly spaced stations. */
export interface BranchProfile {
  /** Index into `skeleton.branches`. */
  branch: number;
  generation: number;
  length: number;
  /** Mean equivalent radius (sqrt(area / pi)) over the stations. */
  meanRadius: number;
  stations: number;
  /** Isoperimetric circularity 4 pi A / P^2 of the sections (mean; 1 = perfect circle). */
  circularity: number;
  /** RMS deviation of the section from its best-fit circle / mean radius (mean over stations; 0 = perfect circle). */
  circularityDeviation: number;
  /** RMS residual of the section radius against a smooth cubic taper / mean radius (0 = perfectly smooth taper). */
  radiusRoughness: number;
  /** RMS residual of the silhouette (support distance from the skeleton axis, both sides, two views) / mean radius. */
  silhouetteDeviation: number;
}

export interface ProfileMetrics {
  trunk: BranchProfile | null;
  /** The two largest other branches (length x base radius). */
  branches: BranchProfile[];
}

export interface ProfileOptions {
  /** Cross-sections per branch (default 40). */
  stations?: number;
  /** Fraction of the branch skipped at the base (root flare / collar) and at the tip (default 0.1 / 0.12). */
  skipStart?: number;
  skipEnd?: number;
  /** How many other branches to measure (default 2). */
  branchCount?: number;
}

export interface Polyline {
  points: V3[];
  radius: number[];
  arc: number[];
  length: number;
}

export function branchPolyline(sk: Skeleton, b: Branch, count: number): Polyline {
  const points: V3[] = [];
  const radius: number[] = [];
  const arc: number[] = [0];
  for (let k = 0; k < Math.min(count, b.count); k++) {
    const i = b.start + k;
    points.push([sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number]);
    radius.push(sk.radius[i] as number);
    if (k > 0) arc.push((arc[k - 1] as number) + len3(sub3(points[k] as V3, points[k - 1] as V3)));
  }
  return { points, radius, arc, length: arc[arc.length - 1] ?? 0 };
}

/** Point, unit tangent and radius at arc length `s` of the polyline. */
export function polylineAt(line: Polyline, s: number): { pos: V3; tan: V3; radius: number } {
  const n = line.points.length;
  let k = 0;
  while (k < n - 2 && (line.arc[k + 1] as number) < s) k++;
  const a = line.points[k] as V3;
  const b = line.points[Math.min(n - 1, k + 1)] as V3;
  const l = (line.arc[Math.min(n - 1, k + 1)] as number) - (line.arc[k] as number);
  const f = l > 1e-12 ? Math.min(1, Math.max(0, (s - (line.arc[k] as number)) / l)) : 0;
  const ra = line.radius[k] as number;
  const rb = line.radius[Math.min(n - 1, k + 1)] as number;
  return { pos: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f], tan: unit3(sub3(b, a)), radius: ra + (rb - ra) * f };
}

/** The section loop around the axis point `p` (the loop containing it, otherwise the one with the nearest centroid). */
export function loopAround(loops: readonly SectionLoop[], p: V3, normal: V3, minArea: number): { loop: SectionLoop; poly: P2[] } | null {
  const { u, v } = planeBasis(normal);
  let best: { loop: SectionLoop; poly: P2[]; d: number } | null = null;
  for (const loop of loops) {
    if (!loop.closed) continue;
    const poly = loop.points.map((q) => toPlane(q, p, u, v));
    if (polygonArea(poly) < minArea) continue;
    const c = centroidOfPoints(poly);
    const d = pointInPolygon(poly, 0, 0) ? 0 : Math.hypot(c[0], c[1]);
    if (!best || d < best.d || (d === best.d && polygonArea(poly) > polygonArea(best.poly))) best = { loop, poly, d };
  }
  return best ? { loop: best.loop, poly: best.poly } : null;
}

/** Cubic-residual roughness (relative to `meanR`) of a series sampled at `xs`. */
const roughness = (xs: number[], ys: number[], meanR: number): number => (meanR > 0 && ys.length >= 4 ? rms(polynomialResiduals(xs, ys, 3)) / meanR : 0);

function measureBranch(sk: Skeleton, mesh: MeshData, bi: number, count: number, o: Required<ProfileOptions>): BranchProfile | null {
  const b = sk.branches[bi] as Branch;
  const line = branchPolyline(sk, b, count);
  if (line.points.length < 2 || line.length <= 0) return null;
  const flat: number[] = [];
  for (const p of line.points) flat.push(p[0], p[1], p[2]);
  const maxR = Math.max(...line.radius);
  const tris = selectTriangles(mesh, (x, y, z) => distanceToPolyline(flat, x, y, z) < 3 * maxR + 0.02);
  if (tris.length === 0) return null;
  const s0 = o.skipStart * line.length;
  const s1 = (1 - o.skipEnd) * line.length;
  const xs: number[] = [];
  const req: number[] = [];
  const circ: number[] = [];
  const dev: number[] = [];
  const sil: number[][] = [[], [], [], []];
  for (let k = 0; k < o.stations; k++) {
    const s = s0 + ((s1 - s0) * (k + 0.5)) / o.stations;
    const at = polylineAt(line, s);
    const found = loopAround(planeSection(mesh, tris, at.pos, at.tan), at.pos, at.tan, 0.2 * Math.PI * at.radius * at.radius);
    if (!found) continue;
    const area = polygonArea(found.poly);
    xs.push(s);
    req.push(Math.sqrt(area / Math.PI));
    circ.push(isoperimetric(found.poly));
    const fit = fitCircle(resampleClosed(found.poly, 96));
    if (fit) dev.push(fit.deviation);
    // silhouette: support distance of the section from the axis point along two perpendicular lateral directions
    const e1 = planeBasis(at.tan).u;
    const e2 = cross3(at.tan, e1);
    const pts = found.loop.points.map((q) => sub3(q as unknown as V3, at.pos));
    const support = (e: V3): [number, number] => [Math.max(...pts.map((q) => dot3(q, e))), -Math.min(...pts.map((q) => dot3(q, e)))];
    const [a1, a2] = support(e1);
    const [c1, c2] = support(e2);
    (sil[0] as number[]).push(a1);
    (sil[1] as number[]).push(a2);
    (sil[2] as number[]).push(c1);
    (sil[3] as number[]).push(c2);
  }
  if (xs.length < 4) return null;
  const meanR = mean(req);
  return {
    branch: bi,
    generation: b.generation,
    length: line.length,
    meanRadius: meanR,
    stations: xs.length,
    circularity: mean(circ),
    circularityDeviation: mean(dev),
    radiusRoughness: roughness(xs, req, meanR),
    silhouetteDeviation: mean(sil.map((ys) => roughness(xs, ys, meanR))),
  };
}

/** Points of a branch before its split starts (a splitting parent is truncated at the shared transition). */
export function keptPointCount(sk: Skeleton, bi: number): number {
  const b = sk.branches[bi] as Branch;
  const flags = sk.attributes.get(SPLIT_ATTR);
  if (!flags || ((flags[b.start] ?? 0) & SplitFlag.Parent) === 0) return b.count;
  let last = b.count;
  for (const o of sk.branches) {
    if (o.parentBranch !== b.id || ((flags[o.start] ?? 0) & (SplitFlag.Side1 | SplitFlag.Side2)) === 0) continue;
    last = Math.min(last, o.parentPoint - b.start + 1);
  }
  return Math.max(2, last);
}

const originOf = (sk: Skeleton, b: Branch): number => Math.round(sk.attributes.get(SPINE_ORIGIN_ATTR)?.[b.start] ?? SpineOrigin.Primary);

/**
 * Circularity, radius roughness and silhouette deviation of the trunk (the longest generation-0 spine) and the largest other
 * branches of `skeleton`, measured on `mesh` (the mesh of the same generator). Returns null entries when no usable section exists.
 */
export function profileMetrics(skeleton: Skeleton, mesh: MeshData, options: ProfileOptions = {}): ProfileMetrics {
  const o: Required<ProfileOptions> = { stations: options.stations ?? 40, skipStart: options.skipStart ?? 0.1, skipEnd: options.skipEnd ?? 0.12, branchCount: options.branchCount ?? 2 };
  const primary = skeleton.branches.map((b, i) => ({ b, i })).filter((e) => originOf(skeleton, e.b) === SpineOrigin.Primary && e.b.count >= 3);
  const trunkEntry = primary.filter((e) => e.b.generation === 0).sort((a, c) => c.b.length - a.b.length)[0];
  const weight = (e: { b: Branch }): number => e.b.length * (skeleton.radius[e.b.start] as number);
  const others = primary
    .filter((e) => e !== trunkEntry)
    .sort((a, c) => weight(c) - weight(a))
    .slice(0, o.branchCount);
  const run = (e: { i: number } | undefined): BranchProfile | null => (e ? measureBranch(skeleton, mesh, e.i, keptPointCount(skeleton, e.i), o) : null);
  return { trunk: run(trunkEntry), branches: others.map((e) => run(e)).filter((p): p is BranchProfile => p !== null) };
}
