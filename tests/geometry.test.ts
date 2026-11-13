import { beforeAll, describe, expect, it } from 'vitest';
import { defaultGraph } from '@/app/project/defaultGraph';
import { CancellationSource } from '@/contracts/nodes';
import { meshTriangleCount, meshVertexCount, type MeshData } from '@/contracts/mesh';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { expandInstances, placeMeshes, composeMatrix } from '@/geometry/instancing';
import { buildLeafMesh, type LeafCard } from '@/geometry/leafMesher';
import { parseGltf, parseObj } from '@/geometry/meshImport';
import { buildPrimitive, PRIMITIVE_KINDS } from '@/geometry/primitives';
import { buildTubeMesh, type TubeOptions } from '@/geometry/tubeMesher';

beforeAll(() => registerDiscoveredNodes());

const baseOpts = (over: Partial<TubeOptions> = {}): TubeOptions => ({
  maxGeneration: 8,
  radialSegments: () => 8,
  color: () => [0.2, 0.15, 0.1],
  uvMetres: 1,
  materialId: 'bark',
  ...over,
});

/** Curved tapering trunk, 7 points. */
function trunk(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i < 7; i++) sb.addPoint(Math.sin(i * 0.3) * 0.4, 0, i * 0.7, 0.3 * (1 - i / 8));
  sb.endBranch();
  return sb.build();
}

/** A child leaving the trunk at point 3, going sideways. */
function child(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(0, 3, 1);
  for (let i = 0; i < 5; i++) sb.addPoint(0.3 + i * 0.5, 0.02 * i, 2.1 + i * 0.25, 0.06 * (1 - i / 6));
  sb.endBranch();
  return sb.build();
}

const tri = (m: MeshData, t: number): number[] => [m.indices[t * 3] as number, m.indices[t * 3 + 1] as number, m.indices[t * 3 + 2] as number];
const pos = (m: MeshData, i: number): [number, number, number] => [m.positions[i * 3] as number, m.positions[i * 3 + 1] as number, m.positions[i * 3 + 2] as number];
const key = (m: MeshData, i: number): string => pos(m, i).map((v) => Math.round(v * 1e4)).join(',');

function edgeUsage(m: MeshData): Map<string, number> {
  const ids = new Map<string, number>();
  const id = (i: number): number => {
    const k = key(m, i);
    let v = ids.get(k);
    if (v === undefined) ids.set(k, (v = ids.size));
    return v;
  };
  const edges = new Map<string, number>();
  for (let t = 0; t < m.indices.length / 3; t++) {
    const [a, b, c] = tri(m, t).map(id) as [number, number, number];
    for (const [x, y] of [[a, b], [b, c], [c, a]] as const) {
      const k = x < y ? `${x}_${y}` : `${y}_${x}`;
      edges.set(k, (edges.get(k) ?? 0) + 1);
    }
  }
  return edges;
}

function signedVolume(m: MeshData): number {
  let v = 0;
  for (let t = 0; t < m.indices.length / 3; t++) {
    const [a, b, c] = tri(m, t).map((i) => pos(m, i)) as unknown as [number[], number[], number[]];
    v += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
  }
  return v;
}

