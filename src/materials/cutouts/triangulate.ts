import type { TessellationMode } from '@/contracts/material';

export type Point2 = [number, number];

const EPS = 1e-9;

/** Signed area of a 2D polygon (positive = CCW in standard (u, v) where u right, v up). */
export function signedPolygonArea(pts: readonly Point2[]): number {
  let a = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const p = pts[i] as Point2;
    const q = pts[(i + 1) % n] as Point2;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

/** Signed area of triangle (a, b, c) (> 0 when CCW). */
export function triSignedArea(a: Point2, b: Point2, c: Point2): number {
  return 0.5 * ((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]));
}

/** Ensure polygon vertices are ordered counter-clockwise in (u, v) space. */
export function ensureCCW(pts: readonly Point2[]): Point2[] {
  const copy = pts.map((p): Point2 => [p[0], p[1]]);
  if (signedPolygonArea(copy) < 0) copy.reverse();
  return copy;
}

/** True if point `p` is strictly inside or on the boundary of triangle `(a, b, c)` (CCW). */
export function pointInTriangle(p: Point2, a: Point2, b: Point2, c: Point2): boolean {
  const d1 = triSignedArea(p, a, b);
  const d2 = triSignedArea(p, b, c);
  const d3 = triSignedArea(p, c, a);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon(p: Point2, poly: readonly Point2[]): boolean {
  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = poly[i] as Point2;
    const pj = poly[j] as Point2;
    const intersect =
      pi[1] > p[1] !== pj[1] > p[1] &&
      p[0] < ((pj[0] - pi[0]) * (p[1] - pi[1])) / (pj[1] - pi[1] + 1e-18) + pi[0];
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Distance from point `p` to segment `(a, b)`, plus parameter `t` in [0,1]. */
export function pointToSegment(p: Point2, a: Point2, b: Point2): { dist: number; t: number; proj: Point2 } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-14) return { dist: Math.hypot(p[0] - a[0], p[1] - a[1]), t: 0, proj: [a[0], a[1]] };
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq));
  const proj: Point2 = [a[0] + t * dx, a[1] + t * dy];
  return { dist: Math.hypot(p[0] - proj[0], p[1] - proj[1]), t, proj };
}

/** True if proper segments `(a, b)` and `(c, d)` strictly intersect in their interiors. */
export function segmentsProperlyIntersect(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = triSignedArea(a, b, c);
  const o2 = triSignedArea(a, b, d);
  const o3 = triSignedArea(c, d, a);
  const o4 = triSignedArea(c, d, b);
  return ((o1 > 1e-7 && o2 < -1e-7) || (o1 < -1e-7 && o2 > 1e-7)) &&
         ((o3 > 1e-7 && o4 < -1e-7) || (o3 < -1e-7 && o4 > 1e-7));
}

/** Andrew's monotone chain 2D convex hull (returns CCW hull without duplicate last point). */
export function computeConvexHull(points: readonly Point2[]): Point2[] {
  if (points.length <= 3) return ensureCCW(points);
  const sorted = [...points].sort((a, b) => (Math.abs(a[0] - b[0]) > 1e-9 ? a[0] - b[0] : a[1] - b[1]));
  const lower: Point2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && triSignedArea(lower[lower.length - 2] as Point2, lower[lower.length - 1] as Point2, p) <= 1e-9) {
      lower.pop();
    }
    lower.push([p[0], p[1]]);
  }
  const upper: Point2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i] as Point2;
    while (upper.length >= 2 && triSignedArea(upper[upper.length - 2] as Point2, upper[upper.length - 1] as Point2, p) <= 1e-9) {
      upper.pop();
    }
    upper.push([p[0], p[1]]);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Ear-clipping triangulation of a simple 2D polygon (handles arbitrary concave outlines). Returns triangle indices (3 per face). */
