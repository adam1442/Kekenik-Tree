import type { ForceDef } from '@/contracts/material';
import { curveToLUT, sampleCurveLUT } from '@/contracts/curve';
import { getBool, getNumber } from '@/contracts/params';
import type { Skeleton } from '@/contracts/skeleton';
import { clamp } from '@/core/math';
import { registerBuiltinForceTypes } from './fields';
import { getForceType } from './registry';
import type { FieldFn, FieldPoint, ForceContext, ForceMode, ForceStats, V3 } from './types';

/** Radius (m) at which a branch has "nominal" stiffness. */
const REF_RADIUS = 0.05;
/** Smallest radius used for the stiffness model (keeps EI finite at the tips). */
const MIN_RADIUS = 0.002;
/** Bending stiffness scale: EI = S0 * stiffnessMul * (r / REF_RADIUS)^4. */
const S0 = 20;
/** Radians of turn per metre of branch for a unit steering field at strength 1. */
const STEER_GAIN = 0.25;

interface Compiled {
  mode: ForceMode;
  loadExponent: number;
  field: FieldFn;
  def: ForceDef;
  strength: number;
  strengthVariance: number;
  lengthLut: Float32Array | null;
  influence: number;
  generationFalloff: number;
  stiffness: number;
  /** Radius (m) with nominal stiffness for this force. */
  refRadius: number;
}

type Quat = [number, number, number, number];

const qAxisAngle = (ax: number, ay: number, az: number, a: number): Quat => {
  const s = Math.sin(a / 2);
  return [ax * s, ay * s, az * s, Math.cos(a / 2)];
};

const qMul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

const qNorm = (q: Quat): Quat => {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
};

function qRot(q: Quat, x: number, y: number, z: number): V3 {
  const [qx, qy, qz, qw] = q;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  return [x + qw * tx + (qy * tz - qz * ty), y + qw * ty + (qz * tx - qx * tz), z + qw * tz + (qx * ty - qy * tx)];
}

/** Shortest rotation taking unit vector `u` to unit vector `v`. */
function qFromTo(u: V3, v: V3): Quat {
  const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  let cx = u[1] * v[2] - u[2] * v[1];
  let cy = u[2] * v[0] - u[0] * v[2];
  let cz = u[0] * v[1] - u[1] * v[0];
  if (dot < -0.999999) {
    // Opposite: pick any perpendicular axis.
    const ax: V3 = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    cx = u[1] * ax[2] - u[2] * ax[1];
    cy = u[2] * ax[0] - u[0] * ax[2];
    cz = u[0] * ax[1] - u[1] * ax[0];
    const l = Math.hypot(cx, cy, cz) || 1;
    return [cx / l, cy / l, cz / l, 0];
  }
  return qNorm([cx, cy, cz, 1 + dot]);
}

function compileForces(forces: readonly ForceDef[]): Compiled[] {
  registerBuiltinForceTypes();
  const out: Compiled[] = [];
  for (const def of forces) {
    if (!def.enabled || !getBool(def.params, 'active', true)) continue;
    const type = getForceType(def.type);
    if (!type) continue;
    const strength = getNumber(def.params, 'strength', 1);
    const influence = clamp(getNumber(def.params, 'influence', 1), 0, 1);
    if (strength === 0 || influence === 0) continue;
    const curve = def.params.strength?.curve;
    out.push({
      mode: type.mode,
      loadExponent: type.loadExponent,
      field: type.compile(def.params),
      def,
      strength,
      strengthVariance: clamp(def.params.strength?.variance ?? 0, 0, 1),
      lengthLut: curve ? curveToLUT(curve, 128) : null,
      influence,
      generationFalloff: clamp(getNumber(def.params, 'generationFalloff', 0), 0, 1),
      stiffness: clamp(getNumber(def.params, 'stiffness', 0.5), 0, 1),
      refRadius: Math.max(0.005, getNumber(def.params, 'refRadius', REF_RADIUS)),
    });
  }
  return out;
}

/**
 * Bend a skeleton with the attached forces, in place. Deterministic (all randomness comes from `ctx.rng`).
 *
 * Every branch is treated as a chain of rigid segments. Segments are only rotated (forward kinematics), so lengths are
 * preserved exactly. `load` forces are turned into a bending moment per joint (cantilever beam, EI ~ r^4, loads ~ r^k),
 * `steer` forces turn the growth direction. Rotations are saturated per segment and clamped in total, so extreme
 * values never flip or produce NaN. Branches that start at a point of another branch of the same skeleton (forks) follow
 * their parent's rotation, branches attached to the parent skeleton stay pinned to their attachment point.
 */
