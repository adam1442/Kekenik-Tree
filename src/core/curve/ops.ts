import { clamp } from '@/core/math';
import { computeAutoSlope, evaluateCurve } from './evaluate';
import { cloneCurve, cloneCurvePoint, type Curve, type CurvePoint, type TangentMode, type WrapMode } from './types';

/**
 * Pure curve manipulation operations (add/remove/move points, tangent modes,
 * flip, mirror, reverse, scale/offset, smooth, simplify, freehand stroke fit,
 * and JSON clipboard serialization).
 */

const MIN_X_GAP = 1e-4;

let memoryClipboardCurve: string | null = null;

/**
 * Recomputes tangent vectors on points whose mode is 'auto', 'smooth', 'linear', 'flat', or 'stepped'.
 */
export function recomputePointTangents(points: readonly CurvePoint[], xRange: [number, number]): CurvePoint[] {
  const n = points.length;
  const span = Math.max(1e-4, xRange[1] - xRange[0]);
  return points.map((p, i) => {
    const pt = cloneCurvePoint(p);
    const prev = i > 0 ? (points[i - 1] as CurvePoint) : null;
    const next = i < n - 1 ? (points[i + 1] as CurvePoint) : null;
    const dxIn = prev ? Math.max(MIN_X_GAP, (pt.x - prev.x) / 3) : span / 6;
    const dxOut = next ? Math.max(MIN_X_GAP, (next.x - pt.x) / 3) : span / 6;

    if (pt.mode === 'flat') {
      pt.inTangent = { dx: Math.abs(pt.inTangent.dx) > 1e-6 ? pt.inTangent.dx : -dxIn, dy: 0 };
      pt.outTangent = { dx: Math.abs(pt.outTangent.dx) > 1e-6 ? pt.outTangent.dx : dxOut, dy: 0 };
    } else if (pt.mode === 'stepped' || pt.mode === 'constant') {
      pt.inTangent = { dx: 0, dy: 0 };
      pt.outTangent = { dx: 0, dy: 0 };
    } else if (pt.mode === 'linear') {
      const sIn = prev && pt.x - prev.x > MIN_X_GAP ? (pt.y - prev.y) / (pt.x - prev.x) : 0;
      const sOut = next && next.x - pt.x > MIN_X_GAP ? (next.y - pt.y) / (next.x - pt.x) : sIn;
      pt.inTangent = { dx: -dxIn, dy: -sIn * dxIn };
      pt.outTangent = { dx: dxOut, dy: sOut * dxOut };
    } else if (pt.mode === 'auto' || pt.mode === 'smooth') {
      const slope = computeAutoSlope(points, i);
      pt.inTangent = { dx: -dxIn, dy: -slope * dxIn };
      pt.outTangent = { dx: dxOut, dy: slope * dxOut };
    } else {
      // 'free' | 'aligned' | 'mirrored' -> ensure non-zero handle lengths if uninitialized
      if (Math.abs(pt.inTangent.dx) < 1e-6 && Math.abs(pt.inTangent.dy) < 1e-6) {
        pt.inTangent = { dx: -dxIn, dy: 0 };
      }
      if (Math.abs(pt.outTangent.dx) < 1e-6 && Math.abs(pt.outTangent.dy) < 1e-6) {
        pt.outTangent = { dx: dxOut, dy: 0 };
      }
    }
    return pt;
  });
}

function syncLevelPoints(curve: Curve, points: CurvePoint[]): Curve {
  const next: Curve = {
    ...curve,
    points,
  };
  if (curve.level !== undefined && curve.levelCurves) {
    next.levelCurves = {
      ...curve.levelCurves,
      [curve.level]: points.map(cloneCurvePoint),
    };
  }
  return next;
}

/**
 * Ensures points are sorted by ascending x, enforces minimum spacing, and updates derived tangents.
 */
export function normalizeCurve(curve: Curve): Curve {
  const copy = cloneCurve(curve);
  copy.points.sort((a, b) => a.x - b.x);
  for (let i = 1; i < copy.points.length; i++) {
    const prev = copy.points[i - 1] as CurvePoint;
    const cur = copy.points[i] as CurvePoint;
    if (cur.x < prev.x + MIN_X_GAP * 0.1) {
      cur.x = prev.x + MIN_X_GAP * 0.1;
    }
  }
  const points = recomputePointTangents(copy.points, copy.xRange);
  return syncLevelPoints(copy, points);
}

