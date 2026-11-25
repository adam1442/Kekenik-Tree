import { createSimplex, type SimplexNoise } from '@/core/noise';

export type SectionKind = 'round' | 'ridged' | 'lobed' | 'noise' | 'organic';

/** Cross-section of a tube: radius multiplier as a function of the angle around the axis. */
export interface SectionShape {
  kind: SectionKind;
  /** Width / height ratio (1 = circle). */
  aspect: number;
  /** 1 = circle, 0 = rounded square (super-ellipse). */
  roundness: number;
  /** Ridge / lobe count. */
  lobes: number;
  /** Ridge / lobe / noise depth, fraction of the radius. */
  depth: number;
  /** Radians of lobe rotation per metre of branch length (spiral bark). */
  spiral: number;
  noiseFrequency: number;
  seed: number;
  /** `organic`: amplitude of the oval (2nd harmonic), fraction of the radius. Its orientation drifts along the length. */
  oval?: number;
  /** `organic`: metres of branch length for one full change of amplitude, phase and orientation. */
  drift?: number;
  /** `organic`: degrees per metre the lobes (3rd harmonic and `lobes`) spiral up the stem, added to `spiral`. */
  grainTwist?: number;
}

export const ROUND_SECTION: SectionShape = {
  kind: 'round',
  aspect: 1,
  roundness: 1,
  lobes: 5,
  depth: 0,
  spiral: 0,
  noiseFrequency: 2,
  seed: 1,
  oval: 0,
  drift: 2,
  grainTwist: 0,
};

export interface SectionEvaluator {
  /** Radius multiplier at angle `a` (radians) and arc length `s` (metres). */
  radius(a: number, s: number): number;
}

export function createSectionEvaluator(shape: SectionShape): SectionEvaluator {
  const noise: SimplexNoise | null = shape.kind === 'noise' || shape.kind === 'organic' ? createSimplex(shape.seed) : null;
  const oval = Math.max(0, shape.oval ?? 0);
  const driftLength = Math.max(0.05, shape.drift ?? 2);
  const grain = ((shape.grainTwist ?? 0) * Math.PI) / 180;
  const lobeOrder = Math.max(2, Math.round(shape.lobes));
  const p = 2 + (1 - Math.min(1, Math.max(0, shape.roundness))) * 6;
  return {
    radius(a, s) {
      let m = 1;
      if (p > 2.001) {
        const c = Math.abs(Math.cos(a));
        const sn = Math.abs(Math.sin(a));
        m = Math.pow(Math.pow(c, p) + Math.pow(sn, p), -1 / p);
      }
      switch (shape.kind) {
        case 'ridged':
          m *= 1 + shape.depth * (0.5 - Math.abs(Math.sin((shape.lobes * (a + s * shape.spiral)) / 2)));
          break;
        case 'lobed':
          m *= 1 + shape.depth * Math.cos(shape.lobes * (a + s * shape.spiral));
          break;
        case 'noise':
          if (noise) {
            const f = shape.noiseFrequency;
            m *= 1 + shape.depth * noise.noise3(Math.cos(a) * f, Math.sin(a) * f, s * f * 0.5);
          }
          break;
        case 'organic':
          if (noise) m *= 1 + organicOffset(noise, a, s, oval, shape.depth, driftLength, shape.spiral, grain, lobeOrder);
          break;
        default:
          break;
      }
      return Math.max(0.2, m);
    },
  };
}

/**
 * Organic section: an oval (2nd harmonic) plus a 3rd harmonic and one of order `lobeOrder`. Amplitude, phase and orientation of
 * every harmonic wander slowly with arc length (one full change per `drift` metres); `spiral` (rad/m) turns the whole section,
 * `grain` (rad/m) additionally turns the lobes (ridges spiral up the stem).
 */
function organicOffset(noise: SimplexNoise, a: number, s: number, oval: number, depth: number, drift: number, spiral: number, grain: number, lobeOrder: number): number {
  const u = s / drift;
  const turn = a + s * spiral;
  const ovalAngle = Math.PI * noise.noise3(u * 0.7, 0.3, 5.1);
  let out = oval * (0.75 + 0.25 * noise.noise3(u, 1.9, 2.2)) * Math.cos(2 * (turn - ovalAngle));
  const orders = [3, lobeOrder === 3 ? 4 : lobeOrder];
  for (let k = 0; k < orders.length; k++) {
    const order = orders[k] as number;
    const amp = depth * (k === 0 ? 0.8 : 0.6) * (0.65 + 0.35 * noise.noise3(u * 0.9, 7.7 + k * 3.1, 0.4));
    const phase = Math.PI * noise.noise3(u * 0.6, 11.3 + k * 5.7, 3.3);
    out += amp * Math.cos(order * (turn + s * grain) + phase);
  }
  return out;
}
