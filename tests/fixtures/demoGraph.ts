import { H_SPACING, tidyTreeLayout } from '@/graph/model/layout';
import type { GraphModel } from '@/graph/model/graphModel';
import { PORT } from '@/graph/ports';

/**
 * Hand-made demo graphs . Ids are stable so the same document always produces the
 * same tree.
 */
export const DEMO_DOCS: Record<string, string> = { 'doc-1': 'spruce', 'doc-2': 'empty', 'doc-3': 'palm' };

type Spec = [id: string, type: string, name: string, parent: string | null];

function build(model: GraphModel, specs: Spec[]): void {
  for (const [id, type, name] of specs) model.addNode({ id, type, name });
  for (const [id, , , parent] of specs) {
    if (!parent) continue;
    const pair = model.findPortPair(parent, id, 'hierarchy');
    if (pair) model.insertEdge(model.makeEdge(pair.from, pair.to, `e-${parent}-${id}`));
  }
  const nodes = specs.map(([id]) => model.getNode(id)).filter((n): n is NonNullable<typeof n> => n !== undefined);
  const links = specs.filter((s) => s[3]).map((s) => ({ parent: s[3] as string, child: s[0] }));
  const layout = tidyTreeLayout(nodes.map((n) => ({ id: n.id, x: 0, y: 0 })), links, H_SPACING);
  for (const [id, p] of layout) model.patchNode(id, { x: p.x, y: p.y });
}

function attach(model: GraphModel, id: string, type: string, name: string, target: string): void {
  model.addNode({ id, type, name });
  model.insertEdge(model.makeEdge({ nodeId: id, portId: PORT.out }, { nodeId: target, portId: attachPort(type) }, `e-${id}`));
}

function attachPort(type: string): string {
  if (type.startsWith('force')) return PORT.forces;
  if (type.startsWith('material')) return PORT.materials;
  if (type.startsWith('mesh')) return PORT.meshes;
  return PORT.wind;
}

export function buildDemoGraph(model: GraphModel, docId: string): void {
  const kind = DEMO_DOCS[docId] ?? 'empty';
  if (kind === 'spruce') {
    build(model, [
      ['tree', 'output.tree', 'Tree', null],
      ['trunk', 'generator.trunk', 'Trunk', 'tree'],
      ['big1', 'generator.branch', 'Big branches', 'trunk'],
      ['big2', 'generator.branch', 'Big branches 2', 'trunk'],
      ['leaf4', 'generator.leaf', 'Leaf 4', 'trunk'],
      ['little', 'generator.branch', 'Little branches', 'big1'],
      ['cap1', 'generator.cap', 'Cap', 'big1'],
      ['leaf', 'generator.leaf', 'Leaf', 'big1'],
      ['cap2', 'generator.cap', 'Cap', 'big2'],
      ['leaf3b', 'generator.leaf', 'Leaf 3', 'leaf4'],
      ['leaf3c', 'generator.leaf', 'Leaf 3', 'leaf4'],
      ['leaf2', 'generator.leaf', 'Leaf 2', 'leaf'],
      ['leaf3a', 'generator.leaf', 'Leaf 3', 'leaf2'],
    ]);
    attach(model, 'f-grav', 'force.gravity', 'Gravity', 'trunk');
    attach(model, 'f-dir', 'force.directional', 'Directional Force', 'trunk');
    attach(model, 'm-bark', 'material.standard', 'Bark texture', 'trunk');
    attach(model, 'm-leaf', 'material.standard', 'Leaves Games', 'leaf');
    attach(model, 'm-cap', 'material.standard', 'Cap material', 'cap1');
  } else if (kind === 'palm') {
    build(model, [
      ['tree', 'output.tree', 'Tree', null],
      ['trunk', 'generator.trunk', 'Trunk', 'tree'],
      ['fronds', 'generator.frond', 'Fronds', 'trunk'],
      ['cluster', 'generator.cluster', 'Coconuts', 'trunk'],
      ['roots', 'generator.root', 'Roots', 'tree'],
    ]);
    attach(model, 'm-bark', 'material.standard', 'Palm bark', 'trunk');
  } else {
    build(model, [
      ['tree', 'output.tree', 'Tree', null],
      ['trunk', 'generator.trunk', 'Trunk', 'tree'],
    ]);
  }
}