/**
 * Add a control point at `(x, y)` (defaulting `y` to `evaluateCurve(curve, x)` if omitted).
 * Returns the updated curve and the index of the newly inserted point.
 */
export function addCurvePoint(
  curve: Curve,
  x: number,
  y: number = evaluateCurve(curve, x),
  mode: TangentMode = 'auto',
): { curve: Curve; index: number } {
  const [xMin, xMax] = curve.xRange;
  const fixed = curve.fixedEndpoints !== false;
  const clampedX = fixed ? clamp(x, xMin + MIN_X_GAP, xMax - MIN_X_GAP) : x;

  const pts = curve.points.map(cloneCurvePoint);
  // If a point already exists very close to clampedX, update its y instead of duplicating
  const existingIdx = pts.findIndex((p, idx) => {
    if (fixed && (idx === 0 || idx === pts.length - 1)) return false;
    return Math.abs(p.x - clampedX) < MIN_X_GAP * 2;
  });

  if (existingIdx >= 0) {
    const existing = pts[existingIdx] as CurvePoint;
    existing.y = y;
    existing.mode = mode;
    const updated = recomputePointTangents(pts, curve.xRange);
    return { curve: syncLevelPoints(curve, updated), index: existingIdx };
  }

  let insertIdx = pts.findIndex((p) => p.x > clampedX);
  if (insertIdx === -1) insertIdx = pts.length;
  if (fixed && pts.length >= 2) {
    insertIdx = clamp(insertIdx, 1, pts.length - 1);
  }

  const slope = pts.length >= 2 ? (evaluateCurve(curve, clampedX + 1e-3) - evaluateCurve(curve, clampedX - 1e-3)) / 2e-3 : 0;
  const span = Math.max(0.05, (xMax - xMin) / Math.max(3, pts.length + 1));
  const dx = span / 3;
  const newPt: CurvePoint = {
    x: clampedX,
    y,
    inTangent: { dx: -dx, dy: -slope * dx },
    outTangent: { dx, dy: slope * dx },
    mode,
  };

  pts.splice(insertIdx, 0, newPt);
  const updated = recomputePointTangents(pts, curve.xRange);
  return { curve: syncLevelPoints(curve, updated), index: insertIdx };
}

/**
 * Remove control points by indices. Preserves endpoints if `fixedEndpoints` is enabled,
 * and always keeps at least 2 points.
 */
export function removeCurvePoints(
  curve: Curve,
  indices: Iterable<number>,
  opts?: { fixedEndpoints?: boolean },
): Curve {
  const fixed = opts?.fixedEndpoints ?? curve.fixedEndpoints !== false;
  const n = curve.points.length;
  if (n <= 2) return curve;

  const toDelete = new Set<number>();
  for (const idx of indices) {
    if (idx < 0 || idx >= n) continue;
    if (fixed && (idx === 0 || idx === n - 1)) continue;
    toDelete.add(idx);
  }
  if (toDelete.size === 0) return curve;

  const remaining = curve.points.filter((_, idx) => !toDelete.has(idx)).map(cloneCurvePoint);
  while (remaining.length < 2 && curve.points.length >= 2) {
    remaining.push(cloneCurvePoint(curve.points[curve.points.length - 1] as CurvePoint));
  }
  const updated = recomputePointTangents(remaining, curve.xRange);
  return syncLevelPoints(curve, updated);
}

export interface MovePointOptions {
  fixedEndpoints?: boolean;
  clampXToRange?: boolean;
  clampYToRange?: boolean;
}

/**
 * Move a single control point while maintaining strict ascending X order between neighbours.
 */
