import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import { defaultParams, type NodeParams } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { buildTubeMesh } from '@/geometry/tubeMesher';
import { getNodeDef, migrateNodeParams, registerDiscoveredNodes } from '@/graph/registry';
import { tubeOptionsFromParams } from '@/nodes/generators/common';
import { evaluateKnot } from '@/nodes/generators/knot';
import { evaluateTrunk } from '@/nodes/generators/trunk';
import { migrateKnotParams } from '@/nodes/generators/knotConfig';
import { SIZE_PARAMS } from '@/generators/common/sizeScalar';
import { getInspectorTabSpecs, buildInspectorSections } from '@/ui/panels/properties/inspectorState';

beforeAll(() => registerDiscoveredNodes());

const RADIUS = 0.25;

/** A 4 m straight vertical trunk with a real tube mesh built (so the skeleton carries the UV attributes). */
function meshedTrunk(): { sk: Skeleton; tube: MeshData } {
  const sb = new SkeletonBuilder();
  sb.beginBranch(-1, -1, 0);
  for (let i = 0; i <= 8; i++) sb.addPoint(0, 0, i * 0.5, RADIUS);
  sb.endBranch();
  const sk = sb.build();
  // The frames a generator stores on its skeleton (the tube mesher and the knot both read them).
  for (const [id, v] of [['rmfNormalX', 0], ['rmfNormalY', -1], ['rmfNormalZ', 0]] as const) sk.attributes.set(id, new Float32Array(sk.count).fill(v));
  const bp = defaultParams(getNodeDef('generator.branch')!.params);
  const tube = buildTubeMesh(sk, tubeOptionsFromParams(bp, 0, null, 'bark', 1, sk));
  return { sk, tube };
}

const knotParamsOf = (over: Record<string, unknown> = {}): NodeParams => {
  const out = defaultParams(getNodeDef('generator.knot')!.params);
  for (const [k, v] of Object.entries(over)) out[k] = { ...(out[k] as NodeParams[string]), value: v as never };
  return out;
};

const ctx = (lod = 0, seed = 9): NodeContext => ({ nodeId: 'knot', name: 'Knot', rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod, logger: createLogger('test', 'error') });

const inputs = (sk: Skeleton): NodeInputs => ({ parent: [{ kind: 'Structure', value: { skeleton: sk, materialId: 'bark' } }] });

const meshOf = (out: ReturnType<typeof evaluateKnot>): MeshData => {
  const g = out.geometry;
  if (!g || g.kind !== 'Mesh') throw new Error('no mesh');
  return g.value;
};

const distanceToAxis = (m: MeshData, i: number): number => Math.hypot(m.positions[i * 3] as number, m.positions[i * 3 + 1] as number);