export function applyForces(sk: Skeleton, forces: readonly ForceDef[], ctx: ForceContext): ForceStats {
  const stats: ForceStats = { appliedForces: 0, branches: 0, maxDisplacement: 0 };
  const compiled = compileForces(forces);
  if (compiled.length === 0 || sk.count === 0) return stats;
  stats.appliedForces = compiled.length;

  const maxStep = ctx.maxSegmentAngle ?? 0.5;
  const maxTotal = ctx.maxTotalAngle ?? (110 * Math.PI) / 180;
  const iterations = Math.max(1, Math.round(ctx.iterations ?? 3));
  const original = new Float32Array(sk.position);
  const pos = sk.position;
  const rot = new Float64Array(sk.count * 4);
  for (let i = 0; i < sk.count; i++) rot[i * 4 + 3] = 1;

  let minGen = Infinity;
  for (const b of sk.branches) minGen = Math.min(minGen, b.generation);
  const order = [...sk.branches].sort((a, b) => a.start - b.start);
  const point: FieldPoint = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 1, t: 0, radius: 0, generation: 0 };
  const f: V3 = [0, 0, 0];

  for (const b of order) {
    const n = b.count;
    const s0 = b.start;
    if (n < 2) continue;
    stats.branches++;
    const gen = b.generation - minGen;

    // Per-branch, per-force random strength (variance) and generation factor.
    const branchStrength = compiled.map((c) => {
      let s = c.strength;
      if (c.strengthVariance > 0) s *= 1 + c.strengthVariance * (ctx.rng.fork(`f:${c.def.id}:${b.id}`).next() * 2 - 1);
      return s * c.influence * Math.pow(1 - c.generationFalloff, gen);
    });

    // Base: pinned at the original location or following the parent branch inside this skeleton.
    const pp = sk.parent[s0] as number;
    let q: Quat = [0, 0, 0, 1];
    let bx = original[s0 * 3] as number;
    let by = original[s0 * 3 + 1] as number;
    let bz = original[s0 * 3 + 2] as number;
    if (pp >= 0 && pp < s0) {
      const near =
        Math.hypot((original[pp * 3] as number) - bx, (original[pp * 3 + 1] as number) - by, (original[pp * 3 + 2] as number) - bz) < 1e-3;
      if (near) {
        q = [rot[pp * 4] as number, rot[pp * 4 + 1] as number, rot[pp * 4 + 2] as number, rot[pp * 4 + 3] as number];
        bx = pos[pp * 3] as number;
        by = pos[pp * 3 + 1] as number;
        bz = pos[pp * 3 + 2] as number;
      }
    }

    const segs = n - 1;
    const sx = new Float64Array(segs);
    const sy = new Float64Array(segs);
    const sz = new Float64Array(segs);
    const sl = new Float64Array(segs);
    for (let k = 0; k < segs; k++) {
      const a = (s0 + k) * 3;
      const c = (s0 + k + 1) * 3;
      sx[k] = (original[c] as number) - (original[a] as number);
      sy[k] = (original[c + 1] as number) - (original[a + 1] as number);
      sz[k] = (original[c + 2] as number) - (original[a + 2] as number);
      sl[k] = Math.hypot(sx[k] as number, sy[k] as number, sz[k] as number);
    }

    // Current estimate of the joint positions (iteration 0: the undeformed shape carried by the inherited rotation).
    const P = new Float64Array(n * 3);
    P[0] = bx;
    P[1] = by;
    P[2] = bz;
    for (let k = 0; k < segs; k++) {
      const v = qRot(q, sx[k] as number, sy[k] as number, sz[k] as number);
      P[(k + 1) * 3] = (P[k * 3] as number) + v[0];
      P[(k + 1) * 3 + 1] = (P[k * 3 + 1] as number) + v[1];
      P[(k + 1) * 3 + 2] = (P[k * 3 + 2] as number) + v[2];
    }

    const W = new Float64Array(segs * 3);
    const C = new Float64Array(segs * 3);
    const T = new Float64Array(n * 3);
    const Pn = new Float64Array(n * 3);
    const Pfinal = new Float64Array(n * 3);
    const Rk = new Float64Array(n * 4);

    for (let it = 0; it < iterations; it++) {
      // 1. Load vectors at the segment midpoints.
      W.fill(0);
      for (let k = 0; k < segs; k++) {
        const L = sl[k] as number;
        if (L < 1e-9) continue;
        const i0 = k * 3;
        const i1 = (k + 1) * 3;
        const cx = ((P[i0] as number) + (P[i1] as number)) * 0.5;
        const cy = ((P[i0 + 1] as number) + (P[i1 + 1] as number)) * 0.5;
        const cz = ((P[i0 + 2] as number) + (P[i1 + 2] as number)) * 0.5;
        C[i0] = cx;
        C[i0 + 1] = cy;
        C[i0 + 2] = cz;
        const t = sk.t[s0 + k] as number;
        const r = Math.max(MIN_RADIUS, ((sk.radius[s0 + k] as number) + (sk.radius[s0 + k + 1] as number)) * 0.5);
        point.x = cx;
        point.y = cy;
        point.z = cz;
        point.dx = ((P[i1] as number) - (P[i0] as number)) / L;
        point.dy = ((P[i1 + 1] as number) - (P[i0 + 1] as number)) / L;
        point.dz = ((P[i1 + 2] as number) - (P[i0 + 2] as number)) / L;
        point.t = t;
        point.radius = r;
        point.generation = gen;
        const infl = ctx.influence ? ctx.influence(t) : 1;
        for (let fi = 0; fi < compiled.length; fi++) {
          const c = compiled[fi] as Compiled;
          if (c.mode !== 'load') continue;
          c.field(point, f);
          const m = (branchStrength[fi] as number) * (c.lengthLut ? sampleCurveLUT(c.lengthLut, t) : 1) * infl * L * Math.pow(r / c.refRadius, c.loadExponent);
          W[i0] = (W[i0] as number) + f[0] * m;
          W[i0 + 1] = (W[i0 + 1] as number) + f[1] * m;
          W[i0 + 2] = (W[i0 + 2] as number) + f[2] * m;
        }
      }

      // 2. Torque about every joint: T_k = sum_{j>=k} (c_j - x_k) x W_j  (reverse accumulation).
      let fx = 0;
      let fy = 0;
      let fz = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let k = segs - 1; k >= 0; k--) {
        const i = k * 3;
        const wx = W[i] as number;
        const wy = W[i + 1] as number;
        const wz = W[i + 2] as number;
        fx += wx;
        fy += wy;
        fz += wz;
        const cx = C[i] as number;
        const cy = C[i + 1] as number;
        const cz = C[i + 2] as number;
        mx += cy * wz - cz * wy;
        my += cz * wx - cx * wz;
        mz += cx * wy - cy * wx;
        const px = P[i] as number;
        const py = P[i + 1] as number;
        const pz = P[i + 2] as number;
        T[i] = mx - (py * fz - pz * fy);
        T[i + 1] = my - (pz * fx - px * fz);
        T[i + 2] = mz - (px * fy - py * fx);
      }

      // 3. Forward kinematics with bending + steering.
      let R: Quat = q;
      Pn[0] = bx;
      Pn[1] = by;
      Pn[2] = bz;
      Rk[0] = q[0];
      Rk[1] = q[1];
      Rk[2] = q[2];
      Rk[3] = q[3];
      for (let k = 0; k < segs; k++) {
        const L = sl[k] as number;
        const ux = L > 1e-9 ? (sx[k] as number) / L : 0;
        const uy = L > 1e-9 ? (sy[k] as number) / L : 0;
        const uz = L > 1e-9 ? (sz[k] as number) / L : 1;
        const ref = qRot(q, ux, uy, uz);
        if (L >= 1e-9) {
          const t = sk.t[s0 + k] as number;
          const rr = Math.max(MIN_RADIUS, ((sk.radius[s0 + k] as number) + (sk.radius[s0 + k + 1] as number)) * 0.5);
          let d: V3 = qRot(R, ux, uy, uz);
          const stiffCurve = ctx.stiffness ? ctx.stiffness(t) : 1;
          const infl = ctx.influence ? ctx.influence(t) : 1;

          // Bending from the loads.
          const ti = k * 3;
          const tx = T[ti] as number;
          const ty = T[ti + 1] as number;
          const tz = T[ti + 2] as number;
          const td = tx * d[0] + ty * d[1] + tz * d[2];
          const px = tx - td * d[0];
          const py = ty - td * d[1];
          const pz = tz - td * d[2];
          const pl = Math.hypot(px, py, pz);
          if (pl > 1e-12) {
            let stiff = 0;
            let cnt = 0;
            for (const c of compiled) {
              if (c.mode === 'load') {
                stiff += c.stiffness;
                cnt++;
              }
            }
            const s = cnt > 0 ? stiff / cnt : 0.5;
            const mul = (0.25 + 3.5 * s * s) * Math.max(0.01, stiffCurve);
            const ei = S0 * mul * Math.pow(rr / REF_RADIUS, 4);
            const raw = (pl / ei) * L;
            const angle = maxStep * Math.tanh(raw / maxStep);
            const dq = qAxisAngle(px / pl, py / pl, pz / pl, angle);
            R = qNorm(qMul(dq, R));
            d = qRot(dq, d[0], d[1], d[2]);
          }

          // Steering towards the fields.
          let ax = 0;
          let ay = 0;
          let az = 0;
          point.x = (Pn[k * 3] as number) + d[0] * L * 0.5;
          point.y = (Pn[k * 3 + 1] as number) + d[1] * L * 0.5;
          point.z = (Pn[k * 3 + 2] as number) + d[2] * L * 0.5;
          point.dx = d[0];
          point.dy = d[1];
          point.dz = d[2];
          point.t = t;
          point.radius = rr;
          point.generation = gen;
          for (let fi = 0; fi < compiled.length; fi++) {
            const c = compiled[fi] as Compiled;
            if (c.mode !== 'steer') continue;
            c.field(point, f);
            const rig = 1 / (1 + 4 * c.stiffness * stiffCurve * Math.pow(rr / c.refRadius, 2));
            const m = (branchStrength[fi] as number) * (c.lengthLut ? sampleCurveLUT(c.lengthLut, t) : 1) * infl * L * STEER_GAIN * rig;
            ax += f[0] * m;
            ay += f[1] * m;
            az += f[2] * m;
          }
          const al = Math.hypot(ax, ay, az);
          if (al > 1e-12) {
            // Rotate d towards d + a (perpendicular part only), saturated at maxStep.
            const ad = ax * d[0] + ay * d[1] + az * d[2];
            const qx = ax - ad * d[0];
            const qy = ay - ad * d[1];
            const qz = az - ad * d[2];
            const ql = Math.hypot(qx, qy, qz);
            if (ql > 1e-12) {
              const angle = maxStep * Math.tanh(Math.atan(ql) / maxStep);
              const dq = qAxisAngle(qx / ql, qy / ql, qz / ql, angle);
              R = qNorm(qMul(dq, R));
              d = qRot(dq, d[0], d[1], d[2]);
            }
          }

          // Total deflection clamp (no flipping).
          const cosA = clamp(d[0] * ref[0] + d[1] * ref[1] + d[2] * ref[2], -1, 1);
          const dev = Math.acos(cosA);
          if (dev > maxTotal) {
            let ex = ref[1] * d[2] - ref[2] * d[1];
            let ey = ref[2] * d[0] - ref[0] * d[2];
            let ez = ref[0] * d[1] - ref[1] * d[0];
            const el = Math.hypot(ex, ey, ez);
            if (el > 1e-9) {
              ex /= el;
              ey /= el;
              ez /= el;
              const clamped = qRot(qAxisAngle(ex, ey, ez, maxTotal), ref[0], ref[1], ref[2]);
              R = qNorm(qMul(qFromTo(d, clamped), R));
              d = clamped;
            }
          }
          Pn[(k + 1) * 3] = (Pn[k * 3] as number) + d[0] * L;
          Pn[(k + 1) * 3 + 1] = (Pn[k * 3 + 1] as number) + d[1] * L;
          Pn[(k + 1) * 3 + 2] = (Pn[k * 3 + 2] as number) + d[2] * L;
        } else {
          Pn[(k + 1) * 3] = Pn[k * 3] as number;
          Pn[(k + 1) * 3 + 1] = Pn[k * 3 + 1] as number;
          Pn[(k + 1) * 3 + 2] = Pn[k * 3 + 2] as number;
        }
        Rk[(k + 1) * 4] = R[0];
        Rk[(k + 1) * 4 + 1] = R[1];
        Rk[(k + 1) * 4 + 2] = R[2];
        Rk[(k + 1) * 4 + 3] = R[3];
      }
      // Under-relaxed update of the geometry used for the next load evaluation (avoids sign-flipping oscillation).
      for (let i = 0; i < n * 3; i++) {
        Pfinal[i] = Pn[i] as number;
        P[i] = 0.5 * ((P[i] as number) + (Pn[i] as number));
      }
    }

    // Commit (Pfinal holds the last result). Fall back to the undeformed shape on numerical trouble.
    let finite = true;
    for (let i = 0; i < n * 3; i++) if (!Number.isFinite(Pfinal[i] as number)) finite = false;
    for (let k = 0; k < n; k++) {
      const gi = s0 + k;
      if (finite) {
        const dx = (Pfinal[k * 3] as number) - (original[gi * 3] as number);
        const dy = (Pfinal[k * 3 + 1] as number) - (original[gi * 3 + 1] as number);
        const dz = (Pfinal[k * 3 + 2] as number) - (original[gi * 3 + 2] as number);
        stats.maxDisplacement = Math.max(stats.maxDisplacement, Math.hypot(dx, dy, dz));
        pos[gi * 3] = Pfinal[k * 3] as number;
        pos[gi * 3 + 1] = Pfinal[k * 3 + 1] as number;
        pos[gi * 3 + 2] = Pfinal[k * 3 + 2] as number;
        for (let c = 0; c < 4; c++) rot[gi * 4 + c] = Rk[k * 4 + c] as number;
      } else {
        for (let c = 0; c < 3; c++) pos[gi * 3 + c] = original[gi * 3 + c] as number;
        for (let c = 0; c < 4; c++) rot[gi * 4 + c] = c === 3 ? 1 : 0;
      }
    }
  }

  refreshDerived(sk, rot);
  return stats;
}

