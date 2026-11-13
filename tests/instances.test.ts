import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import type { EvaluationSummary } from '@/contracts/engine';
import type { InstanceOverride, InstanceTable } from '@/instances/types';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import {
  OVERRIDES_PARAM_ID,
  decodeOverrides,
  encodeOverrides,
  migrateOverridesPayload,
  overridesParamState,
  readOverrides,
  reanchorOverrides,
  resolveOverrides,
  upsertOverride,
} from '@/instances/overrides';
import { instanceKey } from '@/instances/keys';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const specs = (branch: Record<string, number> = {}, trunk: Record<string, number> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { number: 1, length: 6, ...trunk } },
  { id: 'br', type: 'generator.branch', parent: 'trunk', params: { number: 6, length: 2, ...branch } },
];

async function run(s: NodeSpec[], overrides: { node: string; list: InstanceOverride[] }[] = []): Promise<EvaluationSummary> {
  const model = buildGraph(s);
  for (const o of overrides) model.setParam(o.node, OVERRIDES_PARAM_ID, overridesParamState(o.list));
  return new GraphEvaluator().evaluate(snapshotGraph(model), { seed: 1, lod: 0, token: new CancellationSource().token });
}

const tableOf = (r: EvaluationSummary, id: string): InstanceTable => {
  const t = r.scene.skeletons.find((s) => s.nodeId === id)?.instances;
  if (!t) throw new Error(`no table for ${id}`);
  return t;
};
const skOf = (r: EvaluationSummary, id: string) => r.scene.skeletons.find((s) => s.nodeId === id)!.skeleton;

const branchLength = (r: EvaluationSummary, id: string, row: number): number => {
  const t = tableOf(r, id);
  return skOf(r, id).branches[t.branchStart[row] as number]!.length;
};

describe('instance keys', () => {
  it('are deterministic and depend on node, parent, index and sub-seed only', () => {
    expect(instanceKey('a', 0, 3)).toBe(instanceKey('a', 0, 3));
    expect(instanceKey('a', 0, 3)).not.toBe(instanceKey('a', 0, 4));
    expect(instanceKey('a', 0, 3)).not.toBe(instanceKey('b', 0, 3));
    expect(instanceKey('a', 0, 3, 1)).not.toBe(instanceKey('a', 0, 3, 0));
  });

  it('survive unrelated parameter changes and are unique', async () => {
    const a = await run(specs());
    const b = await run(specs({ gravity: 0.5, length: 3 }));
    const ta = tableOf(a, 'br');
    const tb = tableOf(b, 'br');
    expect(ta.count).toBeGreaterThan(0);
    expect(Array.from(tb.key)).toEqual(Array.from(ta.key));
    expect(new Set(ta.key).size).toBe(ta.count);
    expect(Array.from(ta.parentKey).every((k) => k === (tableOf(a, 'trunk').key[0] as number))).toBe(true);
  });

  it('table covers every skeleton branch and bounds are filled', async () => {
    const r = await run(specs());
    const t = tableOf(r, 'br');
    const sk = skOf(r, 'br');
    expect(Array.from(t.branchToInstance).every((v) => v >= 0)).toBe(true);
    expect(t.branchToInstance.length).toBe(sk.branches.length);
    expect(t.bounds[3]! > t.bounds[0]!).toBe(true);
  });
});

