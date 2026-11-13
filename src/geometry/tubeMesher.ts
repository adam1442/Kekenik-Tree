import type { MeshData } from '@/contracts/mesh';
import type { Branch, Skeleton } from '@/contracts/skeleton';
import type { DisplaceDirection, TubeDisplacer, TubeDisplaceVertex } from './displaceMesh';
import { createSectionEvaluator, ROUND_SECTION, type SectionShape } from './crossSection';
import { cross, dot, hash01, len, mul, norm, orthogonalize, perpendicular, rotate, sub, type V3 } from './math3';
import { MeshAccumulator, newVertex, type VertexAttrs } from './meshAccumulator';
import { computeSkeletonWind, WIND_ATTRIBUTES } from './windAttributes';

export interface TubeUv {
  /** false = metric (V = metres / uvMetres, tiles by world length), true = V runs 0..1 per branch. */
  normalized: boolean;
  scaleU: number;
  scaleV: number;
  offsetU: number;
  offsetV: number;
  /** Swap U and V (rotate the texture 90 degrees). */
  rotate: boolean;
}

export interface TubeOptions {
  maxGeneration: number;
  /** Skip a skeleton branch (by index) without meshing it, e.g. instances hidden in Node mode. */
  skipBranch?: (branchIndex: number) => boolean;
  /** Ring sides of a branch; `maxRadius` is its thickest radius (for sizing sides to the radius, e.g. displacement). */
  radialSegments(generation: number, maxRadius: number): number;
  /** Linear RGB colour of a ring. */
  color(generation: number, t: number): [number, number, number];
  /** Metres of branch length per UV v unit. */
  uvMetres: number;
  materialId: string;
  /** Parent skeleton of the generator (junction colour blend, wind inheritance). */
  parent?: Skeleton;
  /** > 0: resample every branch into this many length segments (Catmull-Rom). 0 = one ring per skeleton point. */
  lengthSegments?: number;
  /** 0..1 fraction of rings kept (LOD). */
  segmentKeep?: number;
  section?: SectionShape;
  uv?: Partial<TubeUv>;
  /** 1 = smooth normals, < 0.5 = faceted (unwelded quads). */
  smoothing?: number;
  /** 0..1 blend of the normals toward the pure cylindrical normal (hides section detail in lighting). */
  flatten?: number;
  capEnd?: boolean;
  /** 'auto' = close the base of branches that do not start on a parent. */
  capStart?: boolean | 'auto';
  tipRings?: number;
  /** Radius flare where a child meets its parent (fraction of radius) and its length in radii. */
  collarAmount?: number;
  collarLength?: number;
  /** Degrees of ring twist per metre. */
  twist?: number;
  tintVariance?: number;
  aoStrength?: number;
  seed?: number;
  /** Displacement evaluated per ring vertex (metres along `displaceDirection`); normals are built from the displaced rings. */
  displace?: TubeDisplacer;
  displaceDirection?: DisplaceDirection;
  /** > 0: rings are at most this far apart (adaptive subdivision for displacement), capped at 600 rings per branch. */
  maxSegmentLength?: number;
}

interface Samples {
  n: number;
  pos: Float32Array;
  rad: Float32Array;
  /** Fractional local skeleton index of each sample (for attribute lookups). */
  sf: Float32Array;
  s: Float32Array;
  t: Float32Array;
  tan: Float32Array;
  /** Index of the first ring that belongs to the skeleton (1 when a buried junction ring was prepended). */
  first: number;
}

const catmull = (p0: number, p1: number, p2: number, p3: number, f: number): number =>
  0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);