export function earclipPolygon(outline: readonly Point2[]): number[] {
  const n = outline.length;
  if (n < 3) return [];
  if (n === 3) {
    return signedPolygonArea(outline) >= 0 ? [0, 1, 2] : [0, 2, 1];
  }

  const ccw = signedPolygonArea(outline) >= 0;
  const ring: number[] = [];
  for (let i = 0; i < n; i++) ring.push(ccw ? i : n - 1 - i);

  const tris: number[] = [];
  let guard = n * n * 4 + 32;

  const isEar = (prevIdx: number, currIdx: number, nextIdx: number, active: readonly number[]): boolean => {
    const a = outline[prevIdx] as Point2;
    const b = outline[currIdx] as Point2;
    const c = outline[nextIdx] as Point2;
    if (triSignedArea(a, b, c) <= 1e-10) return false;
    for (const vi of active) {
      if (vi === prevIdx || vi === currIdx || vi === nextIdx) continue;
      const p = outline[vi] as Point2;
      if (pointInTriangle(p, a, b, c)) return false;
    }
    return true;
  };

  let cursor = 0;
  while (ring.length > 3 && guard-- > 0) {
    let clipped = false;
    const m = ring.length;
    for (let step = 0; step < m; step++) {
      const i = (cursor + step) % m;
      const prev = ring[(i + m - 1) % m] as number;
      const curr = ring[i] as number;
      const next = ring[(i + 1) % m] as number;
      if (isEar(prev, curr, next, ring)) {
        tris.push(prev, curr, next);
        ring.splice(i, 1);
        cursor = i % Math.max(1, ring.length);
        clipped = true;
        break;
      }
    }
    if (!clipped) {
      // Fallback for near-collinear / self-touching vertices: clip largest positive-area ear
      let bestI = 0;
      let bestArea = -Infinity;
      for (let i = 0; i < m; i++) {
        const prev = ring[(i + m - 1) % m] as number;
        const curr = ring[i] as number;
        const next = ring[(i + 1) % m] as number;
        const area = triSignedArea(outline[prev] as Point2, outline[curr] as Point2, outline[next] as Point2);
        if (area > bestArea) {
          bestArea = area;
          bestI = i;
        }
      }
      const prev = ring[(bestI + m - 1) % m] as number;
      const curr = ring[bestI] as number;
      const next = ring[(bestI + 1) % m] as number;
      if (bestArea > -1e-7) tris.push(prev, curr, next);
      ring.splice(bestI, 1);
      cursor = 0;
    }
  }

  if (ring.length === 3) {
    const [a, b, c] = [ring[0] as number, ring[1] as number, ring[2] as number];
    if (triSignedArea(outline[a] as Point2, outline[b] as Point2, outline[c] as Point2) >= 0) {
      tris.push(a, b, c);
    } else {
      tris.push(a, c, b);
    }
  }
  return tris;
}

/** True if point `d` lies strictly inside the circumcircle of CCW triangle `(a, b, c)`. */
function inCircumcircle(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const ax = a[0] - d[0], ay = a[1] - d[1];
  const bx = b[0] - d[0], by = b[1] - d[1];
  const cx = c[0] - d[0], cy = c[1] - d[1];
  const ab = ax * ax + ay * ay;
  const bb = bx * bx + by * by;
  const cb = cx * cx + cy * cy;
  const det = ax * (by * cb - bb * cy) - ay * (bx * cb - bb * cx) + ab * (bx * cy - by * cx);
  return det > 1e-10;
}

function edgeKey(u: number, v: number): string {
  return u < v ? `${u}:${v}` : `${v}:${u}`;
}

/**
 * Flip interior non-constrained edges that violate the local Delaunay empty-circumcircle condition.
 */
