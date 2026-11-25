import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForceDef } from '@/contracts/material';
import { defaultParams, type NodeParams, type ParamScalar } from '@/contracts/params';
import { SkeletonBuilder, type Skeleton } from '@/contracts/skeleton';
import { Rng } from '@/core/rng';
import { applyForces, buildGeometryQuery, closestBrute, findForceSourceCycle, TriangleBvh } from '@/forces';
import { setMeshAssetLookup } from '@/geometry/meshAssets';
import { KNOCKOUT_FORCE_TYPE, knockedOutByForce, passesForceContainers, readForceVolume, readKnockoutForces } from '@/generators/common';
import { keepsAtPosition, type GenerationEnv } from '@/nodes/generators/generationEnv';
import { geometryQueryForParams } from '@/forces/geometry/query';
import { nodeDefs } from '@/nodes/forces';

type Patch = Record<string, ParamScalar | number[]>;

function force(nodeType: string, patch: Patch = {}): ForceDef {
  const def = nodeDefs.find((n) => n.type === nodeType);
  if (!def) throw new Error(nodeType);
  const params: NodeParams = defaultParams(def.params);
  for (const [k, v] of Object.entries(patch)) params[k] = { ...(params[k] ?? { value: 0 }), value: v } as NodeParams[string];
  const type = nodeType.replace('force.', '').replace('noise', 'turbulence');
  return { id: nodeType, name: nodeType, type, enabled: true, params };
}

/** Polyline branch from a point list. */
function chain(points: [number, number, number][], radius = 0.02): Skeleton {
  const b = new SkeletonBuilder();
  b.beginBranch(-1, -1, 0);
  points.forEach((p, i) => b.addPoint(p[0], p[1], p[2], radius * (1 - 0.6 * (i / Math.max(1, points.length - 1)))));
  b.endBranch();
  return b.build();
}

const line = (a: [number, number, number], b: [number, number, number], n = 16): [number, number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  });

const pt = (sk: Skeleton, i: number): [number, number, number] => [sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number];
const lastOf = (sk: Skeleton): [number, number, number] => {
  const b = sk.branches[0]!;
  return pt(sk, b.start + b.count - 1);
};
const run = (sk: Skeleton, forces: ForceDef[], align?: number): Skeleton => {
  applyForces(sk, forces, { rng: new Rng(7), ...(align !== undefined ? { align } : {}) });
  return sk;
};

const CUBE_OBJ = [
  'v -0.5 -0.5 0', 'v 0.5 -0.5 0', 'v 0.5 0.5 0', 'v -0.5 0.5 0',
  'v -0.5 -0.5 1', 'v 0.5 -0.5 1', 'v 0.5 0.5 1', 'v -0.5 0.5 1',
  'f 1 3 2', 'f 1 4 3', 'f 5 6 7', 'f 5 7 8', 'f 1 2 6', 'f 1 6 5', 'f 2 3 7', 'f 2 7 6', 'f 3 4 8', 'f 3 8 7', 'f 4 1 5', 'f 4 5 8',
].join('\n');

beforeAll(() => {
  setMeshAssetLookup((id) => (id === 'cube' ? { id, name: 'cube.obj', kind: 'mesh', mime: 'text/plain', data: CUBE_OBJ } : undefined));
});
afterAll(() => setMeshAssetLookup(() => undefined));

/** Box of size 2 at x in [1, 3], y in [-1, 1], z in [0, 2]. */
const boxForce = (patch: Patch = {}): ForceDef => force('force.geometry', { geometryAsset: 'cube', geometryPosition: [2, 0, 0], geometryScale: 2, ...patch } as Patch);

