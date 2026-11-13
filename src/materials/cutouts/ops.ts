import type {
  CutoutAnchor,
  CutoutMesh,
  CutoutPaintLayers,
  CutoutTessellationSettings,
  MeshTransformSettings,
  MeshWindDirectionSettings,
  UVAreaDef,
} from '@/contracts/material';
import type { RGBA } from '@/contracts/params';
import { uid } from '@/core/id';
import { defaultAxisFor, sortAnchorsByAxisT } from './frame';
import { rebuildCutoutLods } from './lod';
import {
  ensureCCW,
  generateTessellationPoints,
  pointInPolygon,
  pointToSegment,
  samplePolyline,
  segmentsProperlyIntersect,
  type Point2,
} from './triangulate';

export function defaultTessellationSettings(): CutoutTessellationSettings {
  return {
    angle: 0,
    tessellation: 'Triangular',
    tessAmount: 0,
    refineEdges: 0,
    snapThreshold: 0.025,
    doubleSided: false,
    opacityMargin: 0.1,
    opacityMarginEnabled: false,
  };
}

export function defaultMeshTransform(): MeshTransformSettings {
  return {
    orient: 'Z-Up Right-handed',
    flip: 'X Y Z',
    flipNormals: false,
    fixWinding: false,
  };
}

export function defaultMeshWindDirection(): MeshWindDirectionSettings {
  return {
    growth: '+Y',
    ripple: 'Normal',
  };
}

export function createEmptyPaintLayers(vertexCount: number): CutoutPaintLayers {
  const vertexMask = new Array<number>(vertexCount).fill(1);
  const vertexColor: number[] = [];
  for (let i = 0; i < vertexCount; i++) vertexColor.push(1, 1, 1, 1);
  const vertexSection = new Array<number>(vertexCount).fill(1);
  return { vertexMask, vertexColor, vertexSection };
}

/** Ensure per-vertex paint arrays match `totalVertices = outline.length + interiorPoints.length`. */
export function syncPaintArrays(cutout: CutoutMesh): void {
  const total = cutout.outline.length + cutout.interiorPoints.length;
  const p = cutout.paint;
  while (p.vertexMask.length < total) p.vertexMask.push(1);
  if (p.vertexMask.length > total) p.vertexMask.length = total;

  while (p.vertexColor.length < total * 4) p.vertexColor.push(1, 1, 1, 1);
  if (p.vertexColor.length > total * 4) p.vertexColor.length = total * 4;

  while (p.vertexSection.length < total) p.vertexSection.push(1);
  if (p.vertexSection.length > total) p.vertexSection.length = total;
}

/**
 * Create a default quad/card CutoutMesh covering the full [0, 1] x [0, 1] UV space.
 */
export function createDefaultCutoutMesh(id: string, name: string, materialId = 'leaf'): CutoutMesh {
  const outline: Point2[] = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  const cutout: CutoutMesh = {
    id,
    name,
    materialId,
    outline,
    interiorPoints: [],
    indices: [0, 1, 2, 0, 2, 3],
    lods: {} as CutoutMesh['lods'],
    straightenAxis: [
      [0.5, 0],
      [0.5, 1],
    ],
    straightenLinear: false,
    anchors: [
      { id: uid('anc'), uv: [0.5, 0.25], handleUv: [0.5, 0.34] },
      { id: uid('anc'), uv: [0.5, 0.65], handleUv: [0.5, 0.74] },
    ],
    paint: createEmptyPaintLayers(outline.length),
    pivot: [0.5, 0],
    doubleSided: false,
    settings: defaultTessellationSettings(),
    boundsMeters: [1, 1],
    scale: 1,
    transform: defaultMeshTransform(),
    windDirection: defaultMeshWindDirection(),
    uvAreaId: null,
  };
  rebuildCutoutLods(cutout);
  return cutout;
}

/**
 * Create the 8-vertex, 7-face polygon cutout
 * (High V:8 F:7, Med V:7 F:6, Low V:5 F:3, with stem anchors).
 */
