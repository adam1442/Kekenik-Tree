/** Bounding sphere used by the broad phase. */
export interface BroadSphere {
  x: number;
  y: number;
  z: number;
  r: number;
}

const MAX_CELLS_PER_ITEM = 512;

/**
 * Uniform grid over bounding spheres. Each sphere is stored in every cell its box overlaps; queries return the
 * indices (ascending, deduplicated) of all spheres whose sphere overlaps the query sphere.
 */
export class SphereGrid {
  private readonly cells = new Map<number, number[]>();
  private readonly inv: number;
  private stamp: Int32Array;
  private tick = 0;
  /** Spheres bigger than the cap go here (rare). */
  private readonly large: number[] = [];

  constructor(
    private readonly spheres: readonly BroadSphere[],
    readonly cellSize: number,
  ) {
    this.inv = 1 / Math.max(1e-6, cellSize);
    this.stamp = new Int32Array(spheres.length);
    spheres.forEach((s, i) => this.insert(s, i));
  }

  /** Cell size heuristic: about twice the median radius (at least 1 mm). */
  static cellSizeFor(spheres: readonly BroadSphere[]): number {
    if (spheres.length === 0) return 1;
    const radii = spheres.map((s) => s.r).sort((a, b) => a - b);
    return Math.max(1e-3, 2 * (radii[radii.length >> 1] as number));
  }

  private key(ix: number, iy: number, iz: number): number {
    // 21 bits per axis fit a safe integer: offset keeps indices positive.
    return ((ix + 1048576) * 2097152 + (iy + 1048576)) * 2097152 + (iz + 1048576);
  }

  private insert(s: BroadSphere, i: number): void {
    const x0 = Math.floor((s.x - s.r) * this.inv);
    const x1 = Math.floor((s.x + s.r) * this.inv);
    const y0 = Math.floor((s.y - s.r) * this.inv);
    const y1 = Math.floor((s.y + s.r) * this.inv);
    const z0 = Math.floor((s.z - s.r) * this.inv);
    const z1 = Math.floor((s.z + s.r) * this.inv);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_CELLS_PER_ITEM) {
      this.large.push(i);
      return;
    }
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const k = this.key(x, y, z);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
  }

  /** Indices of spheres overlapping `q` (strictly: distance < r1 + r2), ascending. */
  query(q: BroadSphere, out: number[] = []): number[] {
    out.length = 0;
    this.tick += 1;
    const x0 = Math.floor((q.x - q.r) * this.inv);
    const x1 = Math.floor((q.x + q.r) * this.inv);
    const y0 = Math.floor((q.y - q.r) * this.inv);
    const y1 = Math.floor((q.y + q.r) * this.inv);
    const z0 = Math.floor((q.z - q.r) * this.inv);
    const z1 = Math.floor((q.z + q.r) * this.inv);
    const take = (j: number): void => {
      if (this.stamp[j] === this.tick) return;
      this.stamp[j] = this.tick;
      const s = this.spheres[j] as BroadSphere;
      const dx = s.x - q.x;
      const dy = s.y - q.y;
      const dz = s.z - q.z;
      const rr = s.r + q.r;
      if (dx * dx + dy * dy + dz * dz < rr * rr) out.push(j);
    };
    if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > MAX_CELLS_PER_ITEM * 8) {
      for (let j = 0; j < this.spheres.length; j++) take(j);
    } else {
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const list = this.cells.get(this.key(x, y, z));
            if (list) for (const j of list) take(j);
          }
      for (const j of this.large) take(j);
    }
    out.sort((a, b) => a - b);
    return out;
  }
}

/** Every overlapping pair (i < j) of the spheres, sorted by (i, j). */
export function findSpherePairs(spheres: readonly BroadSphere[]): [number, number][] {
  const grid = new SphereGrid(spheres, SphereGrid.cellSizeFor(spheres));
  const pairs: [number, number][] = [];
  const hits: number[] = [];
  for (let i = 0; i < spheres.length; i++) {
    grid.query(spheres[i] as BroadSphere, hits);
    for (const j of hits) if (j > i) pairs.push([i, j]);
  }
  return pairs;
}

/** O(n^2) reference used by the tests. */
export function bruteForceSpherePairs(spheres: readonly BroadSphere[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < spheres.length; i++)
    for (let j = i + 1; j < spheres.length; j++) {
      const a = spheres[i] as BroadSphere;
      const b = spheres[j] as BroadSphere;
      const rr = a.r + b.r;
      if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 < rr * rr) pairs.push([i, j]);
    }
  return pairs;
}
