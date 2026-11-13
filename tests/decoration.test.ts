import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource, type NodeContext } from '@/contracts/nodes';
import type { MaskDef } from '@/contracts/material';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { createLogger } from '@/core/logger';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { createMaskDef } from '@/materials/masks';
import { setMaterialSource } from '@/materials/materialSource';
import { planDecorations } from '@/nodes/generators/decoration';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

/** A 4 m straight vertical trunk, radius 0.25. */
function trunk(): Skeleton {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, 0.25);
  sb.endBranch();
  return sb.build();
}

const params = (over: Record<string, unknown> = {}): NodeParams => {
  const out: NodeParams = {};
  for (const d of getNodeDef('generator.decoration')!.params) out[d.id] = defaultParamState(d);
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as NodeParams[string]), value: v as never };
  return out;
};

const ctx = (lod = 0, seed = 5): NodeContext => ({ nodeId: 'd', name: 'Decoration', rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod, logger: createLogger('test', 'error') });

describe('Decoration planning', () => {
  it('places items on the parent surface (distance to the axis = radius + offset)', () => {
    const items = planDecorations(ctx(), trunk(), params({ number: 40, decoOffset: 0.01 }));
    expect(items.length).toBe(40);
    for (const it of items) {
      const d = Math.hypot(it.position[0] - it.axisPoint[0], it.position[1] - it.axisPoint[1], it.position[2] - it.axisPoint[2]);
      expect(d).toBeCloseTo(it.radius + 0.01, 5);
    }
  });

  it('respects the angle range, boundaries and the world compass reference', () => {
    const items = planDecorations(ctx(), trunk(), params({ number: 60, decoAngle: [20, 80], first: 0.25, last: 0.5 }));
    for (const it of items) {
      expect(it.angleDeg).toBeGreaterThanOrEqual(20);
      expect(it.angleDeg).toBeLessThanOrEqual(80);
      expect(it.u).toBeGreaterThanOrEqual(0.249);
      expect(it.u).toBeLessThanOrEqual(0.501);
    }
    const world = planDecorations(ctx(), trunk(), params({ number: 60, decoAngle: [45, 135], decoAngleRef: 'world' }));
    expect(world.length).toBeGreaterThan(30);
    for (const it of world) {
      const az = (Math.atan2(it.outward[1], it.outward[0]) * 180) / Math.PI;
      expect(az).toBeGreaterThanOrEqual(44.9);
      expect(az).toBeLessThanOrEqual(135.1);
    }
  });

  it('excludes surfaces outside the mask (moss only on the upper half of the height range)', () => {
    const mask: MaskDef = { ...createMaskDef('m1', 'High'), relativeElevation: { min: 0.5, max: 1 } };
    setMaterialSource({ materials: () => [], sets: () => [], displacements: () => [], masks: () => [mask], season: () => 0.5 });
    const items = planDecorations(ctx(), trunk(), params({ number: 80, decoMask: 'm1' }));
    setMaterialSource(null);
    expect(items.length).toBeGreaterThan(20);
    expect(items.length).toBeLessThan(80);
    for (const it of items) expect(it.position[2]).toBeGreaterThanOrEqual(2 - 1e-6);
  });

  it('is deterministic and scales with density', () => {
    const a = planDecorations(ctx(), trunk(), params({ number: 25 }));
    const b = planDecorations(ctx(), trunk(), params({ number: 25 }));
    expect(a.map((i) => i.position)).toEqual(b.map((i) => i.position));
    const lo = planDecorations(ctx(), trunk(), params({ decoMode: 'density', decoDensity: 5 }));
    const hi = planDecorations(ctx(), trunk(), params({ decoMode: 'density', decoDensity: 20 }));
    expect(lo.length).toBeGreaterThanOrEqual(19);
    expect(lo.length).toBeLessThanOrEqual(21);
    expect(hi.length).toBeGreaterThanOrEqual(79);
    expect(hi.length).toBeLessThanOrEqual(81);
  });

  it('clustered spacing groups items and overlap < 1 separates them; LOD culls', () => {
    const cl = planDecorations(ctx(), trunk(), params({ number: 30, decoSpacing: 'clustered', decoClusterCount: 10, decoClusterSize: 0.1, decoAngle: [-30, 30] }));
    expect(cl.length).toBe(30);
    const sep = planDecorations(ctx(), trunk(), params({ number: 200, decoOverlap: 0, decoWidth: 0.3, decoHeight: 0.3 }));
    expect(sep.length).toBeLessThan(200);
    const low = planDecorations(ctx(3), trunk(), params({ number: 100, lodCull: 0.8 }));
    expect(low.length).toBeLessThan(40);
  });
});

describe('Decoration node', () => {
  it('Tree -> Trunk -> Decoration builds finite, conforming card geometry with inherited wind', async () => {
    const specs: NodeSpec[] = [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: {} },
      { id: 'deco', type: 'generator.decoration', parent: 'trunk', params: { number: 30 } },
    ];
    const r = await new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod: 0, token: new CancellationSource().token });
    const d = r.diagnostics.get('deco')!;
    expect(d.state).not.toBe('error');
    expect(d.instances).toBe(30);
    expect(d.triangles).toBe(30 * 3 * 2 * 2);
    const entry = r.scene.entries.find((e) => e.nodeId === 'deco')!;
    expect(entry.mesh.wind?.weights.length).toBe((entry.mesh.positions.length / 3) * 4);
    expect(entry.mesh.tangents?.length).toBe((entry.mesh.positions.length / 3) * 4);
    for (const v of entry.mesh.positions) expect(Number.isFinite(v)).toBe(true);
    expect(entry.statsGroup).toBe('decorations');
  });
});
