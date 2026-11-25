import type { MeshData } from '@/contracts/mesh';
import type { Branch, Skeleton } from '@/contracts/skeleton';
import { findSplitLobes } from '@/geometry/splitCrotch';
import {
  centroidOfPoints,
  chordThrough,
  isSimplePolygon,
  polygonArea,
  polygonsCross,
  fitCircle,
  valleyRadius,
  type P2,
} from './outline';
import { loopAround } from './profileMetrics';
import { distanceToPolyline, dot3, lerp3, len3, planeBasis, planeSection, selectTriangles, sub3, toPlane, unit3, type SectionLoop, type V3 } from './section';

/** Result of one cross-section station of a fork. */
export interface ForkStation {
  /** 0 = start of the transition .. 1 = the open ends. */
  fraction: number;
  /** Number of outline loops near the fork axis (1 = lobes still fused, 2 = already separate). */
  loops: number;
  /** Total section area (m^2). */
  area: number;
  /** Section area / linear interpolation between the first and the last station. */
  areaRatio: number;
  /** Width of the neck between the lobes / diameter of the narrower lobe (1 = no waist, 0 = separated). */
  waistRatio: number;
  /** Smallest radius of curvature of the valley corners / radius of the narrower lobe (null: no concave corner). */
  valleyRadiusRel: number | null;
  /** No outline crosses itself or another outline. */
  simple: boolean;
}

export interface ForkReport {
  /** Index of the splitting parent branch. */
  parent: number;
  stations: ForkStation[];
  /** Smallest area ratio over the stations (pipe model: >= 0.9). */
  minAreaRatio: number;
  /** The section area never moves against the direction from the first to the last station (3 % tolerance). */
  areaMonotone: boolean;
  /** Waist ratio at the middle station. */
  waistMid: number;
  /** Smallest valley curvature radius (relative) over the stations that have a valley; null when none. */
  minValleyRadiusRel: number | null;
  allSimple: boolean;
  /** Angle in degrees between the surface normals just before and just after the start of the transition (same polar angle). */
  ring0NormalJump: { mean: number; max: number } | null;
  /** Regularity of the last ring of each lobe: coefficient of variation of the edge lengths and circle deviation. */
  openEnd: { edgeLengthCv: number; circleDeviation: number; vertices: number } | null;
}

export interface ForkMetrics {
  forks: ForkReport[];
  summary: {
    count: number;
    waistMid: number | null;
    minAreaRatio: number | null;
    minValleyRadiusRel: number | null;
    allSimple: boolean;
    thinningForks: number;
    ring0NormalJumpMax: number | null;
    openEndEdgeCv: number | null;
  };
}

export interface ForkOptions {
  /** Stations per fork (default 7). */
  stations?: number;
  /** Called with the 2D outline loops of every station (for SVG dumps); `fork` counts the splits in order. */
  onOutline?: (fork: number, station: number, loops: readonly (readonly P2[])[]) => void;
}

/** What the outline analysis needs to know about the two lobes at one station (all in the section plane). */
export interface LobePair {
  c1: P2;
  c2: P2;
  r1: number;
  r2: number;
}

export interface OutlineAnalysis {
  loops: number;
  area: number;
  waistRatio: number;
  valleyRadiusRel: number | null;
  simple: boolean;
}

/**
 * Pure analysis of the outline loops of one fork cross-section (2D). Exported for synthetic tests.
 * The neck is the narrowest chord (perpendicular to the line through the two lobe centres) between the centres.
 */