function sampleBranch(sk: Skeleton, b: Branch, o: TubeOptions, junction: boolean, collarAmount: number): Samples {
  const n = b.count;
  const P = (k: number, c: number): number => sk.position[(b.start + Math.min(n - 1, Math.max(0, k))) * 3 + c] as number;
  const R = (k: number): number => sk.radius[b.start + Math.min(n - 1, Math.max(0, k))] as number;
  const keep = Math.min(1, Math.max(0, o.segmentKeep ?? 1));
  const px: number[] = [];
  const py: number[] = [];
  const pz: number[] = [];
  const rr: number[] = [];
  const sf: number[] = [];
  let segs = o.lengthSegments ?? 0;
  const cum = [0];
  for (let k = 1; k < n; k++) cum.push((cum[k - 1] as number) + Math.hypot(P(k, 0) - P(k - 1, 0), P(k, 1) - P(k - 1, 1), P(k, 2) - P(k - 1, 2)));
  const branchLen = cum[n - 1] as number;
  const maxLen = o.maxSegmentLength ?? 0;
  const adaptive = maxLen > 0 ? Math.min(600, Math.ceil(branchLen / maxLen)) : 0;
  if (adaptive > segs) segs = adaptive;
  if (segs > 0) {
    const m = (adaptive > 0 && segs === adaptive ? segs : Math.max(1, Math.round(segs * keep))) + 1;
    let i = 0;
    for (let q = 0; q < m; q++) {
      const L = (branchLen * q) / (m - 1);
      while (i < n - 2 && (cum[i + 1] as number) < L) i++;
      const span = (cum[i + 1] as number) - (cum[i] as number);
      const f = span > 1e-12 ? Math.min(1, Math.max(0, (L - (cum[i] as number)) / span)) : 0;
      px.push(catmull(P(i - 1, 0), P(i, 0), P(i + 1, 0), P(i + 2, 0), f));
      py.push(catmull(P(i - 1, 1), P(i, 1), P(i + 1, 1), P(i + 2, 1), f));
      pz.push(catmull(P(i - 1, 2), P(i, 2), P(i + 1, 2), P(i + 2, 2), f));
      rr.push(R(i) + (R(i + 1) - R(i)) * f);
      sf.push(i + f);
    }
  } else {
    const m = Math.max(2, Math.min(n, Math.round(1 + (n - 1) * keep)));
    for (let q = 0; q < m; q++) {
      const k = Math.round((q * (n - 1)) / (m - 1));
      px.push(P(k, 0));
      py.push(P(k, 1));
      pz.push(P(k, 2));
      rr.push(R(k));
      sf.push(k);
    }
  }
  // Drop rings that coincide with their predecessor (zero-length segments produce degenerate triangles).
  const keepIdx: number[] = [0];
  for (let q = 1; q < px.length; q++) {
    const l = keepIdx[keepIdx.length - 1] as number;
    const d = Math.hypot((px[q] as number) - (px[l] as number), (py[q] as number) - (py[l] as number), (pz[q] as number) - (pz[l] as number));
    if (d > 1e-6 || q === px.length - 1) keepIdx.push(q);
  }
  const first = junction ? 1 : 0;
  const count = keepIdx.length + first;
  const pos = new Float32Array(count * 3);
  const rad = new Float32Array(count);
  const sfo = new Float32Array(count);
  keepIdx.forEach((q, k) => {
    const d = k + first;
    pos[d * 3] = px[q] as number;
    pos[d * 3 + 1] = py[q] as number;
    pos[d * 3 + 2] = pz[q] as number;
    rad[d] = Math.max(1e-4, rr[q] as number);
    sfo[d] = sf[q] as number;
  });
  // Tangents (central differences over the real rings).
  const tan = new Float32Array(count * 3);
  for (let k = first; k < count; k++) {
    const a = Math.max(first, k - 1);
    const c = Math.min(count - 1, k + 1);
    const t = norm([pos[c * 3]! - pos[a * 3]!, pos[c * 3 + 1]! - pos[a * 3 + 1]!, pos[c * 3 + 2]! - pos[a * 3 + 2]!]);
    tan[k * 3] = t[0];
    tan[k * 3 + 1] = t[1];
    tan[k * 3 + 2] = t[2];
  }
  if (junction) {
    // A ring buried inside the parent so the child never shows a crack where it leaves the parent surface.
    const r0 = rad[1] as number;
    const back = r0 * 0.8;
    pos[0] = (pos[3] as number) - (tan[3] as number) * back;
    pos[1] = (pos[4] as number) - (tan[4] as number) * back;
    pos[2] = (pos[5] as number) - (tan[5] as number) * back;
    rad[0] = r0 * (1 + collarAmount);
    sfo[0] = 0;
    tan[0] = tan[3] as number;
    tan[1] = tan[4] as number;
    tan[2] = tan[5] as number;
  }
  const s = new Float32Array(count);
  let acc = 0;
  for (let k = 1; k < count; k++) {
    acc += Math.hypot(pos[k * 3]! - pos[(k - 1) * 3]!, pos[k * 3 + 1]! - pos[(k - 1) * 3 + 1]!, pos[k * 3 + 2]! - pos[(k - 1) * 3 + 2]!);
    s[k] = acc;
  }
  const offset = s[first] as number;
  for (let k = 0; k < count; k++) s[k] = (s[k] as number) - offset;
  const total = Math.max(1e-9, (s[count - 1] as number));
  const t = new Float32Array(count);
  for (let k = 0; k < count; k++) t[k] = Math.min(1, Math.max(0, (s[k] as number) / total));
  return { n: count, pos, rad, sf: sfo, s, t, tan, first };
}

