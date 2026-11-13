import type { GraphJSON } from '@/contracts/project';
import { H_SPACING, tidyTreeLayout } from '@/graph/model/layout';
import { GraphModel } from '@/graph/model/graphModel';
import type { ParamValue } from '@/contracts/params';

type Spec = { id: string; type: string; name: string; parent: string | null; params?: Record<string, ParamValue> };

/**
 * Default project graph loaded at startup:
 * Tree -> Trunk -> (Roots, Big Branches -> (Little Branches -> Leaf, Cap)), plus Gravity + Materials.
 */
export function defaultGraph(): GraphJSON {
  const model = new GraphModel();
  const specs: Spec[] = [
    { id: 'tree', type: 'output.tree', name: 'Tree', parent: null },
    {
      id: 'trunk',
      type: 'generator.trunk',
      name: 'Trunk',
      parent: 'tree',
      params: {
        length: 12.5,
        radius: 0.34,
        taper: 0.88,
        flareRadius: 0.32,
        flareHeight: 0.14,
        crownHeight: 0.24,
        lean: 2.5,
        noiseAmount: 0.16,
        segments: 24,
      },
    },
    {
      id: 'roots',
      type: 'generator.root',
      name: 'Roots',
      parent: 'trunk',
      params: {
        number: 5,
        first: 0,
        last: 0.08,
        length: 2.8,
        radius: 0.1,
        flareBlend: 0.7,
        rootSpread: 1.2,
        rootDepth: 1.3,
        splitChance: 0.35,
      },
    },
    {
      id: 'big',
      type: 'generator.branch',
      name: 'Big Branches',
      parent: 'trunk',
      params: {
        mode: 'absolute',
        alignStyle: 'spiral',
        number: 14,
        length: 4.6,
        lengthPercent: 0.12,
        radius: 0.095,
        parentRadiusInfluence: 0.45,
        first: 0.24,
        last: 0.94,
        spread: 52,
        gravity: 0.18,
        upDown: 0.08,
        curvature: 0.1,
        noiseAmount: 0.22,
        splitChance: 0.2,
      },
    },
    {
      id: 'little',
      type: 'generator.branch',
      name: 'Little Branches',
      parent: 'big',
      params: {
        mode: 'phyllotaxy',
        number: 9,
        length: 1.45,
        lengthPercent: 0.15,
        radius: 0.026,
        parentRadiusInfluence: 0.4,
        first: 0.16,
        last: 0.96,
        spread: 54,
        gravity: 0.14,
        upDown: 0.12,
        noiseAmount: 0.16,
      },
    },
    { id: 'leaf', type: 'generator.leaf', name: 'Leaf', parent: 'little', params: { number: 5, width: 0.2, height: 0.36, leavesPerNode: 2, clusterAngle: 35, angleToParent: 50, droopAmount: 0.25 } },
    { id: 'cap', type: 'generator.cap', name: 'Cap', parent: 'big' },
  ];

  for (const s of specs) {
    const node = model.addNode({ id: s.id, type: s.type, name: s.name });
    for (const [pid, value] of Object.entries(s.params ?? {})) {
      const cur = node.params[pid];
      if (cur) node.params[pid] = { ...cur, value };
    }
  }
  for (const s of specs) {
    if (!s.parent) continue;
    const pair = model.findPortPair(s.parent, s.id, 'hierarchy');
    if (pair) model.insertEdge(model.makeEdge(pair.from, pair.to, `e-${s.parent}-${s.id}`));
  }

  const nodes = specs.map((s) => model.getNode(s.id)).filter((n): n is NonNullable<typeof n> => n !== undefined);
  const links = specs.filter((s) => s.parent).map((s) => ({ parent: s.parent as string, child: s.id }));
  for (const [id, p] of tidyTreeLayout(nodes.map((n) => ({ id: n.id, x: 0, y: 0 })), links, H_SPACING)) {
    model.patchNode(id, { x: p.x, y: p.y });
  }

  const attach = (id: string, type: string, name: string, target: string): void => {
    model.addNode({ id, type, name, x: 0, y: 0 });
    const pair = model.findPortPair(id, target, 'attachment');
    if (pair) model.insertEdge(model.makeEdge(pair.from, pair.to, `a-${id}-${target}`));
  };
  attach('f-gravity', 'force.gravity', 'Gravity', 'big');
  attach('m-bark', 'material.standard', 'Bark', 'trunk');
  attach('m-leaf', 'material.standard', 'Leaves', 'leaf');
  return model.toJSON();
}
