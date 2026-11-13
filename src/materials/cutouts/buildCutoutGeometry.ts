import type {
  CutoutLodVariant,
  CutoutMesh,
  ImportedLodMesh,
  LodLevel,
  MeshFlipMode,
  MeshOrientMode,
  WindGrowthAxis,
} from '@/contracts/material';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { cross, dot, len, norm, perpendicular, sub, type V3 } from '@/geometry/math3';
import { cardPointAt, type CardPose } from '@/geometry/cardPose';
import { buildCutoutFrame, cardPoseFor, flipSigns, uvToLocal, type CutoutMetric } from './frame';
import { rebuildCutoutLods } from './lod';
import { pointToSegment, type Point2 } from './triangulate';

/** Extended MeshData carrying per-vertex cutout attributes for shaders, wind, and exporters. */
export interface CutoutMeshData extends MeshData {
  /** Per-vertex section id (1..8) from the Paint > Section [n] tool. */
  cutoutSection?: Uint8Array;
  /** Per-vertex mask weight (0..1) from the Paint > Mask tool. */
  cutoutMask?: Float32Array;
  /** Per-vertex bend weight (0..1) computed from the straighten axis and anchor joints. */
  bendWeights?: Float32Array;
  /** Per-vertex position along the Straighten axis, 0 (attachment base) .. 1 (tip). */
  cutoutAxisT?: Float32Array;
  /** 3D pivot in mesh space. */
  cutoutPivot?: [number, number, number];
}

export interface BuildCutoutGeometryOptions {
  /** World/local origin of the card base (default [0, 0, 0]). */
  origin?: V3;
  /** Growth/length unit axis (default [0, 1, 0]). */
  axis?: V3;
  /** Width/lateral unit axis (default [1, 0, 0]). */
  side?: V3;
  /** Blade length in metres (default cutout.boundsMeters[1]). */
  length?: number;
  /** Blade width in metres (default cutout.boundsMeters[0]). */
  width?: number;
  /** Bend angle along the axis in radians (default 0). */
  bend?: number;
  /** V-fold angle across the midrib in radians (default 0). */
  fold?: number;
  /** Sideways curl amount (default 0). */
  curl?: number;
  /** Twist angle along the axis in radians (default 0). */
  twist?: number;
  /** Base RGB vertex tint (default [1, 1, 1]). */
  color?: V3;
  /** Ambient occlusion factor 0..1 (default 1). */
  ao?: number;
  /** Atlas UV sub-rectangle [u0, v0, u1, v1] (default [0, 0, 1, 1]). */
  atlas?: [number, number, number, number];
  /** Override material id (default cutout.materialId). */
  materialId?: string;
  /** Base wind weights [h0, h1, h2, phase] from parent branch (default [0, 0, 0.2, 0]). */
  wind?: [number, number, number, number];
  /** Lightmap cell index and grid count for UV1 packing. */
  cellIndex?: number;
  cellCount?: number;
  /**
   * Apply the Meshes panel Orient setting to IMPORTED meshes (authored cards are generated in generator space, so
   * Orient is meaningless for them). Default: true when standalone, false when placed.
   */
  applyPanelTransform?: boolean;
  /** Metres per UV unit; overrides length/width/mesh scale (the placed length/width are already node sizes). */
  metric?: CutoutMetric;
}

export function resolveLodLevel(lod: number | LodLevel): LodLevel {
  if (typeof lod === 'string') return lod;
  if (lod <= 0.5) return 'high';
  if (lod <= 1.5) return 'med';
  return 'low';
}

function applyFlip(p: V3, flip: MeshFlipMode): V3 {
  const f = flipSigns(flip);
  return [p[0] * f[0], p[1] * f[1], p[2] * f[2]];
}

function applyOrient(p: V3, orient: MeshOrientMode): V3 {
  switch (orient) {
    case 'Y-Up Right-handed':
      return [p[0], p[2], -p[1]];
    case 'Z-Up Left-handed':
      return [-p[0], p[1], p[2]];
    case 'Y-Up Left-handed':
      return [-p[0], p[2], -p[1]];
    default:
      return p;
  }
}

