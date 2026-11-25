import type { MeshData } from '@/contracts/mesh';

/**
 * Mesh quality report (QA tooling): topology, degeneracy, angles, UV stretch and normal continuity of a triangle mesh.
 * Pure; vertices are welded by position first (UV and normal seams duplicate positions), so the numbers describe the surface.
 */
export interface MeshQualityReport {
  /** Welded edges used by exactly one triangle (open boundary). */
  boundaryEdges: number;
  /** Welded edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Triangles with (nearly) zero area or a repeated welded vertex. */
  degenerateTriangles: number;
  /** Non-finite numbers in positions / normals / uv0. */
  nanCount: number;
  /** Largest angle in degrees between the face normals of two triangles that share an edge near a junction. */
  maxDihedralNearJunctions: number;
  /** Smallest triangle corner in degrees (over non-degenerate triangles; 180 for an empty mesh). */
  minTriangleAngle: number;
  /** Largest anisotropic UV stretch (ratio of the two singular values of the UV -> 3D map, >= 1). 1 = no stretch. */
  uvStretchMax: number;
  /** Vertices that repeat another vertex exactly (same position, UV and normal): wasted duplicates, UV seams excluded. */
  duplicateVertexPairs: number;
  /** Largest angle in degrees between the normals at one welded position or across one edge near a junction. */
  junctionNormalJump: number;
}

export interface MeshQualityOptions {
  /** Junction centres, 4 floats each (x, y, z, radius). The dihedral / normal metrics only look within 2 radii; absent = the whole mesh. */
  junctions?: ArrayLike<number>;
  /** Distance in metres under which two positions are the same vertex (default 1e-4). */
  weldTolerance?: number;
}

const DEG = 180 / Math.PI;
const AREA_EPSILON = 1e-12;

