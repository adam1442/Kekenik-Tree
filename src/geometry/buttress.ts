import { Rng } from '@/core/rng';

/** Shape > Buttress: tall, thin fins that radiate from the base of a trunk. */
export interface ButtressSpec {
  count: number;
  /** Metres the fins climb. */
  height: number;
  /** Outward reach at the ground, in base radii. */
  length: number;
  /** 0..1: width of the flat ridge relative to the space between two fins. */
  thickness: number;
}

/** Extra radius (metres) of the fins at angle `a` (radians) and arc length `s` from the base, for a trunk of base radius `radius`. */
export type ButtressProfile = (a: number, s: number, radius: number) => number;

const TAU = Math.PI * 2;

function wrapAngle(a: number): number {
  const w = a % TAU;
  return Math.abs(w > Math.PI ? w - TAU : w < -Math.PI ? w + TAU : w);
}

/**
 * Fins at seeded angles, each with its own reach and height (+-30 %). Seen from above a fin is a flat ridge with concave (steep)
 * sides; seen from the side its top edge is a concave ridge that runs out into the trunk at `height`. `sides` is the radial count
 * of the tube: a fin is never narrower than about two vertices, so it cannot vanish between them. Pure and deterministic.
 */
export function createButtressProfile(spec: ButtressSpec, seed: number, sides: number): ButtressProfile {
  const n = Math.max(1, Math.round(spec.count));
  const rng = new Rng(Math.round(seed) * 31 + 977);
  const phase = rng.next() * TAU;
  const fins: { angle: number; reach: number; height: number }[] = [];
  for (let k = 0; k < n; k++) {
    fins.push({
      angle: phase + (TAU * k) / n + (rng.next() - 0.5) * 0.5 * (TAU / n),
      reach: 0.7 + 0.6 * rng.next(),
      height: 0.7 + 0.6 * rng.next(),
    });
  }
  const sector = Math.PI / n;
  const thickness = Math.min(1, Math.max(0.02, spec.thickness));
  const minHalf = (1.1 * TAU) / Math.max(3, sides);
  const flat = thickness * sector * 0.5;
  const half = Math.min(sector * 1.6, Math.max(sector * (0.45 + 0.4 * thickness), minHalf)) - flat;
  const reachScale = Math.max(0, spec.length);
  const heightScale = Math.max(1e-3, spec.height);
  return (a, s, radius) => {
    if (s >= heightScale * 1.3) return 0;
    let best = 0;
    for (const fin of fins) {
      const u = s / (heightScale * fin.height);
      if (u >= 1) continue;
      const d = wrapAngle(a - fin.angle);
      let lateral = 1;
      if (d > flat) {
        const x = (d - flat) / Math.max(1e-6, half);
        if (x >= 1) continue;
        lateral = (1 - x) * (1 - x) * (1 - x);
      }
      const vertical = Math.pow(1 - u, 2.2);
      best = Math.max(best, reachScale * fin.reach * radius * vertical * lateral);
    }
    return best;
  };
}