export function moveCurvePoint(
  curve: Curve,
  index: number,
  x: number,
  y: number,
  opts?: MovePointOptions,
): Curve {
  const n = curve.points.length;
  if (index < 0 || index >= n) return curve;
  const fixed = opts?.fixedEndpoints ?? curve.fixedEndpoints !== false;
  const pts = curve.points.map(cloneCurvePoint);
  const target = pts[index] as CurvePoint;

  let nextX: number;
  if (fixed && index === 0) {
    nextX = curve.xRange[0];
  } else if (fixed && index === n - 1) {
    nextX = curve.xRange[1];
  } else {
    const minX = index > 0 ? (pts[index - 1] as CurvePoint).x + MIN_X_GAP : opts?.clampXToRange ? curve.xRange[0] : -Infinity;
    const maxX = index < n - 1 ? (pts[index + 1] as CurvePoint).x - MIN_X_GAP : opts?.clampXToRange ? curve.xRange[1] : Infinity;
    nextX = clamp(x, minX, maxX);
  }

  const nextY = opts?.clampYToRange ? clamp(y, curve.yRange[0], curve.yRange[1]) : y;
  target.x = nextX;
  target.y = nextY;

  const updated = recomputePointTangents(pts, curve.xRange);
  return syncLevelPoints(curve, updated);
}

/**
 * Move multiple selected points by `(deltaX, deltaY)` respecting neighbor ordering and fixed endpoints.
 */
export function moveCurvePointsByDelta(
  curve: Curve,
  indices: readonly number[],
  deltaX: number,
  deltaY: number,
  opts?: MovePointOptions,
): Curve {
  if (indices.length === 0) return curve;
  const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < curve.points.length).sort((a, b) => a - b);
  let cur = curve;
  // Move in direction that doesn't collide with unselected/selected neighbors
  const order = deltaX >= 0 ? [...sorted].reverse() : sorted;
  for (const idx of order) {
    const p = cur.points[idx];
    if (!p) continue;
    cur = moveCurvePoint(cur, idx, p.x + deltaX, p.y + deltaY, opts);
  }
  return cur;
}

/**
 * Set a point's incoming or outgoing tangent vector `(dx, dy)` and update its opposite tangent
 * according to the point's `TangentMode` (`mirrored`, `aligned`, `free`).
 */
export function setPointTangent(
  curve: Curve,
  index: number,
  side: 'in' | 'out',
  dx: number,
  dy: number,
  breakTangents = false,
): Curve {
  const n = curve.points.length;
  if (index < 0 || index >= n) return curve;
  const pts = curve.points.map(cloneCurvePoint);
  const pt = pts[index] as CurvePoint;

  // Constrain dx so incoming handle stays on left (dx <= -eps) and outgoing stays on right (dx >= eps)
  const span = Math.max(1e-3, curve.xRange[1] - curve.xRange[0]);
  const minDx = span * 0.005;
  const clampedDx = side === 'in' ? Math.min(-minDx, dx) : Math.max(minDx, dx);

  if (breakTangents) {
    pt.mode = 'free';
  } else if (pt.mode === 'auto' || pt.mode === 'smooth' || pt.mode === 'linear' || pt.mode === 'flat' || pt.mode === 'stepped' || pt.mode === 'constant') {
    pt.mode = 'aligned';
  }

  if (side === 'in') {
    pt.inTangent = { dx: clampedDx, dy };
    if (pt.mode === 'mirrored') {
      pt.outTangent = { dx: -clampedDx, dy: -dy };
    } else if (pt.mode === 'aligned') {
      const inLen = Math.hypot(clampedDx, dy);
      const outLen = Math.max(minDx, Math.hypot(pt.outTangent.dx, pt.outTangent.dy));
      if (inLen > 1e-6) {
        const scale = outLen / inLen;
        pt.outTangent = { dx: Math.max(minDx, -clampedDx * scale), dy: -dy * scale };
      }
    }
  } else {
    pt.outTangent = { dx: clampedDx, dy };
    if (pt.mode === 'mirrored') {
      pt.inTangent = { dx: -clampedDx, dy: -dy };
    } else if (pt.mode === 'aligned') {
      const outLen = Math.hypot(clampedDx, dy);
      const inLen = Math.max(minDx, Math.hypot(pt.inTangent.dx, pt.inTangent.dy));
      if (outLen > 1e-6) {
        const scale = inLen / outLen;
        pt.inTangent = { dx: Math.min(-minDx, -clampedDx * scale), dy: -dy * scale };
      }
    }
  }

  const updated = recomputePointTangents(pts, curve.xRange);
  return syncLevelPoints(curve, updated);
}

/**
 * Change the tangent mode on one or more points and recompute their tangents accordingly.
 */