/** Same input as the report but for several meshes (their vertices are welded together, as they share one scene). */
export function meshQuality(input: MeshData | readonly MeshData[], options: MeshQualityOptions = {}): MeshQualityReport {
  const meshes = Array.isArray(input) ? (input as readonly MeshData[]) : [input as MeshData];
  let vertexTotal = 0;
  let indexTotal = 0;
  for (const m of meshes) {
    vertexTotal += m.positions.length / 3;
    indexTotal += m.indices.length;
  }
  const tol = Math.max(1e-9, options.weldTolerance ?? 1e-4);
  const pos = new Float64Array(vertexTotal * 3);
  const nor = new Float32Array(vertexTotal * 3);
  const uv = new Float32Array(vertexTotal * 2);
  const idx = new Uint32Array(indexTotal);
  let nanCount = 0;
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    const n = m.positions.length / 3;
    for (let i = 0; i < n * 3; i++) {
      const p = m.positions[i] as number;
      if (!Number.isFinite(p)) nanCount++;
      pos[vo * 3 + i] = Number.isFinite(p) ? p : 0;
      const q = m.normals[i];
      if (q === undefined) continue;
      if (!Number.isFinite(q)) nanCount++;
      nor[vo * 3 + i] = Number.isFinite(q) ? q : 0;
    }
    for (let i = 0; i < n * 2; i++) {
      const q = m.uv0[i];
      if (q === undefined) continue;
      if (!Number.isFinite(q)) nanCount++;
      uv[vo * 2 + i] = Number.isFinite(q) ? q : 0;
    }
    for (let i = 0; i < m.indices.length; i++) idx[io + i] = (m.indices[i] as number) + vo;
    vo += n;
    io += m.indices.length;
  }

  // Weld by quantised position
  const welded = new Int32Array(vertexTotal);
  const cell = new Map<string, number>();
  let weldedCount = 0;
  for (let i = 0; i < vertexTotal; i++) {
    const key = `${Math.round((pos[i * 3] as number) / tol)},${Math.round((pos[i * 3 + 1] as number) / tol)},${Math.round((pos[i * 3 + 2] as number) / tol)}`;
    let w = cell.get(key);
    if (w === undefined) {
      w = weldedCount++;
      cell.set(key, w);
    }
    welded[i] = w;
  }

  // Junction zone test (squared distance to any junction centre within 2 radii)
  const junctions = options.junctions;
  const junctionCount = junctions ? Math.floor(junctions.length / 4) : 0;
  const inZone = (x: number, y: number, z: number): boolean => {
    if (!junctions || junctionCount === 0) return true;
    for (let j = 0; j < junctionCount; j++) {
      const r = 2 * Math.max(1e-6, junctions[j * 4 + 3] as number);
      const dx = x - (junctions[j * 4] as number);
      const dy = y - (junctions[j * 4 + 1] as number);
      const dz = z - (junctions[j * 4 + 2] as number);
      if (dx * dx + dy * dy + dz * dz <= r * r) return true;
    }
    return false;
  };

  const triCount = Math.floor(indexTotal / 3);
  const faceNormal = new Float64Array(triCount * 3);
  const edgeFirst = new Map<number, number>();
  const edgeUse = new Map<number, number>();
  const base = weldedCount + 1;
  let degenerate = 0;
  let minAngle = 180;
  let uvStretch = 1;
  let maxDihedral = 0;
  let normalJump = 0;
  const edgeKey = (a: number, b: number): number => (a < b ? a * base + b : b * base + a);

  for (let t = 0; t < triCount; t++) {
    const i0 = idx[t * 3] as number;
    const i1 = idx[t * 3 + 1] as number;
    const i2 = idx[t * 3 + 2] as number;
    const w0 = welded[i0] as number;
    const w1 = welded[i1] as number;
    const w2 = welded[i2] as number;
    const e1x = (pos[i1 * 3] as number) - (pos[i0 * 3] as number);
    const e1y = (pos[i1 * 3 + 1] as number) - (pos[i0 * 3 + 1] as number);
    const e1z = (pos[i1 * 3 + 2] as number) - (pos[i0 * 3 + 2] as number);
    const e2x = (pos[i2 * 3] as number) - (pos[i0 * 3] as number);
    const e2y = (pos[i2 * 3 + 1] as number) - (pos[i0 * 3 + 1] as number);
    const e2z = (pos[i2 * 3 + 2] as number) - (pos[i0 * 3 + 2] as number);
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    const area2 = Math.hypot(cx, cy, cz);
    if (w0 === w1 || w1 === w2 || w0 === w2 || area2 * 0.5 < AREA_EPSILON) {
      degenerate++;
      continue;
    }
    faceNormal[t * 3] = cx / area2;
    faceNormal[t * 3 + 1] = cy / area2;
    faceNormal[t * 3 + 2] = cz / area2;

    // Smallest corner
    const l01 = Math.hypot(e1x, e1y, e1z);
    const l02 = Math.hypot(e2x, e2y, e2z);
    const l12 = Math.hypot(e2x - e1x, e2y - e1y, e2z - e1z);
    const corner = (opp: number, a: number, b: number): number => Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - opp * opp) / (2 * a * b)))) * DEG;
    minAngle = Math.min(minAngle, corner(l12, l01, l02), corner(l02, l01, l12), corner(l01, l02, l12));

    // UV stretch: singular values of the UV -> 3D Jacobian (from the 2x2 Gram matrix)
    const du1 = (uv[i1 * 2] as number) - (uv[i0 * 2] as number);
    const dv1 = (uv[i1 * 2 + 1] as number) - (uv[i0 * 2 + 1] as number);
    const du2 = (uv[i2 * 2] as number) - (uv[i0 * 2] as number);
    const dv2 = (uv[i2 * 2 + 1] as number) - (uv[i0 * 2 + 1] as number);
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) > 1e-12) {
      const su = [(e1x * dv2 - e2x * dv1) / det, (e1y * dv2 - e2y * dv1) / det, (e1z * dv2 - e2z * dv1) / det];
      const sv = [(e2x * du1 - e1x * du2) / det, (e2y * du1 - e1y * du2) / det, (e2z * du1 - e1z * du2) / det];
      const a = su[0]! * su[0]! + su[1]! * su[1]! + su[2]! * su[2]!;
      const c = sv[0]! * sv[0]! + sv[1]! * sv[1]! + sv[2]! * sv[2]!;
      const b = su[0]! * sv[0]! + su[1]! * sv[1]! + su[2]! * sv[2]!;
      const mean = (a + c) / 2;
      const rad = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b));
      const lMax = mean + rad;
      const lMin = Math.max(1e-30, mean - rad);
      uvStretch = Math.max(uvStretch, Math.sqrt(lMax / lMin));
    }

    const pairs: [number, number][] = [[w0, w1], [w1, w2], [w2, w0]];
    for (const [a, b] of pairs) {
      const k = edgeKey(a, b);
      edgeUse.set(k, (edgeUse.get(k) ?? 0) + 1);
      const first = edgeFirst.get(k);
      if (first === undefined) {
        edgeFirst.set(k, t);
      } else {
        const av = a === w0 ? i0 : a === w1 ? i1 : i2;
        if (inZone(pos[av * 3] as number, pos[av * 3 + 1] as number, pos[av * 3 + 2] as number)) {
          const dot = (faceNormal[first * 3] as number) * (faceNormal[t * 3] as number) + (faceNormal[first * 3 + 1] as number) * (faceNormal[t * 3 + 1] as number) + (faceNormal[first * 3 + 2] as number) * (faceNormal[t * 3 + 2] as number);
          maxDihedral = Math.max(maxDihedral, Math.acos(Math.min(1, Math.max(-1, dot))) * DEG);
        }
      }
    }

    // Normal continuity across the triangle's edges inside the junction zone
    const corners = [i0, i1, i2];
    for (let e = 0; e < 3; e++) {
      const a = corners[e] as number;
      const b = corners[(e + 1) % 3] as number;
      if (!inZone(pos[a * 3] as number, pos[a * 3 + 1] as number, pos[a * 3 + 2] as number)) continue;
      normalJump = Math.max(normalJump, angleBetween(nor, a, b));
    }
  }

  let boundary = 0;
  let nonManifold = 0;
  for (const n of edgeUse.values()) {
    if (n === 1) boundary++;
    else if (n > 2) nonManifold++;
  }

  // Normals that disagree at one welded position, and exact duplicates (position + uv + normal)
  const byWelded = new Map<number, number[]>();
  for (let i = 0; i < vertexTotal; i++) {
    const w = welded[i] as number;
    const list = byWelded.get(w);
    if (list) list.push(i);
    else byWelded.set(w, [i]);
  }
  let duplicates = 0;
  for (const list of byWelded.values()) {
    if (list.length < 2) continue;
    const first = list[0] as number;
    if (!inZone(pos[first * 3] as number, pos[first * 3 + 1] as number, pos[first * 3 + 2] as number)) {
      duplicates += countDuplicates(list, uv, nor);
      continue;
    }
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) normalJump = Math.max(normalJump, angleBetween(nor, list[a] as number, list[b] as number));
    duplicates += countDuplicates(list, uv, nor);
  }

  return {
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    degenerateTriangles: degenerate,
    nanCount,
    maxDihedralNearJunctions: maxDihedral,
    minTriangleAngle: minAngle,
    uvStretchMax: uvStretch,
    duplicateVertexPairs: duplicates,
    junctionNormalJump: normalJump,
  };
}

