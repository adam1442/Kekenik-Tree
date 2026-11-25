import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import {
  DEFAULT_SPLIT_SETTINGS,
  SPINE_ORIGIN_ATTR,
  SpineOrigin,
  isGroundBase,
  planSplit,
  spineOriginName,
  type SpineOriginName,
  tiltTowardGravity,
} from '@/generators/split';
import { EXTEND_CHILD_TYPES, EXTEND_PARENT_TYPES, extendIsValid } from '@/generators/common/extend';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { parseProject } from '@/app/project/format';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const run = (specs: NodeSpec[], seed = 1, lod = 0) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();

const STRAIGHT = { spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, noiseTwist: 0, lean: 0 };
const TRUNK = { ...STRAIGHT, length: { value: 4, variance: 0 }, radius: { value: 0.25, variance: 0 }, sides: 16, accuracy: 24, segments: 24 };
const ROOT = { number: 5, first: 0, last: 0.1, length: { value: 1.5, variance: 0 }, radius: { value: 0.07, variance: 0 }, splitsChance: 0 };

const trunkWithRoots = (trunk: Record<string, unknown>, root: Record<string, unknown> = {}, extra: NodeSpec[] = []): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, ...trunk } as NodeSpec['params'] },
  { id: 'rt', type: 'generator.root', parent: 'tr', params: { ...ROOT, ...root } as NodeSpec['params'] },
  ...extra,
];

const originOf = (sk: Skeleton, branchStart: number): SpineOriginName => spineOriginName(sk.attributes.get(SPINE_ORIGIN_ATTR)?.[branchStart]);
const pointOf = (sk: Skeleton, i: number): [number, number, number] => [sk.position[i * 3]!, sk.position[i * 3 + 1]!, sk.position[i * 3 + 2]!];

/** Branches of the root skeleton that hang directly on a trunk branch (not on another root). */
const sprouts = (rootSk: Skeleton, trunkSk: Skeleton): Skeleton['branches'] => rootSk.branches.filter((b) => b.parentBranch >= 0 && trunkSk.branches.some((t) => t.id === b.parentBranch) && originOf(rootSk, b.start) === 'primary');

/** Same branches, same anchor heights, azimuths within a hair and the same point count per root. */
function expectSameRoots(a: Skeleton, b: Skeleton): void {
  expect(b.branches.length).toBe(a.branches.length);
  for (let i = 0; i < a.branches.length; i++) {
    const x = a.branches[i]!;
    const y = b.branches[i]!;
    expect(y.count).toBe(x.count);
    expect(y.generation).toBe(x.generation);
    const pa = pointOf(a, x.start);
    const pb = pointOf(b, y.start);
    expect(Math.abs(pa[2] - pb[2])).toBeLessThan(1e-4);
    expect(Math.hypot(pa[0] - pb[0], pa[1] - pb[1])).toBeLessThan(0.01);
    const ea = pointOf(a, x.start + x.count - 1);
    const eb = pointOf(b, y.start + y.count - 1);
    expect(Math.hypot(ea[0] - eb[0], ea[1] - eb[1], ea[2] - eb[2])).toBeLessThan(0.05);
  }
}

function edgeUse(mesh: MeshData): Map<string, number> {
  const ids = new Map<string, number>();
  const id = (i: number): number => {
    const k = `${Math.round(mesh.positions[i * 3]! * 1e4)},${Math.round(mesh.positions[i * 3 + 1]! * 1e4)},${Math.round(mesh.positions[i * 3 + 2]! * 1e4)}`;
    const hit = ids.get(k);
    if (hit !== undefined) return hit;
    ids.set(k, ids.size);
    return ids.size - 1;
  };
  const use = new Map<string, number>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const v = [id(mesh.indices[t]!), id(mesh.indices[t + 1]!), id(mesh.indices[t + 2]!)];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
    for (let e = 0; e < 3; e++) {
      const a = v[e]!;
      const b = v[(e + 1) % 3]!;
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }
  return use;
}