export function setPointsTangentMode(
  curve: Curve,
  indices: Iterable<number>,
  mode: TangentMode,
): Curve {
  const pts = curve.points.map(cloneCurvePoint);
  const n = pts.length;
  const span = Math.max(1e-3, curve.xRange[1] - curve.xRange[0]);

  for (const i of indices) {
    if (i < 0 || i >= n) continue;
    const pt = pts[i] as CurvePoint;
    pt.mode = mode;

    if (mode === 'mirrored') {
      const dx = Math.max(span * 0.05, Math.abs(pt.outTangent.dx) || span * 0.1);
      const slope = Math.abs(pt.outTangent.dx) > 1e-6 ? pt.outTangent.dy / pt.outTangent.dx : computeAutoSlope(pts, i);
      pt.outTangent = { dx, dy: slope * dx };
      pt.inTangent = { dx: -dx, dy: -slope * dx };
    } else if (mode === 'aligned') {
      const slope = Math.abs(pt.outTangent.dx) > 1e-6 ? pt.outTangent.dy / pt.outTangent.dx : computeAutoSlope(pts, i);
      const inDx = Math.min(-span * 0.04, pt.inTangent.dx || -span * 0.1);
      const outDx = Math.max(span * 0.04, pt.outTangent.dx || span * 0.1);
      pt.inTangent = { dx: inDx, dy: slope * inDx };
      pt.outTangent = { dx: outDx, dy: slope * outDx };
    } else if (mode === 'free') {
      if (Math.abs(pt.inTangent.dx) < 1e-5) pt.inTangent.dx = -span * 0.1;
      if (Math.abs(pt.outTangent.dx) < 1e-5) pt.outTangent.dx = span * 0.1;
    }
  }

  const updated = recomputePointTangents(pts, curve.xRange);
  return syncLevelPoints(curve, updated);
}

/**
 * Flip the curve horizontally across `xRange` (reverses X and swaps/negates in/out tangents).
 */
export function flipCurveHorizontal(curve: Curve): Curve {
  const [x0, x1] = curve.xRange;
  const flipped = curve.points
    .map((p): CurvePoint => ({
      x: x0 + x1 - p.x,
      y: p.y,
      inTangent: { dx: -p.outTangent.dx, dy: p.outTangent.dy },
      outTangent: { dx: -p.inTangent.dx, dy: p.inTangent.dy },
      mode: p.mode,
      ...(p.weight !== undefined ? { weight: p.weight } : {}),
    }))
    .reverse();
  const updated = recomputePointTangents(flipped, curve.xRange);
  return syncLevelPoints(curve, updated);
}

/**
 * Flip the curve vertically across `yRange` (inverts Y and negates tangent dy).
 */
export function flipCurveVertical(curve: Curve): Curve {
  const [y0, y1] = curve.yRange;
  const flipped = curve.points.map((p): CurvePoint => ({
    x: p.x,
    y: y0 + y1 - p.y,
    inTangent: { dx: p.inTangent.dx, dy: -p.inTangent.dy },
    outTangent: { dx: p.outTangent.dx, dy: -p.outTangent.dy },
    mode: p.mode,
    ...(p.weight !== undefined ? { weight: p.weight } : {}),
  }));
  const updated = recomputePointTangents(flipped, curve.xRange);
  return syncLevelPoints(curve, updated);
}

/**
 * Reverse the curve along X (alias for horizontal flip that reverses start-to-end profile).
 */
export function reverseCurve(curve: Curve): Curve {
  return flipCurveHorizontal(curve);
}

/**
 * Mirror one half of the curve onto the other half across the midpoint of `xRange`.
 */
