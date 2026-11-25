import type { V3 } from '@/geometry/math3';
import { SphereGrid, type BroadSphere } from './broadPhase';
import { leafBounds, type LeafBounds, type Obb } from './bounds';
import { capsuleObbHit, capsuleSphereHit, obbHit, sphereHit, triBoxesOverlap, triTriSegment } from './narrowPhase';
import {
  LEAF_MOVED,
  LEAF_REMOVED,
  LEAF_SHRUNK,
  type AlphaTest,
  type Capsule,
  type Collider,
  type CollisionHooks,
  type CollisionInput,
  type CollisionLevel,
  type CollisionOutcome,
  type CollisionStats,
  type TriangleSoup,
} from './types';

/** Shrink factors tried in order by the Shrink action. */
export const SHRINK_STEPS: readonly number[] = [0.8, 0.6, 0.45, 0.3];
/** Move distances (fractions of the leaf radius) tried by the Move action. */
export const MOVE_STEPS: readonly number[] = [0.25, 0.5, 0.75, 1];

const CHECKPOINT_EVERY = 128;

interface Hit {
  /** World point the loser should move away from. */
  awayFrom: V3;
}

/** A leaf with its current shrink / move transform. */
class Body {
  scale = 1;
  off: V3 = [0, 0, 0];
  readonly broad: BroadSphere;
  private tris: V3[][] | null = null;
  hostBranch = -1;
  hostRadius = 0;

  constructor(
    readonly c: Collider,
    readonly bounds: LeafBounds,
    readonly flat: boolean,
    margin: number,
  ) {
    const r = Math.max(bounds.radius, bounds.testRadius * c.threshold) + margin;
    this.broad = { x: bounds.obb.c[0], y: bounds.obb.c[1], z: bounds.obb.c[2], r };
  }

  setTransform(scale: number, off: V3): void {
    this.scale = scale;
    this.off = off;
    this.tris = null;
  }

  point(p: V3): V3 {
    const o = this.c.origin;
    return [o[0] + (p[0] - o[0]) * this.scale + this.off[0], o[1] + (p[1] - o[1]) * this.scale + this.off[1], o[2] + (p[2] - o[2]) * this.scale + this.off[2]];
  }

  centre(): V3 {
    return this.point(this.bounds.obb.c);
  }

  obb(): Obb {
    const b = this.bounds.obb;
    return { c: this.point(b.c), axes: b.axes, h: [b.h[0] * this.scale, b.h[1] * this.scale, b.h[2] * this.scale] };
  }

  testRadius(): number {
    return this.bounds.testRadius * this.c.threshold * this.scale;
  }

  /** Broad sphere at the current transform (for neighbour queries). */
  sphere(): BroadSphere {
    const c = this.centre();
    return { x: c[0], y: c[1], z: c[2], r: this.broad.r * this.scale };
  }

  triangles(): V3[][] {
    if (this.tris) return this.tris;
    const { positions, indices, indexStart, indexCount } = this.c.shape;
    const out: V3[][] = [];
    for (let i = indexStart; i + 2 < indexStart + indexCount; i += 3) {
      const tri: V3[] = [];
      for (let k = 0; k < 3; k++) {
        const o = (indices[i + k] as number) * 3;
        tri.push(this.point([positions[o] as number, positions[o + 1] as number, this.flat ? 0 : (positions[o + 2] as number)]));
      }
      out.push(tri);
    }
    this.tris = out;
    return out;
  }
}

const accepts = (loser: Collider, winner: Collider): boolean => (loser.testAgainst === 'all' ? true : loser.testAgainst === 'same' ? loser.generator === winner.generator : loser.generator !== winner.generator);

/** Priority order: higher priority first, ties by id (the lower id wins). */
export const compareColliders = (a: Collider, b: Collider): number => b.priority - a.priority || a.id - b.id;

/** Do two leaves collide at the requested quality? `alpha` makes High ignore transparent overlaps. */
export function leavesCollide(a: Collider, b: Collider, level: CollisionLevel, spherical: boolean, alpha?: AlphaTest, plane = false): boolean {
  const A = new Body(a, leafBounds(a, plane), plane, 0);
  const B = new Body(b, leafBounds(b, plane), plane, 0);
  return bodiesCollide(A, B, level, spherical, alpha);
}