describe('tube mesher', () => {
  it('produces a watertight, outward-facing closed tube', () => {
    const m = buildTubeMesh(trunk(), baseOpts());
    const edges = edgeUsage(m);
    expect([...edges.values()].every((n) => n === 2)).toBe(true);
    expect(signedVolume(m)).toBeGreaterThan(0);
  });

  it('writes valid unit normals, finite tangents and AO / wind channels', () => {
    const m = buildTubeMesh(trunk(), baseOpts());
    const n = meshVertexCount(m);
    expect(m.tangents?.length).toBe(n * 4);
    expect(m.ao?.length).toBe(n);
    expect(m.wind?.pivot.length).toBe(n * 3);
    expect(m.wind?.weights.length).toBe(n * 4);
    for (let i = 0; i < n; i++) {
      expect(Math.abs(Math.hypot(m.normals[i * 3]!, m.normals[i * 3 + 1]!, m.normals[i * 3 + 2]!) - 1)).toBeLessThan(1e-3);
      expect(Number.isFinite(m.tangents![i * 4]!)).toBe(true);
    }
    // top of the trunk sways more than its base
    const w = m.wind!.weights;
    expect(w[(n - 1) * 4]!).toBeGreaterThanOrEqual(w[0]!);
  });

  it('has no degenerate triangles', () => {
    const m = buildTubeMesh(trunk(), baseOpts());
    for (let t = 0; t < m.indices.length / 3; t++) {
      const [a, b, c] = tri(m, t).map((i) => pos(m, i)) as unknown as [number[], number[], number[]];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
      expect(area).toBeGreaterThan(1e-10);
    }
  });

  it('tiles V by world length (metric) and U around the circumference', () => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i <= 4; i++) sb.addPoint(0, 0, i, 0.2);
    sb.endBranch();
    const m = buildTubeMesh(sb.build(), baseOpts({ uvMetres: 2, capEnd: false, capStart: false }));
    let maxV = -Infinity;
    for (let i = 0; i < m.uv0.length / 2; i++) maxV = Math.max(maxV, m.uv0[i * 2 + 1]!);
    expect(maxV).toBeCloseTo(2, 4); // 4 m / 2 m per tile
    const metric = buildTubeMesh(sb.build(), baseOpts({ uv: { scaleV: 2 }, capEnd: false, capStart: false }));
    let maxV2 = -Infinity;
    for (let i = 0; i < metric.uv0.length / 2; i++) maxV2 = Math.max(maxV2, metric.uv0[i * 2 + 1]!);
    expect(maxV2).toBeCloseTo(8, 4);
    const normalized = buildTubeMesh(sb.build(), baseOpts({ uv: { normalized: true }, capEnd: false, capStart: false }));
    let maxV3 = -Infinity;
    for (let i = 0; i < normalized.uv0.length / 2; i++) maxV3 = Math.max(maxV3, normalized.uv0[i * 2 + 1]!);
    expect(maxV3).toBeCloseTo(1, 4);
    // seam: first and last vertex of a ring differ by whole tiles in U but share a position
    expect(m.uv0[8 * 2]! - m.uv0[0]!).toBeGreaterThanOrEqual(1);
    expect(key(m, 8)).toBe(key(m, 0));
  });

  it('buries the first child ring inside the parent (no cracks at junctions)', () => {
    const parent = trunk();
    const m = buildTubeMesh(child(), baseOpts({ parent, radialSegments: () => 8 }));
    const V = 9;
    for (let ring = 0; ring < 2; ring++) {
      for (let j = 0; j < V; j++) {
        const [x, y, z] = pos(m, ring * V + j);
        // distance from the trunk axis at that height (trunk axis is x = sin(...) in the XZ plane)
        let best = Infinity;
        for (let i = 0; i < parent.count; i++) best = Math.min(best, Math.hypot(x - parent.position[i * 3]!, y - parent.position[i * 3 + 1]!, z - parent.position[i * 3 + 2]!));
        expect(best).toBeLessThan(0.3 + 0.35);
      }
    }
  });

  it('is deterministic', () => {
    const a = buildTubeMesh(trunk(), baseOpts({ section: { kind: 'noise', aspect: 1, roundness: 1, lobes: 5, depth: 0.2, spiral: 0, noiseFrequency: 2, seed: 5 } }));
    const b = buildTubeMesh(trunk(), baseOpts({ section: { kind: 'noise', aspect: 1, roundness: 1, lobes: 5, depth: 0.2, spiral: 0, noiseFrequency: 2, seed: 5 } }));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.indices)).toEqual(Array.from(b.indices));
  });

  it('reduces triangles with fewer sides / segments (LOD) and supports faceted + lobed sections', () => {
    const full = meshTriangleCount(buildTubeMesh(trunk(), baseOpts({ radialSegments: () => 16 })));
    const mid = meshTriangleCount(buildTubeMesh(trunk(), baseOpts({ radialSegments: () => 8, segmentKeep: 0.6 })));
    const low = meshTriangleCount(buildTubeMesh(trunk(), baseOpts({ radialSegments: () => 4, segmentKeep: 0.3 })));
    expect(full).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(low);
    const faceted = buildTubeMesh(trunk(), baseOpts({ smoothing: 0 }));
    expect(meshVertexCount(faceted)).toBeGreaterThan(meshVertexCount(buildTubeMesh(trunk(), baseOpts())));
    const lobed = buildTubeMesh(trunk(), baseOpts({ section: { kind: 'lobed', aspect: 1, roundness: 1, lobes: 5, depth: 0.3, spiral: 0, noiseFrequency: 2, seed: 1 } }));
    expect(signedVolume(lobed)).toBeGreaterThan(0);
  });

  it('resamples into requested length segments', () => {
    const m = buildTubeMesh(trunk(), baseOpts({ lengthSegments: 20, capEnd: false, capStart: false }));
    expect(meshTriangleCount(m)).toBe(20 * 8 * 2);
  });
});