describe('S7: roots anchor on the ground base only', () => {
  it('Trunk Chance 1 + Extend parent chain: no root hangs on a split half or an extension', async () => {
    const chain: NodeSpec[] = [
      { id: 'b1', type: 'generator.branch', parent: 'tr', params: { number: 0, extendParent: 'any', extendCount: 1, splitsChance: 1, length: { value: 1.5, variance: 0 } } as NodeSpec['params'] },
      { id: 'b2', type: 'generator.branch', parent: 'b1', params: { number: 0, extendParent: 'any', extendCount: 1, splitsChance: 1, length: { value: 1, variance: 0 } } as NodeSpec['params'] },
    ];
    const r = await run(trunkWithRoots({ splitsChance: 1 }, { number: 6 }, chain));
    const trunk = skeletonOf(r, 'tr');
    const roots = skeletonOf(r, 'rt');
    // the trunk really has halves (otherwise the test proves nothing)
    expect(trunk.branches.some((b) => originOf(trunk, b.start) === 'splitHalf')).toBe(true);
    expect(roots.branches.length).toBeGreaterThan(0);
    for (const b of roots.branches) {
      if (b.parentBranch < 0) continue;
      const parent = trunk.branches.find((t) => t.id === b.parentBranch);
      if (!parent) continue; // a lateral root on another root
      expect(originOf(trunk, parent.start)).toBe('primary');
      expect(isGroundBase(parent.parentBranch, originOf(trunk, parent.start))).toBe(true);
    }
    // every anchor lies on the trunk's base ring zone, nowhere near the fork
    const base = pointOf(trunk, trunk.branches[0]!.start);
    const baseRadius = trunk.radius[trunk.branches[0]!.start]!;
    const forkZ = Math.max(...trunk.branches.filter((t) => originOf(trunk, t.start) === 'splitHalf').map((t) => trunk.position[t.start * 3 + 2]!));
    for (const b of sprouts(roots, trunk)) {
      const a = pointOf(roots, b.start);
      expect(Math.hypot(a[0] - base[0], a[1] - base[1])).toBeLessThanOrEqual(baseRadius + 1e-3);
      expect(a[2]).toBeLessThanOrEqual(base[2] + 0.1 * 4 + 0.05);
      expect(a[2]).toBeLessThan(forkZ - 1);
    }
  });

  it('a Root under an extension branch (not a ground base) grows nothing', async () => {
    const specs: NodeSpec[] = [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'tr', type: 'generator.trunk', parent: 'tree', params: { ...TRUNK, splitsChance: 1 } as NodeSpec['params'] },
      { id: 'b1', type: 'generator.branch', parent: 'tr', params: { number: 0, extendParent: 'any', extendCount: 1, length: { value: 1.5, variance: 0 } } as NodeSpec['params'] },
      { id: 'rt', type: 'generator.root', parent: 'b1', params: { ...ROOT } as NodeSpec['params'] },
    ];
    const r = await run(specs);
    expect(skeletonOf(r, 'b1').branches.length).toBeGreaterThan(0);
    expect(skeletonOf(r, 'rt').branches).toHaveLength(0);
  });

  it('root count, positions and seeds are identical for Chance 0 and Chance 1 of the trunk', async () => {
    const a = skeletonOf(await run(trunkWithRoots({ splitsChance: 0 }, { number: 7 })), 'rt');
    const b = skeletonOf(await run(trunkWithRoots({ splitsChance: 1 }, { number: 7 })), 'rt');
    expect(a.branches.length).toBeGreaterThan(0);
    expect(b.branches.length).toBe(a.branches.length);
    expect(b.count).toBe(a.count);
    // The trunk is a hair wider below its fork, so the anchor on its surface moves by a fraction of a millimetre: same
    // heights, same azimuths, same roots.
    expectSameRoots(a, b);
  });

  it('two trunks get two independent root sets, unaffected by the splits of the other', async () => {
    const two = { number: 2 };
    const a = await run(trunkWithRoots({ ...two, splitsChance: 0 }, { number: 4 }));
    const b = await run(trunkWithRoots({ ...two, splitsChance: 1 }, { number: 4 }));
    const trA = skeletonOf(a, 'tr');
    const trB = skeletonOf(b, 'tr');
    const groundsA = trA.branches.filter((t) => t.parentBranch < 0);
    const groundsB = trB.branches.filter((t) => t.parentBranch < 0);
    expect(groundsA).toHaveLength(2);
    expect(groundsB).toHaveLength(2);
    const rootsA = skeletonOf(a, 'rt');
    const rootsB = skeletonOf(b, 'rt');
    const perTrunk = (sk: Skeleton, id: number): number => sk.branches.filter((x) => x.parentBranch === id).length;
    expect(perTrunk(rootsA, groundsA[0]!.id)).toBe(4);
    expect(perTrunk(rootsA, groundsA[1]!.id)).toBe(4);
    expect(perTrunk(rootsB, groundsB[0]!.id)).toBe(4);
    expect(perTrunk(rootsB, groundsB[1]!.id)).toBe(4);
    // each root starts on the ring of its own trunk
    for (const g of groundsB) {
      const base = pointOf(trB, g.start);
      for (const x of rootsB.branches.filter((y) => y.parentBranch === g.id)) {
        const p = pointOf(rootsB, x.start);
        expect(Math.hypot(p[0] - base[0], p[1] - base[1])).toBeLessThanOrEqual(trB.radius[g.start]! + 1e-3);
      }
    }
    expectSameRoots(rootsA, rootsB);
  });
});

