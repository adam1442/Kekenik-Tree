import { beforeAll, describe, expect, it } from 'vitest';
import { CancellationSource, type NodeContext, type NodeInputs } from '@/contracts/nodes';
import { defaultParamState, type NodeParams } from '@/contracts/params';
import type { Lineage, StructureData } from '@/contracts/ports';
import type { MeshData } from '@/contracts/mesh';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { createLogger } from '@/core/logger';
import { Rng } from '@/core/rng';
import { getNodeDef, migrateNodeParams, registerDiscoveredNodes } from '@/graph/registry';
import { buildLineage, chainOf } from '@/geometry/lineage';
import { cross, dot, len, norm, sub, type V3 } from '@/geometry/math3';
import { MeshAccumulator, newVertex } from '@/geometry/meshAccumulator';
import {
  AnchorResolver,
  anchorFromChain,
  applyFinal,
  crossedSide,
  effectiveSize,
  frameNormal,
  isMirrored,
  NEUTRAL_FINAL,
  NEUTRAL_LOCAL,
  NEUTRAL_SENSITIVITY,
  orientLeaf,
  ORIENTATION_STEPS,
  resolveSide,
  weldToSkin,
  type AnchorStyle,
  type LeafFrame,
  type OrientationStep,
} from '@/geometry/leafPlacement';

beforeAll(() => registerDiscoveredNodes());

const UP: V3 = [0, 0, 1];
const near = (a: V3, b: V3, eps = 1e-6): void => {
  for (let i = 0; i < 3; i++) expect(Math.abs((a[i] as number) - (b[i] as number))).toBeLessThan(eps);
};

/** Synthetic ancestor chain: trunk base, two branch bases, the parent's base. */
const CHAIN: V3[] = [
  [0, 0, 0],
  [0, 0, 3],
  [1, 0, 5],
  [2, 0, 6],
  [3, 0, 6.5],
];
const chainCtx = (position: V3, chain: V3[] = CHAIN) => {
  const resolver = new AnchorResolver(() => chain);
  return { position, parentTangent: [1, 0, 0] as V3, anchor: (s: AnchorStyle) => resolver.computeAnchorPoint(1, s) };
};
const startFrame = (): LeafFrame => ({ axis: [0, 1, 0], side: [1, 0, 0] });