describe('leaf mesher and primitives', () => {
  const card = (over: Partial<LeafCard> = {}): LeafCard => ({
    origin: [0, 0, 1], axis: [0, 0, 1], side: [1, 0, 0], length: 0.5, width: 0.3, bend: 0.4, fold: 0.2, curl: 0.1, twist: 0.2,
    segLength: 4, segWidth: 2, outline: 'oval', color: [0.2, 0.4, 0.1], ao: 0.9, atlas: [0.5, 0, 1, 0.5], materialId: 'leaf',
    pivot: [0, 0, 1], wind: [0.1, 0.2, 0.3, 0.4], ...over,
  });

  it('builds multi-segment bent leaves with UVs inside their atlas cell and one slot per material', () => {
    const m = buildLeafMesh([card(), card({ materialId: 'red' }), card()], { defaultMaterial: 'leaf' });
    expect(m.slots.map((s) => s.materialId)).toEqual(['leaf', 'red']);
    expect(m.slots[0]!.indexCount + m.slots[1]!.indexCount).toBe(m.indices.length);
    for (let i = 0; i < m.uv0.length / 2; i++) {
      expect(m.uv0[i * 2]!).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(m.uv0[i * 2]!).toBeLessThanOrEqual(1 + 1e-6);
      expect(m.uv0[i * 2 + 1]!).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    expect(m.wind?.pivot[2]).toBe(1);
    expect(meshTriangleCount(m)).toBe(3 * 4 * 2 * 2);
    for (let t = 0; t < m.indices.length / 3; t++) {
      const [a, b, c] = tri(m, t).map((i) => pos(m, i)) as unknown as [number[], number[], number[]];
      const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
      const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      expect(Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!)).toBeGreaterThan(1e-9);
    }
  });

  it('provides a primitive library with valid indices', () => {
    for (const kind of PRIMITIVE_KINDS) {
      const m = buildPrimitive(kind, 'leaf');
      expect(meshTriangleCount(m)).toBeGreaterThan(0);
      expect(Math.max(...m.indices)).toBeLessThan(meshVertexCount(m));
    }
    expect([...edgeUsage(buildPrimitive('sphere', 'x')).values()].every((n) => n === 2)).toBe(true);
  });

  it('places instances and expands GPU-instanced payloads identically', () => {
    const base = buildPrimitive('cone', 'leaf');
    const mats = new Float32Array(32);
    composeMatrix([0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 1, mats, 0);
    composeMatrix([5, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], 2, mats, 16);
    const baked = placeMeshes(base, mats, 2);
    expect(meshTriangleCount(baked)).toBe(meshTriangleCount(base) * 2);
    const instanced: MeshData = { ...base, instanced: { count: 2, matrices: mats } };
    expect(meshTriangleCount(instanced)).toBe(meshTriangleCount(base) * 2);
    expect(Array.from(expandInstances(instanced).positions)).toEqual(Array.from(baked.positions));
  });
});

describe('mesh import', () => {
  it('parses OBJ quads into triangles and converts Y-up to Z-up', () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n';
    const m = parseObj(obj, 'leaf');
    expect(meshTriangleCount(m)).toBe(2);
    expect(pos(m, 2)).toEqual([1, -0, 1]);
  });

  it('parses glTF with an embedded buffer', () => {
    const buf = new ArrayBuffer(36 + 6);
    new Float32Array(buf, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Uint16Array(buf, 36, 3).set([0, 1, 2]);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const json = {
      buffers: [{ uri: `data:application/octet-stream;base64,${b64}` }],
      bufferViews: [{ buffer: 0, byteOffset: 0 }, { buffer: 0, byteOffset: 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
    };
    const m = parseGltf(new TextEncoder().encode(JSON.stringify(json)), 'leaf');
    expect(meshTriangleCount(m)).toBe(1);
    expect(m.normals[2]).not.toBeNaN();
  });
});

describe('default graph meshing', () => {
  const run = async (lod: number) => {
    const m = new GraphModel();
    m.load(defaultGraph());
    return new GraphEvaluator().evaluate(snapshotGraph(m), { seed: 1, lod, token: new CancellationSource().token });
  };

  it('renders bark with UVs and leaves with wind pivots, and LOD reduces triangles', async () => {
    const hi = await run(0);
    expect(hi.errors).toBe(0);
    const entries = hi.scene.entries;
    expect(entries.length).toBeGreaterThan(2);
    const leaf = entries.find((e) => e.statsGroup.includes('leaf'));
    expect(leaf).toBeDefined();
    expect(leaf!.mesh.wind).toBeDefined();
    const bark = entries.find((e) => e.statsGroup.includes('branches'));
    expect(bark!.mesh.uv0.length).toBeGreaterThan(0);
    expect(bark!.mesh.ao?.length).toBe(meshVertexCount(bark!.mesh));
    const lo = await run(2);
    const vlo = await run(3);
    expect(hi.scene.stats.triangles).toBeGreaterThan(lo.scene.stats.triangles);
    expect(lo.scene.stats.triangles).toBeGreaterThan(vlo.scene.stats.triangles);
    const again = await run(0);
    expect(again.scene.stats.triangles).toBe(hi.scene.stats.triangles);
  });
});
