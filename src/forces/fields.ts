import { getNumber, getString, type NodeParams } from '@/contracts/params';
import { clamp } from '@/core/math';
import { createSimplex } from '@/core/noise';
import { geometryQueryForParams } from './geometry/query';
import type { ForceCollider } from './geometry/collide';
import { registerForceType } from './registry';
import type { FieldFn, FieldPoint, V3 } from './types';

export function readVec3(params: NodeParams, id: string, fallback: V3): V3 {
  const v = params[id]?.value;
  if (Array.isArray(v) && v.length >= 3) {
    const x = Number(v[0]);
    const y = Number(v[1]);
    const z = Number(v[2]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return [x, y, z];
  }
  return fallback;
}

export function normalize3(v: V3, fallback: V3 = [0, 0, 1]): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [fallback[0], fallback[1], fallback[2]];
}

const set = (out: V3, x: number, y: number, z: number): void => {
  out[0] = x;
  out[1] = y;
  out[2] = z;
};

/** Smooth spatial falloff: 1 at the source, 0 at `range`, shaped by `exponent`. Range <= 0 means unbounded. */
const attenuation = (dist: number, range: number, exponent: number): number =>
  range <= 0 ? 1 : dist >= range ? 0 : Math.pow(1 - dist / range, Math.max(0.05, exponent));

function pointField(params: NodeParams): FieldFn {
  const shape = getString(params, 'shape', 'point');
  const c = readVec3(params, 'position', [0, 0, 5]);
  const axis = normalize3(readVec3(params, 'axis', [0, 0, 1]));
  const range = Math.max(0.001, getNumber(params, 'radius', 5));
  const exponent = getNumber(params, 'falloff', 1);
  const shell = Math.max(0.01, getNumber(params, 'shellRadius', 2));
  return (p, out) => {
    let tx: number;
    let ty: number;
    let tz: number;
    if (shape === 'axis') {
      const s = (p.x - c[0]) * axis[0] + (p.y - c[1]) * axis[1] + (p.z - c[2]) * axis[2];
      tx = c[0] + axis[0] * s;
      ty = c[1] + axis[1] * s;
      tz = c[2] + axis[2] * s;
    } else if (shape === 'sphere') {
      const vx = p.x - c[0];
      const vy = p.y - c[1];
      const vz = p.z - c[2];
      const d = Math.hypot(vx, vy, vz);
      if (d < 1e-6) return set(out, 0, 0, 0);
      const k = (shell - d) / d;
      const dist = Math.abs(d - shell);
      const a = attenuation(dist, range, exponent) * clamp(Math.abs(shell - d) / shell, 0, 1) * Math.sign(k);
      return set(out, (vx / d) * a, (vy / d) * a, (vz / d) * a);
    } else {
      tx = c[0];
      ty = c[1];
      tz = c[2];
    }
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dz = tz - p.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-6) return set(out, 0, 0, 0);
    const a = attenuation(dist, range, exponent) / dist;
    set(out, dx * a, dy * a, dz * a);
  };
}

function vortexField(params: NodeParams): FieldFn {
  const axis = normalize3(readVec3(params, 'axis', [0, 0, 1]));
  const c = readVec3(params, 'center', [0, 0, 0]);
  const twist = getNumber(params, 'twist', 0.5);
  const range = getNumber(params, 'radius', 0);
  const exponent = getNumber(params, 'falloff', 1);
  return (p, out) => {
    const rx = p.x - c[0];
    const ry = p.y - c[1];
    const rz = p.z - c[2];
    // tangent = axis x r
    let tx = axis[1] * rz - axis[2] * ry;
    let ty = axis[2] * rx - axis[0] * rz;
    let tz = axis[0] * ry - axis[1] * rx;
    const l = Math.hypot(tx, ty, tz);
    if (l < 1e-6) {
      // On the axis: swirl around it using the segment direction.
      tx = axis[1] * p.dz - axis[2] * p.dy;
      ty = axis[2] * p.dx - axis[0] * p.dz;
      tz = axis[0] * p.dy - axis[1] * p.dx;
      const l2 = Math.hypot(tx, ty, tz);
      if (l2 < 1e-6) return set(out, 0, 0, 0);
      const k2 = twist / l2;
      return set(out, tx * k2, ty * k2, tz * k2);
    }
    const along = rx * axis[0] + ry * axis[1] + rz * axis[2];
    const dist = Math.hypot(rx - along * axis[0], ry - along * axis[1], rz - along * axis[2]);
    const k = (twist * attenuation(dist, range, exponent)) / l;
    set(out, tx * k, ty * k, tz * k);
  };
}