function optimizeDelaunayEdges(
  allVertices: readonly Point2[],
  tris: number[],
  constrainedEdges: ReadonlySet<string>,
): void {
  const maxPasses = Math.min(16, Math.max(4, tris.length / 3));
  for (let pass = 0; pass < maxPasses; pass++) {
    let flippedAny = false;
    const faceCount = tris.length / 3;
    for (let t1 = 0; t1 < faceCount; t1++) {
      for (let e1 = 0; e1 < 3; e1++) {
        const u = tris[t1 * 3 + e1] as number;
        const v = tris[t1 * 3 + ((e1 + 1) % 3)] as number;
        const w1 = tris[t1 * 3 + ((e1 + 2) % 3)] as number;
        if (constrainedEdges.has(edgeKey(u, v))) continue;

        // Find adjacent triangle sharing directed edge (v -> u)
        let t2 = -1;
        let w2 = -1;
        for (let f = t1 + 1; f < faceCount; f++) {
          const a = tris[f * 3] as number;
          const b = tris[f * 3 + 1] as number;
          const c = tris[f * 3 + 2] as number;
          if (a === v && b === u) { t2 = f; w2 = c; break; }
          if (b === v && c === u) { t2 = f; w2 = a; break; }
          if (c === v && a === u) { t2 = f; w2 = b; break; }
        }
        if (t2 < 0 || w2 < 0 || w1 === w2) continue;

        const pu = allVertices[u] as Point2;
        const pv = allVertices[v] as Point2;
        const pw1 = allVertices[w1] as Point2;
        const pw2 = allVertices[w2] as Point2;

        // Convexity check of quad (w1, u, w2, v)
        const area1 = triSignedArea(pw1, pw2, pv);
        const area2 = triSignedArea(pw2, pw1, pu);
        if (area1 <= 1e-8 || area2 <= 1e-8) continue;

        if (inCircumcircle(pu, pv, pw1, pw2)) {
          tris[t1 * 3] = w1;
          tris[t1 * 3 + 1] = pw2 ? w2 : w2;
          tris[t1 * 3 + 2] = v;
          tris[t2 * 3] = w2;
          tris[t2 * 3 + 1] = w1;
          tris[t2 * 3 + 2] = u;
          flippedAny = true;
        }
      }
    }
    if (!flippedAny) break;
  }
}

/**
 * Insert interior Steiner points into an existing polygon triangulation and optimize with Delaunay flips.
 * Boundary edges are preserved as constrained edges.
 */
export function triangulateCutout(
  outline: readonly Point2[],
  interiorPoints: readonly Point2[] = [],
  mode: TessellationMode = 'Triangular',
): { vertices: Point2[]; indices: number[] } {
  if (outline.length < 3) {
    return { vertices: outline.map((p): Point2 => [p[0], p[1]]), indices: [] };
  }

  if (mode === 'Convex Hull') {
    const hull = computeConvexHull([...outline, ...interiorPoints]);
    const indices = earclipPolygon(hull);
    return { vertices: hull, indices };
  }

  const baseVertices: Point2[] = outline.map((p): Point2 => [p[0], p[1]]);
  const tris = earclipPolygon(baseVertices);

  if (mode === 'None') {
    return { vertices: baseVertices, indices: tris };
  }

  const constrained = new Set<string>();
  const n = baseVertices.length;
  for (let i = 0; i < n; i++) {
    constrained.add(edgeKey(i, (i + 1) % n));
  }

  // Filter interior points to those strictly inside the polygon and not duplicating existing vertices
  for (const pt of interiorPoints) {
    if (!pointInPolygon(pt, outline)) continue;
    const tooClose = baseVertices.some((v) => Math.hypot(v[0] - pt[0], v[1] - pt[1]) < 1e-4);
    if (tooClose) continue;

    // Find containing triangle
    let targetTri = -1;
    const faceCount = tris.length / 3;
    for (let f = 0; f < faceCount; f++) {
      const i0 = tris[f * 3] as number;
      const i1 = tris[f * 3 + 1] as number;
      const i2 = tris[f * 3 + 2] as number;
      if (pointInTriangle(pt, baseVertices[i0] as Point2, baseVertices[i1] as Point2, baseVertices[i2] as Point2)) {
        targetTri = f;
        break;
      }
    }
    if (targetTri < 0) continue;

    const newIdx = baseVertices.length;
    baseVertices.push([pt[0], pt[1]]);
    const a = tris[targetTri * 3] as number;
    const b = tris[targetTri * 3 + 1] as number;
    const c = tris[targetTri * 3 + 2] as number;

    // Replace triangle (a, b, c) with 3 triangles meeting at newIdx (skipping near-zero-area slivers when point is on an interior edge)
    const subTris: [number, number, number][] = [
      [a, b, newIdx],
      [b, c, newIdx],
      [c, a, newIdx],
    ].filter(([i0, i1, i2]) => triSignedArea(baseVertices[i0] as Point2, baseVertices[i1] as Point2, baseVertices[i2] as Point2) > 1e-9) as [number, number, number][];

    if (subTris.length > 0) {
      const first = subTris[0] as [number, number, number];
      tris[targetTri * 3] = first[0];
      tris[targetTri * 3 + 1] = first[1];
      tris[targetTri * 3 + 2] = first[2];
      for (let k = 1; k < subTris.length; k++) {
        const st = subTris[k] as [number, number, number];
        tris.push(st[0], st[1], st[2]);
      }
    }
  }

  optimizeDelaunayEdges(baseVertices, tris, constrained);

  // Ensure every triangle is strictly CCW
  const cleanIndices: number[] = [];
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i] as number;
    const b = tris[i + 1] as number;
    const c = tris[i + 2] as number;
    const area = triSignedArea(baseVertices[a] as Point2, baseVertices[b] as Point2, baseVertices[c] as Point2);
    if (Math.abs(area) <= 1e-10) continue;
    if (area > 0) cleanIndices.push(a, b, c);
    else cleanIndices.push(a, c, b);
  }

  return { vertices: baseVertices, indices: cleanIndices };
}