export function createReferenceClusterCutout(
  id: string,
  name: string,
  materialId = 'cluster',
  anchorCount: 2 | 4 = 2,
): CutoutMesh {
  // Note: v=0 is bottom (stem base), v=1 is top (leaf cluster tip)
  const outline: Point2[] = ensureCCW([
    [0.47, 0.01], // bottom stem pivot
    [0.99, 0.38], // mid-right
    [0.93, 0.88], // top-right
    [0.51, 0.97], // top-center
    [0.20, 0.87], // upper-left
    [0.02, 0.43], // mid-left
    [0.08, 0.20], // lower-left
  ]);
  const interiorPoints: Point2[] = [[0.47, 0.44]];
  const anchors: CutoutAnchor[] =
    anchorCount === 4
      ? [
          { id: uid('anc'), uv: [0.47, 0.26], handleUv: [0.47, 0.35] },
          { id: uid('anc'), uv: [0.48, 0.63], handleUv: [0.48, 0.72] },
          { id: uid('anc'), uv: [0.27, 0.48], handleUv: [0.21, 0.55] },
          { id: uid('anc'), uv: [0.69, 0.50], handleUv: [0.75, 0.57] },
        ]
      : [
          { id: uid('anc'), uv: [0.47, 0.26], handleUv: [0.47, 0.35] },
          { id: uid('anc'), uv: [0.48, 0.63], handleUv: [0.48, 0.72] },
        ];

  const cutout: CutoutMesh = {
    id,
    name,
    materialId,
    outline,
    interiorPoints,
    indices: [],
    lods: {} as CutoutMesh['lods'],
    straightenAxis: [
      [0.47, 0],
      [0.47, 0.44],
      [0.48, 1],
    ],
    straightenLinear: false,
    anchors,
    paint: createEmptyPaintLayers(outline.length + interiorPoints.length),
    pivot: [0.47, 0.01],
    doubleSided: false,
    settings: defaultTessellationSettings(),
    boundsMeters: [0.97, 0.96],
    scale: 1,
    transform: defaultMeshTransform(),
    windDirection: defaultMeshWindDirection(),
    uvAreaId: null,
  };
  rebuildCutoutLods(cutout);
  return cutout;
}

/** Update `boundsMeters` from the outline UV bounding box and `scale`. */
export function updateCutoutBounds(cutout: CutoutMesh, atlasScale = 1): [number, number] {
  if (cutout.outline.length === 0) {
    cutout.boundsMeters = [cutout.scale, cutout.scale];
    return cutout.boundsMeters;
  }
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const [u, v] of cutout.outline) {
    if (u < minU) minU = u;
    if (v < minV) minV = v;
    if (u > maxU) maxU = u;
    if (v > maxV) maxV = v;
  }
  const w = Math.max(0.01, maxU - minU) * atlasScale * cutout.scale;
  const h = Math.max(0.01, maxV - minV) * atlasScale * cutout.scale;
  cutout.boundsMeters = [Math.round(w * 1000) / 1000, Math.round(h * 1000) / 1000];
  return cutout.boundsMeters;
}

/** Reset a cutout's outline and interior vertices back to the default quad covering [0,1]x[0,1]. */
export function resetCutoutOutline(cutout: CutoutMesh): void {
  cutout.outline = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
  ];
  cutout.interiorPoints = [];
  cutout.pivot = [0.5, 0];
  syncPaintArrays(cutout);
  rebuildCutoutLods(cutout);
  updateCutoutBounds(cutout);
}

/**
 * Mirror the cutout outline and interior vertices symmetrically across the vertical axis `u = axisU`
 * (defaults to `cutout.pivot[0]` clamped near 0.5).
 * Takes vertices on the side with more points (or left side `u <= axisU`), keeps center-line vertices,
 * and reflects them across `axisU` to produce a strictly symmetric CCW polygon.
 */