export function mirrorCurve(curve: Curve, direction: 'leftToRight' | 'rightToLeft' = 'leftToRight'): Curve {
  const [x0, x1] = curve.xRange;
  const mid = (x0 + x1) * 0.5;
  const midY = evaluateCurve(curve, mid);

  if (direction === 'leftToRight') {
    const left = curve.points.filter((p) => p.x < mid - MIN_X_GAP).map(cloneCurvePoint);
    const center: CurvePoint = {
      x: mid,
      y: midY,
      inTangent: { dx: -(x1 - x0) * 0.08, dy: 0 },
      outTangent: { dx: (x1 - x0) * 0.08, dy: 0 },
      mode: 'flat',
    };
    const right = left
      .map((p): CurvePoint => ({
        x: x0 + x1 - p.x,
        y: p.y,
        inTangent: { dx: -p.outTangent.dx, dy: p.outTangent.dy },
        outTangent: { dx: -p.inTangent.dx, dy: p.inTangent.dy },
        mode: p.mode,
      }))
      .reverse();
    const combined = [...left, center, ...right];
    return normalizeCurve({ ...curve, points: combined });
  }

  const right = curve.points.filter((p) => p.x > mid + MIN_X_GAP).map(cloneCurvePoint);
  const center: CurvePoint = {
    x: mid,
    y: midY,
    inTangent: { dx: -(x1 - x0) * 0.08, dy: 0 },
    outTangent: { dx: (x1 - x0) * 0.08, dy: 0 },
    mode: 'flat',
  };
  const left = right
    .map((p): CurvePoint => ({
      x: x0 + x1 - p.x,
      y: p.y,
      inTangent: { dx: -p.outTangent.dx, dy: p.outTangent.dy },
      outTangent: { dx: -p.inTangent.dx, dy: p.inTangent.dy },
      mode: p.mode,
    }))
    .reverse();
  const combined = [...left, center, ...right];
  return normalizeCurve({ ...curve, points: combined });
}

/**
 * Scale and offset selected points around `(pivotX, pivotY)`.
 */
export function scaleOffsetCurvePoints(
  curve: Curve,
  indices: Iterable<number>,
  scaleX: number,
  scaleY: number,
  offsetX = 0,
  offsetY = 0,
  pivotX = curve.xRange[0],
  pivotY = curve.yRange[0],
): Curve {
  const selected = new Set(indices);
  if (selected.size === 0) {
    for (let i = 0; i < curve.points.length; i++) selected.add(i);
  }
  const fixed = curve.fixedEndpoints !== false;
  const n = curve.points.length;
  const pts = curve.points.map((p, i) => {
    const pt = cloneCurvePoint(p);
    if (!selected.has(i)) return pt;
    const lockX = fixed && (i === 0 || i === n - 1);
    if (!lockX) {
      pt.x = pivotX + (pt.x - pivotX) * scaleX + offsetX;
    }
    pt.y = pivotY + (pt.y - pivotY) * scaleY + offsetY;
    pt.inTangent.dx *= scaleX;
    pt.inTangent.dy *= scaleY;
    pt.outTangent.dx *= scaleX;
    pt.outTangent.dy *= scaleY;
    return pt;
  });
  return normalizeCurve({ ...curve, points: pts });
}

/**
 * Smooth selected points (or all interior points) by relaxing Y toward neighbor average and setting mode to 'auto'.
 */
export function smoothCurvePoints(
  curve: Curve,
  indices?: Iterable<number>,
  factor = 0.5,
): Curve {
  const n = curve.points.length;
  const selected = indices ? new Set(indices) : new Set(curve.points.map((_, i) => i));
  const k = clamp(factor, 0, 1);

  const pts = curve.points.map((p, i) => {
    const pt = cloneCurvePoint(p);
    if (!selected.has(i)) return pt;
    pt.mode = 'auto';
    if (i > 0 && i < n - 1) {
      const prev = curve.points[i - 1] as CurvePoint;
      const next = curve.points[i + 1] as CurvePoint;
      const span = next.x - prev.x;
      const interpY = span > 1e-6 ? prev.y + ((pt.x - prev.x) / span) * (next.y - prev.y) : (prev.y + next.y) * 0.5;
      pt.y = pt.y + (interpY - pt.y) * k;
    }
    return pt;
  });

  const updated = recomputePointTangents(pts, curve.xRange);
  return syncLevelPoints(curve, updated);
}