/**
 * Generate additional interior Steiner points inside `outline` controlled by `tessAmount` (0..1)
 * and aligned with the `straightenAxis` when present.
 */
export function generateTessellationPoints(
  outline: readonly Point2[],
  tessAmount: number,
  straightenAxis: readonly Point2[] = [],
  mode: TessellationMode = 'Triangular',
): Point2[] {
  const amt = Math.max(0, Math.min(1, tessAmount));
  if (amt <= 0.01 || outline.length < 3 || mode === 'None' || mode === 'Convex Hull') return [];

  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const [u, v] of outline) {
    if (u < minU) minU = u;
    if (v < minV) minV = v;
    if (u > maxU) maxU = u;
    if (v > maxV) maxV = v;
  }
  const spanU = Math.max(0.05, maxU - minU);
  const spanV = Math.max(0.05, maxV - minV);
  const minBoundaryDist = Math.min(spanU, spanV) * Math.max(0.06, 0.22 - amt * 0.14);

  const isFarEnoughFromBoundary = (p: Point2): boolean => {
    const n = outline.length;
    for (let i = 0; i < n; i++) {
      const a = outline[i] as Point2;
      const b = outline[(i + 1) % n] as Point2;
      if (pointToSegment(p, a, b).dist < minBoundaryDist) return false;
    }
    return true;
  };

  const pts: Point2[] = [];

  // 1. Add points along the straightenAxis inside the polygon
  if (straightenAxis.length >= 2) {
    const spineSteps = Math.max(1, Math.round(1 + amt * 5));
    for (let s = 1; s <= spineSteps; s++) {
      const t = s / (spineSteps + 1);
      const p = samplePolyline(straightenAxis, t);
      if (pointInPolygon(p, outline) && isFarEnoughFromBoundary(p)) {
        pts.push(p);
      }
    }
  }

  // 2. Add interior grid / staggered lattice points
  const cols = Math.max(1, Math.round(amt * 5));
  const rows = Math.max(1, Math.round(amt * 5));
  for (let r = 1; r <= rows; r++) {
    const v = minV + (r / (rows + 1)) * spanV;
    const stagger = mode === 'Triangular' && r % 2 === 1 ? 0.5 / (cols + 1) : 0;
    for (let c = 1; c <= cols; c++) {
      const u = minU + (c / (cols + 1) + stagger) * spanU;
      const candidate: Point2 = [u, v];
      if (!pointInPolygon(candidate, outline) || !isFarEnoughFromBoundary(candidate)) continue;
      if (pts.some((q) => Math.hypot(q[0] - candidate[0], q[1] - candidate[1]) < minBoundaryDist * 0.8)) continue;
      pts.push(candidate);
    }
  }

  return pts;
}

export function samplePolyline(poly: readonly Point2[], t: number): Point2 {
  if (poly.length === 0) return [0.5, 0.5];
  if (poly.length === 1) return [poly[0]![0], poly[0]![1]];
  const clamped = Math.max(0, Math.min(1, t));
  let totalLen = 0;
  const segLens: number[] = [];
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i] as Point2;
    const b = poly[i + 1] as Point2;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    segLens.push(l);
    totalLen += l;
  }
  if (totalLen < 1e-9) return [poly[0]![0], poly[0]![1]];
  let target = clamped * totalLen;
  for (let i = 0; i < segLens.length; i++) {
    const l = segLens[i] as number;
    if (target <= l || i === segLens.length - 1) {
      const a = poly[i] as Point2;
      const b = poly[i + 1] as Point2;
      const u = l > 1e-9 ? target / l : 0;
      return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    }
    target -= l;
  }
  const last = poly[poly.length - 1] as Point2;
  return [last[0], last[1]];
}
