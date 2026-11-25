import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { linearCurve } from '@/core/curve';
import { Rng } from '@/core/rng';
import {
  EXTENSION_BASE_DISC,
  EXTENSION_ATTR,
  EXTENSION_GROUP_VALUE,
  SPLIT_ATTR,
  SplitFlag,
  collectEndClaims,
  collectOpenEnds,
  extensionAreaRadiusFactor,
  extensionFanAngle,
  extensionGroupRadius,
  extensionRadiusFactor,
  fermatBases,
  isEndClaimed,
  sharedEndNormal,
  usesVirtualSplit,
} from '@/generators/split';
import type { EndClaim } from '@/contracts/nodes';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const STRAIGHT = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 0, noiseTwist: 0 };
const MESHED = { ...STRAIGHT, spineOnly: false };
const trunkSpec = (extra: Record<string, unknown>, children: NodeSpec[]): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...(extra.spineOnly === false ? MESHED : STRAIGHT), splitsChance: 0, ...extra } as NodeSpec['params'] },
  ...children,
];
const extender = (id: string, type: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.branch',
  parent: 'trunk',
  params: { ...(extra.spineOnly === false ? MESHED : STRAIGHT), number: 1, extendParent: type, extendCount: 1, knockout: 1, ...extra } as NodeSpec['params'],
});
const capSpec = (id: string, type: string, extra: Record<string, unknown> = {}): NodeSpec => ({
  id,
  type: 'generator.cap',
  parent: 'trunk',
  params: { extendParent: type, ...extra } as NodeSpec['params'],
});
const boundaryEdges = (meshes: MeshData[]): number => [...weldedEdges(meshes).use.values()].filter((n) => n === 1).length;

const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();

/** Edge use counts after welding vertices by position (UV / normal seams duplicate positions). */
function weldedEdges(meshes: MeshData[]): { use: Map<string, number>; degenerate: number } {
  const ids = new Map<string, number>();
  const id = (m: MeshData, i: number): number => {
    const k = `${Math.round(m.positions[i * 3]! * 1e4)},${Math.round(m.positions[i * 3 + 1]! * 1e4)},${Math.round(m.positions[i * 3 + 2]! * 1e4)}`;
    const hit = ids.get(k);
    if (hit !== undefined) return hit;
    ids.set(k, ids.size);
    return ids.size - 1;
  };
  const use = new Map<string, number>();
  let degenerate = 0;
  for (const m of meshes) {
    for (let t = 0; t < m.indices.length; t += 3) {
      const v = [id(m, m.indices[t]!), id(m, m.indices[t + 1]!), id(m, m.indices[t + 2]!)];
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
  }
  return { use, degenerate };
}

const dirAngleDeg = (a: readonly number[], b: readonly number[]): number => {
  const d = (a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!) / (Math.hypot(a[0]!, a[1]!, a[2]!) * Math.hypot(b[0]!, b[1]!, b[2]!));
  return (Math.acos(Math.min(1, Math.max(-1, d))) * 180) / Math.PI;
};
const lastDirection = (sk: Skeleton, b: Skeleton['branches'][number]): number[] => {
  const i = b.start + b.count - 1;
  return [sk.direction[i * 3]!, sk.direction[i * 3 + 1]!, sk.direction[i * 3 + 2]!];
};

const startDirection = (sk: Skeleton, b: Skeleton['branches'][number]): number[] => [sk.direction[b.start * 3]!, sk.direction[b.start * 3 + 1]!, sk.direction[b.start * 3 + 2]!];

// ---- pure ---------------------------------------------------------------------------------------------------------------

describe('area rule', () => {
  it('count^(-1/e): the extensions keep the cross-section area of the end', () => {
    expect(extensionAreaRadiusFactor(1, 2)).toBe(1);
    expect(extensionAreaRadiusFactor(2, 2)).toBeCloseTo(Math.SQRT1_2, 12);
    expect(extensionAreaRadiusFactor(4, 2)).toBeCloseTo(0.5, 12);
    for (const n of [2, 3, 5, 8]) for (const e of [1.5, 2, 2.5, 3]) expect(n * Math.pow(extensionAreaRadiusFactor(n, e), e)).toBeCloseTo(1, 9);
    expect(extensionGroupRadius(0.2, 3, 2)).toBeCloseTo(0.2 / Math.sqrt(3), 12);
  });

  it('the exponent is clamped to the Splits range and a bad value falls back to 2', () => {
    expect(extensionAreaRadiusFactor(2, 99)).toBeCloseTo(Math.pow(2, -1 / 3), 12);
    expect(extensionAreaRadiusFactor(2, Number.NaN)).toBeCloseTo(Math.SQRT1_2, 12);
  });
});

describe('Fermat bases', () => {
  const rng = new Rng(5);
  it('stay inside half of the end radius, never coincide, and are deterministic', () => {
    for (const n of [3, 5, 8]) {
      const a = fermatBases(n, 0.1, rng);
      const b = fermatBases(n, 0.1, new Rng(5));
      expect(a).toEqual(b);
      for (const p of a) expect(Math.hypot(p.x, p.y)).toBeLessThanOrEqual(0.1 * EXTENSION_BASE_DISC + 1e-12);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) expect(Math.hypot(a[i]!.x - a[j]!.x, a[i]!.y - a[j]!.y)).toBeGreaterThan(1e-4);
    }
  });

  it('one extension stays on the centre; each index has its own jitter stream', () => {
    expect(fermatBases(1, 0.1, rng)).toEqual([{ x: 0, y: 0, azimuth: 0 }]);
    // The jitter of point i only depends on i and the stream: the angles of the first points follow the golden angle plus a small turn.
    const a = fermatBases(4, 0.1, new Rng(9));
    const b = fermatBases(4, 0.1, new Rng(10));
    expect(a.map((p) => p.azimuth)).not.toEqual(b.map((p) => p.azimuth));
    const c = fermatBases(4, 0.1, new Rng(9));
    expect(c).toEqual(a);
  });

  it('the azimuth points from the end centre to the base', () => {
    for (const p of fermatBases(6, 0.2, rng)) expect(Math.atan2(p.y, p.x)).toBeCloseTo(Math.atan2(Math.sin(p.azimuth), Math.cos(p.azimuth)), 9);
  });
});

