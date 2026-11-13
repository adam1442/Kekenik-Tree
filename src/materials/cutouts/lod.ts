import type { CutoutLodVariant, CutoutMesh, LodLevel, TessellationMode } from '@/contracts/material';
import { triangulateCutout, type Point2 } from './triangulate';

/** Flatten Point2[] to [u0, v0, u1, v1, ...]. */
export function flattenPoints2(pts: readonly Point2[]): number[] {
  const out = new Array<number>(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as Point2;
    out[i * 2] = p[0];
    out[i * 2 + 1] = p[1];
  }
  return out;
}

/**
 * Remove `dropCount` lowest-importance vertices from a polygon outline while keeping at least 3 vertices
 * and protecting the vertex closest to `pivot`.
 */
export function decimateOutline(
  outline: readonly Point2[],
  dropCount: number,
  pivot: Point2 = [0.5, 0],
): Point2[] {
  const pts = outline.map((p): Point2 => [p[0], p[1]]);
  const targetLen = Math.max(3, outline.length - Math.max(0, dropCount));
  while (pts.length > targetLen) {
    // Find pivot index in current ring so we avoid collapsing the stem base vertex
    let pivotIdx = 0;
    let bestPivotDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i] as Point2;
      const d = Math.hypot(p[0] - pivot[0], p[1] - pivot[1]);
      if (d < bestPivotDist) {
        bestPivotDist = d;
        pivotIdx = i;
      }
    }

    let removeIdx = -1;
    let minImportance = Infinity;
    const m = pts.length;
    for (let i = 0; i < m; i++) {
      if (i === pivotIdx && m > 3) continue;
      const prev = pts[(i + m - 1) % m] as Point2;
      const curr = pts[i] as Point2;
      const next = pts[(i + 1) % m] as Point2;
      // Visvalingam-Whyatt triangle area + edge length weight
      const area = Math.abs((curr[0] - prev[0]) * (next[1] - prev[1]) - (next[0] - prev[0]) * (curr[1] - prev[1]));
      const chord = Math.hypot(next[0] - prev[0], next[1] - prev[1]) + 1e-4;
      const importance = area + 0.015 * chord;
      if (importance < minImportance) {
        minImportance = importance;
        removeIdx = i;
      }
    }
    if (removeIdx < 0) removeIdx = (pivotIdx + 1) % pts.length;
    pts.splice(removeIdx, 1);
  }
  return pts;
}

/**
 * Build a single CutoutLodVariant for `level` given an outline, interior points, pivot, tessellation mode,
 * and user `step` offset.
 *
 * Total reduction steps:
 * - High: max(0, step)
 * - Med:  max(1, 1 + step)
 * - Low:  max(2, 3 + step)
 */
export function buildLodVariant(
  level: LodLevel,
  outline: readonly Point2[],
  interiorPoints: readonly Point2[],
  pivot: Point2,
  mode: TessellationMode,
  step = 0,
  existing?: Partial<CutoutLodVariant>,
): CutoutLodVariant {
  if (existing?.importedMesh) {
    return {
      level,
      step,
      vertices: existing.vertices ?? [],
      indices: existing.indices ?? existing.importedMesh.indices,
      sourceName: existing.sourceName || existing.importedMesh.fileName || 'Imported',
      importedMesh: existing.importedMesh,
    };
  }

  const baseTotalVerts = outline.length + interiorPoints.length;
  let reduction =
    level === 'high'
      ? Math.max(0, step)
      : level === 'med'
        ? Math.max(1, 1 + step)
        : Math.max(2, 3 + step);

  // Clamp reduction so at least 3 vertices remain
  reduction = Math.min(Math.max(0, baseTotalVerts - 3), reduction);

  // For Med (reduction === 1 with >= 5 boundary vertices), decimate boundary first while keeping interior points
  // so 3D curvature is preserved and Euler counts match V:7 F:6 -> Low drops interior points to V:5 F:3.
  let keptInterior: Point2[];
  let outDrop = 0;
  if (level === 'med' && reduction === 1 && outline.length >= 5 && interiorPoints.length > 0) {
    keptInterior = interiorPoints.map((p): Point2 => [p[0], p[1]]);
    outDrop = 1;
  } else if (reduction <= interiorPoints.length) {
    keptInterior = interiorPoints.slice(0, interiorPoints.length - reduction);
  } else {
    keptInterior = [];
    outDrop = reduction - interiorPoints.length;
  }

  const decimatedOutline = outDrop > 0 ? decimateOutline(outline, outDrop, pivot) : outline;
  const tri = triangulateCutout(decimatedOutline, keptInterior, mode);

  return {
    level,
    step,
    vertices: flattenPoints2(tri.vertices),
    indices: tri.indices,
    sourceName: existing?.sourceName ?? 'Embedded',
    importedMesh: null,
  };
}

/**
 * Recompute all three LOD variants (High, Med, Low) of a `CutoutMesh` in place and update its base `indices`.
 * Guarantees `V(High) >= V(Med) >= V(Low) >= 3`.
 */
export function rebuildCutoutLods(cutout: CutoutMesh): void {
  const mode = cutout.settings.tessellation;
  const highStep = cutout.lods?.high?.step ?? 0;
  const medStep = cutout.lods?.med?.step ?? 0;
  const lowStep = cutout.lods?.low?.step ?? 0;

  const high = buildLodVariant(
    'high',
    cutout.outline,
    cutout.interiorPoints,
    cutout.pivot,
    mode,
    highStep,
    cutout.lods?.high,
  );

  // Ensure Med drops at least 1 vertex relative to High when High has > 4 vertices
  const highVCount = Math.floor(high.vertices.length / 2);
  let med = buildLodVariant(
    'med',
    cutout.outline,
    cutout.interiorPoints,
    cutout.pivot,
    mode,
    medStep,
    cutout.lods?.med,
  );
  if (!med.importedMesh && Math.floor(med.vertices.length / 2) > highVCount) {
    med = buildLodVariant('med', cutout.outline, cutout.interiorPoints, cutout.pivot, mode, highStep, cutout.lods?.med);
  }

  const medVCount = Math.floor(med.vertices.length / 2);
  let low = buildLodVariant(
    'low',
    cutout.outline,
    cutout.interiorPoints,
    cutout.pivot,
    mode,
    lowStep,
    cutout.lods?.low,
  );
  if (!low.importedMesh && Math.floor(low.vertices.length / 2) > medVCount) {
    low = buildLodVariant('low', cutout.outline, cutout.interiorPoints, cutout.pivot, mode, Math.max(medStep, highStep) + 1, cutout.lods?.low);
  }

  cutout.indices = [...high.indices];
  cutout.lods = { high, med, low };
}

/** Vertex and triangle face counts of a LOD variant (handles both 2D cutout and imported 3D mesh). */
export function lodCounts(lod: CutoutLodVariant): { vertices: number; faces: number } {
  if (lod.importedMesh) {
    return {
      vertices: Math.floor(lod.importedMesh.positions.length / 3),
      faces: Math.floor(lod.importedMesh.indices.length / 3),
    };
  }
  return {
    vertices: Math.floor(lod.vertices.length / 2),
    faces: Math.floor(lod.indices.length / 3),
  };
}