/** Parallel-transport (double reflection) frames, optionally snapped to the skeleton's stored RMF normals. */
function buildNormals(sk: Skeleton, b: Branch, sm: Samples, o: TubeOptions): V3[] {
  const nx = sk.attributes.get('rmfNormalX');
  const ny = sk.attributes.get('rmfNormalY');
  const nz = sk.attributes.get('rmfNormalZ');
  const hasRmf = !!nx && !!ny && !!nz;
  const out: V3[] = [];
  const T = (i: number): V3 => [sm.tan[i * 3] as number, sm.tan[i * 3 + 1] as number, sm.tan[i * 3 + 2] as number];
  const Pt = (i: number): V3 => [sm.pos[i * 3] as number, sm.pos[i * 3 + 1] as number, sm.pos[i * 3 + 2] as number];
  const twistRad = ((o.twist ?? 0) * Math.PI) / 180;
  let prev: V3 | null = null;
  for (let i = 0; i < sm.n; i++) {
    const t = T(i);
    let nrm: V3;
    if (hasRmf && nx && ny && nz) {
      const f = sm.sf[i] as number;
      const i0 = b.start + Math.min(b.count - 1, Math.floor(f));
      const i1 = b.start + Math.min(b.count - 1, Math.floor(f) + 1);
      const fr = f - Math.floor(f);
      const h: V3 = [
        (nx[i0] as number) * (1 - fr) + (nx[i1] as number) * fr,
        (ny[i0] as number) * (1 - fr) + (ny[i1] as number) * fr,
        (nz[i0] as number) * (1 - fr) + (nz[i1] as number) * fr,
      ];
      nrm = orthogonalize(h, t);
    } else if (!prev) {
      nrm = perpendicular(t);
    } else {
      const p0 = Pt(i - 1);
      const p1 = Pt(i);
      const t0 = T(i - 1);
      const v1 = sub(p1, p0);
      const c1 = dot(v1, v1);
      if (c1 < 1e-14) nrm = orthogonalize(prev, t);
      else {
        const rL = sub(prev, mul(v1, (2 / c1) * dot(v1, prev)));
        const tL = sub(t0, mul(v1, (2 / c1) * dot(v1, t0)));
        const v2 = sub(t, tL);
        const c2 = dot(v2, v2);
        nrm = orthogonalize(c2 < 1e-14 ? rL : sub(rL, mul(v2, (2 / c2) * dot(v2, rL))), t);
      }
    }
    prev = nrm;
    out.push(twistRad !== 0 ? rotate(nrm, t, twistRad * (sm.s[i] as number)) : nrm);
  }
  return out;
}

const lerpAttr = (arr: Float32Array | undefined, b: Branch, f: number, fallback: number): number => {
  if (!arr) return fallback;
  const i0 = b.start + Math.min(b.count - 1, Math.floor(f));
  const i1 = b.start + Math.min(b.count - 1, Math.floor(f) + 1);
  const fr = f - Math.floor(f);
  return (arr[i0] as number) * (1 - fr) + (arr[i1] as number) * fr;
};