describe('fan angle and radius profile', () => {
  it('Spread eases in from 0 at the base to the full angle; the curve scales it', () => {
    const lut = new Float32Array([1, 0.5]);
    expect(extensionFanAngle(30, 2, 0, null)).toBe(0);
    expect(extensionFanAngle(30, 2, 1, null)).toBeCloseTo((30 * Math.PI) / 180, 9);
    expect(extensionFanAngle(30, 2, 1, lut)).toBeCloseTo((15 * Math.PI) / 180, 6);
    expect(extensionFanAngle(30, 1, 1, null)).toBe(0);
    expect(extensionFanAngle(0, 3, 1, null)).toBe(0);
  });

  it('Radius value 0 leaves the profile, 1 follows the curve, and t = 0 always keeps the end radius', () => {
    for (const c of [0.2, 0.5, 1]) expect(extensionRadiusFactor(0.7, c, c)).toBeCloseTo(1, 12);
    expect(extensionRadiusFactor(0, 0.5, 0.1)).toBeCloseTo(1, 12);
    expect(extensionRadiusFactor(1, 0.5, 0.25)).toBeCloseTo(0.5, 12);
    expect(extensionRadiusFactor(0.5, 1, 0.5)).toBeCloseTo(0.75, 12);
  });

  it('Count 2 is the virtual split, every other count uses separate tubes', () => {
    expect([1, 2, 3, 4].map(usesVirtualSplit)).toEqual([false, true, false, false]);
  });
});

// ---- params / back-compat ----------------------------------------------------------------------------------------------

describe('Extensions params', () => {
  const param = (id: string) => getNodeDef('generator.branch')!.params.find((p) => p.id === id)!;

  it('have the S5 ranges and defaults', () => {
    const lengthScale = param('extensionLengthScale');
    expect(lengthScale).toMatchObject({ kind: 'float', default: 1, min: 0.1, max: 3, group: 'Spine', subgroup: 'Extensions' });
    expect(param('extensionSpread')).toMatchObject({ kind: 'float', default: 0, min: 0, max: 90 });
    expect(param('extensionRadius')).toMatchObject({ kind: 'float', default: 0, min: 0, max: 1, group: 'Skin' });
    expect(param('extensionNormalSmooth')).toMatchObject({ default: 0.5, min: 0, max: 1 });
    expect(param('extensionDisplaceScale')).toMatchObject({ default: 1, min: 0, max: 2 });
    const style = param('extensionUvStyle');
    expect(style.kind === 'enum' ? style.options.map((o) => o.label) : []).toEqual(['Automatic', 'Manual (match)', 'Manual (match u only)', 'Manual (full control)']);
  });

  it('an old project without the params loads with the defaults and still grows its extension', async () => {
    const r = await run(trunkSpec({ breakChance: 1, breakSpot: 0.6 }, [extender('ext', 'any')]));
    const ext = skeletonOf(r, 'ext');
    expect(ext.branches).toHaveLength(1);
    expect(ext.branches[0]!.length).toBeGreaterThan(0.02);
  });
});