export function mirrorCutoutOutline(cutout: CutoutMesh, explicitAxisU?: number): void {
  const axisU = explicitAxisU ?? (Math.abs(cutout.pivot[0] - 0.5) < 0.25 ? cutout.pivot[0] : 0.5);
  const eps = 0.025;

  const leftSide = cutout.outline.filter(([u]) => u < axisU - eps);
  const rightSide = cutout.outline.filter(([u]) => u > axisU + eps);

  // Pick the side with more points (defaulting to left if equal and non-empty)
  const useLeft = leftSide.length >= rightSide.length && leftSide.length >= 2;
  const sourceSide = (useLeft ? leftSide : rightSide)
    .map(([u, v]): Point2 => [useLeft ? u : 2 * axisU - u, v])
    .sort((a, b) => a[1] - b[1]); // sorted bottom (v=0) to top (v=1)

  if (sourceSide.length < 2) {
    // Fallback if outline had no side vertices: reflect all vertices across axisU and hull/sort
    cutout.outline = ensureCCW(
      cutout.outline.map(([u, v]): Point2 => [Math.max(0, Math.min(1, 2 * axisU - u)), v]),
    );
    rebuildCutoutLods(cutout);
    return;
  }

  // Find bottom-most and top-most center vertices if present
  let minV = Infinity;
  let maxV = -Infinity;
  for (const [, v] of cutout.outline) {
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const mirroredRight: Point2[] = sourceSide.map(([u, v]): Point2 => [
    Math.max(0, Math.min(1, 2 * axisU - u)),
    v,
  ]);
  const mirroredLeft: Point2[] = [...sourceSide]
    .reverse()
    .map(([u, v]): Point2 => [Math.max(0, Math.min(1, u)), v]);

  const newOutline: Point2[] = [
    [axisU, minV],
    ...mirroredRight,
    [axisU, maxV],
    ...mirroredLeft,
  ];

  // Deduplicate adjacent near-identical vertices
  const deduped: Point2[] = [];
  for (const pt of newOutline) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.hypot(prev[0] - pt[0], prev[1] - pt[1]) > 0.015) {
      deduped.push(pt);
    }
  }
  if (
    deduped.length > 3 &&
    Math.hypot(
      (deduped[0] as Point2)[0] - (deduped[deduped.length - 1] as Point2)[0],
      (deduped[0] as Point2)[1] - (deduped[deduped.length - 1] as Point2)[1],
    ) <= 0.015
  ) {
    deduped.pop();
  }

  cutout.outline = ensureCCW(deduped);
  cutout.pivot = [axisU, minV];

  // Mirror interior points symmetrically
  const newInterior: Point2[] = [];
  for (const [u, v] of cutout.interiorPoints) {
    if (!pointInPolygon([u, v], cutout.outline)) continue;
    if (Math.abs(u - axisU) <= eps) {
      newInterior.push([axisU, v]);
    } else {
      const lu = Math.min(u, 2 * axisU - u);
      const ru = Math.max(u, 2 * axisU - u);
      if (pointInPolygon([lu, v], cutout.outline)) newInterior.push([lu, v]);
      if (pointInPolygon([ru, v], cutout.outline)) newInterior.push([ru, v]);
    }
  }
  cutout.interiorPoints = newInterior;
  syncPaintArrays(cutout);
  rebuildCutoutLods(cutout);
  updateCutoutBounds(cutout);
}

/**
 * Recompute interior Steiner points from `cutout.settings.tessAmount` and rebuild LODs.
 */
export function applyTessellationSettings(cutout: CutoutMesh): void {
  cutout.doubleSided = cutout.settings.doubleSided;
  if (cutout.settings.tessAmount > 0.01) {
    cutout.interiorPoints = generateTessellationPoints(
      cutout.outline,
      cutout.settings.tessAmount,
      cutout.straightenAxis,
      cutout.settings.tessellation,
    );
  }
  syncPaintArrays(cutout);
  rebuildCutoutLods(cutout);
}

/**
 * Straighten > Linear: the axis becomes the straight line between its first and last point (mode `linear`).
 * Non-destructive: the outline, UVs and anchors are untouched; the straightening itself happens when the
 * generators build geometry (see `frame.ts`), so the texture is never distorted in the editor.
 */
export function linearizeStraighten(cutout: CutoutMesh): void {
  const axis = cutout.straightenAxis.length >= 2 ? cutout.straightenAxis : defaultAxisFor(cutout);
  cutout.straightenAxis = [[axis[0]![0], axis[0]![1]], [axis[axis.length - 1]![0], axis[axis.length - 1]![1]]];
  cutout.straightenLinear = true;
  syncPivotToAxis(cutout);
  sortAnchorsByAxisT(cutout);
  rebuildCutoutLods(cutout);
}

/** Straighten > Reset: default axis (bottom-centre of the outline bounds straight up to the top-centre), curve mode. */
export function resetStraighten(cutout: CutoutMesh): void {
  cutout.straightenAxis = defaultAxisFor(cutout);
  cutout.straightenLinear = false;
  syncPivotToAxis(cutout);
  sortAnchorsByAxisT(cutout);
  rebuildCutoutLods(cutout);
}

/** The attachment pivot is the first axis point. */
export function syncPivotToAxis(cutout: CutoutMesh): void {
  const first = cutout.straightenAxis[0];
  if (first) cutout.pivot = [first[0], first[1]];
}