describe('S7: Extend parent > Bottom on the Root generator', () => {
  it('the Root generator is an Extend child and its open ends can be extended', () => {
    expect(getNodeDef('generator.root')!.params.some((p) => p.id === 'extendParent')).toBe(true);
    expect(EXTEND_CHILD_TYPES.has('generator.root')).toBe(true);
    expect(EXTEND_PARENT_TYPES.has('generator.root')).toBe(true);
    expect(extendIsValid('generator.cap', 'generator.root')).toBe(true);
    expect(extendIsValid('generator.root', 'generator.trunk')).toBe(true);
  });

  it('Bottom continues the base ring of the primary spine only (position / radius within 1e-5, direction = -tangent)', async () => {
    const r = await run(trunkWithRoots({ splitsChance: 1 }, { number: 0, extendParent: 'bottom' }));
    const trunk = skeletonOf(r, 'tr');
    const roots = skeletonOf(r, 'rt');
    expect(roots.branches).toHaveLength(1);
    const ext = roots.branches[0]!;
    const primary = trunk.branches.find((b) => b.parentBranch < 0)!;
    expect(ext.parentBranch).toBe(primary.id);
    expect(originOf(roots, ext.start)).toBe('extension');
    const p = pointOf(roots, ext.start);
    const q = pointOf(trunk, primary.start);
    for (let k = 0; k < 3; k++) expect(Math.abs(p[k]! - q[k]!)).toBeLessThan(1e-5);
    expect(Math.abs(roots.radius[ext.start]! - trunk.radius[primary.start]!)).toBeLessThan(1e-5);
    // grows backwards out of the base: the first stored segment points along -tangent
    const tz = trunk.tangent[primary.start * 3 + 2]!;
    const dz = roots.position[(ext.start + 1) * 3 + 2]! - roots.position[ext.start * 3 + 2]!;
    expect(tz).toBeGreaterThan(0.9);
    expect(dz).toBeLessThan(0);
  });

  it('Bottom with two trunks makes one extension per trunk base', async () => {
    const r = await run(trunkWithRoots({ number: 2, splitsChance: 1 }, { number: 0, extendParent: 'bottom' }));
    expect(skeletonOf(r, 'rt').branches).toHaveLength(2);
  });
});