// ---- generation --------------------------------------------------------------------------------------------------------

describe('Length scale', () => {
  it('scales the spine length of an extension exactly', async () => {
    const len = async (scale: number): Promise<number> => {
      const r = await run(trunkSpec({ breakChance: 1, breakSpot: 0.6 }, [extender('ext', 'any', { extensionLengthScale: scale, length: 0.5, lengthPercent: 0 })]));
      return skeletonOf(r, 'ext').branches[0]!.length;
    };
    const one = await len(1);
    // The polyline is resampled adaptively, so the chord length is within 2 % of the exact multiple.
    expect(Math.abs((await len(0.5)) / one - 0.5)).toBeLessThan(0.01);
    expect(Math.abs((await len(2)) / one - 2)).toBeLessThan(0.04);
  });
});

describe('Radius profile (generation)', () => {
  const withCurve = (value: number, y1: number): GraphEvaluatorInput => {
    const g = buildGraph(trunkSpec({ breakChance: 1, breakSpot: 0.6 }, [extender('ext', 'any', { length: 0.6, lengthPercent: 0 })]));
    const cur = g.getNode('ext')!.params.extensionRadius!;
    g.setParam('ext', 'extensionRadius', { ...cur, value, curve: linearCurve(1, y1) });
    return snapshotGraph(g);
  };
  type GraphEvaluatorInput = ReturnType<typeof snapshotGraph>;
  const radii = async (value: number, y1: number): Promise<{ r: number[]; end: number }> => {
    const res = await new GraphEvaluator().evaluate(withCurve(value, y1), { seed: 1, lod: 0, token: new CancellationSource().token });
    const ext = skeletonOf(res, 'ext');
    const trunk = skeletonOf(res, 'trunk');
    const b = ext.branches[0]!;
    return { r: Array.from(ext.radius.subarray(b.start, b.start + b.count)), end: collectOpenEnds(trunk)[0]!.radius };
  };

  it('value 0 leaves the profile unchanged; value 1 follows the curve; t = 0 equals the end radius', async () => {
    const plain = await radii(0, 0.3);
    const full = await radii(1, 0.3);
    const none = await run(trunkSpec({ breakChance: 1, breakSpot: 0.6 }, [extender('ext', 'any', { length: 0.6, lengthPercent: 0 })]));
    const base = skeletonOf(none, 'ext');
    const bb = base.branches[0]!;
    expect(plain.r).toEqual(Array.from(base.radius.subarray(bb.start, bb.start + bb.count)));
    expect(plain.r[0]).toBeCloseTo(plain.end, 6);
    expect(full.r[0]).toBeCloseTo(full.end, 6);
    const last = plain.r.length - 1;
    expect(full.r[last]! / plain.r[last]!).toBeCloseTo(0.3, 2);
    for (let i = 1; i < full.r.length; i++) expect(full.r[i]!).toBeLessThanOrEqual(plain.r[i]! + 1e-9);
  });
});

