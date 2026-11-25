import { getNumber, type NodeParams } from '@/contracts/params';
import type { MeshData } from '@/contracts/mesh';
import { loadMeshAsset } from '@/geometry/meshAssets';
import { TriangleBvh, type ClosestHit } from './bvh';

export type V3 = [number, number, number];

/** Signed-distance style queries against a triangle mesh in world space. */
export interface GeometryQuery {
  /** Signed distance (negative inside a closed mesh); `normal` receives the unit outward direction at the closest point. */
  signed(x: number, y: number, z: number, normal: V3): number;
  /** Parameter t in (0, 1] where the segment a -> b first meets the surface, -1 when it does not. */
  segmentHit(a: readonly [number, number, number], b: readonly [number, number, number]): number;
  inside(x: number, y: number, z: number): boolean;
  readonly triangleCount: number;
}

export interface GeometryTransform {
  position: V3;
  /** Euler angles in degrees (X, then Y, then Z). */
  rotation: V3;
  scale: number;
}

export const IDENTITY_TRANSFORM: GeometryTransform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };

/** Builds the world-space query for a mesh: the transform is baked into the BVH. */
export function buildGeometryQuery(positions: ArrayLike<number>, indices: ArrayLike<number>, t: GeometryTransform = IDENTITY_TRANSFORM): GeometryQuery {
  const n = Math.floor(positions.length / 3);
  const world = new Float32Array(n * 3);
  const [rx, ry, rz] = [(t.rotation[0] * Math.PI) / 180, (t.rotation[1] * Math.PI) / 180, (t.rotation[2] * Math.PI) / 180];
  const [cxr, sxr, cyr, syr, czr, szr] = [Math.cos(rx), Math.sin(rx), Math.cos(ry), Math.sin(ry), Math.cos(rz), Math.sin(rz)];
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    let x = (positions[i * 3] as number) * t.scale;
    let y = (positions[i * 3 + 1] as number) * t.scale;
    let z = (positions[i * 3 + 2] as number) * t.scale;
    let y1 = y * cxr - z * sxr;
    let z1 = y * sxr + z * cxr;
    y = y1;
    z = z1;
    const x2 = x * cyr + z * syr;
    const z2 = -x * syr + z * cyr;
    x = x2;
    z = z2;
    const x3 = x * czr - y * szr;
    y1 = x * szr + y * czr;
    x = x3 + t.position[0];
    y = y1 + t.position[1];
    z1 = z + t.position[2];
    world[i * 3] = x;
    world[i * 3 + 1] = y;
    world[i * 3 + 2] = z1;
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z1 < min[2]) min[2] = z1;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z1 > max[2]) max[2] = z1;
  }
  const bvh = new TriangleBvh(world, indices);
  const hit: ClosestHit = { dist2: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 1 };
  const insideBox = (x: number, y: number, z: number): boolean => x >= min[0] && x <= max[0] && y >= min[1] && y <= max[1] && z >= min[2] && z <= max[2];
  const inside = (x: number, y: number, z: number): boolean => insideBox(x, y, z) && bvh.inside(x, y, z);
  return {
    triangleCount: bvh.triangleCount,
    inside,
    signed(x, y, z, normal) {
      if (!bvh.closest(x, y, z, hit)) {
        normal[0] = 0;
        normal[1] = 0;
        normal[2] = 1;
        return Infinity;
      }
      const d = Math.sqrt(hit.dist2);
      const isInside = inside(x, y, z);
      if (d > 1e-9) {
        const s = isInside ? -1 / d : 1 / d;
        normal[0] = (x - hit.x) * s;
        normal[1] = (y - hit.y) * s;
        normal[2] = (z - hit.z) * s;
      } else {
        normal[0] = hit.nx;
        normal[1] = hit.ny;
        normal[2] = hit.nz;
      }
      return isInside ? -d : d;
    },
    segmentHit(a, b) {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const dz = b[2] - a[2];
      if (dx * dx + dy * dy + dz * dz < 1e-18) return -1;
      return bvh.raycast(a[0], a[1], a[2], dx, dy, dz, 1);
    },
  };
}

const cache = new WeakMap<MeshData, Map<string, GeometryQuery>>();

const vec = (params: NodeParams, id: string, fallback: V3): V3 => {
  const v = params[id]?.value;
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x))) return [v[0] as number, v[1] as number, v[2] as number];
  return fallback;
};

/** Transform of a geometry force node (`geometryPosition`, `geometryRotation`, `geometryScale`). */
export function readGeometryTransform(params: NodeParams): GeometryTransform {
  return {
    position: vec(params, 'geometryPosition', [0, 0, 0]),
    rotation: vec(params, 'geometryRotation', [0, 0, 0]),
    scale: Math.max(1e-4, getNumber(params, 'geometryScale', 1)),
  };
}

/** Query for the Mesh asset of a geometry force node (cached per mesh + transform); null without a readable asset. */
export function geometryQueryForParams(params: NodeParams): GeometryQuery | null {
  const raw = params.geometryAsset?.value;
  const assetId = typeof raw === 'string' && raw !== '' ? raw : null;
  const mesh = loadMeshAsset(assetId, 'leaf');
  if (!mesh || mesh.indices.length < 3) return null;
  const t = readGeometryTransform(params);
  const key = `${t.position.join(',')}|${t.rotation.join(',')}|${t.scale}`;
  let perMesh = cache.get(mesh);
  if (!perMesh) {
    perMesh = new Map();
    cache.set(mesh, perMesh);
  }
  const hit = perMesh.get(key);
  if (hit) return hit;
  const q = buildGeometryQuery(mesh.positions, mesh.indices, t);
  if (perMesh.size > 16) perMesh.clear();
  perMesh.set(key, q);
  return q;
}