describe('S7: root splitting', () => {
  it('Down bias tilts both halves toward gravity: below the parent direction, below the unbiased halves', () => {
    const tangent: [number, number, number] = [0.6, 0, -0.8];
    const base = {
      end: { position: [0, 0, -1] as [number, number, number], tangent, up: [0, 0, 1] as [number, number, number], radius: 0.1 },
      parentLength: 2,
      ringSpacing: 0.1,
      rng: new Rng(5),
      chance: 1,
      parentTiles: 6,
    };
    const flat = planSplit({ ...base, settings: { ...DEFAULT_SPLIT_SETTINGS, spread1Deg: 30, spread2Deg: 30, downBias: 0 } })!;
    const biased = planSplit({ ...base, settings: { ...DEFAULT_SPLIT_SETTINGS, spread1Deg: 30, spread2Deg: 30, downBias: 0.4 } })!;
    for (let i = 0; i < 2; i++) {
      expect(biased.lobes[i]!.endTangent[2]).toBeLessThan(flat.lobes[i]!.endTangent[2]);
      expect(biased.lobes[i]!.endTangent[2]).toBeLessThan(tangent[2] + 1e-9);
      expect(Math.hypot(...biased.lobes[i]!.endTangent)).toBeCloseTo(1, 6);
    }
    // identical radii: the bias only turns the direction
    expect(biased.lobes[0]!.radius).toBe(flat.lobes[0]!.radius);
  });

  it('tiltTowardGravity: 0 changes nothing, never rotates away from gravity, keeps unit length', () => {
    const d: [number, number, number] = [1, 0, 0];
    expect(tiltTowardGravity(d, [0, 0, -1], 0)).toEqual(d);
    const t = tiltTowardGravity(d, [1, 0, 0], 0.5);
    expect(t[2]).toBeLessThan(0);
    expect(Math.hypot(...t)).toBeCloseTo(1, 9);
    const straightDown = tiltTowardGravity([0, 0, -1], [0, 0, -1], 1);
    expect(straightDown[2]).toBeCloseTo(-1, 9);
  });

  it('Root defaults: Area exponent 2.3, Down bias 0.4; Trunk / Branch keep 2 and 0', () => {
    const def = (type: string, id: string): unknown => getNodeDef(type)!.params.find((p) => p.id === id)?.default;
    expect(def('generator.root', 'splitsAreaExponent')).toBe(2.3);
    expect(def('generator.root', 'splitsDownBias')).toBe(0.4);
    expect(def('generator.trunk', 'splitsAreaExponent')).toBe(2);
    expect(def('generator.branch', 'splitsDownBias')).toBe(0);
  });

  it('a splitting root is one fused watertight skin and its halves point lower than without the bias', async () => {
    const specs = (bias: number): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'rt', type: 'generator.root', parent: 'tree', params: { ...ROOT, number: 3, splitsChance: 1, splitsDownBias: bias, spread: 40, capEnd: true } as NodeSpec['params'] },
    ];
    const r = await run(specs(0.4));
    const sk = skeletonOf(r, 'rt');
    const halves = sk.branches.filter((b) => originOf(sk, b.start) === 'splitHalf');
    expect(halves.length).toBe(6);
    const mesh = meshOf(r, 'rt');
    expect(mesh.indices.length).toBeGreaterThan(0);
    for (const c of edgeUse(mesh).values()) expect(c).toBeLessThanOrEqual(2);
    // direction of the last segment of every half (the open end the extensions continue)
    const endDirZ = (res: Result): number => {
      const s = skeletonOf(res, 'rt');
      const zs = s.branches
        .filter((b) => originOf(s, b.start) === 'splitHalf')
        .map((b) => {
          const i = b.start + b.count - 1;
          const d = [s.position[i * 3]! - s.position[(i - 1) * 3]!, s.position[i * 3 + 1]! - s.position[(i - 1) * 3 + 1]!, s.position[i * 3 + 2]! - s.position[(i - 1) * 3 + 2]!];
          return d[2]! / Math.hypot(d[0]!, d[1]!, d[2]!);
        });
      return zs.reduce((m, z) => m + z, 0) / zs.length;
    };
    expect(endDirZ(r)).toBeLessThan(endDirZ(await run(specs(0))));
  });

  it('roots under a trunk never grow lateral roots on split halves of a root parent', async () => {
    const specs: NodeSpec[] = [
      ...trunkWithRoots({ splitsChance: 0 }, { number: 3, splitsChance: 1 }),
      { id: 'lat', type: 'generator.root', parent: 'rt', params: { ...ROOT, number: 6, first: 0.1, last: 0.9 } as NodeSpec['params'] },
    ];
    const r = await run(specs);
    const rootSk = skeletonOf(r, 'rt');
    const lat = skeletonOf(r, 'lat');
    expect(lat.branches.length).toBeGreaterThan(0);
    for (const b of lat.branches) {
      const parent = rootSk.branches.find((x) => x.id === b.parentBranch)!;
      expect(originOf(rootSk, parent.start)).not.toBe('splitHalf');
    }
  });

  it('Cap on Any closes every root tip: one cap per open end, starting on the end with its radius', async () => {
    const mk = (chance: number): NodeSpec[] => [
      { id: 'tree', type: 'output.tree', parent: null },
      { id: 'rt', type: 'generator.root', parent: 'tree', params: { ...ROOT, number: 2, splitsChance: chance, capEnd: false, spineOnly: false } as NodeSpec['params'] },
      { id: 'cap', type: 'generator.cap', parent: 'rt', params: { extendParent: 'any' } as NodeSpec['params'] },
    ];
    const split = await run(mk(1));
    const roots = skeletonOf(split, 'rt');
    const caps = skeletonOf(split, 'cap');
    expect(caps.branches).toHaveLength(4);
    expect(meshOf(split, 'cap').indices.length).toBeGreaterThan(0);
    for (const c of caps.branches) {
      const end = roots.branches.find((x) => x.id === c.parentBranch)!;
      const last = end.start + end.count - 1;
      const a = pointOf(caps, c.start);
      const e = pointOf(roots, last);
      expect(Math.hypot(a[0] - e[0], a[1] - e[1], a[2] - e[2])).toBeLessThan(1e-5);
      expect(caps.radius[c.start]!).toBeCloseTo(roots.radius[last]!, 6);
    }
  });
});