describe('Count 2 = virtual split', () => {
  const pair = (extra: Record<string, unknown> = {}, trunk: Record<string, unknown> = {}): NodeSpec[] =>
    trunkSpec({ breakChance: 1, breakSpot: 0.6, capEnd: false, spineOnly: false, ...trunk }, [extender('ext', 'any', { spineOnly: false, extendCount: 2, length: 0.5, lengthPercent: 0, capEnd: false, ...extra })]);

  it('creates one fused stub with two halves and one extension per half', async () => {
    const sk = skeletonOf(await run(pair()), 'ext');
    const flags = sk.branches.map((b) => Math.round(sk.attributes.get(SPLIT_ATTR)?.[b.start] ?? 0));
    expect(flags.filter((f) => (f & SplitFlag.Parent) !== 0)).toHaveLength(1);
    expect(flags.filter((f) => (f & SplitFlag.Side1) !== 0)).toHaveLength(1);
    expect(flags.filter((f) => (f & SplitFlag.Side2) !== 0)).toHaveLength(1);
    // stub + 2 halves + 2 extensions
    expect(sk.branches).toHaveLength(5);
    const ext = sk.branches.filter((_, i) => flags[i] === 0);
    expect(ext).toHaveLength(2);
    for (const b of sk.branches) expect(sk.attributes.get(EXTENSION_ATTR)?.[b.start] ?? 0).toBeGreaterThan(0);
  });

  it('the stub starts on the open end; the halves follow the area rule', async () => {
    const r = await run(pair());
    const trunk = skeletonOf(r, 'trunk');
    const sk = skeletonOf(r, 'ext');
    const end = collectOpenEnds(trunk)[0]!;
    const stub = sk.branches[0]!;
    expect(Math.hypot(sk.position[stub.start * 3]! - end.position[0], sk.position[stub.start * 3 + 1]! - end.position[1], sk.position[stub.start * 3 + 2]! - end.position[2])).toBeLessThan(1e-5);
    expect(sk.radius[stub.start]!).toBeCloseTo(end.radius, 6);
    const halves = sk.branches.filter((b) => ((sk.attributes.get(SPLIT_ATTR)?.[b.start] ?? 0) & (SplitFlag.Side1 | SplitFlag.Side2)) !== 0);
    for (const h of halves) expect(sk.radius[h.start + h.count - 1]!).toBeCloseTo(end.radius * extensionAreaRadiusFactor(2, 2), 5);
  });

  it('Spread sets the angle of each half; 0 keeps them parallel', async () => {
    const angle = async (spread: number): Promise<number> => {
      const sk = skeletonOf(await run(pair({ extensionSpread: spread })), 'ext');
      const exts = sk.branches.filter((b) => Math.round(sk.attributes.get(SPLIT_ATTR)?.[b.start] ?? 0) === 0);
      return dirAngleDeg(startDirection(sk, exts[0]!), startDirection(sk, exts[1]!));
    };
    expect(await angle(0)).toBeLessThan(0.5);
    expect(await angle(30)).toBeCloseTo(60, 0);
  });

  /** Boundary edges whose midpoint is farther than 1.6 end radii from every place where separate tubes begin. */
  function strayBoundary(meshes: MeshData[], seams: readonly (readonly number[])[], radius: number): { stray: number; manifold: boolean; degenerate: number } {
    const ids = new Map<string, number>();
    const pts: number[][] = [];
    const id = (m: MeshData, i: number): number => {
      const x = m.positions[i * 3]!;
      const y = m.positions[i * 3 + 1]!;
      const z = m.positions[i * 3 + 2]!;
      const k = `${Math.round(x * 1e4)},${Math.round(y * 1e4)},${Math.round(z * 1e4)}`;
      const hit = ids.get(k);
      if (hit !== undefined) return hit;
      ids.set(k, ids.size);
      pts.push([x, y, z]);
      return ids.size - 1;
    };
    const use = new Map<string, number>();
    let degenerate = 0;
    for (const m of meshes) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const v = [id(m, m.indices[t]!), id(m, m.indices[t + 1]!), id(m, m.indices[t + 2]!)];
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
    }
    let stray = 0;
    for (const [k, n] of use) {
      if (n !== 1) continue;
      const [a, b] = k.split('_').map(Number) as [number, number];
      const mid = [0, 1, 2].map((c) => (pts[a]![c]! + pts[b]![c]!) / 2);
      const near = seams.some((s) => Math.hypot(mid[0]! - s[0]!, mid[1]! - s[1]!, mid[2]! - s[2]!) <= 1.6 * radius);
      if (!near) stray++;
    }
    return { stray, manifold: [...use.values()].every((n) => n <= 2), degenerate };
  }

  it('the stub, the fused crotch and the halves form one manifold skin; open edges exist only where separate tubes begin', async () => {
    const r = await run(pair({ capEnd: true }));
    const trunk = skeletonOf(r, 'trunk');
    const sk = skeletonOf(r, 'ext');
    const end = collectOpenEnds(trunk)[0]!;
    const seams = [end.position, ...collectOpenEnds(sk).map((e) => e.position)];
    const res = strayBoundary([meshOf(r, 'ext')], seams, end.radius);
    expect(meshOf(r, 'ext').indices.length).toBeGreaterThan(0);
    expect(res.degenerate).toBe(0);
    expect(res.manifold).toBe(true);
    expect(res.stray).toBe(0);
  });

  it('together with the parent: no stray open edge and no edge shared by three triangles', async () => {
    const r = await run(pair({ capEnd: true }));
    const end = collectOpenEnds(skeletonOf(r, 'trunk'))[0]!;
    const seams = [end.position, ...collectOpenEnds(skeletonOf(r, 'ext')).map((e) => e.position)];
    const res = strayBoundary([meshOf(r, 'trunk'), meshOf(r, 'ext')], seams, end.radius);
    expect(res.manifold).toBe(true);
    expect(res.stray).toBe(0);
  });

  it('is deterministic', async () => {
    const a = meshOf(await run(pair({ extensionSpread: 20 }), 3), 'ext');
    const b = meshOf(await run(pair({ extensionSpread: 20 }), 3), 'ext');
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });
});

