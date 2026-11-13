import { beforeAll, describe, expect, it } from 'vitest';
import { defaultGraph } from '@/app/project/defaultGraph';
import { CancelledError, CancellationSource, type NodeDef } from '@/contracts/nodes';
import { defaultParams } from '@/contracts/params';
import { Rng } from '@/core/rng';
import { EvalCache, GraphEvaluator, hashOutputs, hashPortValue, ParamSnapshotCache, sampleVariance, snapshotGraph, topologicalOrder, deriveNodeSeed, type GraphSnapshot } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { getNodeDef, listNodeDefs, registerDiscoveredNodes, registerNode, unregisterNode } from '@/graph/registry';
import { PORT } from '@/graph/ports';

beforeAll(() => registerDiscoveredNodes());

function modelFromDefault(): GraphModel {
  const m = new GraphModel();
  m.load(defaultGraph());
  return m;
}

const run = (ev: GraphEvaluator, snap: GraphSnapshot, seed = 1, lod = 0) => ev.evaluate(snap, { seed, lod, token: new CancellationSource().token });

describe('topological order', () => {
  it('lists every node after all of its inputs, independent of node order', () => {
    const m = modelFromDefault();
    const snap = snapshotGraph(m);
    const { order, cyclic } = topologicalOrder(snap);
    expect(cyclic).toEqual([]);
    expect(order).toHaveLength(snap.nodes.length);
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const e of snap.edges) expect(pos.get(e.fromNode) as number).toBeLessThan(pos.get(e.toNode) as number);
    const reversed: GraphSnapshot = { nodes: [...snap.nodes].reverse(), edges: [...snap.edges].reverse() };
    const r = topologicalOrder(reversed);
    const rp = new Map(r.order.map((id, i) => [id, i]));
    for (const e of snap.edges) expect(rp.get(e.fromNode) as number).toBeLessThan(rp.get(e.toNode) as number);
  });

  it('reports nodes on a cycle', () => {
    const snap = snapshotGraph(modelFromDefault());
    const cyc: GraphSnapshot = { nodes: snap.nodes, edges: [...snap.edges, { id: 'x', kind: 'hierarchy', fromNode: 'leaf', fromPort: 'children', toNode: 'trunk', toPort: 'parent' }] };
    expect(topologicalOrder(cyc).cyclic).toEqual(expect.arrayContaining(['trunk', 'big', 'little', 'leaf']));
  });
});

describe('cache & dirty propagation', () => {
  it('re-evaluates only the edited node and its descendants', async () => {
    const m = modelFromDefault();
    const ev = new GraphEvaluator();
    const pc = new ParamSnapshotCache();
    const first = await run(ev, snapshotGraph(m, pc));
    expect(first.cached).toBe(0);
    expect(first.errors).toBe(0);
    expect(first.scene.stats.triangles).toBeGreaterThan(1000);

    const again = await run(ev, snapshotGraph(m, pc));
    expect(again.evaluated).toBe(0);
    expect(again.cached).toBe(first.evaluated);

    const cur = m.getNode('little')?.params.number;
    m.setParam('little', 'number', { ...(cur as object), value: 3 } as never);
    const edited = await run(ev, snapshotGraph(m, pc));
    const reEvaluated = [...edited.diagnostics.values()].filter((d) => d.state === 'ok').map((d) => d.nodeId).sort();
    expect(reEvaluated).toEqual(['leaf', 'little']);
    expect(edited.diagnostics.get('trunk')?.state).toBe('cached');
    expect(edited.diagnostics.get('cap')?.state).toBe('cached');
  });

  it('ignores renames of generators but not of materials (their output embeds the name)', async () => {
    const m = modelFromDefault();
    const ev = new GraphEvaluator();
    await run(ev, snapshotGraph(m));
    m.patchNode('trunk', { name: 'Stem', x: 10 });
    expect((await run(ev, snapshotGraph(m))).evaluated).toBe(0);
    m.patchNode('m-bark', { name: 'Bark 2' });
    const r = await run(ev, snapshotGraph(m));
    expect(r.diagnostics.get('m-bark')?.state).toBe('ok');
  });

  it('is invalidated by the global seed and by the LOD, and keeps results of both LODs', async () => {
    const m = modelFromDefault();
    const ev = new GraphEvaluator();
    const snap = snapshotGraph(m);
    const a = await run(ev, snap, 1, 0);
    const b = await run(ev, snap, 2, 0);
    expect(b.evaluated).toBeGreaterThan(0);
    const lowDetail = await run(ev, snap, 1, 3);
    expect(lowDetail.scene.stats.triangles).toBeLessThan(a.scene.stats.triangles);
    const backToA = await run(ev, snap, 1, 0);
    expect(backToA.evaluated).toBe(0);
  });

  it('bounds memory with LRU eviction', async () => {
    const m = modelFromDefault();
    const ev = new GraphEvaluator(new EvalCache(50_000));
    await run(ev, snapshotGraph(m));
    expect(ev.cache.byteSize).toBeLessThanOrEqual(50_000 + 2_000_000);
    expect(ev.cache.size).toBeGreaterThan(0);
  });
});