function bodiesCollide(a: Body, b: Body, level: CollisionLevel, spherical: boolean, alpha?: AlphaTest): boolean {
  if (level === 'none') return false;
  if (level === 'low' || spherical) {
    const ca = a.centre();
    const cb = b.centre();
    return sphereHit(ca[0], ca[1], ca[2], a.testRadius(), cb[0], cb[1], cb[2], b.testRadius());
  }
  if (!obbHit(a.obb(), b.obb())) return false;
  if (level === 'medium') return true;
  const ta = a.triangles();
  const tb = b.triangles();
  for (const x of ta)
    for (const y of tb) {
      if (!triBoxesOverlap(x, y)) continue;
      const seg = triTriSegment(x, y);
      if (!seg) continue;
      if (!alpha) return true;
      const mid: V3 = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2, (seg[0][2] + seg[1][2]) / 2];
      if (alpha(a.c, mid) && alpha(b.c, mid)) return true;
    }
  return false;
}

/** Flattened triangle soup restricted to a region, with a grid over the triangle bounding spheres. */
class TriangleIndex {
  readonly coords: Float64Array;
  readonly count: number;
  readonly grid: SphereGrid;
  readonly centroid: Float64Array;
  readonly radius: Float64Array;

  constructor(soups: readonly TriangleSoup[], lo: V3, hi: V3, cell: number) {
    const keep: number[] = [];
    const spheres: BroadSphere[] = [];
    const cent: number[] = [];
    for (const s of soups) {
      for (let i = 0; i + 2 < s.indices.length; i += 3) {
        const a = (s.indices[i] as number) * 3;
        const b = (s.indices[i + 1] as number) * 3;
        const c = (s.indices[i + 2] as number) * 3;
        const p = s.positions;
        let outside = false;
        const cx = ((p[a] as number) + (p[b] as number) + (p[c] as number)) / 3;
        const cy = ((p[a + 1] as number) + (p[b + 1] as number) + (p[c + 1] as number)) / 3;
        const cz = ((p[a + 2] as number) + (p[b + 2] as number) + (p[c + 2] as number)) / 3;
        let r = 0;
        for (const o of [a, b, c]) r = Math.max(r, Math.hypot((p[o] as number) - cx, (p[o + 1] as number) - cy, (p[o + 2] as number) - cz));
        const q = [cx, cy, cz];
        for (let k = 0; k < 3; k++) if ((q[k] as number) + r < (lo[k] as number) || (q[k] as number) - r > (hi[k] as number)) outside = true;
        if (outside) continue;
        for (const o of [a, b, c]) keep.push(p[o] as number, p[o + 1] as number, p[o + 2] as number);
        spheres.push({ x: cx, y: cy, z: cz, r });
        cent.push(cx, cy, cz);
      }
    }
    this.coords = Float64Array.from(keep);
    this.centroid = Float64Array.from(cent);
    this.radius = Float64Array.from(spheres, (q) => q.r);
    this.count = spheres.length;
    this.grid = new SphereGrid(spheres, cell);
  }

  triangle(i: number): V3[] {
    const o = i * 9;
    const k = this.coords;
    return [
      [k[o] as number, k[o + 1] as number, k[o + 2] as number],
      [k[o + 3] as number, k[o + 4] as number, k[o + 5] as number],
      [k[o + 6] as number, k[o + 7] as number, k[o + 8] as number],
    ];
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1] as number;
}

/**
 * Leaf collision removal. Leaves are processed by priority (higher first, ties by id); a leaf loses when it collides with
 * a leaf already kept that it is tested against, or with a branch. A loser is removed, shrunk or moved. Deterministic: no
 * random numbers, ties are broken by id. `hooks.checkpoint` may yield or throw to cancel.
 */
