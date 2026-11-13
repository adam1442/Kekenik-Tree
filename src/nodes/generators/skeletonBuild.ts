import type { Branch, Skeleton } from '@/contracts/skeleton';
import { advanceRMF, orthonormalNormal, rotateAroundAxis, v3Norm, type Vec3 } from './frames';

const safe = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

/**
 * High-performance typed-array builder for `Skeleton` (SoA contract).
 * Populates `position`, `radius`, `direction`, `tangent`, `generation`, `parent`, `branchId`, `t`, `age`,
 * plus rotation-minimizing frame normal attributes (`rmfNormalX`, `rmfNormalY`, `rmfNormalZ`, `twist`)
 * of exact length `count`.
 */
export class StructureSkeletonBuilder {
  private cap: number;
  private len = 0;
  private pos: Float32Array;
  private rad: Float32Array;
  private dir: Float32Array;
  private tan: Float32Array;
  private nrmX: Float32Array;
  private nrmY: Float32Array;
  private nrmZ: Float32Array;
  private tws: Float32Array;
  private gen: Uint16Array;
  private par: Int32Array;
  private bid: Uint32Array;
  private tArr: Float32Array;
  private ageArr: Float32Array;
  private readonly branches: Branch[] = [];

  constructor(initialPointCapacity = 1024) {
    const c = Math.max(64, initialPointCapacity);
    this.cap = c;
    this.pos = new Float32Array(c * 3);
    this.rad = new Float32Array(c);
    this.dir = new Float32Array(c * 3);
    this.tan = new Float32Array(c * 3);
    this.nrmX = new Float32Array(c);
    this.nrmY = new Float32Array(c);
    this.nrmZ = new Float32Array(c);
    this.tws = new Float32Array(c);
    this.gen = new Uint16Array(c);
    this.par = new Int32Array(c);
    this.bid = new Uint32Array(c);
    this.tArr = new Float32Array(c);
    this.ageArr = new Float32Array(c);
  }

  get branchCount(): number {
    return this.branches.length;
  }

  get pointCount(): number {
    return this.len;
  }

  private ensure(extra: number): void {
    const needed = this.len + extra;
    if (needed <= this.cap) return;
    let nextCap = this.cap;
    while (nextCap < needed) nextCap *= 2;

    const growF32 = (old: Float32Array, mult = 1): Float32Array => {
      const n = new Float32Array(nextCap * mult);
      n.set(old);
      return n;
    };
    this.pos = growF32(this.pos, 3);
    this.rad = growF32(this.rad, 1);
    this.dir = growF32(this.dir, 3);
    this.tan = growF32(this.tan, 3);
    this.nrmX = growF32(this.nrmX, 1);
    this.nrmY = growF32(this.nrmY, 1);
    this.nrmZ = growF32(this.nrmZ, 1);
    this.tws = growF32(this.tws, 1);
    this.tArr = growF32(this.tArr, 1);
    this.ageArr = growF32(this.ageArr, 1);

    const nGen = new Uint16Array(nextCap);
    nGen.set(this.gen);
    this.gen = nGen;

    const nPar = new Int32Array(nextCap);
    nPar.set(this.par);
    this.par = nPar;

    const nBid = new Uint32Array(nextCap);
    nBid.set(this.bid);
    this.bid = nBid;

    this.cap = nextCap;
  }

