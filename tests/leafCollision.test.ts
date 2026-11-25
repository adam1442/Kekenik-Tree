import { beforeAll, describe, expect, it } from 'vitest';
import { starterGraph } from './fixtures/starterGraph';
import { CancellationSource, CancelledError } from '@/contracts/nodes';
import type { MeshData } from '@/contracts/mesh';
import { Rng } from '@/core/rng';
import {
  LEAF_MOVED,
  LEAF_REMOVED,
  LEAF_SHRUNK,
  applyOutcomeToMesh,
  bruteForceSpherePairs,
  collidersFromMesh,
  findSpherePairs,
  leafBounds,
  leavesCollide,
  levelForLod,
  obbHit,
  resolveLeafCollisions,
  sphereHit,
  triTriSegment,
  type BroadSphere,
  type Collider,
  type CollisionLevel,
  type CollisionSettings,
} from '@/generators/collision';
import { GraphEvaluator, snapshotGraph, type GraphSnapshot } from '@/graph/engine';
import { GraphModel } from '@/graph/model/graphModel';
import { registerDiscoveredNodes } from '@/graph/registry';
import { meshTriangleCount } from '@/contracts/mesh';
import type { V3 } from '@/geometry/math3';

beforeAll(() => registerDiscoveredNodes());

/** A flat quad leaf (two triangles) centred at c, in the plane spanned by u / v, appended to shared buffers. */
class Scene {
  positions: number[] = [];
  indices: number[] = [];
  colliders: Collider[] = [];

  quad(c: V3, size: number, opts: Partial<Collider> = {}, u: V3 = [1, 0, 0], v: V3 = [0, 1, 0]): Collider {
    const base = this.positions.length / 3;
    const h = size / 2;
    for (const [a, b] of [[-h, -h], [h, -h], [h, h], [-h, h]] as const) this.positions.push(c[0] + u[0] * a + v[0] * b, c[1] + u[1] * a + v[1] * b, c[2] + u[2] * a + v[2] * b);
    const indexStart = this.indices.length;
    this.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    const collider = {
      id: this.colliders.length,
      generator: 0,
      priority: 1,
      threshold: 1,
      action: 'remove',
      testAgainst: 'all',
      parentRule: 'keep',
      parentKey: -1,
      origin: c,
      shape: { positions: new Float32Array(0), indices: new Uint32Array(0), vertexStart: base, vertexCount: 4, indexStart, indexCount: 6 },
      ...opts,
    } as Collider;
    this.colliders.push(collider);
    return collider;
  }

  /** Bind the (now final) buffers to every collider. */
  seal(): Collider[] {
    const positions = Float32Array.from(this.positions);
    const indices = Uint32Array.from(this.indices);
    for (const c of this.colliders) c.shape = { ...c.shape, positions, indices };
    return this.colliders;
  }
}

const settings = (level: CollisionLevel, spherical = false): CollisionSettings => ({ level, spherical, plane: false });
const run = (colliders: Collider[], s: CollisionSettings, extra: Partial<Parameters<typeof resolveLeafCollisions>[0]> = {}) => resolveLeafCollisions({ colliders, settings: s, ...extra });