describe('new force types', () => {
  it.each(['force.gnarl', 'force.twist'])('%s bends a straight spine and is deterministic', (type) => {
    const make = (): Skeleton => run(chain(line([0, 0, 0], [0, 0, 3])), [force(type, { strength: 3 })]);
    const a = make();
    const tip = lastOf(a);
    expect(Math.hypot(tip[0], tip[1])).toBeGreaterThan(0.02);
    expect([...make().position]).toEqual([...a.position]);
  });

  it('gnarl responds to its axis', () => {
    const x = lastOf(run(chain(line([0, 0, 0], [0, 0, 3])), [force('force.gnarl', { strength: 3, axis: [1, 0, 0] })]));
    const z = lastOf(run(chain(line([0, 0, 0], [0, 0, 3])), [force('force.gnarl', { strength: 3, axis: [0, 0, 1] })]));
    expect(Math.hypot(x[0] - z[0], x[1] - z[1], x[2] - z[2])).toBeGreaterThan(1e-3);
  });

  it('planar keeps points close to the plane', () => {
    const pts = line([0, 0, 0], [1.5, 0.9, 2.5]);
    const before = Math.max(...pts.map((p) => Math.abs(p[1])));
    const sk = run(chain(pts), [force('force.planar', { strength: 6, normal: [0, 1, 0], planeSoftness: 0.1 })]);
    let after = 0;
    for (let i = 0; i < sk.count; i++) after = Math.max(after, Math.abs(pt(sk, i)[1]));
    expect(after).toBeLessThan(before * 0.6);
    const off = run(chain(pts), [force('force.planar', { strength: 6, normal: [0, 1, 0], planeSoftness: 0.1, active: false })]);
    expect(Math.abs(lastOf(off)[1])).toBeCloseTo(0.9, 3);
  });

  it('return reduces the deviation from the original path', () => {
    const pts = line([0, 0, 0], [3, 0, 0]);
    const dev = (sk: Skeleton): number => Math.abs(lastOf(sk)[2]);
    const droop = dev(run(chain(pts), [force('force.gravity', { strength: 1 })]));
    const held = dev(run(chain(pts), [force('force.gravity', { strength: 1 }), force('force.return', { strength: 12 })]));
    expect(droop).toBeGreaterThan(0.05);
    expect(held).toBeLessThan(droop * 0.8);
  });

  it('knockout never bends geometry and removes only nodes growing in the arrow direction', () => {
    const sk = chain(line([0, 0, 0], [0, 0, 3]));
    const copy = [...sk.position];
    run(sk, [force('force.knockout', { strength: 1 })]);
    expect([...sk.position]).toEqual(copy);

    const specs = readKnockoutForces([force('force.knockout', { strength: 0.5, direction: [0, 0, -1] })]);
    expect(specs).toHaveLength(1);
    expect(knockedOutByForce(specs, [0, 0, -1])).toBe(true);
    expect(knockedOutByForce(specs, [0.5, 0, -0.866])).toBe(true);
    expect(knockedOutByForce(specs, [1, 0, 0])).toBe(false);
    expect(knockedOutByForce(specs, [0, 0, 1])).toBe(false);
    expect(knockedOutByForce(readKnockoutForces([force('force.knockout', { strength: 0 })]), [0, 0, -1])).toBe(false);
    expect(knockedOutByForce(readKnockoutForces([force('force.knockout', { strength: 1 })]), [0, 0, 1])).toBe(true);

    const env: GenerationEnv = { volumes: [], containers: { include: [], exclude: [] }, masks: [], zRange: [0, 1], parentType: undefined, knockouts: specs };
    expect(keepsAtPosition(env, [0, 0, 0], [0, 0, -1])).toBe(false);
    expect(keepsAtPosition(env, [0, 0, 0], [0, 0, 1])).toBe(true);
    expect(KNOCKOUT_FORCE_TYPE).toBe('knockout');
  });

  it('Include / Exclude containers work with every new force type', () => {
    for (const type of ['force.gnarl', 'force.twist', 'force.planar', 'force.return', 'force.knockout', 'force.geometry']) {
      const f = force(type, { volumeShape: 'sphere', volumeRadius: 1, volumeCenter: [0, 0, 0] });
      const v = readForceVolume(f.name, f.params);
      expect(v, type).not.toBeNull();
      const vols = v ? [v] : [];
      expect(passesForceContainers([0, 0, 0], { include: [], exclude: [f.name] }, vols)).toBe(false);
      expect(passesForceContainers([5, 0, 0], { include: [f.name], exclude: [] }, vols)).toBe(false);
      expect(passesForceContainers([0.2, 0, 0], { include: [f.name], exclude: [] }, vols)).toBe(true);
    }
  });
});