/**
 * Skeleton -> tube mesh. Rotation-minimising frames (continuous twist), analytic smooth normals + tangents,
 * metric UV0 (tiling by world length), unique UV1 cells, baked AO / colour, wind attributes, closed tips and bases,
 * buried + flared collars at junctions. Deterministic: depends only on the skeleton and the options.
 */
export function buildTubeMesh(sk: Skeleton, opts: TubeOptions): MeshData {
  const acc = new MeshAccumulator();
  acc.beginSlot(opts.materialId);
  const section = createSectionEvaluator(opts.section ?? ROUND_SECTION);
  const aspect = Math.max(0.05, opts.section?.aspect ?? 1);
  const sqrtA = Math.sqrt(aspect);
  const uvo: TubeUv = { normalized: false, scaleU: 1, scaleV: 1, offsetU: 0, offsetV: 0, rotate: false, ...opts.uv };
  const smooth = (opts.smoothing ?? 1) >= 0.5;
  const flatten = Math.min(1, Math.max(0, opts.flatten ?? 0));
  const collarAmountOpt = Math.max(0, opts.collarAmount ?? 0.3);
  const collarLength = Math.max(0.1, opts.collarLength ?? 1.5);
  const tipRings = Math.max(1, Math.round(opts.tipRings ?? 2));
  const aoStrength = Math.min(1, Math.max(0, opts.aoStrength ?? 0.6));
  const seed = opts.seed ?? 0;
  const windArr = WIND_ATTRIBUTES.map((k) => sk.attributes.get(k));
  const wind = windArr.every((w) => w) ? (windArr as Float32Array[]) : computeSkeletonWind(sk, opts.parent ?? null, seed);
  const nb = sk.branches.length;
  const cells = Math.max(1, Math.ceil(Math.sqrt(nb)));

  for (let bi = 0; bi < nb; bi++) {
    const b = sk.branches[bi] as Branch;
    if (b.generation > opts.maxGeneration || b.count < 2 || opts.skipBranch?.(bi) === true) continue;
    let maxR = 0;
    for (let k = 0; k < b.count; k++) maxR = Math.max(maxR, sk.radius[b.start + k] as number);
    const sides = Math.max(3, Math.round(opts.radialSegments(b.generation, maxR)));
    const V = sides + 1;
    const junction = b.parentPoint >= 0;
    const collarAmount = junction ? collarAmountOpt : 0;
    const sm = sampleBranch(sk, b, opts, junction, collarAmount);
    const R = sm.n;
    if (R < 2) continue;
    const frames = buildNormals(sk, b, sm, opts);
    const r0 = sm.rad[sm.first] as number;
    let rMax = 0;
    for (let i = 0; i < R; i++) rMax = Math.max(rMax, sm.rad[i] as number);
    const uTiles = uvo.normalized ? uvo.scaleU : Math.max(1, Math.round(((2 * Math.PI * rMax * uvo.scaleU) / Math.max(1e-4, opts.uvMetres))));
    const tintMul = 1 + (hash01(b.id + 1, seed) * 2 - 1) * (opts.tintVariance ?? 0) * 0.5;
    const parentT = junction && opts.parent && b.parentPoint < opts.parent.count ? (opts.parent.t[b.parentPoint] as number) : 0.5;
    const parentColor = junction && opts.parent ? opts.color(Math.max(0, b.generation - 1), parentT) : null;
    const cx = bi % cells;
    const cy = Math.floor(bi / cells);

    // --- ring positions
    const dv: TubeDisplaceVertex = { u: 0, s: 0, t: 0, sEnd: 0, radius: 0, circumference: 2 * Math.PI * rMax, sides, junction };
    const gp = new Float32Array(R * V * 3);
    const dirs = new Float32Array(R * V * 3);
    for (let i = 0; i < R; i++) {
      const N = frames[i] as V3;
      const Tn: V3 = [sm.tan[i * 3] as number, sm.tan[i * 3 + 1] as number, sm.tan[i * 3 + 2] as number];
      const B = cross(Tn, N);
      const s = sm.s[i] as number;
      const collar = 1 + collarAmount * Math.exp(-Math.max(0, s) / (collarLength * r0));
      const radius = (i === 0 && junction ? (sm.rad[0] as number) : (sm.rad[i] as number) * collar);
      let slope = 0;
      if (opts.displace && opts.displaceDirection !== 'radial') {
        const a = Math.max(0, i - 1);
        const c = Math.min(R - 1, i + 1);
        const ds = (sm.s[c] as number) - (sm.s[a] as number);
        slope = ds > 1e-9 ? ((sm.rad[c] as number) - (sm.rad[a] as number)) / ds : 0;
      }
      if (opts.displace) {
        dv.s = s;
        dv.t = sm.t[i] as number;
        dv.sEnd = (sm.s[R - 1] as number) - s;
        dv.radius = radius;
      }
      for (let j = 0; j < V; j++) {
        const a = (2 * Math.PI * (j % sides)) / sides;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        const ox = N[0] * c * sqrtA + B[0] * sn / sqrtA;
        const oy = N[1] * c * sqrtA + B[1] * sn / sqrtA;
        const oz = N[2] * c * sqrtA + B[2] * sn / sqrtA;
        const m = section.radius(a, s) * radius;
        const o = (i * V + j) * 3;
        let dd = 0;
        if (opts.displace) {
          dv.u = (j % sides) / sides;
          dd = opts.displace(dv);
        }
        const dl = Math.hypot(ox, oy, oz) || 1;
        gp[o] = (sm.pos[i * 3] as number) + ox * m + (ox / dl - Tn[0] * slope) * dd;
        gp[o + 1] = (sm.pos[i * 3 + 1] as number) + oy * m + (oy / dl - Tn[1] * slope) * dd;
        gp[o + 2] = (sm.pos[i * 3 + 2] as number) + oz * m + (oz / dl - Tn[2] * slope) * dd;
        dirs[o] = ox / dl;
        dirs[o + 1] = oy / dl;
        dirs[o + 2] = oz / dl;
      }
    }

    // --- per-vertex attributes (smooth normals from the ring grid)
    const grid: VertexAttrs[] = new Array<VertexAttrs>(R * V);
    const gp3 = (i: number, j: number): V3 => {
      const o = (i * V + j) * 3;
      return [gp[o] as number, gp[o + 1] as number, gp[o + 2] as number];
    };
    const basePivot: V3 = [sm.pos[sm.first * 3] as number, sm.pos[sm.first * 3 + 1] as number, sm.pos[sm.first * 3 + 2] as number];
    for (let i = 0; i < R; i++) {
      const s = sm.s[i] as number;
      const t = sm.t[i] as number;
      const f = sm.sf[i] as number;
      let col = opts.color(b.generation, t);
      if (parentColor) {
        const w = 0.7 * Math.exp(-Math.max(0, s) / (collarLength * r0 * 1.5));
        col = [col[0] + (parentColor[0] - col[0]) * w, col[1] + (parentColor[1] - col[1]) * w, col[2] + (parentColor[2] - col[2]) * w];
      }
      let ao = 1;
      if (junction) ao -= aoStrength * 0.6 * Math.exp(-Math.max(0, s) / (r0 * 2.5));
      else if (b.generation === 0) ao -= aoStrength * 0.35 * Math.exp(-s / (r0 * 4));
      ao -= aoStrength * 0.12 * Math.min(1, b.generation / 3);
      ao = Math.min(1, Math.max(0.15, ao));
      const shade = tintMul * ao;
      const w0 = lerpAttr(wind[0], b, f, 0);
      const w1 = lerpAttr(wind[1], b, f, 0);
      const w2 = lerpAttr(wind[2], b, f, 0);
      const w3 = lerpAttr(wind[3], b, f, 0);
      const vBase = uvo.normalized ? t * uvo.scaleV : (s / Math.max(1e-4, opts.uvMetres)) * uvo.scaleV;
      for (let j = 0; j < V; j++) {
        const jm = j % sides;
        const jp = (jm + 1) % sides;
        const jq = (jm + sides - 1) % sides;
        const i1 = Math.max(0, i - 1);
        const i2 = Math.min(R - 1, i + 1);
        const dPu = sub(gp3(i, jp), gp3(i, jq));
        const dPv = sub(gp3(i2, jm), gp3(i1, jm));
        const o = (i * V + j) * 3;
        const d: V3 = [dirs[o] as number, dirs[o + 1] as number, dirs[o + 2] as number];
        let n = cross(dPu, dPv);
        if (len(n) < 1e-14) n = d;
        n = norm(n, d);
        if (dot(n, d) < 0) n = mul(n, -1);
        if (flatten > 0) n = norm([n[0] + (d[0] - n[0]) * flatten, n[1] + (d[1] - n[1]) * flatten, n[2] + (d[2] - n[2]) * flatten], d);
        const tg = norm(dPu, perpendicular(n));
        const bit = cross(n, tg);
        const u = (j / sides) * uTiles + uvo.offsetU;
        const v = vBase + uvo.offsetV;
        const vx = newVertex();
        vx.px = gp[o] as number; vx.py = gp[o + 1] as number; vx.pz = gp[o + 2] as number;
        vx.nx = n[0]; vx.ny = n[1]; vx.nz = n[2];
        vx.tx = tg[0]; vx.ty = tg[1]; vx.tz = tg[2];
        vx.tw = dot(bit, dPv) >= 0 ? 1 : -1;
        vx.u = uvo.rotate ? v : u;
        vx.v = uvo.rotate ? u : v;
        vx.u1 = (cx + j / sides) / cells;
        vx.v1 = (cy + t) / cells;
        vx.r = col[0] * shade; vx.g = col[1] * shade; vx.b = col[2] * shade;
        vx.ao = ao;
        vx.pvx = basePivot[0]; vx.pvy = basePivot[1]; vx.pvz = basePivot[2];
        vx.w0 = w0; vx.w1 = w1; vx.w2 = w2; vx.w3 = w3;
        grid[i * V + j] = vx;
      }
    }

    // --- body triangles
    if (smooth) {
      const base = acc.vertexCount;
      for (let k = 0; k < grid.length; k++) acc.addVertex(grid[k] as VertexAttrs);
      for (let i = 0; i < R - 1; i++) {
        for (let j = 0; j < sides; j++) {
          const a0 = base + i * V + j;
          const a1 = a0 + 1;
          const b0 = a0 + V;
          const b1 = b0 + 1;
          acc.addTriangle(a0, a1, b0);
          acc.addTriangle(a1, b1, b0);
        }
      }
    } else {
      for (let i = 0; i < R - 1; i++) {
        for (let j = 0; j < sides; j++) {
          const q = [grid[i * V + j], grid[i * V + j + 1], grid[(i + 1) * V + j], grid[(i + 1) * V + j + 1]] as VertexAttrs[];
          const e1: V3 = [q[1]!.px - q[0]!.px, q[1]!.py - q[0]!.py, q[1]!.pz - q[0]!.pz];
          const e2: V3 = [q[2]!.px - q[0]!.px, q[2]!.py - q[0]!.py, q[2]!.pz - q[0]!.pz];
          const avg: V3 = [q[0]!.nx + q[1]!.nx, q[0]!.ny + q[1]!.ny, q[0]!.nz + q[1]!.nz];
          let fn = norm(cross(e1, e2), avg);
          if (dot(fn, avg) < 0) fn = mul(fn, -1);
          const ids = q.map((src) => acc.addVertex({ ...src, nx: fn[0], ny: fn[1], nz: fn[2] }));
          acc.addTriangle(ids[0] as number, ids[1] as number, ids[2] as number);
          acc.addTriangle(ids[1] as number, ids[3] as number, ids[2] as number);
        }
      }
    }

    // --- tip dome
    if (opts.capEnd !== false) emitTipDome(acc, grid, sm, R, V, sides, tipRings, opts, uvo);
    // --- flat base cap
    const capStart = opts.capStart === undefined || opts.capStart === 'auto' ? !junction : opts.capStart;
    if (capStart) emitBaseCap(acc, grid, sm, V, sides);
  }
  return acc.build(opts.materialId, true);
}