export function analyzeOutline(loops: readonly (readonly P2[])[], lobes: LobePair): OutlineAnalysis {
  const area = loops.reduce((s, l) => s + polygonArea(l), 0);
  let simple = loops.every((l) => isSimplePolygon(l));
  for (let i = 0; i < loops.length && simple; i++) for (let j = i + 1; j < loops.length; j++) if (polygonsCross(loops[i] as readonly P2[], loops[j] as readonly P2[])) simple = false;
  const axis = unit2([lobes.c2[0] - lobes.c1[0], lobes.c2[1] - lobes.c1[1]]);
  const perp: P2 = [-axis[1], axis[0]];
  const chord = (o: P2): number => loops.reduce((best, l) => Math.max(best, chordThrough(l, o, perp)), 0);
  // Chord profile along the lobe axis, scanned a little beyond both centres: a figure-8 fork may have its lobes displaced from the
  // skeleton paths, so the lobe width is the widest chord on each side of the middle (not the chord at the path centre), and the
  // neck is the narrowest chord between those two maxima.
  const span = Math.hypot(lobes.c2[0] - lobes.c1[0], lobes.c2[1] - lobes.c1[1]);
  const lo = -1.5 * lobes.r1;
  const hi = span + 1.5 * lobes.r2;
  const steps = 120;
  const at = (a: number): P2 => [lobes.c1[0] + axis[0] * a, lobes.c1[1] + axis[1] * a];
  const prof: { a: number; c: number }[] = [];
  for (let k = 0; k <= steps; k++) {
    const a = lo + ((hi - lo) * k) / steps;
    prof.push({ a, c: chord(at(a)) });
  }
  const mid = span / 2;
  const left = prof.filter((p) => p.a < mid);
  const right = prof.filter((p) => p.a >= mid);
  const maxOf = (xs: { a: number; c: number }[]): { a: number; c: number } => xs.reduce((b, p) => (p.c > b.c ? p : b), { a: 0, c: 0 });
  const mL = maxOf(left);
  const mR = maxOf(right);
  const w1 = mL.c || 2 * lobes.r1;
  const w2 = mR.c || 2 * lobes.r2;
  const narrow = Math.max(1e-12, Math.min(w1, w2));
  let neck = Infinity;
  for (const p of prof) if (p.a >= mL.a && p.a <= mR.a) neck = Math.min(neck, p.c);
  if (!Number.isFinite(neck)) neck = 0;
  let valley: number | null = null;
  if (loops.length === 1) valley = valleyRadius(loops[0] as readonly P2[]);
  return {
    loops: loops.length,
    area,
    waistRatio: Math.min(1.5, neck / narrow),
    valleyRadiusRel: valley === null ? null : valley / (narrow / 2),
    simple,
  };
}

const unit2 = (v: P2): P2 => {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-12 ? [v[0] / l, v[1] / l] : [1, 0];
};

function pointAt(sk: Skeleton, b: Branch, k: number): V3 {
  const i = b.start + k;
  return [sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number];
}

const angleBetween = (a: number[], b: number[]): number => (Math.acos(Math.min(1, Math.max(-1, (a[0] as number) * (b[0] as number) + (a[1] as number) * (b[1] as number) + (a[2] as number) * (b[2] as number)))) * 180) / Math.PI;

/** Normal jump between two sections of the same fork axis, compared at equal polar angle around the axis. */
function normalJump(a: SectionLoop, b: SectionLoop, centre: V3, axis: V3): { mean: number; max: number } | null {
  const { u, v } = planeBasis(axis);
  const polar = (l: SectionLoop): number[] => l.points.map((p) => Math.atan2(dot3(sub3(p as unknown as V3, centre), v), dot3(sub3(p as unknown as V3, centre), u)));
  const pa = polar(a);
  const pb = polar(b);
  const jumps: number[] = [];
  pa.forEach((ang, i) => {
    let best = 0;
    let bd = Infinity;
    pb.forEach((other, j) => {
      const d = Math.abs(Math.atan2(Math.sin(ang - other), Math.cos(ang - other)));
      if (d < bd) {
        bd = d;
        best = j;
      }
    });
    jumps.push(angleBetween(a.normals[i] as number[], b.normals[best] as number[]));
  });
  if (jumps.length === 0) return null;
  return { mean: jumps.reduce((s, x) => s + x, 0) / jumps.length, max: Math.max(...jumps) };
}

/**
 * Regularity of the mesh ring at the open end of a lobe: the unique vertices of the most populated ring plane (perpendicular to
 * the lobe tangent, within 0.3 radius of the end point), ordered by angle.
 */
function endRing(mesh: MeshData, end: V3, tangent: V3, radius: number): { cv: number; dev: number; n: number } | null {
  const groups = new Map<number, V3[]>();
  const seen = new Set<string>();
  const { u, v } = planeBasis(tangent);
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const p: V3 = [mesh.positions[i * 3] as number, mesh.positions[i * 3 + 1] as number, mesh.positions[i * 3 + 2] as number];
    const d = sub3(p, end);
    const ax = dot3(d, tangent);
    if (Math.abs(ax) > 0.3 * radius) continue;
    const rr = Math.hypot(dot3(d, u), dot3(d, v));
    if (rr < 0.5 * radius || rr > 1.6 * radius) continue;
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)},${Math.round(p[2] * 1e5)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bin = Math.round(ax / (0.01 * radius));
    const list = groups.get(bin);
    if (list) list.push(p);
    else groups.set(bin, [p]);
  }
  let pts: V3[] = [];
  let bestBin = Infinity;
  for (const [bin, list] of groups) {
    if (list.length > pts.length || (list.length === pts.length && Math.abs(bin) < Math.abs(bestBin))) {
      pts = list;
      bestBin = bin;
    }
  }
  if (pts.length < 4) return null;
  const flat: P2[] = pts.map((p) => toPlane(p, end, u, v));
  const c = centroidOfPoints(flat);
  const sorted = [...flat].sort((a, b) => Math.atan2(a[1] - c[1], a[0] - c[0]) - Math.atan2(b[1] - c[1], b[0] - c[0]));
  const edges = sorted.map((p, i) => {
    const q = sorted[(i + 1) % sorted.length] as P2;
    return Math.hypot(q[0] - p[0], q[1] - p[1]);
  });
  const m = edges.reduce((s, x) => s + x, 0) / edges.length;
  const sd = Math.sqrt(edges.reduce((s, x) => s + (x - m) * (x - m), 0) / edges.length);
  const fit = fitCircle(sorted);
  return { cv: m > 0 ? sd / m : 0, dev: fit ? fit.deviation : 0, n: sorted.length };
}