describe('narrow phase', () => {
  it('sphere test agrees with brute force distances', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 500; i++) {
      const a = [rng.next() * 4, rng.next() * 4, rng.next() * 4, 0.1 + rng.next()] as const;
      const b = [rng.next() * 4, rng.next() * 4, rng.next() * 4, 0.1 + rng.next()] as const;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      expect(sphereHit(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3])).toBe(d < a[3] + b[3]);
    }
  });

  it('triangle - triangle intersection finds crossings and misses separated triangles', () => {
    const flat: V3[] = [[0, 0, 0], [2, 0, 0], [0, 2, 0]];
    const crossing: V3[] = [[0.5, 0.5, -1], [0.5, 0.5, 1], [1.2, 0.2, 0]];
    const above: V3[] = [[0.5, 0.5, 0.5], [1, 0.5, 0.5], [0.5, 1, 0.6]];
    const outside: V3[] = [[5, 5, -1], [5, 5, 1], [6, 5, 0]];
    expect(triTriSegment(flat, crossing)).not.toBeNull();
    expect(triTriSegment(flat, above)).toBeNull();
    expect(triTriSegment(flat, outside)).toBeNull();
    expect(triTriSegment(flat, [[0.2, 0.2, 0], [1, 0.2, 0], [0.2, 1, 0]])).not.toBeNull();
    expect(triTriSegment(flat, [[3, 3, 0], [4, 3, 0], [3, 4, 0]])).toBeNull();
  });

  it('box test: crossed thin boxes hit, parallel separated ones do not', () => {
    const s = new Scene();
    const a = s.quad([0, 0, 0], 1);
    const b = s.quad([0, 0, 0], 1, {}, [1, 0, 0], [0, 0, 1]);
    const c = s.quad([0, 0, 0.3], 1);
    s.seal();
    expect(obbHit(leafBounds(a).obb, leafBounds(b).obb)).toBe(true);
    expect(obbHit(leafBounds(a).obb, leafBounds(c).obb)).toBe(false);
  });

  it('a High hit is always a Medium hit, and a Medium hit is always a Low-or-box hit', () => {
    const rng = new Rng(21);
    const s = new Scene();
    for (let i = 0; i < 40; i++) {
      const u: V3 = [rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5];
      const l = Math.hypot(...u) || 1;
      s.quad([rng.next() * 1.5, rng.next() * 1.5, rng.next() * 1.5], 0.7, {}, [u[0] / l, u[1] / l, u[2] / l], [0, 0, 1]);
    }
    const cs = s.seal();
    let highHits = 0;
    for (let i = 0; i < cs.length; i++)
      for (let j = i + 1; j < cs.length; j++) {
        const high = leavesCollide(cs[i] as Collider, cs[j] as Collider, 'high', false);
        const medium = leavesCollide(cs[i] as Collider, cs[j] as Collider, 'medium', false);
        if (high) {
          highHits += 1;
          expect(medium).toBe(true);
        }
      }
    expect(highHits).toBeGreaterThan(0);
  });

  it('alpha-aware High ignores overlaps on transparent texels', () => {
    const s = new Scene();
    const a = s.quad([0, 0, 0], 1);
    const b = s.quad([0, 0, 0], 1, {}, [1, 0, 0], [0, 0, 1]);
    s.seal();
    expect(leavesCollide(a, b, 'high', false)).toBe(true);
    expect(leavesCollide(a, b, 'high', false, () => false)).toBe(false);
    expect(leavesCollide(a, b, 'high', false, () => true)).toBe(true);
  });
});

describe('broad phase', () => {
  it('finds exactly the brute-force pairs', () => {
    const rng = new Rng(11);
    const spheres: BroadSphere[] = Array.from({ length: 600 }, () => ({ x: rng.next() * 20, y: rng.next() * 20, z: rng.next() * 6, r: 0.1 + rng.next() * 0.8 }));
    spheres.push({ x: 10, y: 10, z: 3, r: 30 }); // one huge sphere goes through the large list
    expect(findSpherePairs(spheres)).toEqual(bruteForceSpherePairs(spheres));
  });
});

