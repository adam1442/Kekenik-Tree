/**
 * Fused crotch mesh (pure geometry). The shared body of a split is ONE skin with pair-of-pants topology: the parent's ring of N
 * vertices morphs, over `rings` rings, from a circle into a figure-8 and finally into two tangent circles of N / 2 vertices each.
 *
 * Cross-section of every ring = the OUTER arcs of the two lobe circles between their two intersection points A and B (the pinch
 * points on the +-y side). A and B belong to both arcs, so the outline has exactly N vertices:
 *   j = 0 (A), 1 .. N/2 - 1 (lobe 1 arc), N/2 (B), N/2 + 1 .. N - 1 (lobe 2 arc).
 * At s = 0 the circles coincide (each arc is 180 degrees, the ring is the parent's circle with vertex 0 on +y), at s = 1 they are
 * tangent: A and B merge into the crotch vertex C and the last ring is two closed rings of N / 2 vertices that share C.
 *
 * Vertex j keeps its U for the whole transition (the mesher maps outline vertex j to parent vertex `(j + phase) mod N`). No
 * randomness, no globals: the same input gives the same mesh.
 */
import { valleyAoFactor } from './crotchShading';
import { buildForkOutline, forkOutlineArea } from './forkOutline';
import { isSplitShapeNeutral, splitShapeOf, type SplitShape, type Vec3 } from './splitMath';
import { splitRingParam } from './splitModel';

/** Below this radial count the crease and bend relaxations are skipped (plain welded blend, still watertight). */
export const CROTCH_MIN_RELAX_SIDES = 6;
/** The outer relaxation never moves a vertex along the axis by more than this fraction of the ring spacing. */
export const CROTCH_OUTER_AXIAL_LIMIT = 0.1;

export interface CrotchInput {
  /** Requested radial count; rounded up to an even number >= 4 (see {@link evenSides}). */
  sides: number;
  /** Number of rings (>= 3), ring 0 = start of the transition, last ring = the two open ends. */
  rings: number;
  /** Lobe centre paths, `rings * 3` each. Ring 0 of both is the shared axis point. */
  centre1: ArrayLike<number>;
  centre2: ArrayLike<number>;
  /** Parent radius at s = 0 and the two child radii at s = 1. */
  radius0: number;
  radius1: number;
  radius2: number;
  /** Expand Side 1 / 2: lobe radius multiplier in the middle of the transition (1 at both ends; default 1). */
  expand1?: number;
  expand2?: number;
  /** Unit tangent of the parent at s = 0 and the unit tangents of the two lobes at s = 1. */
  startTangent: Vec3;
  endTangent1: Vec3;
  endTangent2: Vec3;
  /** Divergence axis at s = 0 (towards lobe 1). Vertex 0 sits on `divergence x startTangent`, the lobes leave along `divergence`. */
  divergence: Vec3;
  /** Smooth > Inner / Outer, 0..1 (defaults 0). */
  innerSmooth?: number;
  outerSmooth?: number;
  /** Cyclic shift of the parent's vertex numbering (only used for `cornerU`, default 0). */
  phase?: number;
  /**
   * The parent's real last ring (`N * 3`, outline column order: column j = parent vertex `(j + phase) mod N`). When the parent
   * skin is displaced, squashed or not round, the difference to the ideal ring is carried into the transition and fades out with
   * a smoothstep, so ring 0 equals the parent's ring exactly and the open ends stay clean circles.
   */
  ring0Positions?: ArrayLike<number>;
  /**
   * Fork shape (T08: waist, neck swell, valley fillet, ridge, stretch, ease). Missing or neutral = the former cusp outline, byte for
   * byte. Any other value builds each inner ring from the smooth figure-8 of `forkOutline.ts`; the rings must then sit at the
   * positions of `splitRingParam(k / (rings - 1), shape.ringBias)` along the lobe paths (what `planSplit` produces).
   */
  shape?: Partial<SplitShape>;
  /**
   * T09: displaces the finished ring positions in place (bark / fine / shape / flares), called once after the outline of every ring is
   * final and before the triangles and normals are built, so the normals are smooth over the displaced surface. When set, the open-end
   * ring keeps the normals of the displaced faces (no analytic cylinder normal): the extension that continues it shares them.
   */
  displace?: (grid: CrotchGridView) => void;
}

/** Mutable view of the crotch vertices handed to {@link CrotchInput.displace}. */
export interface CrotchGridView {
  sides: number;
  rings: number;
  vertexCount: number;
  positions: Float32Array;
  vertexRing: Uint32Array;
  vertexColumn: Uint16Array;
}

export interface CrotchMesh {
  /** Even radial count N (>= 4). */
  sides: number;
  rings: number;
  vertexCount: number;
  /** Vertex positions (xyz). Ring k < rings - 1 owns N vertices; the last ring owns N - 1 (A and B are one vertex). */
  positions: Float32Array;
  /** Smooth unit normals (area weighted). */
  normals: Float32Array;
  /** Ring of every vertex and its outline column j (the merged crotch vertex is column 0). */
  vertexRing: Uint32Array;
  vertexColumn: Uint16Array;
  /** Triangles, 3 indices each (Uint32 always: one array for the single material). */
  indices: Uint32Array;
  /**
   * U code of every index entry: the parent vertex number `0 .. N` the corner takes its U from (`phase` applied; N = the seam
   * copy of vertex 0). Corners that share a vertex but have different codes need separate UV vertices (seam, crotch).
   */
  cornerU: Uint16Array;
  /** Normal of every index entry (3 floats): the shared vertex normal, or the lobe's own at a creased pinch vertex (Smooth > Inner < 1). */
  cornerNormals: Float32Array;
  /**
   * 0 = the corner uses the shared vertex. 1 / 2 = split normal fan of lobe 1 / 2 at a pinch vertex. The merged crotch vertex always
   * has two copies (valley side A: 1 .. 3, side B: 4 .. 6; the second and third id of a side are its lobe fans).
   */
  cornerFan: Uint8Array;
  /** AO factor of every vertex (1 = open); only the figure-8 outline darkens the valley. */
  valleyAo: Float32Array;
}

