import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });
const meshOf = (r: Awaited<ReturnType<typeof run>>, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();

const TRUNK = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const graph = (extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, ...extra } as NodeSpec['params'] },
];

/** Edge use counts after welding vertices by position (the UV / normal seams are duplicates of the same position). */
function weldedEdges(mesh: MeshData): { use: Map<string, number>; degenerate: number } {
  const key = (i: number): string => `${Math.round(mesh.positions[i * 3]! * 1e5)},${Math.round(mesh.positions[i * 3 + 1]! * 1e5)},${Math.round(mesh.positions[i * 3 + 2]! * 1e5)}`;
  const ids = new Map<string, number>();
  const id = (i: number): number => {
    const k = key(i);
    const hit = ids.get(k);
    if (hit !== undefined) return hit;
    ids.set(k, ids.size);
    return ids.size - 1;
  };
  const use = new Map<string, number>();
  let degenerate = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [id(mesh.indices[t]!), id(mesh.indices[t + 1]!), id(mesh.indices[t + 2]!)];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) {
      degenerate++;
      continue;
    }
    for (let e = 0; e < 3; e++) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  return { use, degenerate };
}

describe('fused crotch in the tube mesher', () => {
  it('a splitting trunk is one watertight skin (the open ends carry the tip domes)', async () => {
    const mesh = meshOf(await run(graph({ splitsChance: 1 })), 'trunk');
    expect(mesh.indices.length).toBeGreaterThan(0);
    const { use, degenerate } = weldedEdges(mesh);
    expect(degenerate).toBe(0);
    for (const n of use.values()) expect(n).toBeLessThanOrEqual(2);
    expect([...use.values()].filter((n) => n === 1)).toHaveLength(0);
  });

  it('without caps only the two child rings of N / 2 edges are open', async () => {
    const mesh = meshOf(await run(graph({ splitsChance: 1, capEnd: false })), 'trunk');
    const { use } = weldedEdges(mesh);
    const boundary = [...use.values()].filter((n) => n === 1).length;
    for (const n of use.values()) expect(n).toBeLessThanOrEqual(2);
    expect(boundary).toBeGreaterThanOrEqual(6);
    expect(boundary % 2).toBe(0);
  });

  it('is deterministic and a trunk without splits is unchanged by the feature', async () => {
    const a = meshOf(await run(graph({ splitsChance: 1 })), 'trunk');
    const b = meshOf(await run(graph({ splitsChance: 1 })), 'trunk');
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
    const plain = meshOf(await run(graph({ splitsChance: 0 })), 'trunk');
    const { use } = weldedEdges(plain);
    // A closed tube: the dome and the base cap close both ends.
    expect([...use.values()].filter((n) => n === 1)).toHaveLength(0);
  });

  it('works at every LOD (the radial count is raised to an even number >= 6)', async () => {
    for (const lod of [0, 1, 2, 3]) {
      const mesh = meshOf(await run(graph({ splitsChance: 1 }), 1, lod), 'trunk');
      expect(mesh.indices.length).toBeGreaterThan(0);
      const { use, degenerate } = weldedEdges(mesh);
      expect(degenerate).toBe(0);
      for (const n of use.values()) expect(n).toBeLessThanOrEqual(2);
    }
  });

  it('stays finite with unequal halves, Expand and Smooth Inner / Outer', async () => {
    const mesh = meshOf(
      await run(graph({ splitsChance: 1, splitsBalance: 0.8, splitsExpand1: 1.6, splitsExpand2: 0.6, splitsSmoothInner: 1, splitsSmoothOuter: 1 })),
      'trunk',
    );
    for (const v of mesh.positions) expect(Number.isFinite(v)).toBe(true);
    for (const v of mesh.normals) expect(Number.isFinite(v)).toBe(true);
  });
});
