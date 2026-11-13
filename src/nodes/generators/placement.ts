import type { PlacementShape, TreePlacement } from '@/contracts/ports';
import { Rng } from '@/core/rng';

/**
 * Tree placement disc + instance distribution.
 *
 * The Tree node defines a ground disc (`TreePlacement`). First-generation generators (Trunk, Spine, Branch ...)
 * place their `Number` instances inside it with one of the `DistributionMode`s. Everything here is pure and
 * allocation-light: results are typed arrays, every instance draws from its own `rng.fork('i:<index>')` stream, so
 * changing the count never reshuffles existing instances and changing only the radius scales them uniformly.
 */

export type DistributionMode = 'parametric' | 'uniform' | 'poisson' | 'ring' | 'grid' | 'spiral';

export const DISTRIBUTION_MODES: readonly DistributionMode[] = ['parametric', 'uniform', 'poisson', 'ring', 'grid', 'spiral'];

export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export type { PlacementShape, TreePlacement };

export const DEFAULT_PLACEMENT: TreePlacement = { shape: 'circle', radius: 10, centerX: 0, centerY: 0, sink: 0, rollDeg: 0, unify: false };

export interface DistributionOptions {
  mode: DistributionMode;
  count: number;
  /** Parametric: normalised radial distance 0..1 (+ absolute variance). */
  position: number;
  positionVar: number;
  /** Parametric: normalised angle 0..1 turns (+ absolute variance). */
  rotation: number;
  rotationVar: number;
  /** Fraction of the circle used by the angular spread (0..1). */
  sweep: number;
  /** Random displacement 0..1 added to every pattern. */
  jumble: number;
  /** Extra pattern roll in radians (the node's `Roll`). */
  roll: number;
  /** Poisson disk: minimum distance between instances (m). */
  minDistance: number;
  /** Per-instance sink (m) and its absolute variance. */
  sink: number;
  sinkVar: number;
  /** Outward splay (degrees) reached at the disc edge. */
  splayDeg: number;
}

export interface InstanceSet {
  count: number;
  /** x,y,z per instance (z = -sink, relative to the ground). */
  position: Float32Array;
  /** Yaw (radians) used as the lean azimuth. */
  yaw: Float32Array;
  /** Extra outward tilt in degrees. */
  tiltDeg: Float32Array;
  /** Normalised radial position 0..1 (for curves / debugging). */
  radial: Float32Array;
}

const TAU = Math.PI * 2;

/** Reflect `v` into [0, 1] so variance never piles instances on the disc rim. */
export function reflect01(v: number): number {
  const m = ((v % 2) + 2) % 2;
  return m > 1 ? 2 - m : m;
}

interface Point {
  x: number;
  y: number;
}

/** Unit-disc coordinates (radius 1) for the non-parametric patterns. Each returns up to `count` points. */
function poissonUnit(count: number, minDistUnit: number, base: Rng): Point[] {
  const out: Point[] = [];
  const cell = Math.max(1e-3, minDistUnit / Math.SQRT2);
  const dim = Math.ceil(2 / cell) + 1;
  const grid = new Int32Array(dim * dim).fill(-1);
  const min2 = minDistUnit * minDistUnit;
  const attempts = count * 40 + 200;
  for (let j = 0; j < attempts && out.length < count; j++) {
    const r = base.fork(`p:${j}`);
    const rad = Math.sqrt(r.next());
    const ang = r.next() * TAU;
    const x = Math.cos(ang) * rad;
    const y = Math.sin(ang) * rad;
    const gx = Math.floor((x + 1) / cell);
    const gy = Math.floor((y + 1) / cell);
    let ok = true;
    for (let ay = Math.max(0, gy - 2); ay <= Math.min(dim - 1, gy + 2) && ok; ay++) {
      for (let ax = Math.max(0, gx - 2); ax <= Math.min(dim - 1, gx + 2); ax++) {
        const k = grid[ay * dim + ax] as number;
        if (k < 0) continue;
        const q = out[k] as Point;
        if ((q.x - x) ** 2 + (q.y - y) ** 2 < min2) {
          ok = false;
          break;
        }
      }
    }
    if (!ok) continue;
    grid[gy * dim + gx] = out.length;
    out.push({ x, y });
  }
  return out;
}

function gridUnit(count: number): Point[] {
  // Square lattice with ~count points inside the unit disc, nearest-to-centre first.
  let spacing = Math.sqrt(Math.PI / Math.max(1, count));
  for (let attempt = 0; attempt < 12; attempt++) {
    const pts: Point[] = [];
    const n = Math.ceil(1 / spacing);
    for (let iy = -n; iy <= n; iy++) {
      for (let ix = -n; ix <= n; ix++) {
        const x = ix * spacing;
        const y = iy * spacing;
        if (x * x + y * y <= 1) pts.push({ x, y });
      }
    }
    if (pts.length >= count) {
      pts.sort((a, b) => a.x * a.x + a.y * a.y - (b.x * b.x + b.y * b.y) || a.y - b.y || a.x - b.x);
      return pts.slice(0, count);
    }
    spacing *= 0.9;
  }
  return [];
}