export function addAnchor(cutout: CutoutMesh, uv: Point2, handleUv?: Point2): CutoutAnchor {
  const anchor: CutoutAnchor = {
    id: uid('anc'),
    uv: [Math.max(0, Math.min(1, uv[0])), Math.max(0, Math.min(1, uv[1]))],
    handleUv: handleUv
      ? [Math.max(0, Math.min(1, handleUv[0])), Math.max(0, Math.min(1, handleUv[1]))]
      : [Math.max(0, Math.min(1, uv[0])), Math.max(0, Math.min(1, uv[1] + 0.09))],
  };
  cutout.anchors.push(anchor);
  return anchor;
}

export function removeAnchor(cutout: CutoutMesh, anchorId?: string): void {
  if (cutout.anchors.length === 0) return;
  if (anchorId) {
    cutout.anchors = cutout.anchors.filter((a) => a.id !== anchorId);
  } else {
    cutout.anchors.pop();
  }
}

export function resetAnchors(cutout: CutoutMesh): void {
  const axis = cutout.straightenAxis.length >= 2 ? cutout.straightenAxis : defaultAxisFor(cutout);
  const at = (t: number): Point2 => samplePolyline(axis, t);
  cutout.anchors = [0.26, 0.63].map((t) => {
    const p = at(t);
    const q = at(Math.min(1, t + 0.09));
    return { id: uid('anc'), uv: [p[0], p[1]] as Point2, handleUv: [q[0], q[1]] as Point2 };
  });
}

/**
 * Paint a brush stroke in UV space onto the cutout's vertices (and optional 2D grid).
 */
export function applyBrushStroke(
  cutout: CutoutMesh,
  centerUv: Point2,
  radiusUv: number,
  falloff: number,
  channel: 'mask' | 'color' | 'section',
  erase: boolean,
  options: { color?: RGBA; sectionId?: number } = {},
): void {
  syncPaintArrays(cutout);
  const allVerts: Point2[] = [...cutout.outline, ...cutout.interiorPoints];
  const r = Math.max(0.005, radiusUv);
  const innerR = r * Math.max(0, 1 - Math.max(0, Math.min(1, falloff)));

  for (let i = 0; i < allVerts.length; i++) {
    const pt = allVerts[i] as Point2;
    const d = Math.hypot(pt[0] - centerUv[0], pt[1] - centerUv[1]);
    if (d > r) continue;
    const weight = d <= innerR ? 1 : 1 - (d - innerR) / Math.max(1e-6, r - innerR);

    if (channel === 'mask') {
      const cur = cutout.paint.vertexMask[i] ?? 1;
      const target = erase ? 0 : 1;
      cutout.paint.vertexMask[i] = cur + (target - cur) * weight;
    } else if (channel === 'color') {
      const col = erase ? ([1, 1, 1, 1] as RGBA) : (options.color ?? [0.4, 0.85, 0.3, 1]);
      for (let c = 0; c < 4; c++) {
        const cur = cutout.paint.vertexColor[i * 4 + c] ?? 1;
        cutout.paint.vertexColor[i * 4 + c] = cur + (col[c] - cur) * weight;
      }
    } else if (channel === 'section') {
      if (weight >= 0.25) {
        cutout.paint.vertexSection[i] = erase ? 1 : Math.max(1, Math.min(8, Math.round(options.sectionId ?? 1)));
      }
    }
  }
}

export function clearOrFillPaintLayer(
  cutout: CutoutMesh,
  channel: 'mask' | 'color' | 'section',
  fill: boolean,
  options: { color?: RGBA; sectionId?: number } = {},
): void {
  syncPaintArrays(cutout);
  const n = cutout.outline.length + cutout.interiorPoints.length;
  if (channel === 'mask') {
    cutout.paint.vertexMask.fill(fill ? 1 : 0);
  } else if (channel === 'color') {
    const col = fill ? (options.color ?? [0.4, 0.85, 0.3, 1]) : ([1, 1, 1, 1] as RGBA);
    for (let i = 0; i < n; i++) {
      cutout.paint.vertexColor[i * 4] = col[0];
      cutout.paint.vertexColor[i * 4 + 1] = col[1];
      cutout.paint.vertexColor[i * 4 + 2] = col[2];
      cutout.paint.vertexColor[i * 4 + 3] = col[3];
    }
  } else if (channel === 'section') {
    cutout.paint.vertexSection.fill(fill ? Math.max(1, Math.min(8, Math.round(options.sectionId ?? 1))) : 1);
  }
}