function emitTipDome(
  acc: MeshAccumulator,
  grid: VertexAttrs[],
  sm: Samples,
  R: number,
  V: number,
  sides: number,
  rings: number,
  opts: TubeOptions,
  uvo: TubeUv,
): void {
  const last = R - 1;
  const P: V3 = [sm.pos[last * 3] as number, sm.pos[last * 3 + 1] as number, sm.pos[last * 3 + 2] as number];
  const T: V3 = [sm.tan[last * 3] as number, sm.tan[last * 3 + 1] as number, sm.tan[last * 3 + 2] as number];
  const rEnd = sm.rad[last] as number;
  const h = Math.max(rEnd * 0.6, 1e-4);
  const ref = grid[last * V] as VertexAttrs;
  const vStep = uvo.normalized ? 0.04 : (h / Math.max(1e-4, opts.uvMetres)) * uvo.scaleV;
  let prev: number[] = [];
  for (let k = 0; k < rings; k++) {
    const phi = (k / rings) * (Math.PI / 2);
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    const cur: number[] = [];
    for (let j = 0; j < V; j++) {
      const src = grid[last * V + j] as VertexAttrs;
      const rel: V3 = [src.px - P[0], src.py - P[1], src.pz - P[2]];
      const rl = len(rel) || 1;
      const rad: V3 = [rel[0] / rl, rel[1] / rl, rel[2] / rl];
      const n = norm([rad[0] * c * h + T[0] * sn * rl, rad[1] * c * h + T[1] * sn * rl, rad[2] * c * h + T[2] * sn * rl], T);
      const vv: VertexAttrs = {
        ...src,
        px: P[0] + rel[0] * c + T[0] * sn * h,
        py: P[1] + rel[1] * c + T[1] * sn * h,
        pz: P[2] + rel[2] * c + T[2] * sn * h,
        nx: n[0], ny: n[1], nz: n[2],
        v: uvo.rotate ? src.v : src.v + vStep * (k / rings),
        u: uvo.rotate ? src.u + vStep * (k / rings) : src.u,
        ao: src.ao,
      };
      cur.push(acc.addVertex(vv));
    }
    if (prev.length) {
      for (let j = 0; j < sides; j++) {
        acc.addTriangle(prev[j] as number, prev[j + 1] as number, cur[j] as number);
        acc.addTriangle(prev[j + 1] as number, cur[j + 1] as number, cur[j] as number);
      }
    }
    prev = cur;
  }
  const apex = acc.addVertex({
    ...ref,
    px: P[0] + T[0] * h, py: P[1] + T[1] * h, pz: P[2] + T[2] * h,
    nx: T[0], ny: T[1], nz: T[2],
    u: uvo.rotate ? ref.u + vStep : ref.u + 0.5,
    v: uvo.rotate ? ref.v + 0.5 : ref.v + vStep,
    tw: 1,
  });
  for (let j = 0; j < sides; j++) acc.addTriangle(prev[j] as number, prev[j + 1] as number, apex);
}

function emitBaseCap(acc: MeshAccumulator, grid: VertexAttrs[], sm: Samples, V: number, sides: number): void {
  const P: V3 = [sm.pos[0] as number, sm.pos[1] as number, sm.pos[2] as number];
  const T: V3 = [sm.tan[0] as number, sm.tan[1] as number, sm.tan[2] as number];
  const ref = grid[0] as VertexAttrs;
  const center = acc.addVertex({ ...ref, px: P[0], py: P[1], pz: P[2], nx: -T[0], ny: -T[1], nz: -T[2], u: 0.5, v: 0.5, tw: 1 });
  const ring: number[] = [];
  for (let j = 0; j < V; j++) {
    const src = grid[j] as VertexAttrs;
    const a = (2 * Math.PI * (j % sides)) / sides;
    ring.push(acc.addVertex({ ...src, nx: -T[0], ny: -T[1], nz: -T[2], u: 0.5 + 0.5 * Math.cos(a), v: 0.5 + 0.5 * Math.sin(a) }));
  }
  for (let j = 0; j < sides; j++) acc.addTriangle(center, ring[j + 1] as number, ring[j] as number);
}