export async function resolveLeafCollisions(input: CollisionInput, hooks: CollisionHooks = {}): Promise<CollisionOutcome> {
  const { colliders, settings } = input;
  const n = colliders.length;
  const state = new Uint8Array(n);
  const scale = new Float32Array(n).fill(1);
  const offset = new Float32Array(n * 3);
  const stats: CollisionStats = { removed: 0, shrunk: 0, moved: 0, orphanedParents: 0, tests: 0 };
  const level = settings.level;
  if (level === 'none' || n === 0) return { state, scale, offset, orphanedParents: [], stats };
  const plane = settings.plane;
  const hasMove = colliders.some((c) => c.action === 'move') && !plane;
  const bounds = colliders.map((c) => leafBounds(c, plane));
  const bodies = colliders.map((c, i) => new Body(c, bounds[i] as LeafBounds, plane, 0));
  // The broad sphere of a leaf that may move must cover the whole move range.
  const grid = new SphereGrid(
    bodies.map((b) => ({ ...b.broad, r: b.broad.r + (hasMove && b.c.action === 'move' ? b.bounds.radius * 2 : 0) })),
    SphereGrid.cellSizeFor(bodies.map((b) => b.broad)),
  );
  const useBranches = !plane && level !== 'low';
  const capsules: readonly Capsule[] = useBranches ? (input.capsules ?? []) : [];
  const capsuleGrid = capsules.length > 0 ? new SphereGrid(capsules.map(capsuleSphere), Math.max(1e-3, 2 * median(bodies.map((b) => b.broad.r)))) : null;
  let triIndex: TriangleIndex | null = null;
  if (useBranches && level === 'high' && !settings.spherical && (input.branchTriangles?.length ?? 0) > 0) {
    const lo: V3 = [Infinity, Infinity, Infinity];
    const hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const b of bodies) {
      const q = [b.broad.x, b.broad.y, b.broad.z];
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k] as number, (q[k] as number) - b.broad.r);
        hi[k] = Math.max(hi[k] as number, (q[k] as number) + b.broad.r);
      }
    }
    triIndex = new TriangleIndex(input.branchTriangles ?? [], lo, hi, Math.max(1e-3, 2 * median(bodies.map((b) => b.broad.r))));
  }

  // Host branch of each leaf (the twig it grows from): never collides with it.
  if (capsuleGrid) {
    const near: number[] = [];
    for (const b of bodies) {
      capsuleGrid.query(b.broad, near);
      let best = Infinity;
      for (const j of near) {
        const cp = capsules[j] as Capsule;
        const d = segmentDistance(cp, b.c.origin);
        const r = d.radius;
        if (d.dist <= 1.6 * r + 0.003 && d.dist - r < best) {
          best = d.dist - r;
          b.hostBranch = cp.branch;
          b.hostRadius = r;
        }
      }
    }
  }

  const order = colliders.map((_, i) => i).sort((i, j) => compareColliders(colliders[i] as Collider, colliders[j] as Collider));
  const active = new Uint8Array(n);
  const neighbours: number[] = [];
  const capNear: number[] = [];

  const firstHit = (i: number): Hit | null => {
    const me = bodies[i] as Body;
    grid.query(me.sphere(), neighbours);
    let winner = -1;
    for (const j of neighbours) {
      if (j === i || !active[j]) continue;
      const other = bodies[j] as Body;
      if (!accepts(me.c, other.c)) continue;
      stats.tests += 1;
      if (bodiesCollide(me, other, level, settings.spherical, input.alpha)) {
        if (winner < 0 || (colliders[j] as Collider).id < (colliders[winner] as Collider).id) winner = j;
      }
    }
    if (winner >= 0) return { awayFrom: (bodies[winner] as Body).centre() };
    if (!useBranches) return null;
    return branchHit(me);
  };

  const branchHit = (me: Body): Hit | null => {
    const c = me.centre();
    if (capsuleGrid && (settings.spherical || triIndex === null)) {
      capsuleGrid.query(me.sphere(), capNear);
      const box = me.obb();
      for (const j of capNear) {
        const cp = capsules[j] as Capsule;
        if (cp.branch === me.hostBranch) continue;
        stats.tests += 1;
        const hit = settings.spherical ? capsuleSphereHit(cp.a, cp.b, cp.ra, cp.rb, c, me.testRadius()) : capsuleObbHit(cp.a, cp.b, cp.ra, cp.rb, box);
        if (hit) return { awayFrom: segmentDistance(cp, c).closest };
      }
    }
    if (triIndex) {
      const candidates = triIndex.grid.query(me.sphere(), []);
      if (candidates.length === 0) return null;
      const skip = me.hostBranch >= 0 ? me.hostRadius * 3 + 0.03 : 0;
      const own = me.triangles();
      const o = me.c.origin;
      for (const t of candidates) {
        if (skip > 0 && Math.hypot((triIndex.centroid[t * 3] as number) - o[0], (triIndex.centroid[t * 3 + 1] as number) - o[1], (triIndex.centroid[t * 3 + 2] as number) - o[2]) - (triIndex.radius[t] as number) < skip) continue;
        const tri = triIndex.triangle(t);
        for (const mine of own) {
          if (!triBoxesOverlap(mine, tri)) continue;
          stats.tests += 1;
          const seg = triTriSegment(mine, tri);
          if (!seg) continue;
          if (input.alpha) {
            const mid: V3 = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2, (seg[0][2] + seg[1][2]) / 2];
            if (!input.alpha(me.c, mid)) continue;
          }
          return { awayFrom: [triIndex.centroid[t * 3] as number, triIndex.centroid[t * 3 + 1] as number, triIndex.centroid[t * 3 + 2] as number] };
        }
      }
    }
    return null;
  };

  let sinceCheckpoint = 0;
  for (const i of order) {
    if (++sinceCheckpoint >= CHECKPOINT_EVERY) {
      sinceCheckpoint = 0;
      await hooks.checkpoint?.();
    }
    const body = bodies[i] as Body;
    const hit = firstHit(i);
    if (!hit) {
      active[i] = 1;
      continue;
    }
    const action = plane && body.c.action === 'move' ? 'shrink' : body.c.action;
    let resolved = false;
    if (action === 'shrink') {
      for (const s of SHRINK_STEPS) {
        body.setTransform(s, [0, 0, 0]);
        if (!firstHit(i)) {
          state[i] = LEAF_SHRUNK;
          scale[i] = s;
          resolved = true;
          break;
        }
      }
    } else if (action === 'move') {
      const c = body.bounds.obb.c;
      const nrm = body.bounds.normal;
      const side = (c[0] - hit.awayFrom[0]) * nrm[0] + (c[1] - hit.awayFrom[1]) * nrm[1] + (c[2] - hit.awayFrom[2]) * nrm[2] >= 0 ? 1 : -1;
      search: for (const step of MOVE_STEPS) {
        for (const sign of [side, -side]) {
          const d = step * body.bounds.radius * sign;
          const off: V3 = [nrm[0] * d, nrm[1] * d, nrm[2] * d];
          body.setTransform(1, off);
          if (!firstHit(i)) {
            state[i] = LEAF_MOVED;
            offset[i * 3] = off[0];
            offset[i * 3 + 1] = off[1];
            offset[i * 3 + 2] = off[2];
            resolved = true;
            break search;
          }
        }
      }
    }
    if (resolved) {
      active[i] = 1;
    } else {
      body.setTransform(1, [0, 0, 0]);
      state[i] = LEAF_REMOVED;
    }
  }

  const left = new Map<number, number>();
  const asks = new Set<number>();
  colliders.forEach((c, i) => {
    stats.removed += state[i] === LEAF_REMOVED ? 1 : 0;
    stats.shrunk += state[i] === LEAF_SHRUNK ? 1 : 0;
    stats.moved += state[i] === LEAF_MOVED ? 1 : 0;
    if (c.parentKey < 0) return;
    left.set(c.parentKey, (left.get(c.parentKey) ?? 0) + (state[i] === LEAF_REMOVED ? 0 : 1));
    if (c.parentRule === 'remove') asks.add(c.parentKey);
  });
  const orphanedParents = [...asks].filter((k) => left.get(k) === 0).sort((a, b) => a - b);
  stats.orphanedParents = orphanedParents.length;
  return { state, scale, offset, orphanedParents, stats };
}

function capsuleSphere(c: Capsule): BroadSphere {
  const mx = (c.a[0] + c.b[0]) / 2;
  const my = (c.a[1] + c.b[1]) / 2;
  const mz = (c.a[2] + c.b[2]) / 2;
  return { x: mx, y: my, z: mz, r: Math.hypot(c.a[0] - c.b[0], c.a[1] - c.b[1], c.a[2] - c.b[2]) / 2 + Math.max(c.ra, c.rb) };
}

/** Closest point of the capsule axis to `p`, its distance and the radius there. */
function segmentDistance(c: Capsule, p: V3): { dist: number; radius: number; closest: V3 } {
  const dx = c.b[0] - c.a[0];
  const dy = c.b[1] - c.a[1];
  const dz = c.b[2] - c.a[2];
  const l2 = dx * dx + dy * dy + dz * dz;
  const t = l2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p[0] - c.a[0]) * dx + (p[1] - c.a[1]) * dy + (p[2] - c.a[2]) * dz) / l2));
  const q: V3 = [c.a[0] + dx * t, c.a[1] + dy * t, c.a[2] + dz * t];
  return { dist: Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]), radius: c.ra + (c.rb - c.ra) * t, closest: q };
}
