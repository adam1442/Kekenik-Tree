import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Mesh, type BufferGeometry } from 'three';
import { readGlbJson, type GltfJson } from './writers/gltf';

/** Round-trip verification: re-import the exported glTF / GLB and compare its statistics with what was written. */

export interface ModelStats {
  nodes: number;
  meshes: number;
  /** Triangles of the whole file. */
  triangles: number;
  /** Vertices counted per mesh primitive group (shared attributes counted once per mesh). */
  vertices: number;
  materials: number;
  images: number;
  nodeNames: string[];
}

export interface VerifyReport {
  ok: boolean;
  file: string;
  expected: ModelStats;
  actual: ModelStats;
  /** Present when the triangle count was also confirmed by three.js' GLTFLoader. */
  loaderTriangles?: number;
  mismatches: string[];
}

/** Statistics straight from the glTF JSON (accessor counts). */
export function statsFromJson(json: GltfJson): ModelStats {
  let triangles = 0;
  let vertices = 0;
  for (const mesh of json.meshes) {
    let counted = false;
    for (const p of mesh.primitives) {
      const attrs = p.attributes as Record<string, number>;
      if (!counted) {
        vertices += (json.accessors[attrs.POSITION as number]?.count as number | undefined) ?? 0;
        counted = true;
      }
      const idx = p.indices as number | undefined;
      triangles += idx === undefined ? 0 : ((json.accessors[idx]?.count as number | undefined) ?? 0) / 3;
    }
  }
  return { nodes: json.nodes.length, meshes: json.meshes.length, triangles, vertices, materials: json.materials?.length ?? 0, images: json.images?.length ?? 0, nodeNames: json.nodes.map((n) => n.name) };
}

export function compareStats(expected: ModelStats, actual: ModelStats): string[] {
  const out: string[] = [];
  for (const k of ['nodes', 'meshes', 'triangles', 'vertices', 'materials', 'images'] as const) {
    if (expected[k] !== actual[k]) out.push(`${k}: expected ${expected[k]}, file has ${actual[k]}`);
  }
  return out;
}

function parseWithLoader(data: ArrayBuffer): Promise<number> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      data,
      '',
      (gltf) => {
        let tris = 0;
        gltf.scene.traverse((o) => {
          if (o instanceof Mesh) {
            const g = o.geometry as BufferGeometry;
            tris += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
          }
        });
        resolve(tris);
      },
      (e) => reject(e instanceof Error ? e : new Error(String(e))),
    );
  });
}

/**
 * Verify a GLB: parse its container, recompute the statistics from the accessors and ask three.js' GLTFLoader to import it.
 * `expected` comes from the writer's own input (nodes, geometry stats, material and image counts).
 */
export async function verifyGlb(file: string, bytes: Uint8Array, expected: ModelStats, useLoader = true): Promise<VerifyReport> {
  const mismatches: string[] = [];
  let actual: ModelStats = { nodes: 0, meshes: 0, triangles: 0, vertices: 0, materials: 0, images: 0, nodeNames: [] };
  let loaderTriangles: number | undefined;
  try {
    const { json } = readGlbJson(bytes);
    actual = statsFromJson(json);
    mismatches.push(...compareStats(expected, actual));
    if (useLoader) {
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      loaderTriangles = await parseWithLoader(copy);
      if (loaderTriangles !== expected.triangles) mismatches.push(`GLTFLoader imported ${loaderTriangles} triangles, expected ${expected.triangles}`);
    }
  } catch (e) {
    mismatches.push(`Re-import failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ok: mismatches.length === 0, file, expected, actual, loaderTriangles, mismatches };
}
