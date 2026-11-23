import { clamp, lerp } from '@/core/math';
import { remapToRect, tubeU } from '@/generators/uv';
import {
  SECTION_CORE,
  SECTION_INNER,
  SECTION_OUTER,
  type KnotFrame,
  type KnotMesh,
  type KnotNoise,
  type KnotNoiseSource,
  type KnotSegments,
  type KnotShape,
  type KnotUv,
  type ParentUv,
} from './types';

const TAU = Math.PI * 2;
/** Largest angle (around the parent) a knot may span on either side of its centre. */
const MAX_WRAP = Math.PI * 0.95;
const EPS = 1e-9;

/** Smoothstep with zero slope at both ends (the knot meets the parent tangentially). */
const smooth = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

export interface KnotMeshInput {
  frame: KnotFrame;
  shape: KnotShape;
  segments: KnotSegments;
  parentUv: ParentUv;
  noise: KnotNoiseSource;
  /** Per-knot offset of the noise lookups (so every knot looks different). */
  noiseOffset: readonly [number, number];
}

interface Surface {
  /** Writes the surface point (x across, y along the parent, in metres) lifted by `h` along the surface normal. */
  at(x: number, y: number, h: number, out: Float64Array): void;
}

/** The parent as a cone around its axis (position, radius, taper at the knot), the same skin model the weld solver uses, as a parametric map. */
function parentSkin(f: KnotFrame): Surface {
  const [ax, ay, az] = f.axisPoint;
  const [tx, ty, tz] = f.tangent;
  const [nx, ny, nz] = f.normal;
  const [bx, by, bz] = f.binormal;
  return {
    // out: px, py, pz, nx, ny, nz, angle
    at(x, y, h, out) {
      const rad = Math.max(1e-5, f.radius + f.slope * y);
      const ang = f.azimuth + clamp(x / rad, -MAX_WRAP, MAX_WRAP);
      const c = Math.cos(ang);
      const s = Math.sin(ang);
      const dx = nx * c + bx * s;
      const dy = ny * c + by * s;
      const dz = nz * c + bz * s;
      let sx = dx - f.slope * tx;
      let sy = dy - f.slope * ty;
      let sz = dz - f.slope * tz;
      const l = Math.hypot(sx, sy, sz) || 1;
      sx /= l;
      sy /= l;
      sz /= l;
      out[0] = ax + tx * y + dx * rad + sx * h;
      out[1] = ay + ty * y + dy * rad + sy * h;
      out[2] = az + tz * y + dz * rad + sz * h;
      out[3] = sx;
      out[4] = sy;
      out[5] = sz;
      out[6] = ang;
    },
  };
}

/** UV the parent tube has at a surface point: U from the angle around it, V along its axis. */
export function parentUvAt(p: ParentUv, angle: number, along: number): [number, number] {
  const v = p.v0 + p.vSlope * along;
  return [tubeU(angle / TAU, p.tiles, p.uOffset, p.twist, v), v];
}

const fract = (x: number): number => x - Math.floor(x);

function applyRect(uv: KnotUv, u: number, v: number, tiling: boolean): [number, number] {
  if (!uv.rect) return [u, v];
  return remapToRect(uv.rect, tiling ? fract(u) : u, tiling ? fract(v) : v);
}

/**
 * Builds the three ring stacks of one knot on the parent's surface.
 *
 * Plane: x runs around the parent, y along it; the knot centre is the origin. Slice j of a ring sits at the angle
 * `2 pi j / slices` of the (noisy) boundary ellipse, rolled by `rotation`. A plane point (x, y) lies on the parent cone;
 * a height `h` lifts it along the cone normal, so every ring at `h = 0` is exactly on the parent surface.
 *
 * Logical vertices (one per ring slice, shared by neighbouring sections) carry position and smooth normal; every section
 * gets its own physical copy because its UV differs. The seam column is duplicated for continuous UV.
 */