/** Even radial count >= 4 at or above `n` (odd counts and fractions are rounded up, NaN gives 4). */
export function evenSides(n: number): number {
  if (!Number.isFinite(n)) return 4;
  return Math.max(4, 2 * Math.ceil(n / 2 - 1e-9));
}

/** Smallest radial count of a splitting parent (below 6 the lobe rings would be digons). */
export const SPLIT_MIN_SIDES = 6;
/** Fewest rings of the shared transition (crotch) at any LOD; the plan always makes more (the lobes are not LOD-reduced). */
export const SPLIT_MIN_TRANSITION_RINGS = 4;

/**
 * The radial count a splitting parent really gets: even and at least {@link SPLIT_MIN_SIDES}. Always evaluated AFTER the
 * Resolution curve, Segments > Radial scalar, displacement subdivision and Dynamic LOD have produced their number, never before.
 */
export function effectiveSplitSides(n: number): number {
  return Math.max(SPLIT_MIN_SIDES, evenSides(n));
}

/** Index of outline vertex `j` of ring `k` (A and B are one vertex in the last ring). */
export function crotchVertexIndex(sides: number, rings: number, k: number, j: number): number {
  const jj = ((j % sides) + sides) % sides;
  if (k < rings - 1) return k * sides + jj;
  const half = sides / 2;
  const slot = jj === half ? 0 : jj > half ? jj - 1 : jj;
  return (rings - 1) * sides + slot;
}

const smooth01 = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
};

/** Weight of the crease fill along the transition: C1 zero start, plateau of 1, back to 0 so the crotch stays a single point. */
export function creaseFillWeight(t: number): number {
  return smooth01(t / 0.35) * (1 - smooth01((t - 0.75) / 0.25));
}

/**
 * Hump 0 .. 1 .. 0 over the transition: `t^q1 (1 - t)^q2` with its peak at `peak`, normalised to 1, zero slope at both ends. The
 * high start exponent keeps the first 15 % of the transition flat (G1 with the parent's ring).
 */
export function humpProfile(t: number, peak: number, q1: number): number {
  const q2 = (q1 * (1 - peak)) / peak;
  const x = Math.min(1, Math.max(0, t));
  return (Math.pow(x, q1) * Math.pow(1 - x, q2)) / (Math.pow(peak, q1) * Math.pow(1 - peak, q2));
}
/** Neck swell: just before the fork. Stretch (ovalisation): early, but still flat at the start. */
export const swellProfile = (t: number): number => humpProfile(t, 0.55, 4);
export const stretchProfile = (t: number): number => humpProfile(t, 0.45, 7);

const norm3 = (x: number, y: number, z: number, fx: number, fy: number, fz: number): Vec3 => {
  const l = Math.hypot(x, y, z);
  return l < 1e-12 ? [fx, fy, fz] : [x / l, y / l, z / l];
};

interface Frames {
  tan: Float64Array;
  x: Float64Array;
  y: Float64Array;
}

/** Tangent and rotation-minimising (x, y) frame along a lobe path; (x, y) at ring 0 = (divergence, divergence x tangent). */
function lobeFrames(centre: ArrayLike<number>, rings: number, t0: Vec3, tEnd: Vec3, d: Vec3): Frames {
  const tan = new Float64Array(rings * 3);
  const x = new Float64Array(rings * 3);
  const y = new Float64Array(rings * 3);
  for (let k = 0; k < rings; k++) {
    let t: Vec3;
    if (k === 0) t = t0;
    else if (k === rings - 1) t = tEnd;
    else {
      const a = k - 1;
      const b = k + 1;
      t = norm3(
        (centre[b * 3] as number) - (centre[a * 3] as number),
        (centre[b * 3 + 1] as number) - (centre[a * 3 + 1] as number),
        (centre[b * 3 + 2] as number) - (centre[a * 3 + 2] as number),
        t0[0], t0[1], t0[2],
      );
    }
    tan[k * 3] = t[0]; tan[k * 3 + 1] = t[1]; tan[k * 3 + 2] = t[2];
  }
  const T0x = tan[0] as number, T0y = tan[1] as number, T0z = tan[2] as number;
  const dd = d[0] * T0x + d[1] * T0y + d[2] * T0z;
  const x0 = norm3(d[0] - T0x * dd, d[1] - T0y * dd, d[2] - T0z * dd, 1, 0, 0);
  // y0 = x0 x T0, so that T x y-vertex order matches the tube mesher (vertex j at cos(a) n + sin(a) (T x n), n = y0, T x n = x0).
  const y0: Vec3 = [x0[1] * T0z - x0[2] * T0y, x0[2] * T0x - x0[0] * T0z, x0[0] * T0y - x0[1] * T0x];
  x.set(x0, 0);
  y.set(y0, 0);
  for (let k = 1; k < rings; k++) {
    const px = tan[(k - 1) * 3] as number, py = tan[(k - 1) * 3 + 1] as number, pz = tan[(k - 1) * 3 + 2] as number;
    const cx = tan[k * 3] as number, cy = tan[k * 3 + 1] as number, cz = tan[k * 3 + 2] as number;
    const ax = py * cz - pz * cy, ay = pz * cx - px * cz, az = px * cy - py * cx;
    const sinA = Math.hypot(ax, ay, az);
    const cosA = px * cx + py * cy + pz * cz;
    for (const arr of [x, y]) {
      const vx = arr[(k - 1) * 3] as number, vy = arr[(k - 1) * 3 + 1] as number, vz = arr[(k - 1) * 3 + 2] as number;
      let ox = vx, oy = vy, oz = vz;
      if (sinA > 1e-9) {
        const ux = ax / sinA, uy = ay / sinA, uz = az / sinA;
        const ang = Math.atan2(sinA, cosA);
        const c = Math.cos(ang), s = Math.sin(ang);
        const dt = (ux * vx + uy * vy + uz * vz) * (1 - c);
        ox = vx * c + (uy * vz - uz * vy) * s + ux * dt;
        oy = vy * c + (uz * vx - ux * vz) * s + uy * dt;
        oz = vz * c + (ux * vy - uy * vx) * s + uz * dt;
      }
      // Re-orthogonalise against the new tangent so errors never accumulate.
      const od = ox * cx + oy * cy + oz * cz;
      const n = norm3(ox - cx * od, oy - cy * od, oz - cz * od, 1, 0, 0);
      arr[k * 3] = n[0]; arr[k * 3 + 1] = n[1]; arr[k * 3 + 2] = n[2];
    }
  }
  return { tan, x, y };
}