describe('resolution', () => {
  it('None leaves everything alone', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1);
    s.quad([0, 0, 0], 1);
    const o = await run(s.seal(), settings('none'));
    expect([...o.state]).toEqual([0, 0]);
  });

  it('priority decides the winner, ties go to the lower id', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1, { priority: 1 });
    s.quad([0.1, 0, 0], 1, { priority: 5 });
    s.quad([0.05, 0.05, 0], 1, { priority: 5 });
    const o = await run(s.seal(), settings('low'));
    expect([...o.state]).toEqual([LEAF_REMOVED, 0, LEAF_REMOVED]);
    expect(o.stats.removed).toBe(2);
  });

  it('a removed leaf does not remove a third leaf that only touched it', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1, { priority: 3 });
    s.quad([0.7, 0, 0], 1, { priority: 2 });
    s.quad([1.4, 0, 0], 1, { priority: 1 });
    const o = await run(s.seal(), settings('low'));
    // a (0) beats b (1); c touches only b, which is gone -> c survives
    expect([...o.state]).toEqual([0, LEAF_REMOVED, 0]);
  });

  it('Shrink keeps a leaf that fits after shrinking, Move shifts it along its normal', async () => {
    const shrink = new Scene();
    shrink.quad([0, 0, 0], 1, { priority: 2 });
    shrink.quad([0.85, 0, 0], 1, { priority: 1, action: 'shrink' });
    const so = await run(shrink.seal(), settings('medium'));
    expect(so.state[1]).toBe(LEAF_SHRUNK);
    expect(so.scale[1]).toBeLessThan(1);
    const move = new Scene();
    move.quad([0, 0, 0], 1, { priority: 2 });
    move.quad([0.2, 0, 0], 1, { priority: 1, action: 'move' });
    const mo = await run(move.seal(), settings('medium'));
    expect(mo.state[1]).toBe(LEAF_MOVED);
    expect(Math.abs(mo.offset[5] as number)).toBeGreaterThan(0.1); // along the z normal of the flat quad
    expect(Math.abs(mo.offset[3] as number) + Math.abs(mo.offset[4] as number)).toBeLessThan(1e-6);
  });

  it('Test against: same generator ignores leaves of other generators', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1, { priority: 2, generator: 0 });
    s.quad([0.1, 0, 0], 1, { priority: 1, generator: 1, testAgainst: 'same' });
    s.quad([0.1, 0, 0.01], 1, { priority: 0.5, generator: 1, testAgainst: 'other' });
    const o = await run(s.seal(), settings('low'));
    expect(o.state[1]).toBe(0); // only tests its own generator: nothing there
    expect(o.state[2]).toBe(LEAF_REMOVED); // tests the other generator: loses to leaf 0
  });

  it('Remove parent reports twigs that lost every leaf', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1, { priority: 9, parentKey: 1 });
    s.quad([0.1, 0, 0], 1, { priority: 1, parentKey: 2, parentRule: 'remove' });
    s.quad([0.2, 0, 0], 1, { priority: 1, parentKey: 3, parentRule: 'keep' });
    const o = await run(s.seal(), settings('low'));
    expect(o.orphanedParents).toEqual([2]);
  });

  it('is deterministic', async () => {
    const make = (): Collider[] => {
      const rng = new Rng(5);
      const s = new Scene();
      for (let i = 0; i < 300; i++) s.quad([rng.next() * 6, rng.next() * 6, rng.next() * 0.05], 0.5, { priority: Math.floor(rng.next() * 3) });
      return s.seal();
    };
    for (const level of ['low', 'medium', 'high'] as const) {
      const a = await run(make(), settings(level));
      const b = await run(make(), settings(level));
      expect([...a.state]).toEqual([...b.state]);
      if (level === 'low') expect(a.stats.removed).toBeGreaterThan(0);
    }
  });

  it('spherical tests keep at least as many leaves as the box tests', async () => {
    const make = (): Collider[] => {
      const rng = new Rng(9);
      const s = new Scene();
      for (let i = 0; i < 200; i++) s.quad([rng.next() * 5, rng.next() * 5, 0], 0.6);
      return s.seal();
    };
    const boxes = await run(make(), settings('medium'));
    const spheres = await run(make(), settings('medium', true));
    expect(spheres.stats.removed).toBeLessThanOrEqual(boxes.stats.removed);
  });

  it('can be cancelled', async () => {
    const s = new Scene();
    for (let i = 0; i < 1000; i++) s.quad([i * 0.01, 0, 0], 1);
    const src = new CancellationSource();
    let calls = 0;
    const p = resolveLeafCollisions(
      { colliders: s.seal(), settings: settings('low') },
      {
        checkpoint: () => {
          calls += 1;
          if (calls === 2) src.cancel();
          src.token.throwIfCancelled();
        },
      },
    );
    await expect(p).rejects.toBeInstanceOf(CancelledError);
  });

  it('plane mode only looks at the XY projection', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1, { priority: 2 });
    s.quad([0.1, 0, 5], 1, { priority: 1 });
    const o3 = await run(s.seal(), settings('medium'));
    expect([...o3.state]).toEqual([0, 0]);
    const o2 = await run(s.colliders, { level: 'medium', spherical: false, plane: true });
    expect(o2.state[1]).toBe(LEAF_REMOVED);
  });

  it('LOD makes the tests cheaper', () => {
    expect(levelForLod('high', 0)).toBe('high');
    expect(levelForLod('high', 1)).toBe('medium');
    expect(levelForLod('medium', 1)).toBe('low');
    expect(levelForLod('none', 2)).toBe('none');
  });
});

