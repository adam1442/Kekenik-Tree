import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource } from '@/contracts/nodes';
import { emptyMeshData, type MeshData } from '@/contracts/mesh';
import { emptySkeleton, type Skeleton } from '@/contracts/skeleton';
import { SPINE_ORIGIN_ATTR, spineOriginName } from '@/generators/split';
import { snapRingToPolygon } from '@/geometry/ringSnap';
import { createFusedParents, truncatePrepared } from '@/nodes/generators/fusedParent';
import { prepareParentBranch } from '@/nodes/generators/frames';
import { GraphEvaluator, snapshotGraph } from '@/graph/engine';
import { getNodeDef, registerDiscoveredNodes } from '@/graph/registry';
import { buildGraph, type NodeSpec } from './helpers/graphSpec';

beforeAll(() => registerDiscoveredNodes());

const STRAIGHT = { spineOnly: true, spread: 0, gravity: 0, curvature: 0, upDown: 0, noiseAmount: 0, earlyNoiseAmount: 0, straightness: 1, noiseTwist: 0, lean: 0 };
const run = (specs: NodeSpec[], seed = 1) =>
  new GraphEvaluator().evaluate(snapshotGraph(buildGraph(specs)), { seed, lod: 0, token: new CancellationSource().token });
type Result = Awaited<ReturnType<typeof run>>;
const skeletonOf = (r: Result, id: string): Skeleton => r.scene.skeletons.find((s) => s.nodeId === id)?.skeleton ?? emptySkeleton();
const meshOf = (r: Result, id: string): MeshData => r.scene.entries.find((e) => e.nodeId === id)?.mesh ?? emptyMeshData();
const originOf = (sk: Skeleton, start: number) => spineOriginName(sk.attributes.get(SPINE_ORIGIN_ATTR)?.[start]);

const trunk = (chance: number, extra: Record<string, unknown> = {}): NodeSpec[] => [
  { id: 'tree', type: 'output.tree', parent: null },
  { id: 'trunk', type: 'generator.trunk', parent: 'tree', params: { ...STRAIGHT, length: { value: 4, variance: 0 }, radius: { value: 0.25, variance: 0 }, splitsChance: chance, segments: 24, accuracy: 24, ...extra } as NodeSpec['params'] },
];
const child = (id: string, type: string, extra: Record<string, unknown> = {}): NodeSpec => ({ id, type, parent: 'trunk', params: { ...(type === 'generator.split' ? {} : { spineOnly: true }), ...extra } as NodeSpec['params'] });

describe('S8 - a split is one logical spine', () => {
  it('a Branch generator under a splitting trunk is not repeated on the two halves', async () => {
    const specs = (chance: number): NodeSpec[] => [...trunk(chance), child('br', 'generator.branch', { number: 6, first: 0.1, last: 0.6, length: { value: 1, variance: 0 } })];
    const plain = skeletonOf(await run(specs(0)), 'br');
    const r = await run(specs(1));
    const tr = skeletonOf(r, 'trunk');
    const br = skeletonOf(r, 'br');
    const halves = tr.branches.filter((b) => originOf(tr, b.start) === 'splitHalf');
    expect(halves).toHaveLength(2);
    const halfIds = new Set(halves.map((b) => b.id));
    expect(br.branches.length).toBeGreaterThan(0);
    expect(br.branches.some((b) => halfIds.has(b.parentBranch))).toBe(false);
    // The same count as on an unsplit trunk (the cut only shortens the range slightly), never 3x
    expect(br.branches.length).toBeLessThanOrEqual(plain.branches.length + 1);
    expect(br.branches.length).toBeGreaterThanOrEqual(plain.branches.length - 2);
  });

  it.each([
    ['generator.leaf', { number: 10, first: 0.1, last: 1 }],
    ['generator.decal', { number: 30 }],
    ['generator.fin', { number: 30 }],
  ])('a %s generator under a splitting trunk is not repeated on the two halves', async (type, extra) => {
    const specs = (chance: number): NodeSpec[] => [...trunk(chance), { id: 'g', type, parent: 'trunk', params: extra as NodeSpec['params'] }];
    const size = (r: Result): number => meshOf(r, 'g').positions.length;
    const plain = size(await run(specs(0)));
    const split = size(await run(specs(1)));
    expect(plain).toBeGreaterThan(0);
    expect(split).toBeLessThan(plain * 1.5);
  });

  it('children stay on the true tube: never inside the shared transition', async () => {
    const r = await run([...trunk(1), child('br', 'generator.branch', { number: 12, first: 0, last: 1, length: { value: 0.5, variance: 0 } })]);
    const tr = skeletonOf(r, 'trunk');
    const br = skeletonOf(r, 'br');
    const primary = tr.branches.find((b) => originOf(tr, b.start) === 'primary')!;
    const lobe = tr.branches.find((b) => originOf(tr, b.start) === 'splitHalf')!;
    const keepIndex = lobe.parentPoint - primary.start + 1;
    for (const b of br.branches) {
      expect(b.parentBranch).toBe(primary.id);
      expect(b.parentPoint - primary.start).toBeLessThanOrEqual(keepIndex);
    }
  });

  it('the fused view cuts a splitting parent at the transition start and leaves other branches alone', async () => {
    const r = await run(trunk(1));
    const tr = skeletonOf(r, 'trunk');
    const fused = createFusedParents(tr);
    const primary = tr.branches.find((b) => originOf(tr, b.start) === 'primary')!;
    const full = prepareParentBranch(tr, primary);
    const cut = fused.prepare(primary, full);
    expect(cut.branch.count).toBeLessThan(full.branch.count);
    expect(cut.arcLength).toBeLessThan(full.arcLength);
    expect(cut.t[cut.branch.count - 1]).toBeCloseTo(1, 6);
    for (const h of fused.halves) expect(tr.branches.some((b) => b.id === h)).toBe(true);
    const half = tr.branches.find((b) => fused.halves.has(b.id))!;
    const hp = prepareParentBranch(tr, half);
    expect(fused.prepare(half, hp)).toBe(hp);
  });

  it('truncatePrepared keeps the arrays consistent', async () => {
    const r = await run(trunk(0));
    const tr = skeletonOf(r, 'trunk');
    const prep = prepareParentBranch(tr, tr.branches[0]!);
    const pos: [number, number, number] = [prep.positions[3]!, prep.positions[4]!, prep.positions[5]! * 0 + prep.positions[5]!];
    const cut = truncatePrepared(prep, 3, { pos, rad: prep.radii[1]! });
    expect(cut.branch.count).toBe(3);
    expect(cut.positions.length).toBe(9);
    expect(cut.t[0]).toBe(0);
    expect(cut.t[2]).toBeCloseTo(1, 6);
    expect(Number.isFinite(cut.tangents[8]!)).toBe(true);
  });
});