/** Cross-section metrics of every split of `skeleton` on `mesh` (the mesh of the same generator). */
export function forkMetrics(skeleton: Skeleton, mesh: MeshData, options: ForkOptions = {}): ForkMetrics {
  const nStations = Math.max(3, options.stations ?? 7);
  const forks: ForkReport[] = [];
  for (const [pi, lobes] of findSplitLobes(skeleton)) {
    const parent = skeleton.branches[pi] as Branch;
    const l1 = skeleton.branches[lobes.side1] as Branch;
    const l2 = skeleton.branches[lobes.side2] as Branch;
    const rings = l1.count;
    const mid: V3[] = [];
    for (let k = 0; k < rings; k++) mid.push(lerp3(pointAt(skeleton, l1, k), pointAt(skeleton, l2, k), 0.5));
    const arc: number[] = [0];
    for (let k = 1; k < rings; k++) arc.push((arc[k - 1] as number) + len3(sub3(mid[k] as V3, mid[k - 1] as V3)));
    const total = arc[rings - 1] as number;
    if (total <= 1e-9) continue;
    const radius = (b: Branch, k: number): number => skeleton.radius[b.start + k] as number;
    const maxR = Math.max(radius(l1, 0), radius(l2, 0), radius(l1, rings - 1), radius(l2, rings - 1));
    const r0 = skeleton.radius[parent.start + lobes.keep - 2] as number;
    const flat: number[] = [];
    for (const p of mid) flat.push(p[0], p[1], p[2]);
    const reach = Math.max(r0, maxR) * 2 + 0.5 * Math.max(...[l1, l2].map((b) => len3(sub3(pointAt(skeleton, b, rings - 1), pointAt(skeleton, b, 0)))));
    const tris = selectTriangles(mesh, (x, y, z) => distanceToPolyline(flat, x, y, z) < reach);
    if (tris.length === 0) continue;

    const at = (a: number): { pos: V3; tan: V3; k: number; f: number } => {
      let k = 0;
      while (k < rings - 2 && (arc[k + 1] as number) < a) k++;
      const l = (arc[k + 1] as number) - (arc[k] as number);
      const f = l > 1e-12 ? Math.min(1, Math.max(0, (a - (arc[k] as number)) / l)) : 0;
      return { pos: lerp3(mid[k] as V3, mid[k + 1] as V3, f), tan: unit3(sub3(mid[k + 1] as V3, mid[k] as V3)), k, f };
    };

    const eps = 0.01;
    const stations: ForkStation[] = [];
    const raw: { analysis: OutlineAnalysis; fraction: number }[] = [];
    for (let i = 0; i < nStations; i++) {
      const fraction = i / (nStations - 1);
      const s = at((eps + (1 - 2 * eps) * fraction) * total);
      const { u, v } = planeBasis(s.tan);
      const c1 = lerp3(pointAt(skeleton, l1, s.k), pointAt(skeleton, l1, s.k + 1), s.f);
      const c2 = lerp3(pointAt(skeleton, l2, s.k), pointAt(skeleton, l2, s.k + 1), s.f);
      const rr1 = radius(l1, s.k) + (radius(l1, s.k + 1) - radius(l1, s.k)) * s.f;
      const rr2 = radius(l2, s.k) + (radius(l2, s.k + 1) - radius(l2, s.k)) * s.f;
      const loops = planeSection(mesh, tris, s.pos, s.tan);
      const reachHere = len3(sub3(c1, c2)) / 2 + 1.5 * Math.max(rr1, rr2);
      const polys: P2[][] = [];
      let biggest = 0;
      for (const loop of loops) {
        if (!loop.closed) continue;
        const poly = loop.points.map((q) => toPlane(q, s.pos, u, v));
        const cc = centroidOfPoints(poly);
        if (Math.hypot(cc[0], cc[1]) > reachHere) continue;
        polys.push(poly);
        biggest = Math.max(biggest, polygonArea(poly));
      }
      const near = polys.filter((p) => polygonArea(p) >= 0.05 * biggest);
      const analysis = analyzeOutline(near, { c1: toPlane(c1, s.pos, u, v), c2: toPlane(c2, s.pos, u, v), r1: rr1, r2: rr2 });
      options.onOutline?.(forks.length, i, near);
      raw.push({ analysis, fraction });
    }
    const a0 = (raw[0] as { analysis: OutlineAnalysis }).analysis.area;
    const a1 = (raw[raw.length - 1] as { analysis: OutlineAnalysis }).analysis.area;
    for (const { analysis, fraction } of raw) {
      const expected = a0 + (a1 - a0) * fraction;
      stations.push({
        fraction,
        loops: analysis.loops,
        area: analysis.area,
        areaRatio: expected > 0 ? analysis.area / expected : 0,
        waistRatio: analysis.waistRatio,
        valleyRadiusRel: analysis.valleyRadiusRel,
        simple: analysis.simple,
      });
    }
    const dir = Math.sign(a1 - a0) || 1;
    let monotone = true;
    for (let i = 1; i < stations.length; i++) {
      const prev = (stations[i - 1] as ForkStation).area;
      const cur = (stations[i] as ForkStation).area;
      if ((cur - prev) * dir < -0.03 * Math.max(prev, cur)) monotone = false;
    }
    const valleys = stations.map((s) => s.valleyRadiusRel).filter((x): x is number => x !== null);

    // tangent continuity of ring 0 with the parent: sections a little before / after the start of the transition
    const start = at(0);
    const delta = 0.2 * r0;
    const back = sub3(start.pos, [start.tan[0] * delta, start.tan[1] * delta, start.tan[2] * delta]);
    const fwd: V3 = [start.pos[0] + start.tan[0] * delta, start.pos[1] + start.tan[1] * delta, start.pos[2] + start.tan[2] * delta];
    const before = loopAround(planeSection(mesh, tris, back, start.tan), back, start.tan, 0.2 * Math.PI * r0 * r0);
    const after = loopAround(planeSection(mesh, tris, fwd, start.tan), fwd, start.tan, 0.2 * Math.PI * r0 * r0);
    const ring0 = before && after ? normalJump(before.loop, after.loop, start.pos, start.tan) : null;

    // open-end ring regularity (mean of the two lobes)
    const ends = [l1, l2]
      .map((b) => {
        const e = pointAt(skeleton, b, b.count - 1);
        const t = unit3(sub3(e, pointAt(skeleton, b, b.count - 2)));
        return endRing(mesh, e, t, radius(b, b.count - 1));
      })
      .filter((e): e is { cv: number; dev: number; n: number } => e !== null);
    const openEnd = ends.length > 0 ? { edgeLengthCv: ends.reduce((s, e) => s + e.cv, 0) / ends.length, circleDeviation: ends.reduce((s, e) => s + e.dev, 0) / ends.length, vertices: Math.round(ends.reduce((s, e) => s + e.n, 0) / ends.length) } : null;

    forks.push({
      parent: pi,
      stations,
      minAreaRatio: Math.min(...stations.map((s) => s.areaRatio)),
      areaMonotone: monotone,
      waistMid: (stations[Math.floor(stations.length / 2)] as ForkStation).waistRatio,
      minValleyRadiusRel: valleys.length > 0 ? Math.min(...valleys) : null,
      allSimple: stations.every((s) => s.simple),
      ring0NormalJump: ring0,
      openEnd,
    });
  }
  return { forks, summary: summarizeForks(forks) };
}

const avg = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

export function summarizeForks(forks: readonly ForkReport[]): ForkMetrics['summary'] {
  const valleys = forks.map((f) => f.minValleyRadiusRel).filter((x): x is number => x !== null);
  const jumps = forks.map((f) => f.ring0NormalJump?.max).filter((x): x is number => x !== undefined);
  return {
    count: forks.length,
    waistMid: avg(forks.map((f) => f.waistMid)),
    minAreaRatio: forks.length > 0 ? Math.min(...forks.map((f) => f.minAreaRatio)) : null,
    minValleyRadiusRel: valleys.length > 0 ? Math.min(...valleys) : null,
    allSimple: forks.every((f) => f.allSimple),
    thinningForks: forks.filter((f) => f.minAreaRatio < 0.9).length,
    ring0NormalJumpMax: jumps.length > 0 ? Math.max(...jumps) : null,
    openEndEdgeCv: avg(forks.map((f) => f.openEnd?.edgeLengthCv).filter((x): x is number => x !== undefined)),
  };
}