  /**
   * Append a complete branch polyline with `count >= 2` points and compute its arc-length `t`,
   * smoothed tangents, growth directions, and torsion-free RMF normals + axial twist.
   * Returns `{ branchId, start, end }`.
   */
  addPolylineBranch(opts: {
    parentBranch: number;
    parentPoint: number;
    generation: number;
    count: number;
    positions: ArrayLike<number>;
    radii: ArrayLike<number>;
    ages?: ArrayLike<number>;
    twists?: ArrayLike<number>;
    initialNormalHint?: Vec3;
  }): { branchId: number; start: number; end: number; length: number } {
    const n = opts.count;
    if (n < 2) {
      return { branchId: -1, start: this.len, end: this.len, length: 0 };
    }
    this.ensure(n);

    const branchId = this.branches.length;
    const start = this.len;
    const g = Math.max(0, Math.min(65535, Math.round(safe(opts.generation, 0))));
    const cum = new Float64Array(n);

    for (let k = 0; k < n; k++) {
      const gi = start + k;
      const px = safe(opts.positions[k * 3] as number, 0);
      const py = safe(opts.positions[k * 3 + 1] as number, 0);
      const pz = safe(opts.positions[k * 3 + 2] as number, 0);
      this.pos[gi * 3] = px;
      this.pos[gi * 3 + 1] = py;
      this.pos[gi * 3 + 2] = pz;
      this.rad[gi] = Math.max(1e-5, safe(opts.radii[k] as number, 0.002));
      this.gen[gi] = g;
      this.par[gi] = k === 0 ? Math.round(safe(opts.parentPoint, -1)) : gi - 1;
      this.bid[gi] = branchId;
      this.ageArr[gi] = opts.ages ? safe(opts.ages[k] as number, 1 - k / (n - 1)) : 1 - k / (n - 1);
      this.tws[gi] = opts.twists ? safe(opts.twists[k] as number, 0) : 0;

      if (k > 0) {
        const dx = px - (this.pos[(gi - 1) * 3] as number);
        const dy = py - (this.pos[(gi - 1) * 3 + 1] as number);
        const dz = pz - (this.pos[(gi - 1) * 3 + 2] as number);
        cum[k] = (cum[k - 1] as number) + Math.hypot(dx, dy, dz);
      }
    }

    const totalLen = safe(cum[n - 1] as number, 0);
    for (let k = 0; k < n; k++) {
      const gi = start + k;
      this.tArr[gi] = totalLen > 1e-8 ? (cum[k] as number) / totalLen : k / (n - 1);

      const prev = start + Math.max(0, k - 1);
      const next = start + Math.min(n - 1, k + 1);
      const tn = v3Norm([
        (this.pos[next * 3] as number) - (this.pos[prev * 3] as number),
        (this.pos[next * 3 + 1] as number) - (this.pos[prev * 3 + 1] as number),
        (this.pos[next * 3 + 2] as number) - (this.pos[prev * 3 + 2] as number),
      ]);
      this.tan[gi * 3] = tn[0];
      this.tan[gi * 3 + 1] = tn[1];
      this.tan[gi * 3 + 2] = tn[2];

      const back = start + Math.max(0, k - 1);
      const fwd = k === 0 ? start + 1 : gi;
      const dn = v3Norm([
        (this.pos[fwd * 3] as number) - (this.pos[back * 3] as number),
        (this.pos[fwd * 3 + 1] as number) - (this.pos[back * 3 + 1] as number),
        (this.pos[fwd * 3 + 2] as number) - (this.pos[back * 3 + 2] as number),
      ]);
      this.dir[gi * 3] = dn[0];
      this.dir[gi * 3 + 1] = dn[1];
      this.dir[gi * 3 + 2] = dn[2];
    }

    // Propagate double-reflection RMF along the branch
    const t0: Vec3 = [this.tan[start * 3] as number, this.tan[start * 3 + 1] as number, this.tan[start * 3 + 2] as number];
    let rmfN = orthonormalNormal(t0, opts.initialNormalHint);

    for (let k = 0; k < n; k++) {
      const gi = start + k;
      const tk: Vec3 = [this.tan[gi * 3] as number, this.tan[gi * 3 + 1] as number, this.tan[gi * 3 + 2] as number];
      if (k > 0) {
        const gp = gi - 1;
        const p0: Vec3 = [this.pos[gp * 3] as number, this.pos[gp * 3 + 1] as number, this.pos[gp * 3 + 2] as number];
        const p1: Vec3 = [this.pos[gi * 3] as number, this.pos[gi * 3 + 1] as number, this.pos[gi * 3 + 2] as number];
        const tp: Vec3 = [this.tan[gp * 3] as number, this.tan[gp * 3 + 1] as number, this.tan[gp * 3 + 2] as number];
        rmfN = advanceRMF(p0, tp, rmfN, p1, tk);
      }
      const twistRad = this.tws[gi] as number;
      const outN = Math.abs(twistRad) > 1e-7 ? orthonormalNormal(tk, rotateAroundAxis(rmfN, tk, twistRad)) : rmfN;
      this.nrmX[gi] = outN[0];
      this.nrmY[gi] = outN[1];
      this.nrmZ[gi] = outN[2];
    }

    this.len += n;
    const branch: Branch = {
      id: branchId,
      parentBranch: Math.round(safe(opts.parentBranch, -1)),
      parentPoint: Math.round(safe(opts.parentPoint, -1)),
      generation: g,
      start,
      count: n,
      length: totalLen,
    };
    this.branches.push(branch);
    return { branchId, start, end: this.len - 1, length: totalLen };
  }

  build(): Skeleton {
    const n = this.len;
    const attributes = new Map<string, Float32Array>();
    if (n > 0) {
      attributes.set('rmfNormalX', this.nrmX.slice(0, n));
      attributes.set('rmfNormalY', this.nrmY.slice(0, n));
      attributes.set('rmfNormalZ', this.nrmZ.slice(0, n));
      attributes.set('twist', this.tws.slice(0, n));
    }
    return {
      count: n,
      position: this.pos.slice(0, n * 3),
      radius: this.rad.slice(0, n),
      direction: this.dir.slice(0, n * 3),
      tangent: this.tan.slice(0, n * 3),
      generation: this.gen.slice(0, n),
      parent: this.par.slice(0, n),
      branchId: this.bid.slice(0, n),
      t: this.tArr.slice(0, n),
      age: this.ageArr.slice(0, n),
      attributes,
      branches: this.branches,
    };
  }
}