function turbulenceField(params: NodeParams): FieldFn {
  const noise = createSimplex(Math.round(getNumber(params, 'noiseSeed', 1)) || 1);
  const freq = Math.max(0.001, getNumber(params, 'frequency', 1));
  const octaves = clamp(Math.round(getNumber(params, 'octaves', 2)), 1, 6);
  const lacunarity = 2;
  const gain = 0.5;
  return (p, out) => {
    let a = 1;
    let f = freq;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      nx += a * noise.noise3(p.x * f, p.y * f, p.z * f);
      ny += a * noise.noise3(p.x * f + 31.7, p.y * f - 17.3, p.z * f + 5.1);
      nz += a * noise.noise3(p.x * f - 11.9, p.y * f + 23.3, p.z * f + 47.2);
      norm += a;
      a *= gain;
      f *= lacunarity;
    }
    set(out, nx / norm, ny / norm, nz / norm);
  };
}

function groundField(params: NodeParams): FieldFn {
  const ground = getNumber(params, 'groundLevel', 0);
  const margin = Math.max(0.01, getNumber(params, 'margin', 0.4));
  const outward = clamp(getNumber(params, 'outward', 0.5), 0, 2);
  return (p, out) => {
    const h = p.z - ground;
    if (h >= margin) return set(out, 0, 0, 0);
    const s = clamp((margin - h) / margin, 0, 2);
    const r = Math.hypot(p.x, p.y);
    const ox = r > 1e-6 ? p.x / r : 0;
    const oy = r > 1e-6 ? p.y / r : 0;
    set(out, ox * outward * s, oy * outward * s, s);
  };
}

type Sdf = (x: number, y: number, z: number) => number;

function collisionField(params: NodeParams): FieldFn {
  const shape = getString(params, 'volume', getString(params, 'shape', 'sphere'));
  const c = readVec3(params, 'position', [2, 0, 3]);
  const size = readVec3(params, 'size', [1, 1, 1]);
  const radius = Math.max(0.01, params.radius ? getNumber(params, 'radius', 1) : size[0] * 0.5);
  const margin = Math.max(0.01, getNumber(params, 'margin', 0.3));
  const sdf: Sdf =
    shape === 'plane'
      ? (_x, _y, z) => z - c[2]
      : shape === 'box'
        ? (x, y, z) => {
          const qx = Math.abs(x - c[0]) - size[0] * 0.5;
          const qy = Math.abs(y - c[1]) - size[1] * 0.5;
          const qz = Math.abs(z - c[2]) - size[2] * 0.5;
          return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
        }
      : shape === 'cylinder'
        ? (x, y, z) => {
            const dr = Math.hypot(x - c[0], y - c[1]) - radius;
            const dz = Math.abs(z - c[2]) - size[2] * 0.5;
            return Math.hypot(Math.max(dr, 0), Math.max(dz, 0)) + Math.min(Math.max(dr, dz), 0);
          }
        : (x, y, z) => Math.hypot(x - c[0], y - c[1], z - c[2]) - radius;
  const e = 1e-3;
  return (p, out) => {
    const d = sdf(p.x, p.y, p.z);
    if (d >= margin) return set(out, 0, 0, 0);
    const gx = sdf(p.x + e, p.y, p.z) - sdf(p.x - e, p.y, p.z);
    const gy = sdf(p.x, p.y + e, p.z) - sdf(p.x, p.y - e, p.z);
    const gz = sdf(p.x, p.y, p.z + e) - sdf(p.x, p.y, p.z - e);
    const gl = Math.hypot(gx, gy, gz);
    if (gl < 1e-9) return set(out, 0, 0, 0);
    const s = clamp((margin - d) / margin, 0, 2.5) / gl;
    set(out, gx * s, gy * s, gz * s);
  };
}

const TWO_PI = Math.PI * 2;

/** Two unit vectors perpendicular to the unit vector `a` (and to each other). Deterministic. */
function perpBasis(a: V3, e1: V3, e2: V3): void {
  const rx = Math.abs(a[2]) < 0.9 ? 0 : 1;
  const rz = rx === 0 ? 1 : 0;
  let x = a[1] * rz - a[2] * 0;
  let y = a[2] * rx - a[0] * rz;
  let z = a[0] * 0 - a[1] * rx;
  const l = Math.hypot(x, y, z) || 1;
  x /= l;
  y /= l;
  z /= l;
  e1[0] = x;
  e1[1] = y;
  e1[2] = z;
  e2[0] = a[1] * z - a[2] * y;
  e2[1] = a[2] * x - a[0] * z;
  e2[2] = a[0] * y - a[1] * x;
}