/**
 * Compute the instance transforms. Positions are relative to the disc centre rotated by the tree roll and then moved
 * by `placement.centerX/Y`; `placement.sink` is added to every instance sink.
 */
export function computeInstances(placement: TreePlacement, o: DistributionOptions, rng: Rng): InstanceSet {
  const n = Math.max(0, Math.floor(o.count));
  const position = new Float32Array(n * 3);
  const yaw = new Float32Array(n);
  const tiltDeg = new Float32Array(n);
  const radial = new Float32Array(n);
  const R = Math.max(0, placement.radius);
  const treeRoll = (placement.rollDeg * Math.PI) / 180;
  const cr = Math.cos(treeRoll);
  const sr = Math.sin(treeRoll);
  const base = rng.fork('place');
  const sweep = Math.min(1, Math.max(0.01, o.sweep));
  const jumble = Math.min(1, Math.max(0, o.jumble));

  // Point sets (unit disc) for patterns that need global knowledge.
  let pts: Point[] | null = null;
  if (o.mode === 'poisson') pts = poissonUnit(n, R > 0 ? Math.max(0, o.minDistance) / R : 0, base.fork('pd'));
  else if (o.mode === 'grid') pts = gridUnit(n);
  const produced = pts ? Math.min(n, pts.length) : n;

  const single = n === 1 && o.mode !== 'parametric';
  for (let i = 0; i < produced; i++) {
    const r = base.fork(`i:${i}`);
    // Fixed draw order: toggling a mode or variance never shifts the stream of the other attributes.
    const u0 = r.next();
    const u1 = r.next();
    const u2 = r.next();
    const u3 = r.next();
    const u4 = r.next();
    const u5 = r.next();

    let rn: number; // normalised radius 0..1
    let ang: number; // radians
    switch (o.mode) {
      case 'parametric':
        rn = reflect01(o.position + (u0 * 2 - 1) * o.positionVar);
        ang = TAU * (o.rotation + (u1 * 2 - 1) * o.rotationVar + (i * GOLDEN_ANGLE * sweep) / TAU) + o.roll;
        break;
      case 'uniform':
        rn = single ? 0 : Math.sqrt(u0); // r = R * sqrt(u): area-correct
        ang = TAU * u1 * sweep + o.roll;
        break;
      case 'poisson': {
        const p = (pts as Point[])[i] as Point;
        rn = single ? 0 : Math.hypot(p.x, p.y);
        ang = Math.atan2(p.y, p.x);
        break;
      }
      case 'ring':
        rn = single ? 0 : reflect01(o.position || 1);
        ang = TAU * ((i / Math.max(1, n)) * sweep + o.rotation) + o.roll;
        break;
      case 'grid': {
        const p = (pts as Point[])[i] as Point;
        rn = Math.hypot(p.x, p.y);
        ang = Math.atan2(p.y, p.x);
        break;
      }
      case 'spiral':
        rn = single ? 0 : Math.sqrt((i + 0.5) / n);
        ang = i * GOLDEN_ANGLE + o.roll;
        break;
    }

    // Jumble: random displacement in the plane, bounded by about one cell of the pattern.
    let x = Math.cos(ang) * rn;
    let y = Math.sin(ang) * rn;
    if (jumble > 0 && !single && o.mode !== 'poisson') {
      const cellUnit = Math.sqrt(1 / Math.max(1, n));
      const jr = jumble * cellUnit * 0.9 * Math.sqrt(u2);
      const ja = u3 * TAU;
      x += Math.cos(ja) * jr;
      y += Math.sin(ja) * jr;
      const len = Math.hypot(x, y);
      if (len > 1) {
        x /= len;
        y /= len;
      }
    }
    const finalR = Math.min(1, Math.hypot(x, y));
    const wx = x * R;
    const wy = y * R;
    position[i * 3] = wx * cr - wy * sr + placement.centerX;
    position[i * 3 + 1] = wx * sr + wy * cr + placement.centerY;
    position[i * 3 + 2] = -(placement.sink + o.sink + (u4 * 2 - 1) * o.sinkVar);
    radial[i] = finalR;
    if (placement.unify) {
      yaw[i] = 0;
      tiltDeg[i] = 0;
    } else {
      yaw[i] = finalR < 1e-6 ? u5 * TAU : Math.atan2(y, x);
      tiltDeg[i] = o.splayDeg * finalR;
    }
  }

  if (produced === n) return { count: n, position, yaw, tiltDeg, radial };
  return {
    count: produced,
    position: position.slice(0, produced * 3),
    yaw: yaw.slice(0, produced),
    tiltDeg: tiltDeg.slice(0, produced),
    radial: radial.slice(0, produced),
  };
}