/** Builds the fused crotch mesh. */
export function buildCrotchMesh(input: CrotchInput): CrotchMesh {
  const N = evenSides(input.sides);
  const half = N / 2;
  const rings = Math.max(3, Math.floor(input.rings));
  const last = rings - 1;
  const M = half + 1;
  const vertexCount = last * N + (N - 1);
  const pos = new Float32Array(vertexCount * 3);
  const c1 = input.centre1;
  const c2 = input.centre2;
  const f1 = lobeFrames(c1, rings, input.startTangent, input.endTangent1, input.divergence);
  const f2 = lobeFrames(c2, rings, input.startTangent, input.endTangent2, input.divergence);
  const expand1 = Math.max(0.05, input.expand1 ?? 1);
  const expand2 = Math.max(0.05, input.expand2 ?? 1);
  const R0 = Math.max(1e-9, input.radius0);
  const shape = splitShapeOf(input.shape);
  const peanut = !isSplitShapeNeutral(shape);
  const ringBias = peanut ? shape.ringBias : 0;
  const aoWork = new Float64Array(rings * N).fill(1);
  // Axial distance of every ring from ring 0 (midpoint of the lobe centres): the ridge fades into the parent along it.
  const axialS = new Float64Array(rings);
  for (let k = 1; k < rings; k++) {
    let d2 = 0;
    for (let a = 0; a < 3; a++) {
      const m1 = ((c1[k * 3 + a] as number) + (c2[k * 3 + a] as number)) / 2;
      const m0 = ((c1[(k - 1) * 3 + a] as number) + (c2[(k - 1) * 3 + a] as number)) / 2;
      d2 += (m1 - m0) * (m1 - m0);
    }
    axialS[k] = (axialS[k - 1] as number) + Math.sqrt(d2);
  }

  // Full N-vertex working rings (the last ring is packed into `pos` at the end).
  const work = new Float64Array(rings * N * 3);
  const centre = new Float64Array(rings * 3);
  const axial = new Float64Array(rings * 3);
  const ringT = new Float64Array(rings);

  for (let k = 0; k < rings; k++) {
    const t = peanut ? splitRingParam(k / last, ringBias) : k / last;
    ringT[k] = t;
    const e = smooth01(peanut ? Math.pow(t, 1 + shape.ease) : t);
    const bump = (27 / 4) * t * t * (1 - t);
    const rho1 = (R0 + (input.radius1 - R0) * e) * (1 + (expand1 - 1) * bump);
    const rho2 = (R0 + (input.radius2 - R0) * e) * (1 + (expand2 - 1) * bump);
    const o = k * 3;
    const p1x = c1[o] as number, p1y = c1[o + 1] as number, p1z = c1[o + 2] as number;
    const p2x = c2[o] as number, p2y = c2[o + 1] as number, p2z = c2[o + 2] as number;
    const x1: Vec3 = [f1.x[o] as number, f1.x[o + 1] as number, f1.x[o + 2] as number];
    const y1: Vec3 = [f1.y[o] as number, f1.y[o + 1] as number, f1.y[o + 2] as number];
    const x2: Vec3 = [f2.x[o] as number, f2.x[o + 1] as number, f2.x[o + 2] as number];
    const y2: Vec3 = [f2.y[o] as number, f2.y[o + 1] as number, f2.y[o + 2] as number];
    const tm = norm3((f1.tan[o] as number) + (f2.tan[o] as number), (f1.tan[o + 1] as number) + (f2.tan[o + 1] as number), (f1.tan[o + 2] as number) + (f2.tan[o + 2] as number), 0, 0, 1);
    axial[o] = tm[0]; axial[o + 1] = tm[1]; axial[o + 2] = tm[2];
    centre[o] = (p1x + p2x) / 2; centre[o + 1] = (p1y + p2y) / 2; centre[o + 2] = (p1z + p2z) / 2;

    // Centre distance across the ring (mean lobe x axis), clamped so the circles always intersect (exactly tangent at s = 1).
    const xm = norm3(x1[0] + x2[0], x1[1] + x2[1], x1[2] + x2[2], x1[0], x1[1], x1[2]);
    const dRaw = (p1x - p2x) * xm[0] + (p1y - p2y) * xm[1] + (p1z - p2z) * xm[2];
    if (peanut && k > 0 && k < last) {
      const q1 = rho1 * (1 + shape.neckSwell * swellProfile(t));
      const q2 = rho2 * (1 + shape.neckSwell * swellProfile(t));
      const rMin = Math.min(q1, q2);
      // Separation: the path's own, delayed at the start (G1 with the parent) and eased towards a late, sudden pinch.
      const sigma = Math.min(1, Math.max(0, dRaw / (rho1 + rho2)));
      const dEff = (q1 + q2) * Math.pow(sigma, 1 + 2 * shape.ease) * smooth01(t / 0.5) ** 2;
      const waistNow = 1 - (1 - shape.waist) * Math.sin(Math.PI * t) ** 2;
      const rf = shape.valleyRadius * rMin * (1 - smooth01((t - 0.6) / 0.4));
      const toEnd = (axialS[last] as number) - (axialS[k] as number);
      const ridgeW = smooth01(1 - toEnd / (shape.ridgeLength * R0)) * smooth01(t / 0.2) * (1 - smooth01((t - 0.75) / 0.25));
      const outline = buildForkOutline({
        r1: q1,
        r2: q2,
        distance: dEff,
        fillet: rf,
        ...(shape.waist < 1 ? { neckHalf: waistNow * rMin, neckBlend: smooth01((t - 0.25) / 0.25) } : {}),
        ridgeHeight: shape.ridge * rMin * ridgeW,
        ridgeWidth: Math.max(rf, 0.25 * rMin),
        stretch: 1 + (shape.stretch - 1) * stretchProfile(t),
        half,
      });
      // Pipe model: a narrow waist pushes two full lobes apart, which adds area. The ring is scaled down (never up) so its area
      // follows the blend from the parent's cross-section to the sum of the lobes (times the swell).
      const swellNow = 1 + shape.neckSwell * swellProfile(t);
      const areaWanted = Math.PI * ((1 - e) * R0 * R0 + e * (input.radius1 * input.radius1 + input.radius2 * input.radius2)) * swellNow * swellNow;
      const fit = Math.min(1, Math.sqrt(areaWanted / Math.max(1e-18, forkOutlineArea(outline))));
      if (fit < 1) {
        for (const arr of [outline.x1, outline.y1, outline.x2, outline.y2]) for (let i = 0; i < arr.length; i++) arr[i] = (arr[i] as number) * fit;
      }
      const Dp = outline.distance * fit;
      const shift = (Dp - dRaw) / 2;
      const base3 = k * N * 3;
      const aoWidth = Math.max(rf, 0.35 * rMin);
      const P1 = new Float64Array(M * 3);
      const P2 = new Float64Array(M * 3);
      for (let i = 0; i < M; i++) {
        const u1 = outline.x1[i] as number, v1 = outline.y1[i] as number;
        const u2 = (outline.x2[i] as number) + Dp, v2 = outline.y2[i] as number;
        for (let a = 0; a < 3; a++) {
          P1[i * 3 + a] = [p1x, p1y, p1z][a]! + shift * xm[a]! + u1 * x1[a]! + v1 * y1[a]!;
          P2[i * 3 + a] = [p2x, p2y, p2z][a]! - shift * xm[a]! + u2 * x2[a]! + v2 * y2[a]!;
        }
      }
      for (let a = 0; a < 3; a++) {
        const A = ((P1[a] as number) + (P2[(M - 1) * 3 + a] as number)) / 2;
        const B = ((P1[(M - 1) * 3 + a] as number) + (P2[a] as number)) / 2;
        const dA1 = A - (P1[a] as number), dB1 = B - (P1[(M - 1) * 3 + a] as number);
        const dB2 = B - (P2[a] as number), dA2 = A - (P2[(M - 1) * 3 + a] as number);
        for (let i = 0; i < M; i++) {
          const f = i / (M - 1);
          work[base3 + i * 3 + a] = (P1[i * 3 + a] as number) + (1 - f) * dA1 + f * dB1;
          if (i > 0 && i < M - 1) work[base3 + (half + i) * 3 + a] = (P2[i * 3 + a] as number) + (1 - f) * dB2 + f * dA2;
        }
      }
      for (let i = 0; i < M; i++) {
        aoWork[k * N + i] = valleyAoFactor(outline.d1[i] as number, aoWidth, t, shape.includedBark);
        if (i > 0 && i < M - 1) aoWork[k * N + half + i] = valleyAoFactor(outline.d2[i] as number, aoWidth, t, shape.includedBark);
      }
      continue;
    }
    let D = Math.min(rho1 + rho2, Math.max(dRaw, 1.05 * Math.abs(rho1 - rho2)));
    if (k === last) D = rho1 + rho2;
    if (k === 0) D = 0;
    let pOff: number;
    let h: number;
    if (D < 1e-9 * (rho1 + rho2)) {
      pOff = D / 2;
      h = Math.sqrt(Math.max(0, rho1 * rho1 - pOff * pOff));
    } else {
      pOff = (D * D + rho1 * rho1 - rho2 * rho2) / (2 * D);
      h = Math.sqrt(Math.max(0, rho1 * rho1 - pOff * pOff));
    }
    const xA = D - pOff;
    const alpha1 = Math.atan2(h, -pOff);
    const beta2 = Math.atan2(h, xA);

    const point = (cx: number, cy: number, cz: number, rho: number, x: Vec3, y: Vec3, th: number, out: Float64Array, at: number): void => {
      const c = Math.cos(th) * rho;
      const s = Math.sin(th) * rho;
      out[at] = cx + x[0] * c + y[0] * s;
      out[at + 1] = cy + x[1] * c + y[1] * s;
      out[at + 2] = cz + x[2] * c + y[2] * s;
    };
    const tmp = new Float64Array(12);
    point(p1x, p1y, p1z, rho1, x1, y1, alpha1, tmp, 0); // A on lobe 1
    point(p1x, p1y, p1z, rho1, x1, y1, -alpha1, tmp, 3); // B on lobe 1
    point(p2x, p2y, p2z, rho2, x2, y2, beta2 - 2 * Math.PI, tmp, 6); // A on lobe 2
    point(p2x, p2y, p2z, rho2, x2, y2, -beta2, tmp, 9); // B on lobe 2
    const Ax = (tmp[0]! + tmp[6]!) / 2, Ay = (tmp[1]! + tmp[7]!) / 2, Az = (tmp[2]! + tmp[8]!) / 2;
    const Bx = (tmp[3]! + tmp[9]!) / 2, By = (tmp[4]! + tmp[10]!) / 2, Bz = (tmp[5]! + tmp[11]!) / 2;
    const base = k * N * 3;

    // Lobe 1 arc: j = 0 (A) .. N/2 (B), angle alpha1 -> -alpha1.
    for (let i = 0; i < M; i++) {
      const f = i / (M - 1);
      const at = base + i * 3;
      point(p1x, p1y, p1z, rho1, x1, y1, alpha1 * (1 - 2 * f), work, at);
      work[at] = (work[at] as number) + (1 - f) * (Ax - tmp[0]!) + f * (Bx - tmp[3]!);
      work[at + 1] = (work[at + 1] as number) + (1 - f) * (Ay - tmp[1]!) + f * (By - tmp[4]!);
      work[at + 2] = (work[at + 2] as number) + (1 - f) * (Az - tmp[2]!) + f * (Bz - tmp[5]!);
    }
    // Lobe 2 arc interior: j = N/2 + i, i = 1 .. M - 2, angle -beta2 -> beta2 - 2 pi (clockwise).
    for (let i = 1; i < M - 1; i++) {
      const f = i / (M - 1);
      const at = base + (half + i) * 3;
      point(p2x, p2y, p2z, rho2, x2, y2, -beta2 - f * (2 * Math.PI - 2 * beta2), work, at);
      work[at] = (work[at] as number) + (1 - f) * (Bx - tmp[9]!) + f * (Ax - tmp[6]!);
      work[at + 1] = (work[at + 1] as number) + (1 - f) * (By - tmp[10]!) + f * (Ay - tmp[7]!);
      work[at + 2] = (work[at + 2] as number) + (1 - f) * (Bz - tmp[11]!) + f * (Az - tmp[8]!);
    }
  }

  // The parent's real last ring: carry its deviation from the ideal circle into the transition (fades out, zero at the open ends).
  if (input.ring0Positions) {
    const g = input.ring0Positions;
    for (let j = 0; j < N; j++) {
      const dx = (g[j * 3] as number) - (work[j * 3] as number);
      const dy = (g[j * 3 + 1] as number) - (work[j * 3 + 1] as number);
      const dz = (g[j * 3 + 2] as number) - (work[j * 3 + 2] as number);
      for (let k = 0; k < last; k++) {
        const w = 1 - smooth01(ringT[k] as number);
        const at = (k * N + j) * 3;
        work[at] = (work[at] as number) + dx * w;
        work[at + 1] = (work[at + 1] as number) + dy * w;
        work[at + 2] = (work[at + 2] as number) + dz * w;
      }
    }
  }

  // Smooth > Outer: relax the outer arc vertices between neighbouring rings, axial move limited to 10% of the ring spacing.
  const outer = Math.min(1, Math.max(0, input.outerSmooth ?? 0));
  const inner = Math.min(1, Math.max(0, input.innerSmooth ?? 0));
  if (N >= CROTCH_MIN_RELAX_SIDES && outer > 0) {
    let spacing = 0;
    for (let k = 1; k < rings; k++) spacing += Math.hypot((centre[k * 3] as number) - (centre[(k - 1) * 3] as number), (centre[k * 3 + 1] as number) - (centre[(k - 1) * 3 + 1] as number), (centre[k * 3 + 2] as number) - (centre[(k - 1) * 3 + 2] as number));
    spacing /= last;
    const limit = CROTCH_OUTER_AXIAL_LIMIT * spacing;
    const src = work.slice();
    for (let k = 1; k < last; k++) {
      const w = 0.5 * outer * Math.sin(Math.PI * ringT[k]!);
      for (let j = 0; j < N; j++) {
        const fromPinch = Math.min(j % half, half - (j % half));
        if (fromPinch < 2) continue;
        const a = ((k - 1) * N + j) * 3;
        const b = ((k + 1) * N + j) * 3;
        const m = (k * N + j) * 3;
        const dx = w * (((src[a] as number) + (src[b] as number)) / 2 - (src[m] as number));
        const dy = w * (((src[a + 1] as number) + (src[b + 1] as number)) / 2 - (src[m + 1] as number));
        const dz = w * (((src[a + 2] as number) + (src[b + 2] as number)) / 2 - (src[m + 2] as number));
        const tx = axial[k * 3] as number, ty = axial[k * 3 + 1] as number, tz = axial[k * 3 + 2] as number;
        const along = dx * tx + dy * ty + dz * tz;
        const clamped = Math.max(-limit, Math.min(limit, along));
        const fix = clamped - along;
        work[m] = (src[m] as number) + dx + tx * fix;
        work[m + 1] = (src[m + 1] as number) + dy + ty * fix;
        work[m + 2] = (src[m + 2] as number) + dz + tz * fix;
      }
    }
  }

  // Smooth > Inner: fill the crease. The pinch vertices are pushed outwards (towards the chord of their ring neighbours) and the
  // neighbours are relaxed along the ring first; the weight is zero at both ends of the transition (C1 start, single crotch point).
  if (N >= CROTCH_MIN_RELAX_SIDES && inner > 0) {
    for (let k = 1; k < last; k++) {
      const w = inner * creaseFillWeight(ringT[k]!);
      if (w <= 0) continue;
      for (const pinch of [0, half]) {
        const idx = (j: number): number => (k * N + ((j + N) % N)) * 3;
        const prev = idx(pinch - 1);
        const next = idx(pinch + 1);
        const pi = idx(pinch);
        for (const [v, a, b] of [[prev, idx(pinch - 2), pi], [next, pi, idx(pinch + 2)]] as const) {
          for (let c = 0; c < 3; c++) work[v + c] = (work[v + c] as number) + 0.5 * w * (((work[a + c] as number) + (work[b + c] as number)) / 2 - (work[v + c] as number));
        }
        const mx = ((work[prev] as number) + (work[next] as number)) / 2;
        const my = ((work[prev + 1] as number) + (work[next + 1] as number)) / 2;
        const mz = ((work[prev + 2] as number) + (work[next + 2] as number)) / 2;
        const ox = (work[pi] as number) - (centre[k * 3] as number);
        const oy = (work[pi + 1] as number) - (centre[k * 3 + 1] as number);
        const oz = (work[pi + 2] as number) - (centre[k * 3 + 2] as number);
        // Outward = away from the ring centre; only lift (never dig into) the vertex.
        const lift = (mx - (work[pi] as number)) * ox + (my - (work[pi + 1] as number)) * oy + (mz - (work[pi + 2] as number)) * oz;
        if (lift > 0) {
          work[pi] = (work[pi] as number) + w * (mx - (work[pi] as number));
          work[pi + 1] = (work[pi + 1] as number) + w * (my - (work[pi + 1] as number));
          work[pi + 2] = (work[pi + 2] as number) + w * (mz - (work[pi + 2] as number));
        }
      }
    }
  }

  // Pack into the vertex array (the last ring drops B, it is the same vertex as A).
  const vertexRing = new Uint32Array(vertexCount);
  const vertexColumn = new Uint16Array(vertexCount);
  const valleyAo = new Float32Array(vertexCount).fill(1);
  for (let k = 0; k < rings; k++) {
    for (let j = 0; j < N; j++) {
      if (k === last && j === half) continue;
      const v = crotchVertexIndex(N, rings, k, j);
      const s = (k * N + j) * 3;
      pos[v * 3] = work[s] as number;
      pos[v * 3 + 1] = work[s + 1] as number;
      pos[v * 3 + 2] = work[s + 2] as number;
      vertexRing[v] = k;
      vertexColumn[v] = j;
      valleyAo[v] = aoWork[k * N + j] as number;
    }
  }

  input.displace?.({ sides: N, rings, vertexCount, positions: pos, vertexRing, vertexColumn });

  // Triangles: one quad per (row, column), two triangles; the same winding as the tube mesher.
  const phase = ((Math.round(input.phase ?? 0) % N) + N) % N;
  const rows = last;
  const indices = new Uint32Array(rows * N * 6);
  const cornerU = new Uint16Array(rows * N * 6);
  let ni = 0;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < N; j++) {
      const a0 = crotchVertexIndex(N, rings, i, j);
      const a1 = crotchVertexIndex(N, rings, i, j + 1);
      const b0 = crotchVertexIndex(N, rings, i + 1, j);
      const b1 = crotchVertexIndex(N, rings, i + 1, j + 1);
      let pa = j + phase;
      if (pa >= N) pa -= N;
      const pb = pa + 1;
      const quad = [a0, a1, b0, a1, b1, b0];
      const code = [pa, pb, pa, pb, pb, pa];
      for (let q = 0; q < 6; q++) {
        indices[ni] = quad[q] as number;
        cornerU[ni] = code[q] as number;
        ni++;
      }
    }
  }

  // Normals on the LOGICAL vertex set (A, B and the crotch vertex C count once): face normal x area x corner angle summed over every
  // incident triangle. The pinch columns (A, B, C) additionally get one sum per lobe side (the split normal fan) for Smooth > Inner.
  const half2 = N / 2;
  const isPinch = new Uint8Array(vertexCount);
  for (let v = 0; v < vertexCount; v++) {
    const c = vertexColumn[v] as number;
    if (c === 0 || c === half2) isPinch[v] = 1;
  }
  const acc = new Float64Array(vertexCount * 3);
  // Per pinch vertex: 4 normal groups (lobe x side). Only the merged crotch vertex C uses the side index (A side / B side of the valley).
  const fanAcc = new Float64Array(vertexCount * 12);
  const cVertex = crotchVertexIndex(N, rings, rings - 1, 0);
  const corner = [0, 0, 0];
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] as number, ib = indices[t + 1] as number, ic = indices[t + 2] as number;
    const quadJ = Math.floor(t / 6) % N;
    const lobe = quadJ < half2 ? 0 : 1;
    const side = quadJ === N - 1 || quadJ === 0 ? 0 : quadJ === half2 - 1 || quadJ === half2 ? 1 : 0;
    const a = ia * 3, b = ib * 3, c = ic * 3;
    const e1x = (pos[b] as number) - (pos[a] as number), e1y = (pos[b + 1] as number) - (pos[a + 1] as number), e1z = (pos[b + 2] as number) - (pos[a + 2] as number);
    const e2x = (pos[c] as number) - (pos[a] as number), e2y = (pos[c + 1] as number) - (pos[a + 1] as number), e2z = (pos[c + 2] as number) - (pos[a + 2] as number);
    const e3x = (pos[c] as number) - (pos[b] as number), e3y = (pos[c + 1] as number) - (pos[b + 1] as number), e3z = (pos[c + 2] as number) - (pos[b + 2] as number);
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l1 = Math.hypot(e1x, e1y, e1z), l2 = Math.hypot(e2x, e2y, e2z), l3 = Math.hypot(e3x, e3y, e3z);
    if (l1 < 1e-12 || l2 < 1e-12 || l3 < 1e-12) continue;
    const angle = (ux: number, uy: number, uz: number, ul: number, wx: number, wy: number, wz: number, wl: number): number =>
      Math.acos(Math.min(1, Math.max(-1, (ux * wx + uy * wy + uz * wz) / (ul * wl))));
    corner[0] = angle(e1x, e1y, e1z, l1, e2x, e2y, e2z, l2);
    corner[1] = angle(-e1x, -e1y, -e1z, l1, e3x, e3y, e3z, l3);
    corner[2] = Math.PI - (corner[0] as number) - (corner[1] as number);
    for (let k = 0; k < 3; k++) {
      const v = k === 0 ? ia : k === 1 ? ib : ic;
      const w = corner[k] as number;
      acc[v * 3] = (acc[v * 3] as number) + nx * w;
      acc[v * 3 + 1] = (acc[v * 3 + 1] as number) + ny * w;
      acc[v * 3 + 2] = (acc[v * 3 + 2] as number) + nz * w;
      if (isPinch[v]) {
        const o = v * 12 + (lobe + (v === cVertex ? 2 * side : 0)) * 3;
        fanAcc[o] = (fanAcc[o] as number) + nx * w;
        fanAcc[o + 1] = (fanAcc[o + 1] as number) + ny * w;
        fanAcc[o + 2] = (fanAcc[o + 2] as number) + nz * w;
      }
    }
  }
  const normals = new Float32Array(vertexCount * 3);
  for (let v = 0; v < vertexCount; v++) {
    const n = norm3(acc[v * 3] as number, acc[v * 3 + 1] as number, acc[v * 3 + 2] as number, 0, 0, 1);
    normals[v * 3] = n[0]; normals[v * 3 + 1] = n[1]; normals[v * 3 + 2] = n[2];
  }
  // The shared normal of C is only a fallback (the corners use their side's normal): use the A side so it is never a cancelled average.
  {
    const o = cVertex * 12;
    const a = norm3((fanAcc[o] as number) + (fanAcc[o + 3] as number), (fanAcc[o + 1] as number) + (fanAcc[o + 4] as number), (fanAcc[o + 2] as number) + (fanAcc[o + 5] as number), normals[cVertex * 3] as number, normals[cVertex * 3 + 1] as number, normals[cVertex * 3 + 2] as number);
    normals[cVertex * 3] = a[0]; normals[cVertex * 3 + 1] = a[1]; normals[cVertex * 3 + 2] = a[2];
  }
  // Open-end ring: the analytic cylinder normal of each lobe (the extension that continues the open end starts from the same normal).
  for (let j = 0; j < N && !input.displace; j++) {
    if (j === 0 || j === half2) continue;
    const lobeIndex = j < half2 ? 1 : 2;
    const c = lobeIndex === 1 ? input.centre1 : input.centre2;
    const T = lobeIndex === 1 ? input.endTangent1 : input.endTangent2;
    const v = crotchVertexIndex(N, rings, rings - 1, j);
    const cc = (rings - 1) * 3;
    const rx = (pos[v * 3] as number) - (c[cc] as number), ry = (pos[v * 3 + 1] as number) - (c[cc + 1] as number), rz = (pos[v * 3 + 2] as number) - (c[cc + 2] as number);
    const d = rx * T[0] + ry * T[1] + rz * T[2];
    const a = norm3(rx - T[0] * d, ry - T[1] * d, rz - T[2] * d, normals[v * 3] as number, normals[v * 3 + 1] as number, normals[v * 3 + 2] as number);
    normals[v * 3] = a[0]; normals[v * 3 + 1] = a[1]; normals[v * 3 + 2] = a[2];
  }
  // A filleted valley (T08) has no crease: its normals are always smooth across the pinch columns.
  const innerBase = Math.min(1, Math.max(0, Number.isFinite(input.innerSmooth) ? (input.innerSmooth as number) : 0));
  const innerNormals = peanut && shape.valleyRadius > 0 ? Math.max(innerBase, Math.min(1, shape.valleyRadius * 4)) : innerBase;
  const innerForNormals = innerBase;
  relaxNormals(normals, indices, vertexRing, vertexColumn, N, rings, isPinch, 4 + Math.round(12 * innerForNormals), 1 + Math.round(innerForNormals), crotchVertexIndex(N, rings, rings - 1, 0));
  // Per-corner normals: Inner = 1 averages fully (shared vertex normal), Inner = 0 keeps each lobe's own normal at the pinch columns.
  const innerAmt = innerNormals;
  const cornerNormals = new Float32Array(indices.length * 3);
  const cornerFan = new Uint8Array(indices.length);
  const slotNormal = (v: number, slot: number, fx: number, fy: number, fz: number): Vec3 => norm3(fanAcc[v * 12 + slot * 3] as number, fanAcc[v * 12 + slot * 3 + 1] as number, fanAcc[v * 12 + slot * 3 + 2] as number, fx, fy, fz);
  for (let t = 0; t < indices.length; t++) {
    const v = indices[t] as number;
    let nx = normals[v * 3] as number, ny = normals[v * 3 + 1] as number, nz = normals[v * 3 + 2] as number;
    if (isPinch[v]) {
      const quadJ = Math.floor(t / 6) % N;
      const lobe = quadJ < half2 ? 0 : 1;
      if (v === cVertex) {
        // The crotch vertex joins both sides of the valley: each side keeps its own normal (sum of that side's faces).
        const side = quadJ === N - 1 || quadJ === 0 ? 0 : 1;
        const a0 = fanAcc[v * 12 + side * 6] as number + (fanAcc[v * 12 + side * 6 + 3] as number);
        const a1 = fanAcc[v * 12 + side * 6 + 1] as number + (fanAcc[v * 12 + side * 6 + 4] as number);
        const a2 = fanAcc[v * 12 + side * 6 + 2] as number + (fanAcc[v * 12 + side * 6 + 5] as number);
        const b = norm3(a0, a1, a2, nx, ny, nz);
        const f = slotNormal(v, lobe + 2 * side, b[0], b[1], b[2]);
        const m = norm3(b[0] + (f[0] - b[0]) * (1 - innerAmt), b[1] + (f[1] - b[1]) * (1 - innerAmt), b[2] + (f[2] - b[2]) * (1 - innerAmt), b[0], b[1], b[2]);
        cornerFan[t] = 1 + side * 3 + (b[0] * m[0] + b[1] * m[1] + b[2] * m[2] < 0.99985 ? 1 + lobe : 0);
        nx = m[0]; ny = m[1]; nz = m[2];
      } else if (innerAmt < 1 - 1e-6) {
        const f = slotNormal(v, lobe, nx, ny, nz);
        const m = norm3(nx + (f[0] - nx) * (1 - innerAmt), ny + (f[1] - ny) * (1 - innerAmt), nz + (f[2] - nz) * (1 - innerAmt), nx, ny, nz);
        // Only split the vertex where the fan actually differs from the shared normal (more than ~1 degree).
        if (nx * m[0] + ny * m[1] + nz * m[2] < 0.99985) cornerFan[t] = lobe + 1;
        nx = m[0]; ny = m[1]; nz = m[2];
      }
    }
    cornerNormals[t * 3] = nx; cornerNormals[t * 3 + 1] = ny; cornerNormals[t * 3 + 2] = nz;
  }
  return { sides: N, rings, vertexCount, positions: pos, normals, vertexRing, vertexColumn, indices, cornerU, cornerNormals, cornerFan, valleyAo };
}