/** Gnarl: spirals the spine around a world-space vector (axis) with noisy turns and a swirl around the axis. */
function gnarlField(params: NodeParams): FieldFn {
  const a = normalize3(readVec3(params, 'axis', [0, 0, 1]));
  const freq = Math.max(0.001, getNumber(params, 'frequency', 1));
  const irregularity = clamp(getNumber(params, 'gnarlIrregularity', 0.4), 0, 1);
  const noise = createSimplex(Math.round(getNumber(params, 'noiseSeed', 1)) || 1);
  const e1: V3 = [1, 0, 0];
  const e2: V3 = [0, 1, 0];
  perpBasis(a, e1, e2);
  return (p, out) => {
    const along = p.x * a[0] + p.y * a[1] + p.z * a[2];
    const n = noise.noise3(p.x * freq * 0.5, p.y * freq * 0.5, p.z * freq * 0.5);
    const phase = TWO_PI * freq * along + irregularity * 3 * n;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    const k = 1 + irregularity * n;
    // Helical component (acts on straight spines) + swirl around the axis (acts on bent ones).
    const swx = a[1] * p.dz - a[2] * p.dy;
    const swy = a[2] * p.dx - a[0] * p.dz;
    const swz = a[0] * p.dy - a[1] * p.dx;
    set(out, (c * e1[0] + s * e2[0]) * k + swx * 0.5, (c * e1[1] + s * e2[1]) * k + swy * 0.5, (c * e1[2] + s * e2[2]) * k + swz * 0.5);
  };
}

/** Twist: turns the growth direction around the segment's local up vector (its undeformed direction): a helix along the branch. */
function twistField(params: NodeParams): FieldFn {
  const turns = getNumber(params, 'turns', 2);
  const phase0 = (getNumber(params, 'phase', 0) * Math.PI) / 180;
  const up: V3 = [0, 0, 1];
  const e1: V3 = [1, 0, 0];
  const e2: V3 = [0, 1, 0];
  return (p, out) => {
    up[0] = p.ox;
    up[1] = p.oy;
    up[2] = p.oz;
    perpBasis(up, e1, e2);
    const phase = phase0 + TWO_PI * turns * p.t;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    set(out, c * e1[0] + s * e2[0], c * e1[1] + s * e2[1], c * e1[2] + s * e2[2]);
  };
}

/** Planar: confines growth to the plane (position, normal): pulls points onto it and flattens the direction into it. */
function planarField(params: NodeParams): FieldFn {
  const o = readVec3(params, 'position', [0, 0, 0]);
  const n = normalize3(readVec3(params, 'normal', [0, 1, 0]), [0, 1, 0]);
  const soft = Math.max(0.01, getNumber(params, 'planeSoftness', 0.25));
  return (p, out) => {
    const dist = (p.x - o[0]) * n[0] + (p.y - o[1]) * n[1] + (p.z - o[2]) * n[2];
    const dn = p.dx * n[0] + p.dy * n[1] + p.dz * n[2];
    const k = -(clamp(dist / soft, -1, 1) + dn);
    set(out, n[0] * k, n[1] * k, n[2] * k);
  };
}

/** Return: steers every segment back to its original (undeformed) growth direction. */
const returnField: FieldFn = (p, out) => set(out, p.ox - p.dx, p.oy - p.dy, p.oz - p.dz);

function geometryField(params: NodeParams): FieldFn {
  const query = geometryQueryForParams(params);
  const behaviour = getString(params, 'geometryForce', 'avoid');
  if (!query || behaviour === 'none') return (_p, out) => set(out, 0, 0, 0);
  const range = Math.max(0.001, getNumber(params, 'geometryRange', 1));
  const exponent = getNumber(params, 'geometryFalloff', 1);
  const sign = behaviour === 'attract' ? -1 : 1;
  const n: V3 = [0, 0, 1];
  return (p, out) => {
    const sd = query.signed(p.x, p.y, p.z, n);
    if (sd >= range) return set(out, 0, 0, 0);
    // Inside the mesh the push is always out of it (Avoid) or towards the surface (Attract); outside it fades with distance.
    const w = sd <= 0 ? 1 : Math.pow(1 - sd / range, Math.max(0.05, exponent));
    const k = sd <= 0 ? 1 : sign * w;
    let tx = 0;
    let ty = 0;
    let tz = 0;
    const dn = p.dx * n[0] + p.dy * n[1] + p.dz * n[2];
    if (sign > 0 && dn < 0) {
      // Avoid: a branch heading into the surface is also turned along it (so a head-on approach slides around the obstacle).
      tx = p.dx - dn * n[0];
      ty = p.dy - dn * n[1];
      tz = p.dz - dn * n[2];
      const tl = Math.hypot(tx, ty, tz);
      const kk = tl > 1e-6 ? (-dn * w) / tl : 0;
      tx *= kk;
      ty *= kk;
      tz *= kk;
    }
    set(out, n[0] * k + tx, n[1] * k + ty, n[2] * k + tz);
  };
}