/** Vertices of one position group that repeat an earlier one in UV and normal (a UV seam differs in UV and is not counted). */
function countDuplicates(list: readonly number[], uv: Float32Array, nor: Float32Array): number {
  let n = 0;
  for (let a = 1; a < list.length; a++) {
    const i = list[a] as number;
    for (let b = 0; b < a; b++) {
      const j = list[b] as number;
      if (Math.abs((uv[i * 2] as number) - (uv[j * 2] as number)) < 1e-6 && Math.abs((uv[i * 2 + 1] as number) - (uv[j * 2 + 1] as number)) < 1e-6 && angleBetween(nor, i, j) < 0.01) {
        n++;
        break;
      }
    }
  }
  return n;
}

function angleBetween(nor: Float32Array, a: number, b: number): number {
  const la = Math.hypot(nor[a * 3] as number, nor[a * 3 + 1] as number, nor[a * 3 + 2] as number);
  const lb = Math.hypot(nor[b * 3] as number, nor[b * 3 + 1] as number, nor[b * 3 + 2] as number);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const d = ((nor[a * 3] as number) * (nor[b * 3] as number) + (nor[a * 3 + 1] as number) * (nor[b * 3 + 1] as number) + (nor[a * 3 + 2] as number) * (nor[b * 3 + 2] as number)) / (la * lb);
  return Math.acos(Math.min(1, Math.max(-1, d))) * DEG;
}