describe('cancellation', () => {
  it('stops at the next slice and a restarted run reuses finished nodes', async () => {
    const m = modelFromDefault();
    const ev = new GraphEvaluator();
    const snap = snapshotGraph(m);
    const src = new CancellationSource();
    let yields = 0;
    await expect(
      ev.evaluate(snap, {
        seed: 1,
        lod: 0,
        token: src.token,
        budgetMs: -1,
        yieldFn: () => {
          yields += 1;
          if (yields === 3) src.cancel();
          return Promise.resolve();
        },
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    const resumed = await run(ev, snap);
    expect(resumed.cached).toBeGreaterThan(0);
    expect(resumed.evaluated).toBeGreaterThan(0);
    expect(resumed.errors).toBe(0);
  });

  it('passes the token to node code', async () => {
    const def: NodeDef = { type: 'test.slow', category: 'utility', label: 'Slow', icon: 'x', color: 'x', ports: [], params: [], evaluate: (ctx) => { ctx.cancel.throwIfCancelled(); return {}; } };
    registerNode(def);
    const m = new GraphModel();
    m.addNode({ type: 'test.slow', id: 's' });
    const src = new CancellationSource();
    src.cancel();
    await expect(new GraphEvaluator().evaluate(snapshotGraph(m), { seed: 1, lod: 0, token: src.token })).rejects.toBeInstanceOf(CancelledError);
    unregisterNode('test.slow');
  });
});

describe('determinism', () => {
  const sceneHashes = async (seed: number, reverse = false): Promise<string[]> => {
    const snap = snapshotGraph(modelFromDefault());
    const s = reverse ? { nodes: [...snap.nodes].reverse(), edges: [...snap.edges].reverse() } : snap;
    const r = await run(new GraphEvaluator(), s, seed);
    return r.scene.entries.map((e) => `${e.nodeId}:${hashPortValue({ kind: 'Mesh', value: e.mesh })}`).sort();
  };

  it('same graph + seed => identical geometry, regardless of node order', async () => {
    const a = await sceneHashes(77);
    expect(await sceneHashes(77)).toEqual(a);
    expect(await sceneHashes(77, true)).toEqual(a);
    expect(await sceneHashes(78)).not.toEqual(a);
  });

  it('node streams depend only on (seed, node id, node seed)', () => {
    expect(deriveNodeSeed(5, 'trunk')).toBe(deriveNodeSeed(5, 'trunk'));
    expect(deriveNodeSeed(5, 'trunk')).not.toBe(deriveNodeSeed(5, 'trunk', 1));
    expect(deriveNodeSeed(5, 'trunk')).not.toBe(deriveNodeSeed(5, 'branch'));
  });

  it('variance sampling consumes exactly one number and stays inside the band', () => {
    const a = new Rng(1);
    const b = new Rng(1);
    sampleVariance(a, 10, 0);
    sampleVariance(b, 10, 0.5);
    expect(a.next()).toBe(b.next());
    const r = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const v = sampleVariance(r, 10, 0.2);
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(12);
    }
  });
});

describe('node states', () => {
  it('survives a failing node: it errors, its descendants are blocked, siblings still run', async () => {
    const m = modelFromDefault();
    const orig = getNodeDef('generator.cap') as NodeDef;
    unregisterNode('generator.cap');
    registerNode({ ...orig, evaluate: () => { throw new Error('boom'); } });
    try {
      const r = await run(new GraphEvaluator(), snapshotGraph(m));
      expect(r.diagnostics.get('cap')?.state).toBe('error');
      expect(r.diagnostics.get('cap')?.messages[0]?.text).toBe('boom');
      expect(r.diagnostics.get('big')?.state).toBe('ok');
      expect(r.errors).toBe(1);
    } finally {
      unregisterNode('generator.cap');
      registerNode(orig);
    }
  });

  it('skips disabled nodes with their sub-tree; bypass passes the structure through; solo limits geometry', async () => {
    const m = modelFromDefault();
    m.patchNode('little', { enabled: false });
    let r = await run(new GraphEvaluator(), snapshotGraph(m));
    expect(r.diagnostics.get('little')?.state).toBe('skipped');
    expect(r.diagnostics.get('leaf')?.state).toBe('skipped');
    expect(r.diagnostics.get('cap')?.state).toBe('ok');

    m.patchNode('little', { enabled: true, bypass: true });
    r = await run(new GraphEvaluator(), snapshotGraph(m));
    expect(r.diagnostics.get('little')?.state).toBe('bypassed');
    expect(r.diagnostics.get('leaf')?.state).toBe('ok');
    expect(r.scene.entries.some((e) => e.nodeId === 'little')).toBe(false);
    expect(r.scene.entries.some((e) => e.nodeId === 'leaf')).toBe(true);

    m.patchNode('little', { bypass: false });
    m.patchNode('trunk', { solo: true });
    r = await run(new GraphEvaluator(), snapshotGraph(m));
    expect(r.scene.entries.map((e) => e.nodeId)).toEqual(['trunk']);
    expect(r.diagnostics.get('leaf')?.state).toBe('skipped');
  });

  it('labels edges with instance counts and totals', async () => {
    const m = modelFromDefault();
    const r = await run(new GraphEvaluator(), snapshotGraph(m));
    expect(r.edgeLabels.get('e-trunk-big')).toBeDefined();
    expect(r.scene.stats.totalInstances).toBeGreaterThan(10);
    expect(r.scene.stats.groups.map((g) => g.label)).toEqual(expect.arrayContaining(['branches', 'leaf meshes']));
  });
});

describe('node registry catalogue', () => {
  it('covers every category with consistent ports and unique ids', () => {
    const cats = new Set(listNodeDefs().map((d) => d.category));
    for (const c of ['generator', 'modifier', 'force', 'material', 'mesh', 'wind', 'utility', 'output'] as const) expect(cats.has(c)).toBe(true);
    for (const d of listNodeDefs()) {
      expect(new Set(d.params.map((p) => p.id)).size).toBe(d.params.length);
      if (d.category === 'generator') expect(d.ports.some((p) => p.id === PORT.parent)).toBe(true);
    }
    expect(listNodeDefs('generator').map((d) => d.label)).toEqual(expect.arrayContaining(['Trunk', 'Branch', 'Root', 'Leaf', 'Frond', 'Cap', 'Cluster']));
  });

  it('exposes the inspector tabs', () => {
    const tabs = (type: string): string[] => [...new Set((getNodeDef(type) as NodeDef).params.map((p) => p.group))];
    expect(tabs('generator.trunk')).toEqual(['Generation', 'Spine', 'Forces', 'Shape', 'Skin', 'UV', 'LOD', 'Displacement', 'Material', 'Animation', 'Hand drawn']);
    expect(tabs('generator.leaf')).toEqual(['Generation', 'Skin', 'Forces', 'Orientation', 'Material', 'Lighting', 'Wind', 'Post']);
    const leaf = getNodeDef('generator.leaf') as NodeDef;
    const subs = [...new Set(leaf.params.filter((p) => p.group === 'Material').map((p) => p.subgroup))];
    expect(subs).toEqual(['Leaves', 'Season', 'Fallen', 'Vertex Color', 'Lightmap']);
  });

  it('every definition evaluates with its default params and empty inputs', async () => {
    for (const d of listNodeDefs()) {
      const out = await d.evaluate({ nodeId: 'n', name: d.label, rng: new Rng(1), seed: 1, cancel: new CancellationSource().token, lod: 0, logger: console as never }, {}, defaultParams(d.params));
      expect(typeof out).toBe('object');
      expect(Object.values(out).every((v) => typeof v.kind === 'string')).toBe(true);
    }
  });

  it('hashes outputs by content', async () => {
    const d = getNodeDef('wind.settings') as NodeDef;
    const ctx = { nodeId: 'w', name: 'Wind', rng: new Rng(1), seed: 1, cancel: new CancellationSource().token, lod: 0, logger: console as never };
    const a = await d.evaluate(ctx, {}, defaultParams(d.params));
    expect(hashOutputs(a)).toBe(hashOutputs(await d.evaluate(ctx, {}, defaultParams(d.params))));
  });
});
