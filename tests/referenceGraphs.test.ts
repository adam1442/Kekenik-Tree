import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph } from './helpers/graphSpec';
import { REFERENCE_GRAPHS } from './helpers/referenceGraphs';

beforeAll(() => registerDiscoveredNodes());

describe('reference graphs (buildable from nodes and params only)', () => {
  it.each(Object.keys(REFERENCE_GRAPHS))('%s evaluates to a plausible tree', async (name) => {
    const model = buildGraph(REFERENCE_GRAPHS[name] as never);
    const r = await new GraphEvaluator().evaluate(snapshotGraph(model), { seed: 1, lod: 0, token: new CancellationSource().token });
    expect(r.errors).toBe(0);
    const trunk = r.scene.skeletons.find((s) => s.nodeId === 'trunk')?.skeleton;
    expect(trunk).toBeDefined();
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxR = 0;
    for (const s of r.scene.skeletons) {
      for (let i = 0; i < s.skeleton.count; i++) {
        const z = s.skeleton.position[i * 3 + 2] as number;
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        maxR = Math.max(maxR, Math.hypot(s.skeleton.position[i * 3] as number, s.skeleton.position[i * 3 + 1] as number));
      }
    }
    const stats = { triangles: r.scene.stats.triangles, branches: r.scene.stats.skeletonBranches, height: +(maxZ - minZ).toFixed(1), crownRadius: +maxR.toFixed(1) };
    expect(stats.height).toBeGreaterThan(5);
    expect(stats.crownRadius).toBeGreaterThan(0.5);
    expect(r.scene.stats.triangles).toBeGreaterThan(1000);
  }, 120000);
});