/** Recompute directions, tangents, lengths and rotate the stored frames after the positions changed. */
function refreshDerived(sk: Skeleton, rot: Float64Array): void {
  const pos = sk.position;
  const norm = (arr: Float32Array, i: number, x: number, y: number, z: number): void => {
    const l = Math.hypot(x, y, z) || 1;
    arr[i * 3] = x / l;
    arr[i * 3 + 1] = y / l;
    arr[i * 3 + 2] = z / l;
  };
  const nx = sk.attributes.get('rmfNormalX');
  const ny = sk.attributes.get('rmfNormalY');
  const nz = sk.attributes.get('rmfNormalZ');
  for (const b of sk.branches) {
    let len = 0;
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      const prev = b.start + Math.max(0, k - 1);
      const next = b.start + Math.min(b.count - 1, k + 1);
      norm(sk.tangent, i, (pos[next * 3] as number) - (pos[prev * 3] as number), (pos[next * 3 + 1] as number) - (pos[prev * 3 + 1] as number), (pos[next * 3 + 2] as number) - (pos[prev * 3 + 2] as number));
      const fwd = k === 0 ? Math.min(b.count - 1, 1) + b.start : i;
      norm(sk.direction, i, (pos[fwd * 3] as number) - (pos[prev * 3] as number), (pos[fwd * 3 + 1] as number) - (pos[prev * 3 + 1] as number), (pos[fwd * 3 + 2] as number) - (pos[prev * 3 + 2] as number));
      if (k > 0) len += Math.hypot((pos[i * 3] as number) - (pos[(i - 1) * 3] as number), (pos[i * 3 + 1] as number) - (pos[(i - 1) * 3 + 1] as number), (pos[i * 3 + 2] as number) - (pos[(i - 1) * 3 + 2] as number));
      if (nx && ny && nz) {
        const q: Quat = [rot[i * 4] as number, rot[i * 4 + 1] as number, rot[i * 4 + 2] as number, rot[i * 4 + 3] as number];
        const v = qRot(q, nx[i] as number, ny[i] as number, nz[i] as number);
        // Re-orthogonalise against the new tangent.
        const tx = sk.tangent[i * 3] as number;
        const ty = sk.tangent[i * 3 + 1] as number;
        const tz = sk.tangent[i * 3 + 2] as number;
        const dt = v[0] * tx + v[1] * ty + v[2] * tz;
        const ox = v[0] - dt * tx;
        const oy = v[1] - dt * ty;
        const oz = v[2] - dt * tz;
        const l = Math.hypot(ox, oy, oz);
        if (l > 1e-6) {
          nx[i] = ox / l;
          ny[i] = oy / l;
          nz[i] = oz / l;
        }
      }
    }
    b.length = len;
  }
}
