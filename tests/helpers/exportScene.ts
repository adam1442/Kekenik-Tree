import type { SceneEntry, SceneModel } from '@/contracts/engine';
import type { MeshData } from '@/contracts/mesh';

/** Synthetic plant: one bark mesh (tapered boxes along Z) and one foliage mesh of separate leaf cards. */
export function cards(count: number, material = 'leaf', seed = 1): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = (i * 2.399 + seed) % (Math.PI * 2);
    const cx = Math.cos(a) * 0.4 * (1 + (i % 5) * 0.1);
    const cy = Math.sin(a) * 0.4 * (1 + (i % 5) * 0.1);
    const cz = 1 + (i / count) * 2;
    const b = positions.length / 3;
    // base edge at v = 0, tip edge at v = 1
    positions.push(cx - 0.05, cy, cz, cx + 0.05, cy, cz, cx + 0.05, cy, cz + 0.2, cx - 0.05, cy, cz + 0.2);
    for (let k = 0; k < 4; k++) normals.push(0, -1, 0);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uv0: Float32Array.from(uv), indices: Uint32Array.from(indices), slots: [{ materialId: material, indexStart: 0, indexCount: indices.length }] };
}

export function boxes(sizes: number[], material = 'bark'): MeshData {
  const positions: number[] = [];
  const normals: number[] = [];
  const uv: number[] = [];
  const indices: number[] = [];
  sizes.forEach((s, i) => {
    const x = i * 0.3;
    const b = positions.length / 3;
    positions.push(x, 0, 0, x + 0.05, 0, 0, x + 0.05, 0, s, x, 0, s);
    for (let k = 0; k < 4; k++) normals.push(0, -1, 0);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), uv0: Float32Array.from(uv), indices: Uint32Array.from(indices), slots: [{ materialId: material, indexStart: 0, indexCount: indices.length }] };
}

function entry(nodeId: string, type: string, statsGroup: string, mesh: MeshData): SceneEntry {
  return { nodeId, type, statsGroup, mesh, rev: `${nodeId}:${mesh.indices.length}` };
}

export function testScene(leafCount = 100, branchSizes = [3, 2, 0.05, 0.04, 1]): SceneModel {
  const entries = [entry('trunk', 'trunk', 'branches', boxes(branchSizes)), entry('leaves', 'leaf', 'leaf meshes', cards(leafCount))];
  const triangles = entries.reduce((s, e) => s + e.mesh.indices.length / 3, 0);
  const vertices = entries.reduce((s, e) => s + e.mesh.positions.length / 3, 0);
  return { entries, skeletons: [], stats: { triangles, vertices, bones: 0, groups: [], totalInstances: 0 } };
}