describe('Count 3 and more', () => {
  const triple = (extra: Record<string, unknown> = {}, trunk: Record<string, unknown> = {}): NodeSpec[] =>
    trunkSpec({ breakChance: 1, breakSpot: 0.6, ...trunk }, [extender('ext', 'any', { extendCount: 3, length: 0.5, lengthPercent: 0, ...extra })]);

  it('bases lie inside half of the end radius, radii follow the area rule', async () => {
    const r = await run(triple());
    const trunk = skeletonOf(r, 'trunk');
    const sk = skeletonOf(r, 'ext');
    const end = collectOpenEnds(trunk)[0]!;
    expect(sk.branches).toHaveLength(3);
    for (const b of sk.branches) {
      const d = Math.hypot(sk.position[b.start * 3]! - end.position[0], sk.position[b.start * 3 + 1]! - end.position[1], sk.position[b.start * 3 + 2]! - end.position[2]);
      expect(d).toBeLessThanOrEqual(end.radius * EXTENSION_BASE_DISC + 1e-5);
      expect(sk.radius[b.start]!).toBeCloseTo(end.radius * extensionAreaRadiusFactor(3, 2), 5);
    }
  });

  it('Spread fans the three extensions out; 0 keeps them parallel', async () => {
    const spreadOf = async (deg: number): Promise<number> => {
      const sk = skeletonOf(await run(triple({ extensionSpread: deg })), 'ext');
      const dirs = sk.branches.map((b) => lastDirection(sk, b));
      const axis = dirs.reduce((m, d) => [m[0]! + d[0]!, m[1]! + d[1]!, m[2]! + d[2]!], [0, 0, 0]);
      return Math.max(...dirs.map((d) => dirAngleDeg(d, axis)));
    };
    const flat = await spreadOf(0);
    expect(flat).toBeLessThan(6);
    expect(await spreadOf(40)).toBeGreaterThan(flat + 10);
  });

  it('the Splits seed and the Break seed do not move the group (own forked streams)', async () => {
    const a = skeletonOf(await run(triple({ splitsSeed: 1 })), 'ext');
    const b = skeletonOf(await run(triple({ splitsSeed: 9 })), 'ext');
    expect(Array.from(b.position)).toEqual(Array.from(a.position));
    const c = skeletonOf(await run(triple(), 4), 'ext');
    const d = skeletonOf(await run(triple(), 4), 'ext');
    expect(Array.from(d.position)).toEqual(Array.from(c.position));
  });
});

describe('Displacement scale', () => {
  const disp = (type: string, scale: number): NodeSpec[] =>
    trunkSpec({ breakChance: 1, breakSpot: 0.6, spineOnly: false }, [
      extender('ext', type, { spineOnly: false, number: type === 'none' ? 3 : 1, knockout: 0, length: 0.6, lengthPercent: 0, displaceRadial: 0.03, displaceUScale: 4, displaceVScale: 4, extensionDisplaceScale: scale, capEnd: false }),
    ]);
  /** Largest per-vertex move compared with the same mesh without displacement (identical topology). */
  const relief = (m: MeshData, flat: MeshData): number => {
    let worst = 0;
    for (let i = 0; i < m.positions.length; i++) worst = Math.max(worst, Math.abs(m.positions[i]! - flat.positions[i]!));
    return worst;
  };
  it('multiplies the displacement amplitude of extensions', async () => {
    // Scale 0 switches the extension displacement off without changing the topology: it is the flat reference.
    const flat = meshOf(await run(disp('any', 0)), 'ext');
    expect(flat.positions.length).toBeGreaterThan(0);
    const one = relief(meshOf(await run(disp('any', 1)), 'ext'), flat);
    const two = relief(meshOf(await run(disp('any', 2)), 'ext'), flat);
    expect(one).toBeGreaterThan(1e-3);
    expect(two / one).toBeGreaterThan(1.8);
    expect(two / one).toBeLessThan(2.2);
  });

  it('changes nothing on a node that is not an extension', async () => {
    const a = meshOf(await run(disp('none', 0)), 'ext');
    const b = meshOf(await run(disp('none', 2)), 'ext');
    expect(a.positions.length).toBeGreaterThan(0);
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });
});

// ---- Cap ---------------------------------------------------------------------------------------------------------------

