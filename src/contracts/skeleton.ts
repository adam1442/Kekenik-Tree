/**
 * Skeleton — the plant's centre-line structure, stored as struct-of-arrays typed buffers.
 * Coordinate system (whole project): right-handed, **Z-up**, metres.
 * Produced by structure generators, consumed by mesh builders.
 */

export interface Branch {
  id: number;
  /** Parent branch id, -1 for roots. */
  parentBranch: number;
  /** Index of the point on the parent branch this branch grows from, -1 for roots. */
  parentPoint: number;
  /** 0 = trunk/root, 1 = first-level branches, ... */
  generation: number;
  /** First point index in the shared buffers. */
  start: number;
  /** Number of points. */
  count: number;
  /** Arc length in metres. */
  length: number;
}

export interface Skeleton {
  count: number;
  /** xyz per point. */
  position: Float32Array;
  radius: Float32Array;
  /** Unit growth direction per point (xyz). */
  direction: Float32Array;
  /** Smoothed unit tangent per point (xyz). */
  tangent: Float32Array;
  generation: Uint16Array;
  /** Previous point along the branch; for a branch's first point: the parent point (or -1). */
  parent: Int32Array;
  branchId: Uint32Array;
  /** Normalised arc length along its branch, 0..1. */
  t: Float32Array;
  /** Age in arbitrary units (0 = newest). */
  age: Float32Array;
  /** Named per-point custom channels (length === count). */
  attributes: Map<string, Float32Array>;
  branches: Branch[];
}

export function emptySkeleton(): Skeleton {
  return new SkeletonBuilder().build();
}

/** Incremental builder. Usage: beginBranch -> addPoint* -> endBranch, repeat, build(). */
export class SkeletonBuilder {
  private pos: number[] = [];
  private rad: number[] = [];
  private gen: number[] = [];
  private par: number[] = [];
  private bid: number[] = [];
  private age: number[] = [];
  private branches: Branch[] = [];
  private current: Branch | null = null;

  beginBranch(parentBranch: number, parentPoint: number, generation: number): number {
    if (this.current) throw new Error('SkeletonBuilder: endBranch() missing');
    const id = this.branches.length;
    this.current = {
      id,
      parentBranch,
      parentPoint,
      generation,
      start: this.rad.length,
      count: 0,
      length: 0,
    };
    return id;
  }

  /** Returns the global point index. */
  addPoint(x: number, y: number, z: number, radius: number, age = 0): number {
    const b = this.current;
    if (!b) throw new Error('SkeletonBuilder: beginBranch() missing');
    const index = this.rad.length;
    this.pos.push(x, y, z);
    this.rad.push(radius);
    this.gen.push(b.generation);
    this.par.push(b.count === 0 ? b.parentPoint : index - 1);
    this.bid.push(b.id);
    this.age.push(age);
    b.count += 1;
    return index;
  }

  endBranch(): void {
    if (!this.current) return;
    if (this.current.count > 0) this.branches.push(this.current);
    this.current = null;
  }

  build(): Skeleton {
    const n = this.rad.length;
    const position = Float32Array.from(this.pos);
    const direction = new Float32Array(n * 3);
    const tangent = new Float32Array(n * 3);
    const t = new Float32Array(n);
    const normalize = (arr: Float32Array, i: number, x: number, y: number, z: number): void => {
      const len = Math.hypot(x, y, z) || 1;
      arr[i * 3] = x / len;
      arr[i * 3 + 1] = y / len;
      arr[i * 3 + 2] = z / len;
    };
    for (const b of this.branches) {
      const cum: number[] = [0];
      for (let k = 1; k < b.count; k++) {
        const i = b.start + k;
        const p = i - 1;
        cum.push(
          (cum[k - 1] as number) +
            Math.hypot(
              (position[i * 3] as number) - (position[p * 3] as number),
              (position[i * 3 + 1] as number) - (position[p * 3 + 1] as number),
              (position[i * 3 + 2] as number) - (position[p * 3 + 2] as number),
            ),
        );
      }
      b.length = cum[b.count - 1] as number;
      for (let k = 0; k < b.count; k++) {
        const i = b.start + k;
        const prev = b.start + Math.max(0, k - 1);
        const next = b.start + Math.min(b.count - 1, k + 1);
        const dx = (position[next * 3] as number) - (position[prev * 3] as number);
        const dy = (position[next * 3 + 1] as number) - (position[prev * 3 + 1] as number);
        const dz = (position[next * 3 + 2] as number) - (position[prev * 3 + 2] as number);
        normalize(tangent, i, dx, dy, dz);
        const back = b.start + Math.max(0, k - 1);
        const fwd = k === 0 ? Math.min(b.count - 1, 1) + b.start : i;
        normalize(
          direction,
          i,
          (position[fwd * 3] as number) - (position[back * 3] as number),
          (position[fwd * 3 + 1] as number) - (position[back * 3 + 1] as number),
          (position[fwd * 3 + 2] as number) - (position[back * 3 + 2] as number),
        );
        t[i] = b.length > 0 ? (cum[k] as number) / b.length : 0;
      }
    }
    return {
      count: n,
      position,
      radius: Float32Array.from(this.rad),
      direction,
      tangent,
      generation: Uint16Array.from(this.gen),
      parent: Int32Array.from(this.par),
      branchId: Uint32Array.from(this.bid),
      t,
      age: Float32Array.from(this.age),
      attributes: new Map(),
      branches: this.branches,
    };
  }
}