function growthCoord(p: V3, growth: WindGrowthAxis): number {
  switch (growth) {
    case '+Y': return p[1];
    case '-Y': return -p[1];
    case '+X': return p[0];
    case '-X': return -p[0];
    case '+Z': return p[2];
    case '-Z': return -p[2];
  }
}

/** Normalised growth coordinate (Meshes panel > Wind direction > Growth) of a straightened local point. */
function growthCoordNorm(cutout: CutoutMesh, loc: V3, length: number): number {
  const g = cutout.windDirection?.growth ?? '+Y';
  return Math.max(0, Math.min(1, growthCoord(loc, g) / Math.max(1e-4, length)));
}

/**
 * Compute per-vertex bend weight (0..1) and local anchor pivot in UV space from the cutout's
 * straighten axis and anchors.
 */
export function computeVertexBendAndAnchor(
  uv: Point2,
  cutout: CutoutMesh,
): { bendWeight: number; anchorUv: Point2; lateralDist: number } {
  const [u, v] = uv;
  const pv = cutout.pivot[1];
  const axial = Math.max(0, Math.min(1, (v - pv) / Math.max(0.1, 1 - pv)));

  // Distance to straighten axis
  let minAxisDist = Math.abs(u - cutout.pivot[0]);
  const axis = cutout.straightenAxis;
  for (let i = 0; i + 1 < axis.length; i++) {
    const seg = pointToSegment(uv, axis[i] as Point2, axis[i + 1] as Point2);
    if (seg.dist < minAxisDist) minAxisDist = seg.dist;
  }

  // Find nearest anchor at or below `v` (or closest overall) to serve as local joint pivot
  let bestAnchorUv: Point2 = [cutout.pivot[0], cutout.pivot[1]];
  let bestDist = Infinity;
  for (const a of cutout.anchors) {
    const d = Math.hypot(u - a.uv[0], v - a.uv[1]);
    if (d < bestDist) {
      bestDist = d;
      bestAnchorUv = a.uv;
    }
  }

  // Vertices farther along the stem (axial) and farther laterally from the rigid stem bend more
  const bendWeight = Math.max(0, Math.min(1, Math.pow(axial, 1.15) * 0.75 + Math.min(1, minAxisDist * 2) * 0.25));
  return { bendWeight, anchorUv: bestAnchorUv, lateralDist: minAxisDist };
}