describe('Cap generator on open ends', () => {
  const open = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ spineOnly: false, capEnd: false, ...extra });
  const withCaps = (trunk: Record<string, unknown>, caps: NodeSpec[]): NodeSpec[] => trunkSpec(open(trunk), caps);

  it('open ends expose position, radius, direction, frame, ring count and (after meshing) the U tiling', async () => {
    const r = await run(withCaps({ splitsChance: 1 }, [capSpec('cap', 'any')]));
    const ends = collectOpenEnds(skeletonOf(r, 'trunk'));
    expect(ends).toHaveLength(2);
    for (const e of ends) {
      expect(e.radius).toBeGreaterThan(0);
      expect(Math.hypot(...e.direction)).toBeCloseTo(1, 6);
      expect(e.frame).toBeDefined();
      expect(Math.abs(e.frame!.normal[0] * e.direction[0] + e.frame!.normal[1] * e.direction[1] + e.frame!.normal[2] * e.direction[2])).toBeLessThan(1e-6);
      expect(e.radialSides).toBeGreaterThanOrEqual(6);
      expect(e.radialSides % 2).toBe(0);
    }
    const tiles = ends.map((e) => e.uTiles);
    expect(tiles.every((t) => t !== undefined && t > 0)).toBe(true);
  });

  it('Break and Split both feed the Cap: one cap per end', async () => {
    const broken = skeletonOf(await run(withCaps({ breakChance: 1, breakSpot: 0.6 }, [capSpec('cap', 'any')])), 'cap');
    expect(broken.branches).toHaveLength(1);
    const split = skeletonOf(await run(withCaps({ splitsChance: 1 }, [capSpec('cap', 'any')])), 'cap');
    expect(split.branches).toHaveLength(2);
  });

  it('Split 1 caps only side 1 and leaves side 2 open; Any caps both; a cap starts on its end', async () => {
    const trunk = { splitsChance: 1, splitsBalance: 0.6 };
    const one = await run(withCaps(trunk, [capSpec('cap', 'split-1')]));
    const both = await run(withCaps(trunk, [capSpec('cap', 'any')]));
    const sk = skeletonOf(one, 'trunk');
    const side = (id: number): number => {
      const b = sk.branches.find((x) => x.id === id)!;
      const f = Math.round(sk.attributes.get(SPLIT_ATTR)?.[b.start] ?? 0);
      return f & SplitFlag.Side1 ? 1 : f & SplitFlag.Side2 ? 2 : 0;
    };
    const capOne = skeletonOf(one, 'cap');
    const capBoth = skeletonOf(both, 'cap');
    expect(capOne.branches.map((b) => side(b.parentBranch))).toEqual([1]);
    expect(capBoth.branches.map((b) => side(b.parentBranch)).sort()).toEqual([1, 2]);
    for (const b of capBoth.branches) {
      const end = collectOpenEnds(sk).find((e) => e.branchId === b.parentBranch)!;
      expect(Math.hypot(capBoth.position[b.start * 3]! - end.position[0], capBoth.position[b.start * 3 + 1]! - end.position[1], capBoth.position[b.start * 3 + 2]! - end.position[2])).toBeLessThan(1e-5);
      expect(capBoth.radius[b.start]!).toBeCloseTo(end.radius, 6);
      // The cap ring has as many vertices as the half's ring (N / 2)
      expect(capBoth.attributes.get('radialSides')![b.start]!).toBe(end.radialSides / 2);
    }
    expect(meshOf(one, 'cap').indices.length).toBeGreaterThan(0);
  });

  it('a cap on a broken end closes the ring exactly (no open edge left at that end)', async () => {
    const r = await run(withCaps({ breakChance: 1, breakSpot: 0.6 }, [capSpec('cap', 'breaks-only')]));
    const bare = await run(withCaps({ breakChance: 1, breakSpot: 0.6 }, []));
    expect(boundaryEdges([meshOf(bare, 'trunk')])).toBeGreaterThan(0);
    const { use } = weldedEdges([meshOf(r, 'trunk'), meshOf(r, 'cap')]);
    expect([...use.values()].filter((n) => n === 1)).toHaveLength(0);
    for (const n of use.values()) expect(n).toBeLessThanOrEqual(2);
  });

  it('Radius scale and Rings still shape the cap', async () => {
    const small = skeletonOf(await run(withCaps({ breakChance: 1, breakSpot: 0.6 }, [capSpec('cap', 'any', { capRadiusScale: 0.5 })])), 'cap');
    const full = skeletonOf(await run(withCaps({ breakChance: 1, breakSpot: 0.6 }, [capSpec('cap', 'any')])), 'cap');
    expect(small.radius[small.branches[0]!.start]!).toBeCloseTo(full.radius[full.branches[0]!.start]! * 0.5, 6);
    const rings = async (n: number): Promise<number> => meshOf(await run(withCaps({ breakChance: 1, breakSpot: 0.6 }, [capSpec('cap', 'any', { capRings: n })])), 'cap').positions.length;
    expect(await rings(6)).toBeGreaterThan(await rings(1));
  });

  it('is deterministic', async () => {
    const g = (): NodeSpec[] => withCaps({ splitsChance: 1 }, [capSpec('cap', 'any')]);
    const a = meshOf(await run(g(), 4), 'cap');
    const b = meshOf(await run(g(), 4), 'cap');
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  });
});