describe('S7: back-compat', () => {
  const fixture = (): unknown => JSON.parse(readFileSync(new URL('./fixtures/legacySplitProject.ktree.json', import.meta.url), 'utf8')) as unknown;

  it('an old project (Root without the new parameters) loads, evaluates and anchors its roots on the ground base', async () => {
    const project = parseProject(fixture());
    const toSpec = (id: string, parent: string): NodeSpec => {
      const n = project.graph.nodes.find((x) => x.id === id)!;
      const params: Record<string, number | string | boolean | { value: number; variance: number }> = {};
      for (const [k, v] of Object.entries(n.params)) {
        params[k] = v.variance !== undefined ? ({ value: v.value as number, variance: v.variance } as { value: number; variance: number }) : (v.value as number | string | boolean);
      }
      return { id, type: n.type, parent, params: params as NodeSpec['params'] };
    };
    const r = await run([{ id: 'tree', type: 'output.tree', parent: null }, toSpec('trunk', 'tree'), toSpec('roots', 'trunk')], 6);
    expect(r.errors).toBe(0);
    const trunk = skeletonOf(r, 'trunk');
    const roots = skeletonOf(r, 'roots');
    expect(roots.branches.length).toBeGreaterThan(0);
    for (const b of roots.branches) {
      const parent = trunk.branches.find((t) => t.id === b.parentBranch);
      if (parent) expect(originOf(trunk, parent.start)).toBe('primary');
    }
  });

  it('spine origin helpers: ground base needs a primary spine without a parent', () => {
    expect(isGroundBase(-1, 'primary')).toBe(true);
    expect(isGroundBase(3, 'primary')).toBe(false);
    expect(isGroundBase(-1, 'splitHalf')).toBe(false);
    expect(isGroundBase(-1, 'extension')).toBe(false);
    expect(SpineOrigin.Primary).toBe(0);
  });
});