describe('orientation pipeline', () => {
  it('applies the steps in the documented order', () => {
    const trace: OrientationStep[] = [];
    orientLeaf(startFrame(), chainCtx([4, 0, 7]), NEUTRAL_LOCAL, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL, trace);
    expect(trace).toEqual([...ORIENTATION_STEPS]);
    expect(ORIENTATION_STEPS.indexOf('unification')).toBeLessThan(ORIENTATION_STEPS.indexOf('sky'));
    expect(ORIENTATION_STEPS.indexOf('face')).toBeLessThan(ORIENTATION_STEPS.indexOf('final'));
  });

  it('is the identity with neutral settings', () => {
    const f = orientLeaf(startFrame(), chainCtx([4, 0, 7]), NEUTRAL_LOCAL, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    near(f.axis, [0, 1, 0]);
    near(f.side, [1, 0, 0]);
  });

  it('order matters: sky influence runs before fold', () => {
    const ctx = chainCtx([4, 0, 7]);
    const both = orientLeaf(startFrame(), ctx, { ...NEUTRAL_LOCAL, sky: 1, fold: 0.7 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    const skyOnly = orientLeaf(startFrame(), ctx, { ...NEUTRAL_LOCAL, sky: 1 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    expect(dot(frameNormal(skyOnly), UP)).toBeCloseTo(1, 6);
    expect(dot(frameNormal(both), UP)).toBeLessThan(0.999);
  });

  it('sky influence 1 points the leaf z axis straight up from any start', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 25; i++) {
      const axis = norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)]);
      const side = norm(cross(axis, norm([rng.range(-1, 1), rng.range(-1, 1), rng.range(-1, 1)])));
      const f = orientLeaf({ axis, side }, chainCtx([1, 1, 1]), { ...NEUTRAL_LOCAL, sky: 1 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
      expect(dot(frameNormal(f), UP)).toBeCloseTo(1, 5);
    }
  });

  it('sky influence is a partial turn for values below 1', () => {
    const ctx = chainCtx([1, 1, 1]);
    const start: LeafFrame = { axis: [0, 1, 0], side: [0, 0, 1] };
    const n0 = dot(frameNormal(start), UP);
    const half = dot(frameNormal(orientLeaf(start, ctx, { ...NEUTRAL_LOCAL, sky: 0.5 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL)), UP);
    expect(half).toBeGreaterThan(n0);
    expect(half).toBeLessThan(1 - 1e-3);
  });

  it('unification points "out" from every anchor type of a synthetic chain', () => {
    const attach: V3 = [4, 0, 7];
    const expected: Record<Exclude<AnchorStyle, 'none'>, V3> = {
      global: CHAIN[0] as V3,
      deep: CHAIN[1] as V3,
      intermediate: CHAIN[2] as V3,
      local: CHAIN[4] as V3,
    };
    for (const [style, anchor] of Object.entries(expected) as [Exclude<AnchorStyle, 'none'>, V3][]) {
      const f = orientLeaf(startFrame(), chainCtx(attach), { ...NEUTRAL_LOCAL, unification: style }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
      near(f.axis, norm(sub(attach, anchor)), 1e-6);
      expect(len(f.side)).toBeCloseTo(1, 6);
      expect(dot(f.side, f.axis)).toBeCloseTo(0, 6);
    }
    const none = orientLeaf(startFrame(), chainCtx(attach), { ...NEUTRAL_LOCAL, unification: 'none' }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    near(none.axis, [0, 1, 0]);
  });

  it('anchor styles pick the documented chain entries (and degrade on short chains)', () => {
    expect(anchorFromChain(CHAIN, 'global')).toEqual(CHAIN[0]);
    expect(anchorFromChain(CHAIN, 'deep')).toEqual(CHAIN[1]);
    expect(anchorFromChain(CHAIN, 'intermediate')).toEqual(CHAIN[2]);
    expect(anchorFromChain(CHAIN, 'local')).toEqual(CHAIN[4]);
    expect(anchorFromChain(CHAIN, 'none')).toBeNull();
    expect(anchorFromChain([[1, 2, 3]], 'deep')).toEqual([1, 2, 3]);
    expect(anchorFromChain([], 'global')).toBeNull();
  });

  it('computeAnchorPoint caches per parent and style', () => {
    let calls = 0;
    const r = new AnchorResolver(() => {
      calls += 1;
      return CHAIN;
    });
    r.computeAnchorPoint(7, 'global');
    r.computeAnchorPoint(7, 'global');
    r.computeAnchorPoint(7, 'deep');
    r.computeAnchorPoint(8, 'global');
    expect(calls).toBe(3);
  });

  it('align tips the leaf toward the parent growth direction, fold swings it around it', () => {
    const ctx = { position: [0, 0, 0] as V3, parentTangent: UP, anchor: () => null };
    const start: LeafFrame = { axis: [1, 0, 0], side: [0, 1, 0] };
    const aligned = orientLeaf(start, ctx, { ...NEUTRAL_LOCAL, align: Math.PI / 4 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    expect(dot(aligned.axis, UP)).toBeCloseTo(Math.SQRT1_2, 6);
    const away = orientLeaf(start, ctx, { ...NEUTRAL_LOCAL, align: -Math.PI / 4 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    expect(dot(away.axis, UP)).toBeCloseTo(-Math.SQRT1_2, 6);
    const folded = orientLeaf(start, ctx, { ...NEUTRAL_LOCAL, fold: Math.PI / 2 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    near(folded.axis, [0, 1, 0]);
  });

  it('face spins the up vector toward the parent growth without moving the stem', () => {
    const ctx = { position: [0, 0, 0] as V3, parentTangent: UP, anchor: () => null };
    const start: LeafFrame = { axis: [1, 0, 0], side: [0, 0, 1] };
    const f = orientLeaf(start, ctx, { ...NEUTRAL_LOCAL, face: 1 }, NEUTRAL_SENSITIVITY, NEUTRAL_FINAL);
    near(f.axis, [1, 0, 0]);
    expect(dot(frameNormal(f), UP)).toBeCloseTo(1, 6);
  });

  it('sensitivity turns the leaf bottom toward its anchor and Sky spins toward up', () => {
    const ctx = { position: [4, 0, 7] as V3, parentTangent: UP, anchor: (s: AnchorStyle) => (s === 'global' ? ([0, 0, 0] as V3) : null) };
    const start: LeafFrame = { axis: [1, 0, 0], side: [0, 1, 0] };
    const f = orientLeaf(start, ctx, NEUTRAL_LOCAL, { amount: 1, anchor: 'global', sky: 0 }, NEUTRAL_FINAL);
    near(f.axis, [1, 0, 0]);
    const toAnchor = norm(sub([0, 0, 0], [4, 0, 7]));
    const n = frameNormal(f);
    expect(dot(n, toAnchor)).toBeLessThan(0);
    const sky = orientLeaf(start, ctx, NEUTRAL_LOCAL, { amount: 0, anchor: 'none', sky: 1 }, NEUTRAL_FINAL);
    expect(dot(frameNormal(sky), UP)).toBeCloseTo(1, 6);
  });

  it('final adjustments rotate about the local X / Y / Z axes', () => {
    const f = startFrame();
    const up = applyFinal(f, { up: Math.PI / 2, right: 0, out: 0 });
    near(up.side, [1, 0, 0]);
    near(up.axis, [0, 0, 1]);
    const right = applyFinal(f, { up: 0, right: Math.PI / 2, out: 0 });
    near(right.axis, [0, 1, 0]);
    near(right.side, [0, 0, -1]);
    const out = applyFinal(f, { up: 0, right: 0, out: Math.PI / 2 });
    near(frameNormal(out), frameNormal(f));
    near(out.axis, [-1, 0, 0]);
  });
});

describe('weld, cross, sides, size', () => {
  it('weldToSkin lands on the tube surface; hair-thin parents have no skin', () => {
    const p = weldToSkin([0, 0, 2], UP, norm([1, 1, 0.3]), 0.25);
    expect(p).not.toBeNull();
    const q = p as V3;
    expect(Math.hypot(q[0], q[1])).toBeCloseTo(0.25, 6);
    expect(q[2]).toBeCloseTo(2, 6);
    expect(weldToSkin([0, 0, 0], UP, [1, 0, 0], 0.001)).toBeNull();
  });

  it('the crossed copy is orthogonal to the leaf', () => {
    const f = startFrame();
    const s2 = crossedSide(f.side, f.axis);
    expect(dot(s2, f.side)).toBeCloseTo(0, 9);
    expect(dot(norm(cross(s2, f.axis)), frameNormal(f))).toBeCloseTo(0, 9);
    expect(dot(s2, f.axis)).toBeCloseTo(0, 9);
  });

  it('resolveSide prefers the own placement side, then the parent side, then a random draw', () => {
    expect(resolveSide(-1, 1, () => 0.9)).toBe(-1);
    expect(resolveSide(0, -1, () => 0.9)).toBe(-1);
    expect(resolveSide(0, 0, () => 0.9)).toBe(1);
    expect(resolveSide(0, 0, () => 0.1)).toBe(-1);
  });

  it('Classic mirrors the left side, Synchronized never, Flip mirrors a random half', () => {
    expect(isMirrored(false, 'classic', -1, 0.9)).toBe(true);
    expect(isMirrored(false, 'classic', 1, 0.9)).toBe(false);
    expect(isMirrored(false, 'synchronized', -1, 0.1)).toBe(false);
    expect(isMirrored(true, 'classic', 1, 0.2)).toBe(true);
    expect(isMirrored(true, 'classic', -1, 0.7)).toBe(false);
  });

  it('size adds a share of the parent size', () => {
    expect(effectiveSize(1, 0, 4)).toBe(1);
    expect(effectiveSize(1, 0.25, 4)).toBe(2);
    expect(effectiveSize(0, 0, 4)).toBeGreaterThan(0);
  });
});

describe('mesh accumulator mirror + winding', () => {
  it('mirroring reverses the winding and fixWinding restores agreement with the normals', () => {
    const acc = new MeshAccumulator();
    const add = (x: number, y: number): void => {
      const v = newVertex();
      v.px = x;
      v.py = y;
      v.nz = 1;
      acc.addVertex(v);
    };
    add(1, 0);
    add(2, 0);
    add(1, 1);
    acc.addTriangle(0, 1, 2);
    acc.mirrorFrom(0, [0, 0, 0], [1, 0, 0]);
    const raw = acc.build('m', false);
    const geo = (m: MeshData): number => {
      const p = m.positions;
      const [a, b, c] = [m.indices[0] as number, m.indices[1] as number, m.indices[2] as number];
      const e1: V3 = [(p[b * 3] as number) - (p[a * 3] as number), (p[b * 3 + 1] as number) - (p[a * 3 + 1] as number), 0];
      const e2: V3 = [(p[c * 3] as number) - (p[a * 3] as number), (p[c * 3 + 1] as number) - (p[a * 3 + 1] as number), 0];
      return cross(e1, e2)[2];
    };
    expect(raw.positions[0]).toBe(-1);
    expect(geo(raw)).toBeLessThan(0);
    expect(acc.fixWinding()).toBe(1);
    expect(geo(acc.build('m', false))).toBeGreaterThan(0);
    expect(acc.fixWinding()).toBe(0);
  });
});

describe('lineage', () => {
  function chainSkeleton(n: number, parent?: { sk: Skeleton; at: number }): Skeleton {
    const sb = new SkeletonBuilder();
    sb.beginBranch(parent ? 0 : -1, parent ? parent.at : -1, parent ? 1 : 0);
    const base: V3 = parent ? ([parent.sk.position[parent.at * 3], parent.sk.position[parent.at * 3 + 1], parent.sk.position[parent.at * 3 + 2]] as V3) : [0, 0, 0];
    for (let i = 0; i < n; i++) sb.addPoint(base[0] + (parent ? i * 0.3 : 0), base[1], base[2] + i * 0.5, 0.03);
    sb.endBranch();
    return sb.build();
  }

  it('builds ancestor chains highest first, ending with the own base', () => {
    const trunk = chainSkeleton(6);
    const trunkL = buildLineage(trunk, trunk, undefined);
    expect(chainOf(trunkL, trunk, 0)).toEqual([[0, 0, 0]]);
    const branch = chainSkeleton(4, { sk: trunk, at: 3 });
    const branchL = buildLineage(branch, trunk, trunkL);
    const chain = chainOf(branchL, branch, 0);
    expect(chain.length).toBe(2);
    near(chain[0] as V3, [0, 0, 0]);
    near(chain[1] as V3, [0, 0, 1.5]);
    const twig = chainSkeleton(3, { sk: branch, at: 2 });
    const twigChain = chainOf(buildLineage(twig, branch, branchL), twig, 0);
    expect(twigChain.length).toBe(3);
    near(twigChain[0] as V3, [0, 0, 0]);
  });

  it('falls back to the parent base when no lineage is known', () => {
    const trunk = chainSkeleton(4);
    expect(chainOf(undefined, trunk, 0)).toEqual([[0, 0, 0]]);
    expect(chainOf(undefined, trunk, 5)).toEqual([]);
  });
});

describe('Leaf node', () => {
  const trunk = (radius = 0.03, points = 9): Skeleton => {
    const sb = new SkeletonBuilder();
    sb.beginBranch(-1, -1, 0);
    for (let i = 0; i < points; i++) sb.addPoint(0, 0, i * 0.5, radius);
    sb.endBranch();
    return sb.build();
  };

  function run(type: string, over: Record<string, unknown>, parent: StructureData = { skeleton: trunk() }, seed = 1): Record<string, { kind: string; value: unknown }> {
    const def = getNodeDef(type);
    if (!def) throw new Error(`${type} missing`);
    const p: NodeParams = {};
    for (const d of def.params) p[d.id] = defaultParamState(d);
    for (const [k, v] of Object.entries(over)) p[k] = { ...(p[k] as NodeParams[string]), value: v as never };
    const ctx: NodeContext = { nodeId: type, name: type, rng: new Rng(seed), seed, cancel: new CancellationSource().token, lod: 0, logger: createLogger('dev', 'error') };
    const inputs: NodeInputs = { parent: [{ kind: 'Structure', value: parent }] };
    return def.evaluate(ctx, inputs, p) as Record<string, { kind: string; value: unknown }>;
  }
  const mesh = (o: Record<string, { value: unknown }>): MeshData => o.geometry?.value as MeshData;
  const skeletonOf = (o: Record<string, { value: unknown }>): Skeleton => (o.children?.value as StructureData).skeleton;
  const BASE = { number: 8, first: 0.1, last: 0.9, cardType: 'quad', leafBend: 0, droopAmount: 0, leafTwist: 0, droopStiffness: 1 };
  const extent = (m: MeshData): number => {
    let hi = 0;
    for (let i = 0; i < m.positions.length; i++) hi = Math.max(hi, Math.abs(m.positions[i] as number));
    return hi;
  };

  it('defaults reproduce the previous leaf layout (migrated Scale -> Size)', () => {
    const migrated = migrateNodeParams('generator.leaf', { scale: { value: 2, variance: 0.1 } }, 1);
    expect(migrated.leafSize?.value).toBe(2);
    expect(migrated.scale).toBeUndefined();
    const big = extent(mesh(run('generator.leaf', { ...BASE, leafSize: 3 })));
    const small = extent(mesh(run('generator.leaf', { ...BASE, leafSize: 1 })));
    expect(big).toBeGreaterThan(small);
  });

  it('Use actual size ignores Size; +% of parent grows the leaf', () => {
    const a = mesh(run('generator.leaf', { ...BASE, leafSize: 1, leafUseActualSize: true }));
    const b = mesh(run('generator.leaf', { ...BASE, leafSize: 4, leafUseActualSize: true }));
    expect(Array.from(a.positions)).toEqual(Array.from(b.positions));
    const plain = extent(mesh(run('generator.leaf', { ...BASE })));
    const pct = extent(mesh(run('generator.leaf', { ...BASE, leafSizeParent: 50 })));
    expect(pct).toBeGreaterThan(plain);
  });

  it('Cross adds a second, orthogonal plane at the same position', () => {
    const one = mesh(run('generator.leaf', { ...BASE, number: 1, first: 0.5, last: 0.5 }));
    const two = mesh(run('generator.leaf', { ...BASE, number: 1, first: 0.5, last: 0.5, leafCross: true }));
    expect(two.indices.length).toBe(one.indices.length * 2);
    const nv = one.positions.length / 3;
    const n1: V3 = [two.normals[0] as number, two.normals[1] as number, two.normals[2] as number];
    const n2: V3 = [two.normals[nv * 3] as number, two.normals[nv * 3 + 1] as number, two.normals[nv * 3 + 2] as number];
    expect(Math.abs(dot(n1, n2))).toBeLessThan(1e-4);
    for (let i = 0; i < nv * 3; i++) expect(two.positions[i]).toBeCloseTo(one.positions[i] as number, 6);
    const centroid = (from: number): V3 => {
      const c: V3 = [0, 0, 0];
      for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) c[k] = (c[k] as number) + (two.positions[(from + i) * 3 + k] as number) / nv;
      return c;
    };
    near(centroid(0), centroid(nv), 1e-4);
  });

  it('Weld puts the leaf base on the parent skin (distance to the axis = radius)', () => {
    const radius = 0.05;
    const welded = skeletonOf(run('generator.leaf', { ...BASE, leafWeld: true }, { skeleton: trunk(radius) }));
    expect(welded.branches.length).toBe(8);
    for (const b of welded.branches) {
      const x = welded.position[b.start * 3] as number;
      const y = welded.position[b.start * 3 + 1] as number;
      expect(Math.abs(Math.hypot(x, y) - radius)).toBeLessThan(1e-5);
    }
    const spine = skeletonOf(run('generator.leaf', { ...BASE }, { skeleton: trunk(radius) }));
    for (const b of spine.branches) expect(Math.hypot(spine.position[b.start * 3] as number, spine.position[b.start * 3 + 1] as number)).toBeLessThan(1e-5);
  });

  it('failed welds are kept on the spine or dropped', () => {
    const thin = { skeleton: trunk(0.0005) };
    const kept = skeletonOf(run('generator.leaf', { ...BASE, leafWeld: true, leafKeepFailedWelds: true }, thin));
    expect(kept.branches.length).toBe(8);
    for (const b of kept.branches) expect(Math.hypot(kept.position[b.start * 3] as number, kept.position[b.start * 3 + 1] as number)).toBeLessThan(1e-5);
    const dropped = run('generator.leaf', { ...BASE, leafWeld: true, leafKeepFailedWelds: false }, thin);
    expect(skeletonOf(dropped).branches.length).toBe(0);
    expect(mesh(dropped).indices.length).toBe(0);
  });

  it('Sky influence 1 lifts every leaf face toward the sky', () => {
    const m = mesh(run('generator.leaf', { ...BASE, orientSky: 1 }));
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.abs(m.normals[i + 2] as number)).toBeGreaterThan(0.999);
  });

  it('Fix winding makes every triangle agree with its normals after Flip', () => {
    const disagreeing = (m: MeshData): number => {
      let bad = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t] as number, m.indices[t + 1] as number, m.indices[t + 2] as number];
        const P = (i: number): V3 => [m.positions[i * 3] as number, m.positions[i * 3 + 1] as number, m.positions[i * 3 + 2] as number];
        const g = cross(sub(P(b), P(a)), sub(P(c), P(a)));
        const N = (i: number): number => dot(g, [m.normals[i * 3] as number, m.normals[i * 3 + 1] as number, m.normals[i * 3 + 2] as number]);
        if (N(a) + N(b) + N(c) < 0) bad += 1;
      }
      return bad;
    };
    const over = { ...BASE, number: 16, leafFlip: true };
    expect(disagreeing(mesh(run('generator.leaf', { ...over, leafFixWinding: false })))).toBeGreaterThan(0);
    expect(disagreeing(mesh(run('generator.leaf', { ...over, leafFixWinding: true })))).toBe(0);
  });

  it('Classic orientation mirrors the left side of Interval placement', () => {
    const over = { ...BASE, number: 6, mode: 'interval', intervalStep: 0.5, leafBend: 0 };
    const sync = Array.from(mesh(run('generator.leaf', { ...over })).positions);
    const classic = Array.from(mesh(run('generator.leaf', { ...over, leafInitialOrientation: 'classic' })).positions);
    expect(classic).not.toEqual(sync);
  });

  it('Branch publishes the alternating side of Interval placement as a skeleton attribute', () => {
    const out = run('generator.branch', { mode: 'interval', intervalStep: 0.5, first: 0.1, last: 0.9 });
    const side = skeletonOf(out).attributes.get('side');
    expect(side).toBeDefined();
    const values = new Set(Array.from(side as Float32Array));
    expect(values.has(1)).toBe(true);
    expect(values.has(-1)).toBe(true);
    const absolute = skeletonOf(run('generator.branch', { mode: 'absolute' })).attributes.get('side');
    expect(absolute).toBeUndefined();
  });

  it('Unification reads the lineage published by upstream generators', () => {
    const parentOut = run('generator.branch', { number: 2, first: 0.4, last: 0.6 });
    const sk = skeletonOf(parentOut);
    const lineage = (parentOut.children?.value as StructureData).lineage as Lineage;
    expect(lineage.offset.length).toBe(sk.branches.length + 1);
    const out = run('generator.leaf', { ...BASE, number: 2, orientUnification: 'global' }, { skeleton: sk, lineage });
    const m = mesh(out);
    expect(m.indices.length).toBeGreaterThan(0);
    const without = mesh(run('generator.leaf', { ...BASE, number: 2 }, { skeleton: sk, lineage }));
    expect(Array.from(m.positions)).not.toEqual(Array.from(without.positions));
  });

  it('is deterministic for the same seed and differs for another', () => {
    const over = { ...BASE, leafFlip: true, leafCross: true, leafWeld: true, orientSky: 0.4, orientFold: 20, finalOut: 15 };
    const a = Array.from(mesh(run('generator.leaf', over, { skeleton: trunk() }, 5)).positions);
    const b = Array.from(mesh(run('generator.leaf', over, { skeleton: trunk() }, 5)).positions);
    const c = Array.from(mesh(run('generator.leaf', over, { skeleton: trunk() }, 6)).positions);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