describe('override application', () => {
  it('lengthScale changes only that instance', async () => {
    const base = await run(specs());
    const t = tableOf(base, 'br');
    const key = t.key[2] as number;
    const r = await run(specs(), [{ node: 'br', list: [{ key, params: {}, transform: { lengthScale: 2 } }] }]);
    expect(branchLength(r, 'br', 2)).toBeGreaterThan(branchLength(base, 'br', 2) * 1.6);
    expect(branchLength(r, 'br', 1)).toBeCloseTo(branchLength(base, 'br', 1), 4);
    expect(Array.from(tableOf(r, 'br').key)).toEqual(Array.from(t.key));
  });

  it('param overrides support set / offset / scale', async () => {
    const base = await run(specs());
    const key = tableOf(base, 'br').key[0] as number;
    const L0 = branchLength(base, 'br', 0);
    const set = await run(specs(), [{ node: 'br', list: [{ key, params: { length: { mode: 'set', value: 0.5 } } }] }]);
    expect(branchLength(set, 'br', 0)).toBeLessThan(L0);
    const scale = await run(specs(), [{ node: 'br', list: [{ key, params: { length: { mode: 'scale', value: 0.25 } } }] }]);
    expect(branchLength(scale, 'br', 0)).toBeLessThan(L0 * 0.5);
  });

  it('pruned instances disappear and are not reported as orphans', async () => {
    const base = await run(specs());
    const key = tableOf(base, 'br').key[1] as number;
    const list: InstanceOverride[] = [{ key, params: {}, pruned: true }];
    const r = await run(specs(), [{ node: 'br', list }]);
    expect(tableOf(r, 'br').count).toBe(tableOf(base, 'br').count - 1);
    expect(resolveOverrides(tableOf(r, 'br'), list).orphans).toHaveLength(0);
  });

  it('hidden instances stay in the skeleton but lose their triangles', async () => {
    const base = await run(specs());
    const key = tableOf(base, 'br').key[1] as number;
    const r = await run(specs(), [{ node: 'br', list: [{ key, params: {}, hidden: true }] }]);
    expect(tableOf(r, 'br').count).toBe(tableOf(base, 'br').count);
    const tris = (x: EvaluationSummary): number => x.scene.entries.find((e) => e.nodeId === 'br')!.mesh.indices.length / 3;
    expect(tris(r)).toBeLessThan(tris(base));
  });

  it('applies parents before children: children follow a modified parent and keep their keys', async () => {
    const base = await run(specs());
    const trunkKey = tableOf(base, 'trunk').key[0] as number;
    const r = await run(specs(), [{ node: 'trunk', list: [{ key: trunkKey, params: {}, transform: { lengthScale: 0.5 } }] }]);
    expect(skOf(r, 'trunk').branches[0]!.length).toBeLessThan(skOf(base, 'trunk').branches[0]!.length * 0.7);
    expect(Array.from(tableOf(r, 'br').key)).toEqual(Array.from(tableOf(base, 'br').key));
    const topBase = Math.max(...Array.from(skOf(base, 'br').position).filter((_, i) => i % 3 === 2));
    const topNew = Math.max(...Array.from(skOf(r, 'br').position).filter((_, i) => i % 3 === 2));
    expect(topNew).toBeLessThan(topBase);
  });

  it('rotation offset moves a branch around the parent axis', async () => {
    const base = await run(specs());
    const key = tableOf(base, 'br').key[0] as number;
    const r = await run(specs(), [{ node: 'br', list: [{ key, params: {}, transform: { rotation: 90 } }] }]);
    const tip = (x: EvaluationSummary): [number, number] => {
      const sk = skOf(x, 'br');
      const b = sk.branches[0]!;
      const i = (b.start + b.count - 1) * 3;
      return [sk.position[i] as number, sk.position[i + 1] as number];
    };
    const [x0, y0] = tip(base);
    const [x1, y1] = tip(r);
    expect(Math.hypot(x1 - x0, y1 - y0)).toBeGreaterThan(0.2);
  });
});

describe('serialisation and re-anchoring', () => {
  it('round-trips through encode/decode and the graph JSON', () => {
    const list: InstanceOverride[] = [
      { key: 7, anchor: { parentKey: 3, index: 2 }, params: { spread: { mode: 'offset', value: 5 } }, transform: { rotation: 10, lengthScale: 1.5 }, hidden: true },
    ];
    expect(decodeOverrides(encodeOverrides(list))).toEqual(list);
    const m = buildGraph(specs());
    m.setParam('br', OVERRIDES_PARAM_ID, overridesParamState(list));
    const json = JSON.parse(JSON.stringify(m.toJSON())) as ReturnType<GraphModel['toJSON']>;
    const back = GraphModel.fromJSON(json);
    expect(readOverrides(back.getNode('br')!.params)).toEqual(list);
  });

  it('migrates the bare-array v0 payload and drops malformed items', () => {
    const out = migrateOverridesPayload([{ key: 5, params: { a: { mode: 'set', value: 1 } } }, { key: 'x' }, null, { key: 5, params: {} }]);
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe(5);
    expect(decodeOverrides('not json')).toEqual([]);
  });

  it('neutral overrides are removed by upsert', () => {
    const one = upsertOverride([], { key: 1, params: {}, transform: { lengthScale: 2 } });
    expect(one).toHaveLength(1);
    expect(upsertOverride(one, { key: 1, params: {}, transform: { lengthScale: 1 } })).toHaveLength(0);
  });

  it('re-anchors orphans to the nearest free slot of the same parent, otherwise lists them', async () => {
    const base = await run(specs());
    const t = tableOf(base, 'br');
    const gone: InstanceOverride = { key: 123456, anchor: { parentKey: t.parentKey[0] as number, index: (t.index[0] as number) + 0 }, params: {}, transform: { rotation: 5 } };
    const stranger: InstanceOverride = { key: 654321, anchor: { parentKey: 99, index: 0 }, params: {}, transform: { rotation: 5 } };
    const keep: InstanceOverride = { key: t.key[0] as number, params: {}, transform: { rotation: 1 } };
    const res = resolveOverrides(t, [gone, stranger, keep]);
    expect(res.orphans.map((o) => o.key).sort()).toEqual([123456, 654321]);
    const fixed = reanchorOverrides(t, [gone, stranger, keep], 3);
    expect(fixed.remaining.map((o) => o.key)).toEqual([654321]);
    expect(resolveOverrides(t, fixed.overrides).orphans.map((o) => o.key)).toEqual([654321]);
  });
});