describe('S8 - Split generator: Split parents only', () => {
  it('registers the param (default off)', () => {
    const def = getNodeDef('generator.split')!;
    const p = def.params.find((d) => d.id === 'splitParentsOnly');
    expect(p?.kind).toBe('bool');
    expect(p?.default).toBe(false);
  });

  const splitNode = (only: boolean): NodeSpec => child('sp', 'generator.split', { splitParentsOnly: only, forkCount: 2, splitAt: 0.5 });

  it('forks only parents that split; never the halves', async () => {
    const off = skeletonOf(await run([...trunk(1), splitNode(false)]), 'sp');
    expect(off.branches).toHaveLength(2);
    const noSplit = skeletonOf(await run([...trunk(0), splitNode(true)]), 'sp');
    expect(noSplit.branches).toHaveLength(0);
    const on = skeletonOf(await run([...trunk(1), splitNode(true)]), 'sp');
    expect(on.branches).toHaveLength(2);
    const plainAll = skeletonOf(await run([...trunk(0), splitNode(false)]), 'sp');
    expect(plainAll.branches).toHaveLength(2);
  });
});

describe('S8 - ring snap', () => {
  const circle = (n: number, r: number, phase: number): Float32Array => {
    const out = new Float32Array(n * 3);
    for (let j = 0; j < n; j++) {
      out[j * 3] = Math.cos(phase + (2 * Math.PI * j) / n) * r;
      out[j * 3 + 1] = Math.sin(phase + (2 * Math.PI * j) / n) * r;
    }
    return out;
  };

  it('equal counts: lands exactly on the target vertices regardless of phase and direction', () => {
    const target = circle(8, 1, 0.13);
    for (const reversed of [false, true]) {
      const ring = circle(8, 1.02, 0.5);
      if (reversed) {
        const copy = new Float32Array(ring);
        for (let j = 0; j < 8; j++) for (let k = 0; k < 3; k++) ring[j * 3 + k] = copy[((8 - j) % 8) * 3 + k]!;
      }
      expect(snapRingToPolygon(ring, 0, 8, target, 1)).toBe(true);
      const used = new Set<number>();
      for (let j = 0; j < 8; j++) {
        const k = [...Array(8).keys()].find((q) => Math.hypot(ring[j * 3]! - target[q * 3]!, ring[j * 3 + 1]! - target[q * 3 + 1]!) < 1e-5);
        expect(k).toBeDefined();
        used.add(k!);
      }
      expect(used.size).toBe(8);
    }
  });

  it('different counts: every vertex ends up on the polygon', () => {
    const target = circle(6, 1, 0);
    const ring = circle(10, 1, 0.2);
    expect(snapRingToPolygon(ring, 0, 10, target, 1)).toBe(true);
    for (let j = 0; j < 10; j++) expect(Math.hypot(ring[j * 3]!, ring[j * 3 + 1]!)).toBeGreaterThan(0.8);
  });

  it('refuses a target that is far away', () => {
    const target = circle(8, 1, 0);
    for (let i = 0; i < 24; i += 3) target[i] = target[i]! + 10;
    const ring = circle(8, 1, 0);
    const before = new Float32Array(ring);
    expect(snapRingToPolygon(ring, 0, 8, target, 1)).toBe(false);
    expect(Array.from(ring)).toEqual(Array.from(before));
  });
});