function geometryCollider(params: NodeParams): ForceCollider | null {
  const mode = getString(params, 'geometryCollide', 'none');
  if (mode !== 'obstruct' && mode !== 'prune' && mode !== 'stop') return null;
  const query = geometryQueryForParams(params);
  if (!query) return null;
  return { mode, query, skin: Math.max(0, getNumber(params, 'geometrySkin', 0.02)) };
}

let registered = false;

/** Registers the built-in force types (idempotent). */
export function registerBuiltinForceTypes(): void {
  if (registered) return;
  registered = true;
  registerForceType({ type: 'gravity', mode: 'load', loadExponent: 2, compile: () => (_p, out) => set(out, 0, 0, -1) });
  registerForceType({
    type: 'directional',
    mode: 'load',
    loadExponent: 1,
    compile: (params) => {
      const d = normalize3(readVec3(params, 'direction', [1, 0, 0]));
      return (_p, out) => set(out, d[0], d[1], d[2]);
    },
  });
  const turbulence = (params: NodeParams): FieldFn => turbulenceField(params);
  registerForceType({ type: 'turbulence', mode: 'load', loadExponent: 1, compile: turbulence });
  registerForceType({ type: 'custom', mode: 'load', loadExponent: 1, compile: turbulence });
  registerForceType({
    type: 'phototropism',
    mode: 'steer',
    loadExponent: 0,
    compile: (params) => {
      const d = normalize3(readVec3(params, 'lightDirection', [0.4, 0.2, 1]));
      const s = clamp(getNumber(params, 'sensitivity', 0.5), 0, 1);
      return (_p, out) => set(out, d[0] * s, d[1] * s, d[2] * s);
    },
  });
  registerForceType({ type: 'point', mode: 'steer', loadExponent: 0, compile: pointField });
  registerForceType({ type: 'vortex', mode: 'steer', loadExponent: 0, compile: vortexField });
  registerForceType({
    type: 'curl',
    mode: 'steer',
    loadExponent: 0,
    compile: (params) => {
      const a = normalize3(readVec3(params, 'axis', [0, 0, 1]));
      return (p, out: V3) => set(out, a[1] * p.dz - a[2] * p.dy, a[2] * p.dx - a[0] * p.dz, a[0] * p.dy - a[1] * p.dx);
    },
  });
  registerForceType({
    type: 'pullToAxis',
    mode: 'steer',
    loadExponent: 0,
    compile: (params) => {
      const o = readVec3(params, 'position', [0, 0, 0]);
      const a = normalize3(readVec3(params, 'axis', [0, 0, 1]));
      const range = Math.max(0.05, getNumber(params, 'radius', 3));
      return (p: FieldPoint, out) => {
        const s = (p.x - o[0]) * a[0] + (p.y - o[1]) * a[1] + (p.z - o[2]) * a[2];
        const dx = o[0] + a[0] * s - p.x;
        const dy = o[1] + a[1] * s - p.y;
        const dz = o[2] + a[2] * s - p.z;
        const d = Math.hypot(dx, dy, dz);
        if (d < 1e-6) return set(out, 0, 0, 0);
        const k = Math.min(1, d / range) / d;
        set(out, dx * k, dy * k, dz * k);
      };
    },
  });
  registerForceType({ type: 'groundAvoid', mode: 'steer', loadExponent: 0, compile: groundField });
  registerForceType({ type: 'collision', mode: 'steer', loadExponent: 0, compile: collisionField });
  registerForceType({ type: 'gnarl', mode: 'steer', loadExponent: 0, compile: gnarlField });
  registerForceType({ type: 'twist', mode: 'steer', loadExponent: 0, compile: twistField });
  registerForceType({ type: 'planar', mode: 'steer', loadExponent: 0, compile: planarField });
  registerForceType({ type: 'return', mode: 'steer', loadExponent: 0, compile: () => returnField });
  registerForceType({ type: 'knockout', mode: 'steer', loadExponent: 0, inert: true, compile: () => (_p, out) => set(out, 0, 0, 0) });
  registerForceType({ type: 'geometry', mode: 'steer', loadExponent: 0, compile: geometryField, collider: geometryCollider });
}