describe('common force properties', () => {
  it('defaults reproduce the previous behaviour (old projects unchanged)', () => {
    const pts = line([0, 0, 0], [0, 0, 3]);
    const plain = run(chain(pts), [force('force.phototropism', { strength: 2, sensitivity: 1 })]);
    const explicit = run(chain(pts), [force('force.phototropism', { strength: 2, sensitivity: 1, alignStrength: 1, attenuationEnabled: false })], 1);
    expect([...explicit.position]).toEqual([...plain.position]);
    const legacy = force('force.phototropism', { strength: 2, sensitivity: 1 });
    delete legacy.params.alignStrength;
    delete legacy.params.attenuationEnabled;
    expect([...run(chain(pts), [legacy]).position]).toEqual([...plain.position]);
  });

  it('align strength scales the influence on the initial orientation', () => {
    const first = (align: number, gen = 1): number => {
      const sk = run(chain(line([0, 0, 0], [0, 0, 3])), [force('force.phototropism', { strength: 2, sensitivity: 1, alignStrength: align })], gen);
      const p0 = pt(sk, 0);
      const p1 = pt(sk, 1);
      return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    };
    expect(first(0)).toBeCloseTo(0, 6);
    expect(first(1)).toBeGreaterThan(first(0.4));
    expect(first(0.4)).toBeGreaterThan(0);
    expect(first(1, 0)).toBeCloseTo(0, 6);
  });

  it('attenuation limits the effect to its radius', () => {
    const tipX = (patch: Patch): number => lastOf(run(chain(line([0, 0, 0], [0, 0, 3])), [force('force.phototropism', { strength: 2, sensitivity: 1, ...patch })]))[0];
    const free = tipX({});
    const far = tipX({ attenuationEnabled: true, attenuationCenter: [50, 0, 0], attenuationRadius: 1 });
    const soft = tipX({ attenuationEnabled: true, attenuationCenter: [0, 0, 1.5], attenuationRadius: 4 });
    expect(far).toBeCloseTo(0, 6);
    expect(soft).toBeGreaterThan(0);
    expect(soft).toBeLessThan(free);
  });
});