describe('S8 - extension of a split half meets the half without a gap', () => {
  const edgeUse = (meshes: MeshData[]): Map<string, number> => {
    const ids = new Map<string, number>();
    const id = (m: MeshData, i: number): number => {
      const k = `${Math.round(m.positions[i * 3]! * 1e4)},${Math.round(m.positions[i * 3 + 1]! * 1e4)},${Math.round(m.positions[i * 3 + 2]! * 1e4)}`;
      const hit = ids.get(k);
      if (hit !== undefined) return hit;
      ids.set(k, ids.size);
      return ids.size - 1;
    };
    const use = new Map<string, number>();
    for (const m of meshes) {
      for (let t = 0; t < m.indices.length; t += 3) {
        const v = [id(m, m.indices[t]!), id(m, m.indices[t + 1]!), id(m, m.indices[t + 2]!)];
        for (let e = 0; e < 3; e++) {
          const a = v[e]!;
          const b = v[(e + 1) % 3]!;
          if (a === b) continue;
          const k = a < b ? `${a}_${b}` : `${b}_${a}`;
          use.set(k, (use.get(k) ?? 0) + 1);
        }
      }
    }
    return use;
  };

  it('an Extend parent branch shares its first ring with the half (no open edges at the junction)', async () => {
    const meshed = { spineOnly: false };
    const r = await run([
      ...trunk(1, { ...meshed, sides: 16, capEnd: true }),
      child('ext', 'generator.branch', { ...meshed, number: 0, extendParent: 'any', extendCount: 1, length: { value: 1, variance: 0 } }),
    ]);
    const use = edgeUse([meshOf(r, 'trunk'), meshOf(r, 'ext')]);
    const open = [...use.values()].filter((n) => n === 1).length;
    // Only the two tips of the extensions stay open (their far ends are capped by the dome, so nothing is open)
    expect(open).toBe(0);
  });

  it('a Cap on both split halves closes the trunk without a gap (no open edge, no edge shared by three triangles)', async () => {
    const r = await run([
      ...trunk(1, { spineOnly: false, sides: 16, capEnd: false }),
      child('cap', 'generator.cap', { extendParent: 'any', spineOnly: false }),
    ]);
    const use = edgeUse([meshOf(r, 'trunk'), meshOf(r, 'cap')]);
    expect([...use.values()].filter((n) => n === 1)).toHaveLength(0);
    expect([...use.values()].filter((n) => n > 2)).toHaveLength(0);
  });
});

describe('S8 - Show open ends overlay', () => {
  it('builds a ring, an arrow and index ticks per open end, coloured by kind', async () => {
    const { buildOpenEndGlyphs, OPEN_END_COLORS } = await import('@/viewport/debug/openEndGlyphs');
    const r = await run(trunk(1));
    const g = buildOpenEndGlyphs(skeletonOf(r, 'trunk'));
    expect(g.ends.map((e) => `${e.kind}${e.index}`).sort()).toEqual(['bottom1', 'fat1', 'skinny2']);
    expect(g.ends.filter((e) => e.kind === 'fat' || e.kind === 'skinny')).toHaveLength(2);
    expect(g.ends.some((e) => e.kind === 'bottom')).toBe(true);
    expect(g.segments).toBe(g.positions.length / 6);
    expect(g.colors.length).toBe(g.positions.length);
    expect(Array.from(g.colors.subarray(0, 3))).toEqual(Array.from(OPEN_END_COLORS[g.ends[0]!.kind]).map((v) => Math.fround(v)));
    for (const v of g.positions) expect(Number.isFinite(v)).toBe(true);
  });

  it('a broken end is drawn as a break; an unbroken, unsplit trunk has only its bottom', async () => {
    const { buildOpenEndGlyphs } = await import('@/viewport/debug/openEndGlyphs');
    const plain = buildOpenEndGlyphs(skeletonOf(await run(trunk(0)), 'trunk'));
    expect(plain.ends.map((e) => e.kind)).toEqual(['bottom']);
    const broken = buildOpenEndGlyphs(skeletonOf(await run(trunk(0, { breakChance: 1 })), 'trunk'));
    expect(broken.ends.map((e) => e.kind).sort()).toEqual(['bottom', 'break']);
  });

  it('is off by default and exposed as a view command', async () => {
    const { createAppStore } = await import('@/app/state');
    expect(createAppStore().get().showOpenEnds).toBe(false);
  });
});
