import type { Skeleton } from '@/contracts/skeleton';
import { collectOpenEnds } from '@/generators/split/openEnds';

/** Kinds of open end the overlay distinguishes. */
export type OpenEndGlyphKind = 'fat' | 'skinny' | 'break' | 'bottom';

/** Linear-RGB colour of each kind. */
export const OPEN_END_COLORS: Readonly<Record<OpenEndGlyphKind, readonly [number, number, number]>> = {
  fat: [1.0, 0.62, 0.12],
  skinny: [0.2, 0.82, 1.0],
  break: [1.0, 0.27, 0.27],
  bottom: [0.32, 0.92, 0.45],
};

export interface OpenEndGlyphs {
  /** Line segment end points, xyz xyz per segment. */
  positions: Float32Array;
  /** Colour per segment end point, rgb rgb per segment. */
  colors: Float32Array;
  segments: number;
  /** Kind and index (1 / 2) of every end, in the order the glyphs were written. */
  ends: { kind: OpenEndGlyphKind; index: 1 | 2 }[];
}

const RING_SIDES = 24;
const MIN_SIZE = 0.012;

type V3 = readonly [number, number, number];

/**
 * Debug glyphs of the open ends of a skeleton: a ring at the end (end radius, perpendicular to the direction), an arrow along the
 * direction, and one or two tick marks for the end's index (Side 1 / Side 2 of a split; breaks and bottoms are index 1).
 * Pure; only called when the overlay is switched on.
 */
export function buildOpenEndGlyphs(sk: Skeleton): OpenEndGlyphs {
  const entries: { kind: OpenEndGlyphKind; index: 1 | 2; position: V3; direction: V3; normal: V3; radius: number }[] = [];
  for (const e of collectOpenEnds(sk)) {
    const kind: OpenEndGlyphKind = e.broken ? 'break' : e.kind === 'skinny' ? 'skinny' : 'fat';
    entries.push({ kind, index: e.side === 2 ? 2 : 1, position: e.position, direction: e.direction, normal: e.frame ? e.frame.normal : perpendicular(e.direction), radius: e.radius });
  }
  // Bottom: the base of every branch that grows from nothing, pointing back out of the ground-side end
  const nx = sk.attributes.get('rmfNormalX');
  const ny = sk.attributes.get('rmfNormalY');
  const nz = sk.attributes.get('rmfNormalZ');
  for (const b of sk.branches) {
    if (b.parentBranch >= 0 || b.count < 2) continue;
    const i = b.start;
    const t = unit([(sk.position[(i + 1) * 3] as number) - (sk.position[i * 3] as number), (sk.position[(i + 1) * 3 + 1] as number) - (sk.position[i * 3 + 1] as number), (sk.position[(i + 1) * 3 + 2] as number) - (sk.position[i * 3 + 2] as number)]);
    const hint: V3 = nx && ny && nz && nx.length === sk.count ? [nx[i] as number, ny[i] as number, nz[i] as number] : perpendicular(t);
    entries.push({
      kind: 'bottom',
      index: 1,
      position: [sk.position[i * 3] as number, sk.position[i * 3 + 1] as number, sk.position[i * 3 + 2] as number],
      direction: [-t[0], -t[1], -t[2]],
      normal: projectOff(hint, t),
      radius: sk.radius[i] as number,
    });
  }

  const perEnd = RING_SIDES + 3 + 2;
  const positions = new Float32Array(entries.length * (perEnd + 2) * 6);
  const colors = new Float32Array(positions.length);
  let s = 0;
  const seg = (a: V3, b: V3, c: readonly [number, number, number]): void => {
    const o = s * 6;
    positions[o] = a[0];
    positions[o + 1] = a[1];
    positions[o + 2] = a[2];
    positions[o + 3] = b[0];
    positions[o + 4] = b[1];
    positions[o + 5] = b[2];
    for (let k = 0; k < 2; k++) {
      colors[o + k * 3] = c[0];
      colors[o + k * 3 + 1] = c[1];
      colors[o + k * 3 + 2] = c[2];
    }
    s++;
  };
  for (const e of entries) {
    const c = OPEN_END_COLORS[e.kind];
    const r = Math.max(MIN_SIZE, e.radius);
    const d = unit(e.direction);
    const n = unit(projectOff(e.normal, d));
    const b = cross(d, n);
    const at = (angle: number, scale: number, along = 0): V3 => {
      const ca = Math.cos(angle) * r * scale;
      const sa = Math.sin(angle) * r * scale;
      return [e.position[0] + n[0] * ca + b[0] * sa + d[0] * along, e.position[1] + n[1] * ca + b[1] * sa + d[1] * along, e.position[2] + n[2] * ca + b[2] * sa + d[2] * along];
    };
    for (let j = 0; j < RING_SIDES; j++) seg(at((j / RING_SIDES) * Math.PI * 2, 1), at(((j + 1) / RING_SIDES) * Math.PI * 2, 1), c);
    // Arrow: shaft from the centre along the direction, head as two barbs
    const len = Math.max(r * 2.6, 0.05);
    const tip: V3 = [e.position[0] + d[0] * len, e.position[1] + d[1] * len, e.position[2] + d[2] * len];
    seg(e.position, tip, c);
    const head = len * 0.28;
    seg(tip, [tip[0] - d[0] * head + n[0] * head * 0.55, tip[1] - d[1] * head + n[1] * head * 0.55, tip[2] - d[2] * head + n[2] * head * 0.55], c);
    seg(tip, [tip[0] - d[0] * head - n[0] * head * 0.55, tip[1] - d[1] * head - n[1] * head * 0.55, tip[2] - d[2] * head - n[2] * head * 0.55], c);
    // Index: one or two ticks standing on the ring
    for (let k = 0; k < e.index; k++) {
      const along = (k - (e.index - 1) / 2) * r * 0.35;
      seg(at(0, 1.0, along), at(0, 1.35, along), c);
    }
  }
  return { positions: positions.subarray(0, s * 6), colors: colors.subarray(0, s * 6), segments: s, ends: entries.map((e) => ({ kind: e.kind, index: e.index })) };
}

function unit(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l < 1e-9 ? [0, 0, 1] : [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function projectOff(v: V3, d: V3): V3 {
  const k = v[0] * d[0] + v[1] * d[1] + v[2] * d[2];
  return [v[0] - d[0] * k, v[1] - d[1] * k, v[2] - d[2] * k];
}

function perpendicular(d: V3): V3 {
  return unit(Math.abs(d[0]) < 0.9 ? [0, -d[2], d[1]] : [d[2], 0, -d[0]]);
}