describe('triangle BVH', () => {
  it('closest point equals brute force on random meshes', () => {
    const rng = new Rng(11);
    for (let m = 0; m < 3; m++) {
      const verts: number[] = [];
      const idx: number[] = [];
      const tris = 60 + m * 90;
      for (let t = 0; t < tris; t++) {
        const cx = rng.next() * 10 - 5;
        const cy = rng.next() * 10 - 5;
        const cz = rng.next() * 10 - 5;
        for (let k = 0; k < 3; k++) {
          idx.push(verts.length / 3);
          verts.push(cx + rng.next() - 0.5, cy + rng.next() - 0.5, cz + rng.next() - 0.5);
        }
      }
      const bvh = new TriangleBvh(verts, idx);
      const hit = { dist2: 0, x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0 };
      for (let q = 0; q < 150; q++) {
        const x = rng.next() * 14 - 7;
        const y = rng.next() * 14 - 7;
        const z = rng.next() * 14 - 7;
        const ref = closestBrute(verts, idx, x, y, z);
        expect(bvh.closest(x, y, z, hit)).toBe(true);
        expect(hit.dist2).toBeCloseTo(ref.dist2, 5);
      }
    }
  });

  it('inside test and ray hits on a cube', () => {
    const q = geometryQueryForParams(boxForce().params);
    expect(q).not.toBeNull();
    const query = q!;
    expect(query.inside(2, 0, 1)).toBe(true);
    expect(query.inside(0, 0, 1)).toBe(false);
    expect(query.inside(2, 0, 3)).toBe(false);
    expect(query.segmentHit([0, 0, 1], [2, 0, 1])).toBeCloseTo(0.5, 5);
    expect(query.segmentHit([0, 0, 1], [0.5, 0, 1])).toBe(-1);
    const n: [number, number, number] = [0, 0, 0];
    expect(query.signed(0, 0, 1, n)).toBeCloseTo(1, 5);
    expect(n[0]).toBeCloseTo(-1, 5);
    expect(query.signed(2, 0, 1, n)).toBeCloseTo(-1, 5);
    const standalone = buildGeometryQuery([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    expect(standalone.triangleCount).toBe(1);
  });
});

describe('geometry force', () => {
  const minSigned = (sk: Skeleton): number => {
    const q = geometryQueryForParams(boxForce().params)!;
    const n: [number, number, number] = [0, 0, 0];
    let min = Infinity;
    for (let i = 0; i < sk.count; i++) {
      const p = pt(sk, i);
      min = Math.min(min, q.signed(p[0], p[1], p[2], n));
    }
    return min;
  };
  const towardsBox = (): Skeleton => chain(line([-1, 0.2, 1], [4, 0.2, 2.2], 24));

  it('Avoid steers away from the mesh, Attract towards it, deterministic', () => {
    const vertical = (): Skeleton => chain(line([0, 0, 0], [0, 0, 3]));
    const avoid = lastOf(run(vertical(), [boxForce({ strength: 2, geometryForce: 'avoid', geometryRange: 3 })]));
    const attract = lastOf(run(vertical(), [boxForce({ strength: 2, geometryForce: 'attract', geometryRange: 3 })]));
    const none = lastOf(run(vertical(), [boxForce({ strength: 2, geometryForce: 'none', geometryRange: 3 })]));
    expect(avoid[0]).toBeLessThan(-0.01);
    expect(attract[0]).toBeGreaterThan(0.01);
    expect(none[0]).toBeCloseTo(0, 6);
    const negative = lastOf(run(vertical(), [boxForce({ strength: -2, geometryForce: 'attract', geometryRange: 3 })]));
    expect(negative[0]).toBeLessThan(-0.01);
    expect([...run(vertical(), [boxForce({ strength: 2, geometryRange: 3 })]).position]).toEqual([...run(vertical(), [boxForce({ strength: 2, geometryRange: 3 })]).position]);
  });

  it('Avoid keeps a skimming branch out of a box mesh', () => {
    const skim = (): Skeleton => chain(line([-1, 0, 0.3], [4, 0, 0.9], 30));
    const without = minSigned(run(skim(), []));
    const withAvoid = minSigned(run(skim(), [boxForce({ strength: 8, geometryForce: 'avoid', geometryRange: 2.5 })]));
    expect(without).toBeLessThan(0);
    expect(withAvoid).toBeGreaterThan(without);
    expect(withAvoid).toBeGreaterThanOrEqual(-1e-6);
  });

  it('Obstruct leaves no point inside the mesh and keeps the root', () => {
    const sk = run(towardsBox(), [boxForce({ strength: 0, geometryForce: 'none', geometryCollide: 'obstruct', geometrySkin: 0.02 })]);
    expect(minSigned(sk)).toBeGreaterThanOrEqual(0.02 - 1e-6);
    expect(pt(sk, 0)).toEqual([-1, expect.closeTo(0.2, 5), 1].map((v) => v) as [number, number, number]);
    for (const v of sk.position) expect(Number.isFinite(v)).toBe(true);
  });

  it('Prune cuts before the first intersection, Stop ends on the surface', () => {
    const base = towardsBox();
    const n = base.branches[0]!.count;
    const pruned = run(towardsBox(), [boxForce({ strength: 0, geometryForce: 'none', geometryCollide: 'prune' })]);
    const pb = pruned.branches[0]!;
    expect(pb.count).toBeLessThan(n);
    expect(pb.count).toBeGreaterThan(1);
    expect(minSigned({ ...pruned, count: pb.count })).toBeGreaterThan(0);
    const stopped = run(towardsBox(), [boxForce({ strength: 0, geometryForce: 'none', geometryCollide: 'stop' })]);
    const sb = stopped.branches[0]!;
    expect(sb.count).toBe(pb.count + 1);
    const q = geometryQueryForParams(boxForce().params)!;
    const end = pt(stopped, sb.start + sb.count - 1);
    expect(Math.abs(q.signed(end[0], end[1], end[2], [0, 0, 0]))).toBeLessThan(1e-3);
  });

  it('Prune removes the children of the cut part', () => {
    const b = new SkeletonBuilder();
    b.beginBranch(-1, -1, 0);
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(b.addPoint(-1 + i * 0.5, 0, 1, 0.02));
    b.endBranch();
    b.beginBranch(0, ids[1]!, 1);
    for (let i = 0; i < 4; i++) b.addPoint(-0.5, 0.3 * i, 1, 0.01);
    b.endBranch();
    b.beginBranch(0, ids[10]!, 1);
    for (let i = 0; i < 4; i++) b.addPoint(4, 0.3 * i, 1, 0.01);
    b.endBranch();
    const sk = b.build();
    run(sk, [boxForce({ strength: 0, geometryForce: 'none', geometryCollide: 'prune' })]);
    expect(sk.branches[0]!.count).toBeLessThan(12);
    expect(sk.branches[1]!.count).toBe(4);
    expect(sk.branches[2]!.count).toBe(0);
  });

  it('without a readable asset the force does nothing', () => {
    const sk = chain(line([0, 0, 0], [0, 0, 3]));
    const copy = [...sk.position];
    run(sk, [force('force.geometry', { strength: 3, geometryCollide: 'prune' })]);
    expect([...sk.position]).toEqual(copy);
  });
});

describe('force source cycle guard', () => {
  it('reports a generator that is its own (indirect) geometry source', () => {
    expect(findForceSourceCycle(new Map([['a', ['b']], ['b', ['c']], ['c', []]]))).toBeNull();
    expect(findForceSourceCycle(new Map([['a', ['a']]]))).toEqual(['a', 'a']);
    expect(findForceSourceCycle(new Map([['a', ['b']], ['b', ['c']], ['c', ['a']]]))).toEqual(['a', 'b', 'c', 'a']);
  });
});