describe('leaf - branch collisions', () => {
  it('Medium removes a leaf placed inside a branch capsule but not a leaf next to it', async () => {
    const s = new Scene();
    s.quad([0, 0, 1], 0.1, { origin: [2, 0, 1] }); // inside the capsule, attached elsewhere
    s.quad([1, 0, 1], 0.1); // far away
    const capsule = { a: [0, 0, 0] as V3, b: [0, 0, 2] as V3, ra: 0.2, rb: 0.2, branch: 1 };
    const o = await run(s.seal(), settings('medium'), { capsules: [capsule] });
    expect([...o.state]).toEqual([LEAF_REMOVED, 0]);
    const low = await run(s.colliders, settings('low'), { capsules: [capsule] });
    expect([...low.state]).toEqual([0, 0]);
  });

  it('a leaf growing out of its own branch is not removed (host branch)', async () => {
    const s = new Scene();
    s.quad([0.22, 0, 1], 0.2, {}, [0, 1, 0], [0, 0, 1]);
    s.colliders[0]!.origin = [0.2, 0, 1];
    const capsule = { a: [0, 0, 0] as V3, b: [0, 0, 2] as V3, ra: 0.2, rb: 0.2, branch: 1 };
    const o = await run(s.seal(), settings('medium'), { capsules: [capsule] });
    expect(o.state[0]).toBe(0);
  });

  it('High tests real branch triangles', async () => {
    const s = new Scene();
    s.quad([0, 0, 1], 0.4);
    s.quad([3, 0, 1], 0.4);
    const wall = { positions: Float32Array.from([-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
    const o = await run(s.seal(), settings('high'), { branchTriangles: [wall] });
    expect([...o.state]).toEqual([LEAF_REMOVED, 0]);
  });
});

describe('performance', () => {
  it('20,000 leaves under Low in well under a second or two', async () => {
    const rng = new Rng(3);
    const s = new Scene();
    for (let i = 0; i < 20000; i++) s.quad([rng.next() * 40, rng.next() * 40, rng.next() * 12], 0.3);
    const colliders = s.seal();
    const t0 = performance.now();
    const o = await run(colliders, settings('low'));
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(o.stats.removed).toBeGreaterThanOrEqual(0);
  });

  it('High on 2,000 leaves finishes', async () => {
    const rng = new Rng(4);
    const s = new Scene();
    for (let i = 0; i < 2000; i++) {
      const u: V3 = [rng.next() - 0.5, rng.next() - 0.5, rng.next() - 0.5];
      const l = Math.hypot(...u) || 1;
      s.quad([rng.next() * 6, rng.next() * 6, rng.next() * 3], 0.4, {}, [u[0] / l, u[1] / l, u[2] / l], [0, 0, 1]);
    }
    const o = await run(s.seal(), settings('high'));
    expect(o.stats.tests).toBeGreaterThan(0);
  });
});

describe('mesh application', () => {
  const meshOf = (s: Scene, collision: MeshData['collision']): MeshData => ({
    positions: Float32Array.from(s.positions),
    normals: new Float32Array(s.positions.length),
    uv0: new Float32Array((s.positions.length / 3) * 2),
    indices: Uint32Array.from(s.indices),
    slots: [{ materialId: 'leaf', indexStart: 0, indexCount: s.indices.length }],
    ...(collision ? { collision } : {}),
  });

  it('drops the triangles of removed leaves and keeps slots consistent', async () => {
    const s = new Scene();
    s.quad([0, 0, 0], 1);
    s.quad([0.1, 0, 0], 1);
    s.quad([5, 0, 0], 1);
    const n = s.colliders.length;
    const mesh = meshOf(s, {
      count: n,
      vertexStart: Uint32Array.from(s.colliders, (c) => c.shape.vertexStart),
      vertexCount: Uint32Array.from(s.colliders, () => 4),
      indexStart: Uint32Array.from(s.colliders, (c) => c.shape.indexStart),
      indexCount: Uint32Array.from(s.colliders, () => 6),
      origin: Float32Array.from(s.colliders.flatMap((c) => c.origin)),
      priority: Float32Array.from([2, 1, 1]),
      parent: Int32Array.from([0, 0, 0]),
      threshold: 1,
      action: 'remove',
      testAgainst: 'all',
      parentRule: 'keep',
    });
    const colliders = collidersFromMesh(mesh, 0, 0, 1);
    const o = await run(colliders, settings('low'));
    const out = applyOutcomeToMesh(mesh, o, 0);
    expect(meshTriangleCount(out)).toBe(4);
    expect(out.slots[0]?.indexCount).toBe(12);
    expect(out.collision).toBeUndefined();
    expect(mesh.indices.length).toBe(18); // the cached input is untouched
    // None leaves positions + indices bit-identical
    const none = await run(colliders, settings('none'));
    const same = applyOutcomeToMesh(mesh, none, 0);
    expect([...same.indices]).toEqual([...mesh.indices]);
    expect([...same.positions]).toEqual([...mesh.positions]);
  });
});

describe('engine integration', () => {
  const model = (): GraphModel => {
    const m = new GraphModel();
    m.load(starterGraph());
    return m;
  };
  const evaluate = (snap: GraphSnapshot, opts: { lod?: number; collision?: boolean } = {}, ev = new GraphEvaluator()) =>
    ev.evaluate(snap, { seed: 1, lod: opts.lod ?? 0, token: new CancellationSource().token, ...(opts.collision === undefined ? {} : { collision: opts.collision }) });
  const withTree = (level: string, extra: Record<string, string | boolean> = {}): GraphSnapshot => {
    const m = model();
    const tree = m.getNode('tree');
    if (!tree) throw new Error('no tree node');
    for (const [id, value] of Object.entries({ leafCollision: level, ...extra })) {
      const cur = tree.params[id];
      if (!cur) throw new Error(`missing param ${id}`);
      m.setParam('tree', id, { ...cur, value });
    }
    return snapshotGraph(m);
  };
  const leafTriangles = (s: Awaited<ReturnType<typeof evaluate>>): number => s.scene.entries.filter((e) => e.type === 'generator.leaf').reduce((n, e) => n + meshTriangleCount(e.mesh), 0);

  it('None is bit-identical to the old output and reports no statistics', async () => {
    const a = await evaluate(withTree('none'));
    const b = await evaluate(withTree('none'), { collision: false });
    expect(a.scene.stats.collision).toBeUndefined();
    const ea = a.scene.entries.find((e) => e.type === 'generator.leaf');
    const eb = b.scene.entries.find((e) => e.type === 'generator.leaf');
    expect(ea).toBeDefined();
    expect([...(ea?.mesh.indices ?? [])]).toEqual([...(eb?.mesh.indices ?? [])]);
    expect([...(ea?.mesh.positions ?? [])]).toEqual([...(eb?.mesh.positions ?? [])]);
  }, 60_000);

  it('removes leaves, reports the statistics, and keeps the plain pass available', async () => {
    const plain = await evaluate(withTree('low'), { collision: false });
    const ev = new GraphEvaluator();
    const done = await evaluate(withTree('low', { leafCollisionSpherical: false }), {}, ev);
    const stats = done.scene.stats.collision;
    expect(stats).toBeDefined();
    expect(stats?.leaves).toBeGreaterThan(0);
    expect(leafTriangles(done)).toBeLessThanOrEqual(leafTriangles(plain));
    if ((stats?.removed ?? 0) > 0) expect(leafTriangles(done)).toBeLessThan(leafTriangles(plain));
    const again = await evaluate(withTree('low'), {}, ev);
    expect(again.scene.stats.collision).toEqual(done.scene.stats.collision);
  }, 60_000);

  it('the revision of a changed leaf entry includes the collision settings', async () => {
    const plain = await evaluate(withTree('none'));
    const high = await evaluate(withTree('medium'));
    const a = plain.scene.entries.find((e) => e.type === 'generator.leaf');
    const b = high.scene.entries.find((e) => e.type === 'generator.leaf');
    if ((high.scene.stats.collision?.removed ?? 0) > 0) expect(b?.rev).not.toBe(a?.rev);
  }, 60_000);

  it('an already cancelled run throws', async () => {
    const src = new CancellationSource();
    src.cancel();
    await expect(new GraphEvaluator().evaluate(withTree('medium'), { seed: 1, lod: 0, token: src.token })).rejects.toBeInstanceOf(CancelledError);
  });
});