export interface UvWarningReport {
  hasWarnings: boolean;
  /** Indices into `[...outline, ...interiorPoints]` that lie outside `[0, 1] x [0, 1]`. */
  outOfBoundsVertices: number[];
  /** Pairs of outline edge indices `[i, j]` that self-intersect. */
  selfIntersectingEdges: [number, number][];
  /** Indices of vertices that overlap another cutout mesh of the same material. */
  overlappingVertices: number[];
}

/**
 * Validate UV bounds (0..1), outline self-intersections, and overlaps with other cutouts of the same material.
 */
export function checkUvWarnings(
  cutout: CutoutMesh,
  otherMeshesOfSameMaterial: readonly CutoutMesh[] = [],
): UvWarningReport {
  const allVerts: Point2[] = [...cutout.outline, ...cutout.interiorPoints];
  const outOfBoundsVertices: number[] = [];
  const eps = 1e-4;
  for (let i = 0; i < allVerts.length; i++) {
    const [u, v] = allVerts[i] as Point2;
    if (u < -eps || u > 1 + eps || v < -eps || v > 1 + eps) {
      outOfBoundsVertices.push(i);
    }
  }

  const selfIntersectingEdges: [number, number][] = [];
  const n = cutout.outline.length;
  for (let i = 0; i < n; i++) {
    const iNext = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const jNext = (j + 1) % n;
      if (i === jNext) continue;
      if (
        segmentsProperlyIntersect(
          cutout.outline[i] as Point2,
          cutout.outline[iNext] as Point2,
          cutout.outline[j] as Point2,
          cutout.outline[jNext] as Point2,
        )
      ) {
        selfIntersectingEdges.push([i, j]);
      }
    }
  }

  const overlappingVertices: number[] = [];
  for (const other of otherMeshesOfSameMaterial) {
    if (other.id === cutout.id || other.outline.length < 3) continue;
    for (let i = 0; i < allVerts.length; i++) {
      if (pointInPolygon(allVerts[i] as Point2, other.outline)) {
        if (!overlappingVertices.includes(i)) overlappingVertices.push(i);
      }
    }
  }

  return {
    hasWarnings:
      outOfBoundsVertices.length > 0 ||
      selfIntersectingEdges.length > 0 ||
      overlappingVertices.length > 0,
    outOfBoundsVertices,
    selfIntersectingEdges,
    overlappingVertices,
  };
}

/** Snap a dragged vertex `pt` to UV bounds (0, 0.5, 1), straighten axis, or other vertices within `threshold`. */
export function snapUvPoint(
  pt: Point2,
  threshold: number,
  otherPoints: readonly Point2[],
  straightenAxis: readonly Point2[] = [],
): Point2 {
  if (threshold <= 1e-4) return [pt[0], pt[1]];
  let [u, v] = pt;
  const r = threshold * 0.12;

  // Snap to UV bounds 0, 0.5, 1
  for (const target of [0, 0.5, 1]) {
    if (Math.abs(u - target) < r) u = target;
    if (Math.abs(v - target) < r) v = target;
  }

  // Snap to straighten axis
  for (let i = 0; i + 1 < straightenAxis.length; i++) {
    const seg = pointToSegment([u, v], straightenAxis[i] as Point2, straightenAxis[i + 1] as Point2);
    if (seg.dist < r) {
      u = seg.proj[0];
      v = seg.proj[1];
      break;
    }
  }

  // Snap to other vertices' u or v alignment
  for (const o of otherPoints) {
    if (Math.abs(u - o[0]) < r * 0.7) u = o[0];
    if (Math.abs(v - o[1]) < r * 0.7) v = o[1];
  }

  return [u, v];
}

export function createDefaultUVArea(id: string, name: string, materialId: string, index = 0): UVAreaDef {
  const col = index % 2;
  const row = Math.floor(index / 2) % 2;
  const u0 = index === 0 ? 0 : col * 0.5;
  const v0 = index === 0 ? 0 : row * 0.5;
  const u1 = index === 0 ? 1 : u0 + 0.5;
  const v1 = index === 0 ? 1 : v0 + 0.5;
  return {
    id,
    name,
    materialId,
    shape: 'rect',
    rect: [u0, v0, u1, v1],
    pivot: [(u0 + u1) * 0.5, v0],
    usage: 'any',
    weight: 1,
  };
}