/** Find index of the closest base vertex in `[...cutout.outline, ...cutout.interiorPoints]` to sample paint attributes. */
function findClosestBaseVertex(uv: Point2, baseVerts: readonly Point2[]): number {
  let bestIdx = 0;
  let bestD = Infinity;
  for (let i = 0; i < baseVerts.length; i++) {
    const b = baseVerts[i] as Point2;
    const d = (b[0] - uv[0]) * (b[0] - uv[0]) + (b[1] - uv[1]) * (b[1] - uv[1]);
    if (d < bestD) {
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/**
 * Runtime builder that converts a `CutoutMesh` at `lod` into an engine-ready `CutoutMeshData`.
 */
export function buildCutoutGeometry(
  cutout: CutoutMesh,
  lod: number | LodLevel = 'high',
  opts: BuildCutoutGeometryOptions = {},
): CutoutMeshData {
  if (!cutout.lods || !cutout.lods.high) {
    rebuildCutoutLods(cutout);
  }
  const level = resolveLodLevel(lod);
  const variant: CutoutLodVariant = cutout.lods[level] ?? cutout.lods.high;
  const materialId = opts.materialId || cutout.materialId || 'leaf';

  if (variant.importedMesh && variant.importedMesh.positions.length >= 9) {
    return buildImportedLodGeometry(cutout, variant.importedMesh, materialId, opts);
  }

  const vCount = Math.floor(variant.vertices.length / 2);
  const iCount = variant.indices.length;
  if (vCount < 3 || iCount < 3) return emptyMeshData();

  const origin: V3 = opts.origin ?? [0, 0, 0];
  const axis: V3 = norm(opts.axis ?? [0, 1, 0]);
  const side: V3 = norm(opts.side ?? [1, 0, 0]);
  const n0: V3 = norm(cross(side, axis), [0, 0, 1]);

  const applyPanel = opts.applyPanelTransform ?? (opts.origin === undefined);
  // UV unit square -> metres. Placed cards: node width/height x mesh Scale; standalone: bounds x mesh Scale.
  const meshScale = Math.max(0.001, cutout.scale || 1);
  const metric: CutoutMetric = opts.metric ?? {
    w: Math.max(1e-5, (opts.width ?? (cutout.boundsMeters?.[0] || 1)) * meshScale),
    h: Math.max(1e-5, (opts.length ?? (cutout.boundsMeters?.[1] || 1)) * meshScale),
  };
  const frame = buildCutoutFrame(cutout, metric);
  const length = frame.length;
  const pose: CardPose = cardPoseFor(frame, { origin, axis, side }, { bend: opts.bend, twist: opts.twist, fold: opts.fold, curl: opts.curl });
  const baseColor: V3 = opts.color ?? [1, 1, 1];
  const baseAo = opts.ao ?? 1;
  const [u0, v0, u1, v1] = opts.atlas ?? [0, 0, 1, 1];
  const baseWind: [number, number, number, number] = opts.wind ?? [0, 0, 0.2, 0];
  const cellIndex = opts.cellIndex ?? 0;
  const cellCount = Math.max(1, opts.cellCount ?? 1);
  const cx = cellIndex % cellCount;
  const cy = Math.floor(cellIndex / cellCount);

  const baseVerts: Point2[] = [...cutout.outline, ...cutout.interiorPoints];

  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const tangents = new Float32Array(vCount * 4);
  const uv0 = new Float32Array(vCount * 2);
  const uv1 = new Float32Array(vCount * 2);
  const colors = new Float32Array(vCount * 4);
  const aoArr = new Float32Array(vCount);
  const windPivot = new Float32Array(vCount * 3);
  const windWeights = new Float32Array(vCount * 4);
  const cutoutSection = new Uint8Array(vCount);
  const cutoutMask = new Float32Array(vCount);
  const bendWeights = new Float32Array(vCount);
  const axisT = new Float32Array(vCount);

  // Straighten: every vertex becomes (lateral d, arc length s) relative to the axis, then the generator's
  // bend / twist / fold / curl deform it procedurally from the base (the base stays fixed at `origin`).
  for (let i = 0; i < vCount; i++) {
    const u = variant.vertices[i * 2] as number;
    const v = variant.vertices[i * 2 + 1] as number;
    const { bendWeight } = computeVertexBendAndAnchor([u, v], cutout);
    bendWeights[i] = bendWeight;

    const loc = uvToLocal(frame, [u, v]);
    const a = Math.max(0, Math.min(1, loc[1] / length));
    axisT[i] = a;
    const p = cardPointAt(pose, loc[0], loc[1]).p;

    positions[i * 3] = p[0];
    positions[i * 3 + 1] = p[1];
    positions[i * 3 + 2] = p[2];

    // UVs
    uv0[i * 2] = u0 + u * (u1 - u0);
    uv0[i * 2 + 1] = v0 + v * (v1 - v0);
    uv1[i * 2] = (cx + u) / cellCount;
    uv1[i * 2 + 1] = (cy + v) / cellCount;

    // Sample paint attributes from closest base vertex
    const baseIdx = findClosestBaseVertex([u, v], baseVerts);
    const maskVal = cutout.paint.vertexMask[baseIdx] ?? 1;
    const secVal = cutout.paint.vertexSection[baseIdx] ?? 1;
    const pr = cutout.paint.vertexColor[baseIdx * 4] ?? 1;
    const pg = cutout.paint.vertexColor[baseIdx * 4 + 1] ?? 1;
    const pb = cutout.paint.vertexColor[baseIdx * 4 + 2] ?? 1;

    cutoutMask[i] = maskVal;
    cutoutSection[i] = secVal;

    const vAo = baseAo * (0.85 + 0.15 * a);
    aoArr[i] = vAo;
    colors[i * 4] = baseColor[0] * pr * vAo;
    colors[i * 4 + 1] = baseColor[1] * pg * vAo;
    colors[i * 4 + 2] = baseColor[2] * pb * vAo;
    colors[i * 4 + 3] = 1; // keep alpha=1 for three.js alphaTest compatibility

    // Wind pivot (axis base) & weights: the flutter weight grows with axisT (0 at the base -> 1 at the tip).
    windPivot[i * 3] = origin[0];
    windPivot[i * 3 + 1] = origin[1];
    windPivot[i * 3 + 2] = origin[2];

    const growthFactor = applyPanel ? Math.max(a, growthCoordNorm(cutout, loc, length)) : a;
    const flutterWeight = Math.max(0, Math.min(1, baseWind[2] + (1 - baseWind[2]) * Math.max(bendWeight, growthFactor) * 0.8 * maskVal));
    windWeights[i * 4] = baseWind[0];
    windWeights[i * 4 + 1] = baseWind[1];
    windWeights[i * 4 + 2] = flutterWeight;
    windWeights[i * 4 + 3] = baseWind[3];
  }

  // Indices & optional winding fix
  const indices = new Uint32Array(iCount);
  const flipWinding = frame.mirrored !== Boolean(cutout.transform?.fixWinding);
  for (let t = 0; t < iCount; t += 3) {
    const a = variant.indices[t] as number;
    const b = variant.indices[t + 1] as number;
    const c = variant.indices[t + 2] as number;
    indices[t] = a;
    indices[t + 1] = flipWinding ? c : b;
    indices[t + 2] = flipWinding ? b : c;
  }

  // Compute smooth normals from triangle faces
  for (let t = 0; t < iCount; t += 3) {
    const i0 = indices[t] as number;
    const i1 = indices[t + 1] as number;
    const i2 = indices[t + 2] as number;
    const p0: V3 = [positions[i0 * 3] as number, positions[i0 * 3 + 1] as number, positions[i0 * 3 + 2] as number];
    const p1: V3 = [positions[i1 * 3] as number, positions[i1 * 3 + 1] as number, positions[i1 * 3 + 2] as number];
    const p2: V3 = [positions[i2 * 3] as number, positions[i2 * 3 + 1] as number, positions[i2 * 3 + 2] as number];
    const fn = cross(sub(p1, p0), sub(p2, p0));
    for (const vi of [i0, i1, i2]) {
      normals[vi * 3] = (normals[vi * 3] as number) + fn[0];
      normals[vi * 3 + 1] = (normals[vi * 3 + 1] as number) + fn[1];
      normals[vi * 3 + 2] = (normals[vi * 3 + 2] as number) + fn[2];
    }
  }

  const nSign = cutout.transform?.flipNormals ? -1 : 1;
  for (let i = 0; i < vCount; i++) {
    let n: V3 = [
      (normals[i * 3] as number) * nSign,
      (normals[i * 3 + 1] as number) * nSign,
      (normals[i * 3 + 2] as number) * nSign,
    ];
    n = len(n) < 1e-9 ? n0 : norm(n, n0);
    normals[i * 3] = n[0];
    normals[i * 3 + 1] = n[1];
    normals[i * 3 + 2] = n[2];

    const tg = norm(sub(side, [n[0] * dot(side, n), n[1] * dot(side, n), n[2] * dot(side, n)]), perpendicular(n));
    tangents[i * 4] = tg[0];
    tangents[i * 4 + 1] = tg[1];
    tangents[i * 4 + 2] = tg[2];
    tangents[i * 4 + 3] = 1;
  }

  return {
    positions,
    normals,
    tangents,
    uv0,
    uv1,
    colors,
    ao: aoArr,
    indices,
    wind: { pivot: windPivot, weights: windWeights },
    slots: [{ materialId, indexStart: 0, indexCount: iCount }],
    cutoutSection,
    cutoutMask,
    bendWeights,
    cutoutAxisT: axisT,
    cutoutPivot: [origin[0], origin[1], origin[2]],
  };
}

function buildImportedLodGeometry(
  cutout: CutoutMesh,
  imp: ImportedLodMesh,
  materialId: string,
  opts: BuildCutoutGeometryOptions,
): CutoutMeshData {
  const vCount = Math.floor(imp.positions.length / 3);
  const iCount = imp.indices.length;
  const scale = Math.max(0.001, cutout.scale || 1) * (opts.length ?? 1);
  const origin: V3 = opts.origin ?? [0, 0, 0];
  const baseColor: V3 = opts.color ?? [1, 1, 1];
  const baseAo = opts.ao ?? 1;
  const baseWind: [number, number, number, number] = opts.wind ?? [0, 0, 0.2, 0];

  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const tangents = new Float32Array(vCount * 4);
  const uv0 = new Float32Array(vCount * 2);
  const uv1 = new Float32Array(vCount * 2);
  const colors = new Float32Array(vCount * 4);
  const aoArr = new Float32Array(vCount);
  const windPivot = new Float32Array(vCount * 3);
  const windWeights = new Float32Array(vCount * 4);

  const nSign = cutout.transform.flipNormals ? -1 : 1;
  // Placement basis: local +X -> side, +Y -> growth axis (attachment base tangent), +Z -> card normal.
  const bAxis: V3 = norm(opts.axis ?? [0, 1, 0], [0, 1, 0]);
  const bSide: V3 = norm(opts.side ?? [1, 0, 0], [1, 0, 0]);
  const bNormal: V3 = norm(cross(bSide, bAxis), [0, 0, 1]);
  const toWorld = (q: V3): V3 => [
    bSide[0] * q[0] + bAxis[0] * q[1] + bNormal[0] * q[2],
    bSide[1] * q[0] + bAxis[1] * q[1] + bNormal[1] * q[2],
    bSide[2] * q[0] + bAxis[2] * q[1] + bNormal[2] * q[2],
  ];

  for (let i = 0; i < vCount; i++) {
    let p: V3 = [
      (imp.positions[i * 3] as number) * scale,
      (imp.positions[i * 3 + 1] as number) * scale,
      (imp.positions[i * 3 + 2] as number) * scale,
    ];
    p = applyFlip(p, cutout.transform.flip);
    p = applyOrient(p, cutout.transform.orient);
    const pw = toWorld(p);
    positions[i * 3] = origin[0] + pw[0];
    positions[i * 3 + 1] = origin[1] + pw[1];
    positions[i * 3 + 2] = origin[2] + pw[2];

    let n: V3 = [
      (imp.normals[i * 3] ?? 0) * nSign,
      (imp.normals[i * 3 + 1] ?? 0) * nSign,
      (imp.normals[i * 3 + 2] ?? 1) * nSign,
    ];
    n = applyOrient(applyFlip(n, cutout.transform.flip), cutout.transform.orient);
    n = norm(toWorld(norm(n, [0, 0, 1])), [0, 0, 1]);
    normals[i * 3] = n[0];
    normals[i * 3 + 1] = n[1];
    normals[i * 3 + 2] = n[2];

    const tg = perpendicular(n);
    tangents[i * 4] = tg[0];
    tangents[i * 4 + 1] = tg[1];
    tangents[i * 4 + 2] = tg[2];
    tangents[i * 4 + 3] = 1;

    const u = imp.uvs[i * 2] ?? 0;
    const v = imp.uvs[i * 2 + 1] ?? 0;
    uv0[i * 2] = u;
    uv0[i * 2 + 1] = v;
    uv1[i * 2] = u;
    uv1[i * 2 + 1] = v;

    aoArr[i] = baseAo;
    colors[i * 4] = baseColor[0] * baseAo;
    colors[i * 4 + 1] = baseColor[1] * baseAo;
    colors[i * 4 + 2] = baseColor[2] * baseAo;
    colors[i * 4 + 3] = 1;

    windPivot[i * 3] = origin[0];
    windPivot[i * 3 + 1] = origin[1];
    windPivot[i * 3 + 2] = origin[2];

    const gCoord = Math.max(0, Math.min(1, growthCoord(p, cutout.windDirection.growth) / Math.max(1e-4, scale)));
    windWeights[i * 4] = baseWind[0];
    windWeights[i * 4 + 1] = baseWind[1];
    windWeights[i * 4 + 2] = Math.min(1, baseWind[2] + (1 - baseWind[2]) * gCoord * 0.8);
    windWeights[i * 4 + 3] = baseWind[3];
  }

  const indices = new Uint32Array(iCount);
  const fs = flipSigns(cutout.transform.flip);
  const flipWinding = (fs[0] * fs[1] * fs[2] < 0) !== Boolean(cutout.transform.fixWinding);
  for (let t = 0; t < iCount; t += 3) {
    indices[t] = imp.indices[t] as number;
    indices[t + 1] = (flipWinding ? imp.indices[t + 2] : imp.indices[t + 1]) as number;
    indices[t + 2] = (flipWinding ? imp.indices[t + 1] : imp.indices[t + 2]) as number;
  }

  return {
    positions,
    normals,
    tangents,
    uv0,
    uv1,
    colors,
    ao: aoArr,
    indices,
    wind: { pivot: windPivot, weights: windWeights },
    slots: [{ materialId, indexStart: 0, indexCount: iCount }],
    cutoutPivot: [origin[0], origin[1], origin[2]],
  };
}

/** Convert a parsed `MeshData` into a serialisable `ImportedLodMesh` for a LOD slot. */
export function meshDataToImportedLod(mesh: MeshData, fileName: string, assetId?: string): ImportedLodMesh {
  return {
    assetId,
    fileName,
    positions: Array.from(mesh.positions),
    normals: Array.from(mesh.normals),
    uvs: Array.from(mesh.uv0),
    indices: Array.from(mesh.indices),
  };
}

/** Serialize a `MeshData` to Wavefront OBJ text (for the Export button in the Meshes panel). */
export function meshDataToObj(mesh: MeshData, name = 'CutoutMesh'): string {
  const lines: string[] = [`# Kekenik Tree Cutout Mesh Export`, `o ${name.replace(/\s+/g, '_')}`];
  const nv = Math.floor(mesh.positions.length / 3);
  const fmt = (n: number): string => (Math.round(n * 100000) / 100000).toString();
  for (let i = 0; i < nv; i++) {
    lines.push(`v ${fmt(mesh.positions[i * 3] as number)} ${fmt(mesh.positions[i * 3 + 1] as number)} ${fmt(mesh.positions[i * 3 + 2] as number)}`);
  }
  for (let i = 0; i < nv; i++) {
    lines.push(`vt ${fmt(mesh.uv0[i * 2] as number)} ${fmt(mesh.uv0[i * 2 + 1] as number)}`);
  }
  for (let i = 0; i < nv; i++) {
    lines.push(`vn ${fmt(mesh.normals[i * 3] as number)} ${fmt(mesh.normals[i * 3 + 1] as number)} ${fmt(mesh.normals[i * 3 + 2] as number)}`);
  }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = (mesh.indices[t] as number) + 1;
    const b = (mesh.indices[t + 1] as number) + 1;
    const c = (mesh.indices[t + 2] as number) + 1;
    lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
  }
  return lines.join('\n') + '\n';
}
