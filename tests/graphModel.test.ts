import { beforeAll, describe, expect, it } from 'vitest';
import { GraphModel } from '@/graph/model/graphModel';
import { copySubgraph, planPaste } from '@/graph/model/clipboard';
import { alignPositions, distributePositions, findFreeSlot, tidyTreeLayout } from '@/graph/model/layout';
import { fuzzyScore, searchDefs } from '@/graph/model/search';
import { buildDemoGraph } from './fixtures/demoGraph';
import { PORT } from '@/graph/ports';
import { registerDiscoveredNodes } from '@/graph/registry';

beforeAll(() => registerDiscoveredNodes());

function small(): GraphModel {
  const m = new GraphModel();
  buildDemoGraph(m, 'doc-1');
  return m;
}

describe('GraphModel', () => {
  it('builds the demo graph with hierarchy and attachments', () => {
    const m = small();
    expect(m.hierarchyNodes()).toHaveLength(13);
    expect(m.attachmentNodes()).toHaveLength(5);
    expect(m.roots().map((n) => n.id)).toEqual(['tree']);
    expect(m.parentOf('big1')?.id).toBe('trunk');
    expect(m.childrenOf('trunk').map((n) => n.id).sort()).toEqual(['big1', 'big2', 'leaf4']);
    expect(m.descendants('trunk')).toHaveLength(11);
    expect(m.ancestors('leaf3a').map((n) => n.id)).toEqual(['leaf2', 'leaf', 'big1', 'trunk', 'tree']);
    expect(m.attachedTo('trunk', 'force')).toHaveLength(2);
  });

  it('validates connections: type, direction, self, cycle, duplicates, capacity', () => {
    const m = small();
    const out = (id: string): { nodeId: string; portId: string } => ({ nodeId: id, portId: PORT.children });
    const inn = (id: string): { nodeId: string; portId: string } => ({ nodeId: id, portId: PORT.parent });
    expect(m.canConnect(out('big1'), inn('big1')).reason).toMatch(/itself/);
    expect(m.canConnect(out('leaf3a'), inn('trunk')).reason).toMatch(/cycle/);
    expect(m.canConnect(out('trunk'), inn('big1')).reason).toMatch(/Already/);
    expect(m.canConnect(inn('big1'), out('trunk')).reason).toMatch(/output to an input/);
    // Force output into a Structure input: incompatible edge family
    expect(m.canConnect({ nodeId: 'f-grav', portId: PORT.out }, inn('big1')).ok).toBe(false);
    // single-parent rule: connecting a second parent replaces the old edge
    const c = m.canConnect(out('big2'), inn('leaf'));
    expect(c.ok).toBe(true);
    expect(c.replaced.map((e) => e.from.nodeId)).toEqual(['big1']);
    // attachments accept many
    expect(m.canConnect({ nodeId: 'f-grav', portId: PORT.out }, { nodeId: 'big1', portId: PORT.forces }).ok).toBe(true);
    // locked nodes cannot be rewired
    m.patchNode('big1', { locked: true });
    expect(m.canConnect(out('big2'), inn('big1')).reason).toMatch(/locked/);
  });

  it('removing a node removes its edges and emits events', () => {
    const m = small();
    const seen: string[] = [];
    m.events.on('edgeRemoved', (e) => seen.push(e.id));
    m.events.on('nodeRemoved', (n) => seen.push(n.id));
    m.removeNode('leaf4');
    expect(m.getNode('leaf4')).toBeUndefined();
    expect(seen).toContain('leaf4');
    expect(seen.filter((s) => s.startsWith('e-'))).toHaveLength(3);
    expect(m.childrenOf('trunk').map((n) => n.id).sort()).toEqual(['big1', 'big2']);
  });

  it('patchNode emits only changed keys; setParam emits paramChanged', () => {
    const m = small();
    const keys: string[][] = [];
    m.events.on('nodeChanged', (e) => keys.push(e.keys));
    m.patchNode('trunk', { x: 5, y: m.getNode('trunk')?.y });
    expect(keys).toEqual([['x']]);
    m.patchNode('trunk', { x: 5 });
    expect(keys).toHaveLength(1);
    let got = '';
    m.events.on('paramChanged', (e) => (got = `${e.nodeId}.${e.paramId}`));
    m.setParam('trunk', 'number', { value: 9 });
    expect(got).toBe('trunk.number');
    expect(m.getNode('trunk')?.params.number?.value).toBe(9);
  });

  it('round-trips through JSON (including flags and annotations)', () => {
    const m = small();
    m.patchNode('big1', { collapsed: true, locked: true, note: 'hello', enabled: false });
    m.insertAnnotation({ id: 'g1', kind: 'group', text: 'G', x: 1, y: 2, w: 100, h: 80, color: 'green' });
    const json = JSON.parse(JSON.stringify(m.toJSON())) as unknown;
    const back = GraphModel.fromJSON(json);
    expect(back.toJSON()).toEqual(m.toJSON());
    expect(back.getNode('big1')).toMatchObject({ collapsed: true, locked: true, note: 'hello', enabled: false });
  });

  it('load() drops invalid entries instead of throwing', () => {
    const m = GraphModel.fromJSON({
      nodes: [{ id: 'a', type: 'output.tree' }, { id: 'a', type: 'output.tree' }, { id: 5 }, null, { id: 'b', type: 'generator.trunk', position: { x: 'x' } }],
      edges: [
        { id: 'e1', kind: 'hierarchy', from: { nodeId: 'a', portId: 'children' }, to: { nodeId: 'b', portId: 'parent' } },
        { id: 'e2', kind: 'hierarchy', from: { nodeId: 'a', portId: 'children' }, to: { nodeId: 'zzz', portId: 'parent' } },
        { id: 'e1', kind: 'hierarchy', from: { nodeId: 'a', portId: 'children' }, to: { nodeId: 'b', portId: 'parent' } },
      ],
    });
    expect(m.nodeCount).toBe(2);
    expect(m.edges()).toHaveLength(1);
    expect(GraphModel.fromJSON('garbage').nodeCount).toBe(0);
  });

  it('generates unique ids', () => {
    const m = small();
    const ids = new Set(Array.from({ length: 50 }, () => m.newId('n')));
    expect(ids.size).toBe(50);
  });
});