function perpendicularDistance(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  xScale: number,
  yScale: number,
): number {
  const px = p.x * xScale;
  const py = p.y * yScale;
  const ax = a.x * xScale;
  const ay = a.y * yScale;
  const bx = b.x * xScale;
  const by = b.y * yScale;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function rdpIndices(
  pts: readonly { x: number; y: number }[],
  start: number,
  end: number,
  tolerance: number,
  xScale: number,
  yScale: number,
  keep: Set<number>,
): void {
  if (end <= start + 1) return;
  const a = pts[start] as { x: number; y: number };
  const b = pts[end] as { x: number; y: number };
  let maxDist = -1;
  let maxIdx = -1;
  for (let i = start + 1; i < end; i++) {
    const d = perpendicularDistance(pts[i] as { x: number; y: number }, a, b, xScale, yScale);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > tolerance && maxIdx !== -1) {
    keep.add(maxIdx);
    rdpIndices(pts, start, maxIdx, tolerance, xScale, yScale, keep);
    rdpIndices(pts, maxIdx, end, tolerance, xScale, yScale, keep);
  }
}

/**
 * Simplify a curve using Ramer-Douglas-Peucker in normalized domain space, preserving endpoints.
 */
export function simplifyCurve(curve: Curve, tolerance = 0.02): Curve {
  const n = curve.points.length;
  if (n <= 2) return curve;
  const xSpan = Math.max(1e-4, curve.xRange[1] - curve.xRange[0]);
  const ySpan = Math.max(1e-4, curve.yRange[1] - curve.yRange[0]);
  const keep = new Set<number>([0, n - 1]);
  rdpIndices(curve.points, 0, n - 1, tolerance, 1 / xSpan, 1 / ySpan, keep);

  const reduced = curve.points.filter((_, idx) => keep.has(idx)).map((p) => ({
    ...cloneCurvePoint(p),
    mode: p.mode === 'linear' ? ('linear' as const) : ('auto' as const),
  }));
  const updated = recomputePointTangents(reduced, curve.xRange);
  return syncLevelPoints(curve, updated);
}

/**
 * Convert a freehand drawn stroke (`samples` in curve coordinates) into a clean, simplified Curve
 * (powers the `Draw` tool in the Curve Editor toolbar).
 */
export function fitCurveFromStroke(
  samples: readonly { x: number; y: number }[],
  baseCurve: Curve,
  tolerance = 0.018,
): Curve {
  if (samples.length === 0) return baseCurve;
  const [xMin, xMax] = baseCurve.xRange;
  const [yMin, yMax] = baseCurve.yRange;

  // Sort samples by ascending x and deduplicate close x values
  const sorted = samples
    .map((s) => ({ x: clamp(s.x, xMin, xMax), y: clamp(s.y, yMin, yMax) }))
    .sort((a, b) => a.x - b.x);

  const filtered: { x: number; y: number }[] = [];
  for (const s of sorted) {
    const last = filtered[filtered.length - 1];
    if (!last || s.x - last.x >= MIN_X_GAP * 5) {
      filtered.push(s);
    } else {
      last.y = (last.y + s.y) * 0.5;
    }
  }

  if (filtered.length === 0) return baseCurve;
  const firstSample = filtered[0] as { x: number; y: number };
  const lastSample = filtered[filtered.length - 1] as { x: number; y: number };

  if (baseCurve.fixedEndpoints !== false) {
    if (firstSample.x > xMin + MIN_X_GAP) {
      filtered.unshift({ x: xMin, y: firstSample.y });
    } else {
      firstSample.x = xMin;
    }
    if (lastSample.x < xMax - MIN_X_GAP) {
      filtered.push({ x: xMax, y: lastSample.y });
    } else {
      lastSample.x = xMax;
    }
  }

  const rawPoints: CurvePoint[] = filtered.map((s) => ({
    x: s.x,
    y: s.y,
    inTangent: { dx: -0.05, dy: 0 },
    outTangent: { dx: 0.05, dy: 0 },
    mode: 'auto',
  }));

  const rawCurve: Curve = {
    ...baseCurve,
    points: recomputePointTangents(rawPoints, baseCurve.xRange),
  };
  return simplifyCurve(rawCurve, tolerance);
}

/**
 * Switch the active parent-level curve (1..5), storing current points in `levelCurves` and loading
 * or cloning points for `newLevel`.
 */
export function switchCurveLevel(curve: Curve, newLevel: number): Curve {
  const lvl = Math.max(1, Math.round(newLevel));
  const curLevel = curve.level ?? 1;
  if (lvl === curLevel && curve.level !== undefined) return curve;

  const map: Record<number, CurvePoint[]> = { ...(curve.levelCurves ?? {}) };
  map[curLevel] = curve.points.map(cloneCurvePoint);

  const targetPts = map[lvl] ? map[lvl].map(cloneCurvePoint) : curve.points.map(cloneCurvePoint);
  map[lvl] = targetPts;

  return {
    ...curve,
    level: lvl,
    points: recomputePointTangents(targetPts, curve.xRange),
    levelCurves: map,
  };
}

const VALID_MODES = new Set<TangentMode>([
  'auto',
  'smooth',
  'linear',
  'flat',
  'free',
  'stepped',
  'constant',
  'aligned',
  'mirrored',
]);
const VALID_WRAPS = new Set<WrapMode>(['clamp', 'loop', 'repeat', 'pingpong']);

export function serializeCurve(curve: Curve): string {
  return JSON.stringify({
    format: 'kekenik-curve-v1',
    curve: cloneCurve(curve),
  });
}

export function deserializeCurve(json: string): Curve | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = ('curve' in parsed ? (parsed as { curve: unknown }).curve : parsed) as Record<string, unknown>;
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.points) || raw.points.length === 0) return null;

    const xRange: [number, number] =
      Array.isArray(raw.xRange) && typeof raw.xRange[0] === 'number' && typeof raw.xRange[1] === 'number'
        ? [raw.xRange[0], raw.xRange[1]]
        : [0, 1];
    const yRange: [number, number] =
      Array.isArray(raw.yRange) && typeof raw.yRange[0] === 'number' && typeof raw.yRange[1] === 'number'
        ? [raw.yRange[0], raw.yRange[1]]
        : [0, 1];
    const wrap: WrapMode = typeof raw.wrap === 'string' && VALID_WRAPS.has(raw.wrap as WrapMode) ? (raw.wrap as WrapMode) : 'clamp';

    const points: CurvePoint[] = [];
    for (const item of raw.points) {
      if (typeof item !== 'object' || item === null) continue;
      const p = item as Record<string, unknown>;
      if (typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const inT = (typeof p.inTangent === 'object' && p.inTangent !== null ? p.inTangent : {}) as Record<string, unknown>;
      const outT = (typeof p.outTangent === 'object' && p.outTangent !== null ? p.outTangent : {}) as Record<string, unknown>;
      const mode: TangentMode =
        typeof p.mode === 'string' && VALID_MODES.has(p.mode as TangentMode) ? (p.mode as TangentMode) : 'auto';
      points.push({
        x: p.x,
        y: p.y,
        inTangent: {
          dx: typeof inT.dx === 'number' && Number.isFinite(inT.dx) ? inT.dx : -0.1,
          dy: typeof inT.dy === 'number' && Number.isFinite(inT.dy) ? inT.dy : 0,
        },
        outTangent: {
          dx: typeof outT.dx === 'number' && Number.isFinite(outT.dx) ? outT.dx : 0.1,
          dy: typeof outT.dy === 'number' && Number.isFinite(outT.dy) ? outT.dy : 0,
        },
        mode,
        ...(typeof p.weight === 'number' && Number.isFinite(p.weight) ? { weight: p.weight } : {}),
      });
    }

    if (points.length === 0) return null;
    const out: Curve = {
      points,
      xRange,
      yRange,
      wrap,
      ...(typeof raw.fixedEndpoints === 'boolean' ? { fixedEndpoints: raw.fixedEndpoints } : {}),
      ...(raw.valueMode === 'relative' || raw.valueMode === 'absolute' ? { valueMode: raw.valueMode } : {}),
      ...(typeof raw.level === 'number' ? { level: raw.level } : {}),
    };
    return normalizeCurve(out);
  } catch {
    return null;
  }
}

export async function copyCurveClipboard(curve: Curve): Promise<string> {
  const text = serializeCurve(curve);
  memoryClipboardCurve = text;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
  } catch {
    // Fallback to in-memory clipboard if permission denied or headless
  }
  return text;
}

export async function pasteCurveClipboard(): Promise<Curve | null> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
      const text = await navigator.clipboard.readText();
      const parsed = deserializeCurve(text);
      if (parsed) return parsed;
    }
  } catch {
    // Fallback to in-memory clipboard
  }
  return memoryClipboardCurve ? deserializeCurve(memoryClipboardCurve) : null;
}