describe('Knot node', () => {
  it('is registered as a generator of decorations with the new tabs', () => {
    const def = getNodeDef('generator.knot')!;
    expect(def.statsGroup).toBe('decorations');
    const tabs = getInspectorTabSpecs('generator.knot', def.params).map((t) => t.id);
    for (const tab of ['Generation', 'Outer', 'Inner', 'Core', 'Material', 'Segments', 'LOD']) expect(tabs).toContain(tab);
    const ids = new Set(def.params.map((p) => p.id));
    for (const id of ['outerSize', 'outerOffset', 'outerRotation', 'outerScale', 'outerLip', 'outerNoiseSeed', 'outerShapeAmount', 'outerShapeScale', 'outerOffsetAmount', 'outerOffsetScale',
      'innerSizePct', 'innerScale', 'innerCurvature', 'innerOverlap', 'innerUvStyle', 'innerUvScale', 'innerUvOffsetU', 'innerUvOffsetV', 'innerShapeAmount', 'innerShapeScale',
      'coreSizePct', 'coreOffset', 'coreUvStyle', 'coreUvScale', 'coreUvOffsetU', 'coreUvOffsetV', 'coreShapeAmount', 'coreShapeScale', 'coreOffsetAmount', 'coreOffsetScale',
      'innerMaterials', 'coreMaterials', 'ringsOuter', 'ringsInner', 'ringsCore', 'slices', 'knotResolution', 'lodWeight', 'lodRingSegments', 'lodSliceSegments', 'number', 'seed']) {
      expect(ids.has(id), id).toBe(true);
    }
    const noise = buildInspectorSections(def.params, 'Outer').find((s) => s.title === 'Noise');
    expect(noise?.blocks.map((b) => b.subhead)).toEqual([null, 'Shape', 'Offset']);
    expect(SIZE_PARAMS['generator.knot']).toContain('outerSize');
  });

  it('gives every parameter a tooltip in the knot-specific tabs', () => {
    for (const p of getNodeDef('generator.knot')!.params.filter((d) => ['Outer', 'Inner', 'Core', 'Material', 'Segments', 'LOD'].includes(d.group))) {
      expect(p.kind === 'seed' || (p.tooltip ?? '').length > 5, p.id).toBe(true);
    }
  });

  it('builds one mesh with slots Outer = parent material, Inner and Core from the Material lists', () => {
    const { sk } = meshedTrunk();
    const out = evaluateKnot(
      ctx(),
      inputs(sk),
      knotParamsOf({
        number: 6,
        innerMaterials: [{ material: 'wood_inner', weight: 1, uvArea: 'whole' }],
        coreMaterials: [{ material: 'cut_wood', weight: 1, uvArea: 'whole' }],
      }),
    );
    const mesh = meshOf(out);
    expect(out.instances).toEqual({ kind: 'Scalar', value: 6 });
    expect(mesh.slots.map((s) => s.materialId)).toEqual(['bark', 'wood_inner', 'cut_wood']);
    expect(mesh.slots.every((s) => s.indexCount > 0)).toBe(true);
    const total = mesh.slots.reduce((a, s) => a + s.indexCount, 0);
    expect(total).toBe(mesh.indices.length);
  });

  it('keeps Inner and Core on the parent material by default (Inherited / None)', () => {
    const { sk } = meshedTrunk();
    const mesh = meshOf(evaluateKnot(ctx(), inputs(sk), knotParamsOf({ number: 3 })));
    expect(mesh.slots.map((s) => s.materialId)).toEqual(['bark']);
  });

  it('welds the outer boundary to the parent surface (distance to the axis = radius)', () => {
    const { sk } = meshedTrunk();
    const mesh = meshOf(evaluateKnot(ctx(), inputs(sk), knotParamsOf({ number: 5, outerOffset: 0.03, outerLip: 0.01 })));
    let onSurface = 0;
    for (let i = 0; i < mesh.positions.length / 3; i++) {
      const d = distanceToAxis(mesh, i);
      // offset and lip are positive: nothing may be inside the parent, and the rim touches it
      expect(d).toBeGreaterThan(RADIUS - 0.011);
      if (Math.abs(d - RADIUS) < 1e-5) onSurface++;
    }
    expect(onSurface).toBeGreaterThanOrEqual(5 * 16);
  });

  it('Outer UV equals the parent UV (V exactly, U within one parent segment) on the weld ring', () => {
    const { sk, tube } = meshedTrunk();
    const mesh = meshOf(evaluateKnot(ctx(), inputs(sk), knotParamsOf({ number: 8, outerShapeAmount: 0, innerMaterials: [{ material: 'inner', weight: 1, uvArea: 'whole' }] })));
    const outer = mesh.slots[0]!;
    const tiles = sk.attributes.get('uvTiles')![0] as number;
    const sides = tube.uv0.length; // only used for tolerance below
    expect(sides).toBeGreaterThan(0);
    const vertexOf = new Set<number>();
    for (let k = outer.indexStart; k < outer.indexStart + outer.indexCount; k++) vertexOf.add(mesh.indices[k] as number);
    let checked = 0;
    for (const i of vertexOf) {
      if (Math.abs(distanceToAxis(mesh, i) - RADIUS) > 1e-5) continue;
      const z = mesh.positions[i * 3 + 2] as number;
      expect(mesh.uv0[i * 2 + 1] as number).toBeCloseTo(z, 3);
      // nearest vertex of the parent tube
      let best = Infinity;
      let bu = 0;
      for (let t = 0; t < tube.positions.length / 3; t++) {
        const d = Math.hypot(
          (tube.positions[t * 3] as number) - (mesh.positions[i * 3] as number),
          (tube.positions[t * 3 + 1] as number) - (mesh.positions[i * 3 + 1] as number),
          (tube.positions[t * 3 + 2] as number) - z,
        );
        if (d < best) {
          best = d;
          bu = tube.uv0[t * 2] as number;
        }
      }
      let du = (((mesh.uv0[i * 2] as number) - bu) % tiles + tiles) % tiles;
      du = Math.min(du, tiles - du);
      expect(du).toBeLessThan((tiles / 8) * 0.75);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('is deterministic for the same seed and differs for another one', () => {
    const { sk } = meshedTrunk();
    const p = knotParamsOf({ number: 6, outerShapeAmount: 0.3 });
    const a = meshOf(evaluateKnot(ctx(0, 3), inputs(sk), p));
    const b = meshOf(evaluateKnot(ctx(0, 3), inputs(sk), p));
    const c = meshOf(evaluateKnot(ctx(0, 4), inputs(sk), p));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    expect(Array.from(a.uv0)).toEqual(Array.from(b.uv0));
    expect(Array.from(a.positions)).not.toEqual(Array.from(c.positions));
  });

  it('scales rings and slices with Resolution and the level of detail', () => {
    const { sk } = meshedTrunk();
    const perKnot = (over: Record<string, unknown>, lod = 0): number => {
      const out = evaluateKnot(ctx(lod), inputs(sk), knotParamsOf({ number: 6, ...over }));
      return meshOf(out).positions.length / 3 / (out.instances as { value: number }).value;
    };
    const base = perKnot({});
    // Outer 3 + Inner 3 + Core 2 rings: (4 + 4 + 2) rows of 17 vertices (seam doubled) + the Core centre, minus none shared physically
    expect(base).toBe((3 + 1 + 3 + 1 + 2) * 17 + 1);
    expect(perKnot({ knotResolution: 2 })).toBeGreaterThan(base * 3);
    expect(perKnot({}, 3)).toBeLessThan(base);
    expect(perKnot({ lodSliceSegments: 0, lodRingSegments: 0 }, 3)).toBe(base);
    expect(perKnot({ slices: 8, ringsOuter: 1, ringsInner: 1, ringsCore: 1 })).toBe((1 + 1 + 1 + 1 + 1) * 9 + 1);
  });

  it('drops knots with Dynamic LOD Weight below 1 at lower detail only', () => {
    const { sk } = meshedTrunk();
    const n = (weight: number, lod: number): number => {
      const out = evaluateKnot(ctx(lod), inputs(sk), knotParamsOf({ number: 40, lodWeight: weight }));
      return (out.instances as { value: number }).value;
    };
    expect(n(0, 0)).toBe(40);
    expect(n(0, 3)).toBe(0);
    const full = n(1, 3);
    expect(full).toBeGreaterThan(3);
    const half = n(0.5, 3);
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(full);
  });

  it('Size scalar and Size parameters change the footprint', () => {
    const { sk } = meshedTrunk();
    const extent = (over: Record<string, unknown>): number => {
      const m = meshOf(evaluateKnot(ctx(), inputs(sk), knotParamsOf({ number: 1, mode: 'absolute', ...over })));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < m.positions.length / 3; i++) {
        const z = m.positions[i * 3 + 2] as number;
        lo = Math.min(lo, z);
        hi = Math.max(hi, z);
      }
      return hi - lo;
    };
    expect(extent({ outerSize: 0.2, outerShapeAmount: 0 })).toBeGreaterThan(extent({ outerSize: 0.1, outerShapeAmount: 0 }) * 1.8);
  });

  it('is empty without a parent or when inactive', () => {
    const { sk } = meshedTrunk();
    expect(evaluateKnot(ctx(), { parent: [] }, knotParamsOf()).instances).toEqual({ kind: 'Scalar', value: 0 });
    expect(evaluateKnot(ctx(), inputs(sk), knotParamsOf({ active: false })).instances).toEqual({ kind: 'Scalar', value: 0 });
  });
});

describe('Knot on a generated trunk', () => {
  it('matches the UV of the real trunk mesh (frames and mapping come from the generator)', () => {
    const def = getNodeDef('generator.trunk')!;
    const tp = defaultParams(def.params);
    const trunkCtx: NodeContext = { ...ctx(0, 11), nodeId: 'trunk', name: 'Trunk' };
    const trunkOut = evaluateTrunk(trunkCtx, { parent: [] }, tp);
    const children = trunkOut.children;
    const geometry = trunkOut.geometry;
    if (!children || children.kind !== 'Structure' || !geometry || geometry.kind !== 'Mesh') throw new Error('trunk output');
    const tube = geometry.value;
    const sk = children.value.skeleton;
    const out = evaluateKnot(ctx(0, 5), { parent: [children] }, knotParamsOf({ number: 10, outerShapeAmount: 0.1 }));
    const mesh = meshOf(out);
    const outer = mesh.slots[0]!;
    const tiles = sk.attributes.get('uvTiles')![0] as number;
    const used = new Set<number>();
    for (let k = outer.indexStart; k < outer.indexStart + outer.indexCount; k++) used.add(mesh.indices[k] as number);
    let checked = 0;
    for (const i of used) {
      // vertices touching the parent surface: closest to a tube vertex
      let best = Infinity;
      let bu = 0;
      let bv = 0;
      for (let t = 0; t < tube.positions.length / 3; t++) {
        const d = Math.hypot(
          (tube.positions[t * 3] as number) - (mesh.positions[i * 3] as number),
          (tube.positions[t * 3 + 1] as number) - (mesh.positions[i * 3 + 1] as number),
          (tube.positions[t * 3 + 2] as number) - (mesh.positions[i * 3 + 2] as number),
        );
        if (d < best) {
          best = d;
          bu = tube.uv0[t * 2] as number;
          bv = tube.uv0[t * 2 + 1] as number;
        }
      }
      if (best > 0.03) continue;
      let du = (((mesh.uv0[i * 2] as number) - bu) % tiles + tiles) % tiles;
      du = Math.min(du, tiles - du);
      expect(du).toBeLessThan(tiles * 0.2);
      expect(Math.abs((mesh.uv0[i * 2 + 1] as number) - bv)).toBeLessThan(0.5);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});

describe('Knot back-compat', () => {
  const old = (): NodeParams => ({
    knotRadius: { value: 0.5, variance: 0.2 },
    knotLength: { value: 0.12 },
    knotCoreScale: { value: 0.65 },
    knotCurvature: { value: 0.25 },
    spread: { value: 82 },
    segments: { value: 5 },
    material: { value: 'old_bark' },
    number: { value: 7 },
  });

  it('maps the old ids to the new parameters and keeps the Generation values', () => {
    const m = migrateKnotParams(old());
    expect(m.outerSize?.value).toBeCloseTo(0.05, 6);
    expect(m.outerSize?.variance).toBe(0.2);
    expect(m.outerOffset?.value).toBeCloseTo(0.03, 6);
    expect(m.innerSizePct?.value).toBeCloseTo(65, 6);
    expect(m.innerCurvature?.value).toBeCloseTo(0.5, 6);
    expect(m.innerMaterials?.value).toEqual([{ material: 'old_bark', weight: 1, uvArea: 'whole' }]);
    expect(m.coreMaterials?.value).toEqual([{ material: 'old_bark', weight: 1, uvArea: 'whole' }]);
    expect(m.number?.value).toBe(7);
    for (const id of ['knotRadius', 'knotLength', 'knotCoreScale', 'knotCurvature', 'spread', 'segments', 'material']) expect(m[id]).toBeUndefined();
  });

  it('is idempotent and leaves new projects alone', () => {
    const once = migrateKnotParams(old());
    expect(migrateKnotParams(once)).toEqual(once);
    const fresh = knotParamsOf();
    expect(migrateKnotParams(fresh)).toBe(fresh);
  });

  it('runs through the registry for saved versions and the result evaluates', () => {
    const migrated = migrateNodeParams('generator.knot', old(), 1);
    expect(migrated.outerSize).toBeDefined();
    const { sk } = meshedTrunk();
    const merged = { ...knotParamsOf(), ...migrated };
    expect(meshOf(evaluateKnot(ctx(), inputs(sk), merged)).indices.length).toBeGreaterThan(0);
  });
});
