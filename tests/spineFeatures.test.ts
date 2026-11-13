import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { crownEnvelope, type CompiledSpineConfig } from '@/nodes/generators/spine';
import { getInspectorTabSpecs } from '@/ui/panels/properties/inspectorState';
import { getSpineOverlay } from '@/viewport/spineOverlay';
import { arcPositions, radiusFromDrag } from '@/viewport/gizmos/treePlacementGizmo';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[]) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod: 0, token: new CancellationSource().token });

const tipSpread = (r: Awaited<ReturnType<typeof run>>, id: string): number => {
  const sk = r.scene.skeletons.find((s) => s.nodeId === id)!.skeleton;
  let max = 0;
  for (let i = 0; i < sk.count; i++) max = Math.max(max, Math.hypot(sk.position[i * 3] as number, sk.position[i * 3 + 1] as number));
  return max;
};

describe('inspector tabs', () => {
  it('Trunk / Branch / Spine show the standard tab strip with unimplemented tabs disabled', () => {
    for (const type of ['generator.trunk', 'generator.branch', 'generator.spine']) {
      const tabs = getInspectorTabSpecs(type, getNodeDef(type)!.params);
      expect(tabs.map((t) => t.label)).toEqual(['All', 'Gen', 'Spine', 'Forces', 'Shape', 'Skin', 'UV', 'LOD', 'Displacement', 'Material', 'Animation', 'Segments', 'Physics', 'Hand Drawn']);
      expect(tabs.find((t) => t.label === 'Physics')?.disabled).toBe(true);
      expect(tabs.find((t) => t.label === 'Gen')?.disabled).toBeFalsy();
    }
  });

  it('Tree shows All | Gen | Shape | LOD | Collision', () => {
    const tabs = getInspectorTabSpecs('output.tree', getNodeDef('output.tree')!.params);
    expect(tabs.map((t) => t.label)).toEqual(['All', 'Gen', 'Shape', 'LOD', 'Collision']);
    expect(tabs.find((t) => t.label === 'Shape')?.disabled).toBeFalsy();
    expect(tabs.find((t) => t.label === 'Collision')?.disabled).toBe(true);
  });

  it('Spine tab sections follow the expected order', () => {
    const defs = getNodeDef('generator.spine')!.params.filter((d) => d.group === 'Spine');
    const sections = [...new Set(defs.map((d) => d.subgroup))];
    expect(sections.slice(0, 7)).toEqual(['Length', 'Clamp', 'Orientation', 'Shape', 'Parent Curl', 'Zigzag', 'Segment length']);
  });

  it('Tree Shape section has Radius, Sink, Roll and Unify child orientation', () => {
    const labels = getNodeDef('output.tree')!.params.filter((d) => d.group === 'Shape').map((d) => d.label);
    expect(labels).toEqual(expect.arrayContaining(['Radius', 'Sink', 'Roll', 'Unify child orientation']));
  });
});

describe('new spine parameters change the result', () => {
  const base = (extra: Record<string, number>): NodeSpec[] => [
    { id: 'tree', type: 'output.tree', parent: null },
    { id: 'sp', type: 'generator.spine', parent: 'tree', params: { number: 1, length: 3, noiseAmount: 0, earlyNoiseAmount: 0, spread: 0, ...extra } },
  ];

  it('Parent Curl Out bends the spine away from the axis', async () => {
    const straight = tipSpread(await run(base({})), 'sp');
    const curled = tipSpread(await run(base({ curlOut: 1 })), 'sp');
    expect(curled).toBeGreaterThan(straight + 0.1);
  });

  it('Zigzag displaces the spine sideways', async () => {
    const straight = tipSpread(await run(base({ segments: 8 })), 'sp');
    const zig = tipSpread(await run(base({ segments: 8, zigzag: 1 })), 'sp');
    expect(zig).toBeGreaterThan(straight + 0.05);
  });

  it('Clamp Max limits the spine length', async () => {
    const r = await run(base({ lengthMax: 1 }));
    const sk = r.scene.skeletons.find((s) => s.nodeId === 'sp')!.skeleton;
    expect(sk.branches[0]!.length).toBeLessThanOrEqual(1.01);
  });

  it('Spine overlay exposes its segments', async () => {
    const r = await run(base({ number: 5 }));
    const o = getSpineOverlay(r.scene, 'sp');
    expect(o?.branchCount).toBe(5);
    expect(o!.segments.length).toBeGreaterThan(0);
    expect(getSpineOverlay(r.scene, 'missing')).toBeNull();
  });
});

describe('crown envelope', () => {
  const cfg = (shape: string): Pick<CompiledSpineConfig, 'crownShape' | 'crownLut'> => ({ crownShape: shape, crownLut: null });
  it('conical shrinks toward the top, oval peaks in the middle, columnar is constant', () => {
    expect(crownEnvelope(cfg('conical'), 0)).toBeGreaterThan(crownEnvelope(cfg('conical'), 1));
    expect(crownEnvelope(cfg('oval'), 0.5)).toBeGreaterThan(crownEnvelope(cfg('oval'), 0.02));
    expect(crownEnvelope(cfg('oval'), 0.5)).toBeGreaterThan(crownEnvelope(cfg('oval'), 0.98));
    expect(crownEnvelope(cfg('columnar'), 0.3)).toBe(1);
  });
});

describe('Tree gizmo math', () => {
  it('radius follows the drag and Shift snaps to 0.5 m', () => {
    expect(radiusFromDrag({ x: 3, y: 4 }, { x: 0, y: 0 }, false)).toBe(5);
    expect(radiusFromDrag({ x: 3.1, y: 4.1 }, { x: 0, y: 0 }, true)).toBe(5);
    expect(radiusFromDrag({ x: 13, y: 4 }, { x: 10, y: 0 }, false)).toBe(5);
    expect(arcPositions(0, Math.PI * 2, 8)).toHaveLength(48);
  });
});