export function buildKnotMesh(inp: KnotMeshInput): KnotMesh {
  const { shape: S, frame, segments: seg, noise } = inp;
  const n = seg.slices;
  const nO = seg.outer;
  const nI = seg.inner;
  const nC = seg.core;
  const size = Math.max(1e-4, S.size);
  const pI = clamp(S.inner.sizeFrac, 0.05, 0.98);
  const pC = clamp(S.core.sizeFrac, 0.05, 0.98);
  const overlap = clamp(S.inner.overlap, 0, 0.9);
  const wOuter = Math.max(0.05, S.width);
  const wInner = wOuter * Math.max(0.05, S.inner.scale);
  const curv = S.inner.curvature;
  const surface = parentSkin(frame);
  const cosR = Math.cos(S.rotation);
  const sinR = Math.sin(S.rotation);
  const [ox, oy] = inp.noiseOffset;

  const cosT = new Float64Array(n + 1);
  const sinT = new Float64Array(n + 1);
  for (let j = 0; j <= n; j++) {
    cosT[j] = Math.cos((TAU * j) / n);
    sinT[j] = Math.sin((TAU * j) / n);
  }

  const noiseAt = (nx: number, ny: number, salt: number): number => noise.noise2(nx + ox + salt * 17.13, ny + oy + salt * 9.71);
  const shapeFactor = (j: number, nz: KnotNoise, salt: number): number =>
    nz.amount > 0 ? Math.max(0.15, 1 + nz.amount * noiseAt(cosT[j]! * nz.scale, sinT[j]! * nz.scale, salt)) : 1;
  const offsetNoise = (ul: number, vl: number, nz: KnotNoise, salt: number): number =>
    nz.amount !== 0 ? nz.amount * noiseAt((ul / size) * nz.scale, (vl / size) * nz.scale, salt) : 0;

  // Boundary radii per slice (noise deformed).
  const Rb = new Float64Array(n);
  const Rin = new Float64Array(n);
  const Rc = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    Rb[j] = size * shapeFactor(j, S.outerShape, 1);
    Rin[j] = Math.min(size * pI * shapeFactor(j, S.inner.shape, 2), Rb[j]! * 0.96);
    Rc[j] = Math.min(Rin[j]! * pC * shapeFactor(j, S.core.shape, 3), Rin[j]! * 0.96);
  }

  const hRim = S.offset + S.lip;
  const hCore = S.offset + S.core.offset;
  const bulgeAmp = 0.5 * Math.abs(hRim - hCore) + 0.2 * size * pI * (1 - pC);
  const dome = 0.25 * size * pI * pC;
  const eps = 0.002 * size;

  // ---- logical rings ------------------------------------------------------------------------------------------------
  const ringCap = nO + 1 + nI + nC + 2;
  const L = ringCap * n + 1;
  const P = new Float32Array(L * 3);
  const NS = new Float32Array(L * 3);
  const ANG = new Float32Array(L);
  const PX = new Float32Array(L);
  const PY = new Float32Array(L);
  const tmp = new Float64Array(7);
  let ringCount = 0;

  const place = (id: number, ul: number, vl: number, h: number): void => {
    const x = ul * cosR - vl * sinR;
    const y = ul * sinR + vl * cosR;
    surface.at(x, y, h, tmp);
    P[id * 3] = tmp[0]!;
    P[id * 3 + 1] = tmp[1]!;
    P[id * 3 + 2] = tmp[2]!;
    NS[id * 3] = tmp[3]!;
    NS[id * 3 + 1] = tmp[4]!;
    NS[id * 3 + 2] = tmp[5]!;
    ANG[id] = tmp[6]!;
    PX[id] = x;
    PY[id] = y;
  };

  /** Adds a ring of radii `R` (per slice) with width factor `w`; `height(j, ul, vl)` is the lift at each slice. */
  const addRing = (R: ArrayLike<number>, w: number, height: (j: number, ul: number, vl: number) => number): number => {
    const ring = ringCount++;
    for (let j = 0; j < n; j++) {
      const ul = R[j]! * cosT[j]! * w;
      const vl = R[j]! * sinT[j]!;
      place(ring * n + j, ul, vl, height(j, ul, vl));
    }
    return ring;
  };
  const scratch = new Float64Array(n);
  const radii = (a: Float64Array, b: Float64Array, f: number): Float64Array => {
    for (let j = 0; j < n; j++) scratch[j] = lerp(a[j]!, b[j]!, f);
    return scratch;
  };

  const coreHeight = (ul: number, vl: number): number => hCore + offsetNoise(ul, vl, S.core.offsetNoise, 5);

  const outerRings: number[] = [];
  for (let k = 0; k <= nO; k++) {
    const f = k / nO;
    const s = smooth(f);
    outerRings.push(
      addRing(radii(Rb, Rin, f), lerp(wOuter, wInner, f), (_j, ul, vl) => (k === 0 ? 0 : hRim * s + offsetNoise(ul, vl, S.outerOffset, 4) * s)),
    );
  }
  const Re = new Float64Array(n);
  for (let j = 0; j < n; j++) Re[j] = Rc[j]! * (1 - overlap);
  const innerRings: number[] = [outerRings[nO]!];
  for (let k = 1; k <= nI; k++) {
    const f = k / nI;
    const R = radii(Rin, Re, f);
    const Rcopy = Float64Array.from(R);
    innerRings.push(
      addRing(Rcopy, wInner, (j, ul, vl) => {
        const g = clamp((Rin[j]! - Rcopy[j]!) / Math.max(EPS, Rin[j]! - Rc[j]!), 0, 1);
        const sg = smooth(g);
        const base = lerp(hRim + offsetNoise(ul, vl, S.outerOffset, 4) * (1 - sg), coreHeight(ul, vl), sg);
        return base + curv * bulgeAmp * Math.sin(Math.PI * g) - (overlap > 0 && g >= 0.999 ? eps : 0);
      }),
    );
  }
  const coreRings: number[] = [];
  const coreHeightAt = (q: number) => (_j: number, ul: number, vl: number): number => coreHeight(ul, vl) + curv * dome * (1 - q * q);
  for (let k = 0; k < nC; k++) {
    if (k === 0 && overlap <= 1e-6) {
      coreRings.push(innerRings[nI]!);
      continue;
    }
    const q = 1 - k / nC;
    const Rq = new Float64Array(n);
    for (let j = 0; j < n; j++) Rq[j] = Rc[j]! * q;
    coreRings.push(addRing(Rq, wInner, coreHeightAt(q)));
  }
  const center = ringCount * n;
  place(center, 0, 0, coreHeight(0, 0) + curv * dome);

  // ---- triangles ----------------------------------------------------------------------------------------------------
  // Logical triangles (for the smooth normals) and physical triangles (per section) are generated by the same pattern.
  const lTris: number[] = [];
  const secRings: number[][] = [outerRings, innerRings, coreRings];
  const rowsPer = [nO + 1, nI + 1, nC];
  const physBase: number[] = [0, 0, 0];
  const physTris: number[][] = [[], [], []];
  let phys = 0;
  for (let sec = 0; sec < 3; sec++) {
    physBase[sec] = phys;
    phys += rowsPer[sec]! * (n + 1) + (sec === SECTION_CORE ? 1 : 0);
  }
  const lid = (ring: number, j: number): number => ring * n + (j % n);
  for (let sec = 0; sec < 3; sec++) {
    const rings = secRings[sec]!;
    const base = physBase[sec]!;
    const out = physTris[sec]!;
    const pid = (r: number, c: number): number => base + r * (n + 1) + c;
    for (let r = 0; r + 1 < rings.length; r++) {
      for (let c = 0; c < n; c++) {
        const a = lid(rings[r]!, c);
        const a1 = lid(rings[r]!, c + 1);
        const b = lid(rings[r + 1]!, c);
        const b1 = lid(rings[r + 1]!, c + 1);
        lTris.push(a, a1, b, a1, b1, b);
        out.push(pid(r, c), pid(r, c + 1), pid(r + 1, c), pid(r, c + 1), pid(r + 1, c + 1), pid(r + 1, c));
      }
    }
    if (sec === SECTION_CORE) {
      const last = rings.length - 1;
      const cp = base + rowsPer[sec]! * (n + 1);
      for (let c = 0; c < n; c++) {
        lTris.push(lid(rings[last]!, c), lid(rings[last]!, c + 1), center);
        out.push(pid(last, c), pid(last, c + 1), cp);
      }
    }
  }

  // ---- smooth normals (area weighted over every section; the Outer edge keeps the exact parent normal) ---------------
  const N = new Float64Array(L * 3);
  for (let t = 0; t < lTris.length; t += 3) {
    const a = lTris[t]! * 3;
    const b = lTris[t + 1]! * 3;
    const c = lTris[t + 2]! * 3;
    const e1x = P[b]! - P[a]!;
    const e1y = P[b + 1]! - P[a + 1]!;
    const e1z = P[b + 2]! - P[a + 2]!;
    const e2x = P[c]! - P[a]!;
    const e2y = P[c + 1]! - P[a + 1]!;
    const e2z = P[c + 2]! - P[a + 2]!;
    const gx = e1y * e2z - e1z * e2y;
    const gy = e1z * e2x - e1x * e2z;
    const gz = e1x * e2y - e1y * e2x;
    for (let k = 0; k < 3; k++) {
      const v = lTris[t + k]! * 3;
      N[v] = N[v]! + gx;
      N[v + 1] = N[v + 1]! + gy;
      N[v + 2] = N[v + 2]! + gz;
    }
  }
  const finalN = new Float32Array(L * 3);
  for (let i = 0; i < L; i++) {
    const o = i * 3;
    const edge = i < n;
    let x = N[o]!;
    let y = N[o + 1]!;
    let z = N[o + 2]!;
    const l = Math.hypot(x, y, z);
    if (edge || l < 1e-18) {
      x = NS[o]!;
      y = NS[o + 1]!;
      z = NS[o + 2]!;
    } else {
      x /= l;
      y /= l;
      z /= l;
      if (x * NS[o]! + y * NS[o + 1]! + z * NS[o + 2]! < 0) {
        x = -x;
        y = -y;
        z = -z;
      }
    }
    finalN[o] = x;
    finalN[o + 1] = y;
    finalN[o + 2] = z;
  }

  // ---- physical vertices --------------------------------------------------------------------------------------------
  const V = phys;
  const positions = new Float32Array(V * 3);
  const normals = new Float32Array(V * 3);
  const tangents = new Float32Array(V * 3);
  const uvs = new Float32Array(V * 2);
  const plane = new Float32Array(V * 2);
  const ao = new Float32Array(V);
  const section = new Uint8Array(V);
  const [nfx, nfy, nfz] = frame.normal;
  const [bfx, bfy, bfz] = frame.binormal;
  const [uc, vc] = parentUvAt(inp.parentUv, frame.azimuth, 0);
  const planeScale = 1 / (2 * Math.max(...Rb) * Math.max(1, wOuter, wInner) * 1.0001);
  const totalDepth = nO + nI + nC;

  const writeVertex = (pv: number, logical: number, sec: number, u: number, v: number, depth: number): void => {
    const o = logical * 3;
    positions[pv * 3] = P[o]!;
    positions[pv * 3 + 1] = P[o + 1]!;
    positions[pv * 3 + 2] = P[o + 2]!;
    const nx = finalN[o]!;
    const ny = finalN[o + 1]!;
    const nz = finalN[o + 2]!;
    normals[pv * 3] = nx;
    normals[pv * 3 + 1] = ny;
    normals[pv * 3 + 2] = nz;
    // Tangent: direction around the parent (U increases with the angle), made perpendicular to the normal.
    const a = ANG[logical]!;
    let ex = -nfx * Math.sin(a) + bfx * Math.cos(a);
    let ey = -nfy * Math.sin(a) + bfy * Math.cos(a);
    let ez = -nfz * Math.sin(a) + bfz * Math.cos(a);
    const d = ex * nx + ey * ny + ez * nz;
    ex -= nx * d;
    ey -= ny * d;
    ez -= nz * d;
    const el = Math.hypot(ex, ey, ez) || 1;
    tangents[pv * 3] = ex / el;
    tangents[pv * 3 + 1] = ey / el;
    tangents[pv * 3 + 2] = ez / el;
    uvs[pv * 2] = u;
    uvs[pv * 2 + 1] = v;
    plane[pv * 2] = 0.5 + PX[logical]! * planeScale;
    plane[pv * 2 + 1] = 0.5 + PY[logical]! * planeScale;
    ao[pv] = clamp(1 - 0.3 * Math.pow(depth / Math.max(1, totalDepth), 1.4), 0.4, 1);
    section[pv] = sec;
  };

  const matchUv = (logical: number): [number, number] => parentUvAt(inp.parentUv, ANG[logical]!, PY[logical]!);
  const styled = (uv: KnotUv, logical: number): [number, number] => {
    const [u, v] = matchUv(logical);
    return applyRect(uv, (u - uc) * uv.scale + uc + uv.offsetU, (v - vc) * uv.scale + vc + uv.offsetV, true);
  };

  // Outer: exactly the parent's UV.
  for (let r = 0; r <= nO; r++) {
    for (let c = 0; c <= n; c++) {
      const logical = lid(outerRings[r]!, c);
      const [u, v] = matchUv(logical);
      writeVertex(physBase[SECTION_OUTER]! + r * (n + 1) + c, logical, SECTION_OUTER, u, v, r);
    }
  }
  // Inner.
  const iuv = S.inner.uv;
  for (let r = 0; r <= nI; r++) {
    for (let c = 0; c <= n; c++) {
      const logical = lid(innerRings[r]!, c);
      let u: number;
      let v: number;
      if (iuv.style === 'ring') {
        [u, v] = applyRect(iuv, (c / n) * iuv.scale + iuv.offsetU, (r / nI) * iuv.scale + iuv.offsetV, false);
      } else [u, v] = styled(iuv, logical);
      writeVertex(physBase[SECTION_INNER]! + r * (n + 1) + c, logical, SECTION_INNER, u, v, nO + r);
    }
  }
  // Core.
  const cuv = S.core.uv;
  for (let r = 0; r < nC; r++) {
    const q = 1 - r / nC;
    for (let c = 0; c <= n; c++) {
      const logical = lid(coreRings[r]!, c);
      let u: number;
      let v: number;
      if (cuv.style === 'ring') {
        [u, v] = applyRect(cuv, 0.5 + 0.5 * q * cosT[c]! * cuv.scale, 0.5 + 0.5 * q * sinT[c]! * cuv.scale, false);
      } else {
        const [mu, mv] = matchUv(logical);
        [u, v] = applyRect(cuv, (mu - uc) * cuv.scale + uc, (mv - vc) * cuv.scale + vc, true);
      }
      writeVertex(physBase[SECTION_CORE]! + r * (n + 1) + c, logical, SECTION_CORE, u, v, nO + nI + r);
    }
  }
  {
    const cp = physBase[SECTION_CORE]! + nC * (n + 1);
    const [mu, mv] = matchUv(center);
    const [u, v] =
      cuv.style !== 'ring'
        ? applyRect(cuv, (mu - uc) * cuv.scale + uc, (mv - vc) * cuv.scale + vc, true)
        : applyRect(cuv, 0.5, 0.5, false);
    writeVertex(cp, center, SECTION_CORE, u, v, totalDepth);
  }

  // ---- indices (sorted by section) -----------------------------------------------------------------------------------
  const total = physTris[0]!.length + physTris[1]!.length + physTris[2]!.length;
  const indices = new Uint32Array(total);
  const ranges: [number, number][] = [];
  let at = 0;
  for (let sec = 0; sec < 3; sec++) {
    const list = physTris[sec]!;
    ranges.push([at, list.length]);
    indices.set(list, at);
    at += list.length;
  }

  const rim = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) {
    rim[j * 3] = P[j * 3]!;
    rim[j * 3 + 1] = P[j * 3 + 1]!;
    rim[j * 3 + 2] = P[j * 3 + 2]!;
  }

  return {
    vertexCount: V,
    positions,
    normals,
    tangents,
    uvs,
    plane,
    ao,
    section,
    indices,
    ranges: [ranges[0]!, ranges[1]!, ranges[2]!],
    segments: seg,
    boundary: { outer: Rb, inner: Rin, core: Rc },
    rim,
  };
}