describe('Normal smooth of a group (Count 3+)', () => {
  it('sharedEndNormal is the radial direction of the end cylinder; a point on the axis uses the fallback', () => {
    expect(sharedEndNormal([0.3, 0, 5], [0, 0, 5], [0, 0, 1], [9, 9, 9])).toEqual([1, 0, 0]);
    const n = sharedEndNormal([1, 2, 7], [1, 1, 5], [0, 0, 1], [9, 9, 9]);
    expect(n[0]).toBeCloseTo(0, 9);
    expect(n[1]).toBeCloseTo(1, 9);
    expect(n[2]).toBeCloseTo(0, 9);
    expect(sharedEndNormal([0, 0, 8], [0, 0, 5], [0, 0, 1], [0, 1, 0])).toEqual([0, 1, 0]);
  });

  const triple = (smooth: number, count = 3): NodeSpec[] =>
    trunkSpec({ spineOnly: false, breakChance: 1, breakSpot: 0.6, capEnd: false }, [
      extender('ext', 'any', { spineOnly: false, extendCount: count, length: 0.5, lengthPercent: 0, extensionNormalSmooth: smooth, extensionSpread: 25 }),
    ]);

  it('only extensions that share an end carry the group value', async () => {
    const group = skeletonOf(await run(triple(0.5)), 'ext');
    for (const b of group.branches) expect(group.attributes.get(EXTENSION_ATTR)?.[b.start]).toBe(EXTENSION_GROUP_VALUE);
    const single = skeletonOf(await run(triple(0.5, 1)), 'ext');
    for (const b of single.branches) expect(single.attributes.get(EXTENSION_ATTR)?.[b.start]).toBe(1);
  });

  it('Normal smooth 1 aligns the first-ring normals of all siblings with the shared end cylinder; 0 does not', async () => {
    const agreement = async (smooth: number): Promise<number> => {
      const r = await run(triple(smooth));
      const end = collectOpenEnds(skeletonOf(r, 'trunk'))[0]!;
      const m = meshOf(r, 'ext');
      let sum = 0;
      let n = 0;
      for (let i = 0; i < m.positions.length / 3; i++) {
        const p: [number, number, number] = [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!];
        const along = (p[0] - end.position[0]) * end.direction[0] + (p[1] - end.position[1]) * end.direction[1] + (p[2] - end.position[2]) * end.direction[2];
        // First rings only (the fan tilts them by a few millimetres out of the end plane)
        if (Math.abs(along) > 0.01) continue;
        const shared = sharedEndNormal(p, end.position, end.direction, end.direction);
        sum += m.normals[i * 3]! * shared[0] + m.normals[i * 3 + 1]! * shared[1] + m.normals[i * 3 + 2]! * shared[2];
        n++;
      }
      expect(n).toBeGreaterThanOrEqual(18);
      return sum / n;
    };
    const smooth = await agreement(1);
    expect(smooth).toBeGreaterThan(0.999);
    expect(await agreement(0)).toBeLessThan(smooth - 0.01);
  });
});