/**
 * Laplacian relaxation of the logical vertex normals over the mesh edges (typed CSR adjacency). Ring 0 (the parent's ring) and the
 * open-end ring (except the merged crotch vertex) stay pinned, so the turn of the normals at the pinch columns spreads over the whole
 * transition instead of one ring row.
 */
function relaxNormals(normals: Float32Array, indices: Uint32Array, vertexRing: Uint32Array, vertexColumn: Uint16Array, sides: number, rings: number, isPinch: Uint8Array, iterations: number, freeColumns: number, skip: number): void {
  const n = normals.length / 3;
  const degree = new Uint32Array(n + 1);
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      degree[(indices[t + e] as number) + 1] = (degree[(indices[t + e] as number) + 1] as number) + 2;
    }
  }
  for (let v = 0; v < n; v++) degree[v + 1] = (degree[v + 1] as number) + (degree[v] as number);
  const fill = new Uint32Array(n);
  const adj = new Uint32Array(degree[n] as number);
  const link = (a: number, b: number): void => {
    adj[(degree[a] as number) + (fill[a] as number)] = b;
    fill[a] = (fill[a] as number) + 1;
  };
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e] as number;
      const b = indices[t + ((e + 1) % 3)] as number;
      link(a, b);
      link(b, a);
    }
  }
  const pinned = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    const ring = vertexRing[v] as number;
    if (ring === 0 || v === skip) pinned[v] = 1;
    else if (ring === rings - 1 && !isPinch[v]) {
      // Open-end ring: pinned, except the columns beside a pinch point which follow the smoothed valley (Smooth > Inner).
      const c = vertexColumn[v] as number;
      const dist = Math.min(c, Math.abs(c - sides / 2), sides - c);
      if (dist > freeColumns) pinned[v] = 1;
    }
  }
  let cur = Float64Array.from(normals);
  let next = new Float64Array(cur.length);
  for (let it = 0; it < iterations; it++) {
    for (let v = 0; v < n; v++) {
      const o = v * 3;
      if (pinned[v]) {
        next[o] = cur[o] as number; next[o + 1] = cur[o + 1] as number; next[o + 2] = cur[o + 2] as number;
        continue;
      }
      let sx = 0, sy = 0, sz = 0;
      const a0 = degree[v] as number, a1 = degree[v + 1] as number;
      let d = 0;
      for (let a = a0; a < a1; a++) {
        if (adj[a] === skip) continue;
        const q = (adj[a] as number) * 3;
        sx += cur[q] as number; sy += cur[q + 1] as number; sz += cur[q + 2] as number;
        d++;
      }
      d = Math.max(1, d);
      const r = norm3(0.5 * (cur[o] as number) + (0.5 * sx) / d, 0.5 * (cur[o + 1] as number) + (0.5 * sy) / d, 0.5 * (cur[o + 2] as number) + (0.5 * sz) / d, cur[o] as number, cur[o + 1] as number, cur[o + 2] as number);
      next[o] = r[0]; next[o + 1] = r[1]; next[o + 2] = r[2];
    }
    const swap = cur; cur = next; next = swap;
  }
  for (let i = 0; i < normals.length; i++) normals[i] = cur[i] as number;
}

/**
 * Turning angle (radians, 0 = straight) of a ring's outline at pinch vertex `column` (0 = A, N / 2 = B), measured between the two
 * outline segments that meet there. This is the crease sharpness of that ring.
 */
export function crotchPinchTurning(mesh: CrotchMesh, ring: number, column: 0 | 'B'): number {
  const N = mesh.sides;
  const j = column === 0 ? 0 : N / 2;
  const at = (c: number): number => crotchVertexIndex(N, mesh.rings, ring, c) * 3;
  const p = at(j - 1), q = at(j), r = at(j + 1);
  const P = mesh.positions;
  const ax = (P[q] as number) - (P[p] as number), ay = (P[q + 1] as number) - (P[p + 1] as number), az = (P[q + 2] as number) - (P[p + 2] as number);
  const bx = (P[r] as number) - (P[q] as number), by = (P[r + 1] as number) - (P[q + 1] as number), bz = (P[r + 2] as number) - (P[q + 2] as number);
  const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz);
  if (la < 1e-12 || lb < 1e-12) return 0;
  return Math.acos(Math.min(1, Math.max(-1, (ax * bx + ay * by + az * bz) / (la * lb))));
}
