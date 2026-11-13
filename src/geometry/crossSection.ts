import { createSimplex, type SimplexNoise } from '@/core/noise';

export type SectionKind = 'round' | 'ridged' | 'lobed' | 'noise';

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
};

export interface SectionEvaluator {
  /** Radius multiplier at angle `a` (radians) and arc length `s` (metres). */
  radius(a: number, s: number): number;
}

export function createSectionEvaluator(shape: SectionShape): SectionEvaluator {
  const noise: SimplexNoise | null = shape.kind === 'noise' ? createSimplex(shape.seed) : null;
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
        default:
          break;
      }
      return Math.max(0.2, m);
    },
  };
}