describe('Sibling claim list', () => {
  const claim = (type: string, owner: EndClaim['owner'] = 'branch'): EndClaim => ({ owner, type });
  const cand = (id: string, type: string, extendType: string, extra: Partial<Parameters<typeof collectEndClaims>[0][number]> = {}): Parameters<typeof collectEndClaims>[0][number] => ({
    id,
    type,
    parentId: 'p',
    live: true,
    active: true,
    extendType,
    ...extra,
  });

  it('isEndClaimed: a claim blocks the ends it selects; the same explicit type and Bottom never block', () => {
    const side1 = { flags: SplitFlag.Side1 | SplitFlag.Fat, broken: false };
    const side2 = { flags: SplitFlag.Side2, broken: false };
    const brk = { flags: 0, broken: true };
    expect(isEndClaimed([claim('split-1')], 'any', side1)).toBe(true);
    expect(isEndClaimed([claim('split-1')], 'any', side2)).toBe(false);
    expect(isEndClaimed([claim('any')], 'any', side2)).toBe(true);
    expect(isEndClaimed([claim('split-1')], 'split-1', side1)).toBe(false);
    expect(isEndClaimed([claim('breaks-only')], 'any', brk)).toBe(true);
    expect(isEndClaimed([claim('breaks-only')], 'any', side1)).toBe(false);
    expect(isEndClaimed([claim('bottom')], 'any', side1)).toBe(false);
    expect(isEndClaimed([claim('any')], 'bottom', side1)).toBe(false);
    expect(isEndClaimed([], 'any', side1)).toBe(false);
  });

  it('collectEndClaims: only Caps get claims; Branch siblings always claim, Caps only when earlier; off nodes do not', () => {
    const list = [
      cand('capA', 'generator.cap', 'any'),
      cand('br', 'generator.branch', 'split-1'),
      cand('capB', 'generator.cap', 'any'),
      cand('off', 'generator.branch', 'any', { live: false }),
      cand('idle', 'generator.branch', 'any', { active: false }),
      cand('none', 'generator.branch', 'none'),
      cand('other', 'generator.branch', 'any', { parentId: 'q' }),
      cand('leaf', 'generator.leaf', 'any'),
    ];
    expect(collectEndClaims(list, 'capA')).toEqual([{ owner: 'branch', type: 'split-1' }]);
    expect(collectEndClaims(list, 'capB')).toEqual([{ owner: 'cap', type: 'any' }, { owner: 'branch', type: 'split-1' }]);
    expect(collectEndClaims(list, 'br')).toEqual([]);
    expect(collectEndClaims(list, 'missing')).toEqual([]);
  });

  const trunk = { spineOnly: false, splitsChance: 1, capEnd: false };
  const sidesOf = (r: Result): number[] => {
    const sk = skeletonOf(r, 'trunk');
    return skeletonOf(r, 'cap')
      .branches.map((b) => {
        const host = sk.branches.find((x) => x.id === b.parentBranch)!;
        const f = Math.round(sk.attributes.get(SPLIT_ATTR)?.[host.start] ?? 0);
        return f & SplitFlag.Side1 ? 1 : 2;
      })
      .sort();
  };

  it('a Cap on Any leaves the end that a Branch extends open and still closes the other', async () => {
    expect(sidesOf(await run(trunkSpec(trunk, [extender('ext', 'split-1'), capSpec('cap', 'any')])))).toEqual([2]);
    expect(sidesOf(await run(trunkSpec(trunk, [extender('ext', 'any'), capSpec('cap', 'any')])))).toEqual([]);
    expect(sidesOf(await run(trunkSpec(trunk, [extender('ext', 'split-2'), capSpec('cap', 'any')])))).toEqual([1]);
  });

  it('the order of the nodes does not matter for a Branch claim', async () => {
    expect(sidesOf(await run(trunkSpec(trunk, [capSpec('cap', 'any'), extender('ext', 'split-1')])))).toEqual([2]);
  });

  it('a Cap that names exactly the extended type is still allowed', async () => {
    expect(sidesOf(await run(trunkSpec(trunk, [extender('ext', 'split-1'), capSpec('cap', 'split-1')])))).toEqual([1]);
  });

  it('a disabled / inactive / non-extending / Bottom Branch claims nothing', async () => {
    for (const ext of [extender('ext', 'any', { active: false }), extender('ext', 'none'), extender('ext', 'bottom')]) {
      expect(sidesOf(await run(trunkSpec(trunk, [ext, capSpec('cap', 'any')])))).toEqual([1, 2]);
    }
  });

  it('two Caps never close the same end twice: the first one wins', async () => {
    const r = await run(trunkSpec(trunk, [capSpec('cap', 'any'), capSpec('cap2', 'any')]));
    expect(sidesOf(r)).toEqual([1, 2]);
    expect(skeletonOf(r, 'cap2').branches).toHaveLength(0);
  });

  it('editing the sibling re-evaluates the Cap (the claims are part of its cache key)', async () => {
    const evaluator = new GraphEvaluator();
    const evalSpec = (specs: NodeSpec[]) => evaluator.evaluate(snapshotGraph(buildGraph(specs)), { seed: 1, lod: 0, token: new CancellationSource().token });
    expect(sidesOf(await evalSpec(trunkSpec(trunk, [extender('ext', 'split-1'), capSpec('cap', 'any')])))).toEqual([2]);
    expect(sidesOf(await evalSpec(trunkSpec(trunk, [extender('ext', 'none'), capSpec('cap', 'any')])))).toEqual([1, 2]);
    expect(sidesOf(await evalSpec(trunkSpec(trunk, [extender('ext', 'split-1'), capSpec('cap', 'any')])))).toEqual([2]);
  });
});