describe('layout helpers', () => {
  it('tidy tree: parents centred above children, root anchored, no overlaps', () => {
    const nodes = ['r', 'a', 'b', 'c', 'd'].map((id) => ({ id, x: 0, y: 0 }));
    nodes[0] = { id: 'r', x: 100, y: 50 };
    const links = [
      { parent: 'r', child: 'a' },
      { parent: 'r', child: 'b' },
      { parent: 'a', child: 'c' },
      { parent: 'a', child: 'd' },
    ];
    const p = tidyTreeLayout(nodes, links, 50, 50);
    expect(p.get('r')).toEqual({ x: 100, y: 50 });
    expect(p.get('a')?.y).toBe(0);
    expect(p.get('c')?.y).toBe(-50);
    expect(p.get('a')?.x).toBe(((p.get('c')?.x ?? 0) + (p.get('d')?.x ?? 0)) / 2);
    expect(p.get('r')?.x).toBe(((p.get('a')?.x ?? 0) + (p.get('b')?.x ?? 0)) / 2);
    const xs = [p.get('c')?.x, p.get('d')?.x, p.get('b')?.x];
    expect(new Set(xs).size).toBe(3);
  });

  it('align / distribute / free slot', () => {
    const items = [
      { id: 'a', x: 0, y: 10 },
      { id: 'b', x: 30, y: 50 },
      { id: 'c', x: 100, y: 20 },
    ];
    expect(alignPositions(items, 'left').get('c')?.x).toBe(0);
    expect(alignPositions(items, 'bottom').get('a')?.y).toBe(50);
    expect(distributePositions(items, 'x').get('b')?.x).toBe(50);
    const slot = findFreeSlot([{ x: 0, y: 0 }], 0, 0, 52, 40);
    expect(Math.abs(slot.x)).toBe(52);
  });
});

describe('search', () => {
  it('ranks prefix > word start > substring > subsequence', () => {
    expect(fuzzyScore('le', 'Leaf')).toBeGreaterThan(fuzzyScore('le', 'Gravity Level'));
    expect(fuzzyScore('lf', 'Leaf')).toBeGreaterThan(0);
    expect(fuzzyScore('xyz', 'Leaf')).toBe(-1);
    const defs = [
      { type: 'a', label: 'Branch', category: 'generator' },
      { type: 'b', label: 'Leaf', category: 'generator' },
    ];
    expect(searchDefs(defs, 'lea').map((d) => d.type)).toEqual(['b']);
    expect(searchDefs(defs, '', ['b']).map((d) => d.type)).toEqual(['b', 'a']);
  });
});

describe('clipboard', () => {
  it('copies internal edges only and plans a paste with fresh ids under a parent', () => {
    const m = small();
    const payload = copySubgraph(m, ['big1', 'little', 'cap1', 'tree']);
    expect(payload.nodes.map((n) => n.id).sort()).toEqual(['big1', 'cap1', 'little']);
    expect(payload.edges).toHaveLength(2);
    const plan = planPaste(m, payload, 10, 10, 'trunk');
    expect(plan.nodes).toHaveLength(3);
    expect(plan.nodes.every((n) => !m.hasNode(n.id))).toBe(true);
    expect(plan.rootIds).toHaveLength(1);
    expect(plan.edges).toHaveLength(3);
    expect(plan.edges.some((e) => e.from.nodeId === 'trunk' && e.to.nodeId === plan.rootIds[0])).toBe(true);
  });
});
