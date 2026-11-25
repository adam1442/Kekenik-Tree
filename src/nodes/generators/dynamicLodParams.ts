import type { NodeParams, ParamDef } from '@/contracts/params';
import { getNumber } from '@/contracts/params';
import { clamp } from '@/core/math';
import { section } from '../shared/builders';

/**
 * Per-generator Dynamic LOD properties (SpeedTree "Weight / Optimization / Length segments / Radial segments").
 * Every default is neutral: with the defaults a generator produces exactly the geometry it produced before.
 */
export interface GeneratorLod {
  /** Priority to survive among pieces of the same type (0..1, 0.5 = neutral). */
  weight: number;
  /** Extra straight-section merge angle (degrees) added per LOD step. */
  optimization: number;
  /** Scalar applied to the length segment count once per LOD step (1 = unchanged). */
  lengthSegments: number;
  /** Scalar applied to the radial / width segment count once per LOD step (1 = unchanged). */
  radialSegments: number;
}

export const NEUTRAL_GENERATOR_LOD: GeneratorLod = { weight: 0.5, optimization: 0, lengthSegments: 1, radialSegments: 1 };

export function readGeneratorLod(p: NodeParams): GeneratorLod {
  return {
    weight: clamp(getNumber(p, 'lodWeight', 0.5), 0, 1),
    optimization: clamp(getNumber(p, 'lodOptimization', 0), 0, 45),
    lengthSegments: clamp(getNumber(p, 'lodLengthSegments', 1), 0.1, 1),
    radialSegments: clamp(getNumber(p, 'lodRadialSegments', 1), 0.1, 1),
  };
}

const steps = (lod: number): number => Math.min(3, Math.max(0, lod));

/** Factor on the length segment count at generator LOD `lod` (1 at LOD 0). */
export const lodLengthFactor = (g: GeneratorLod, lod: number): number => Math.pow(g.lengthSegments, steps(lod));
/** Factor on the radial / width segment count at generator LOD `lod` (1 at LOD 0). */
export const lodRadialFactor = (g: GeneratorLod, lod: number): number => Math.pow(g.radialSegments, steps(lod));

/** Parameters shared by every generator that makes geometry. `tab` / `sub` place them in the node's LOD tab. */
export function dynamicLodGeneratorParams(tab = 'LOD', sub = 'Dynamic LOD', withOptimization = false, withRadial = true): ParamDef[] {
  const s = section(tab, sub);
  return [
    s.float('lodWeight', 'Weight', 0.5, { min: 0, max: 1, step: 0.01, tooltip: 'Priority to survive when Tree > Dynamic LOD removes pieces of the same type (branches, leaves, fronds, decorations): pieces of a generator with a higher Weight are removed later. 0.5 = neutral; equal weights never change the ranking.' }),
    ...(withOptimization
      ? [s.float('lodOptimization', 'Optimization', 0, { min: 0, max: 45, unit: '°', tooltip: 'Degrees added to the straight-section merge angle (Segments > Optimization) for every LOD step: lower levels merge nearly straight length segments more aggressively. 0 = unchanged.' })]
      : []),
    s.float('lodLengthSegments', 'Length segments', 1, { min: 0.1, max: 1, step: 0.01, tooltip: 'Scalar applied to the number of length segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction.' }),
    ...(withRadial
      ? [s.float('lodRadialSegments', 'Radial segments', 1, { min: 0.1, max: 1, step: 0.01, tooltip: 'Scalar applied to the number of radial (or width) segments once per LOD step (LOD 1 = x, LOD 2 = x², LOD 3 = x³). 1 = no extra reduction.' })]
      : []),
  ];
}

/**
 * Per-generator lightmap weight (SpeedTree "Lightmap weight"): the relative texel density of the generator's pieces in the lightmap UV
 * layout (Tree > Lightmap). 1 = same density as everything else, 0 = one texel per piece (leaves). Used by the export packer only.
 */
export const LIGHTMAP_WEIGHT_PARAM = 'lightmapWeight';

export function lightmapGeneratorParams(defaultWeight: number, tab = 'LOD'): ParamDef[] {
  const s = section(tab, 'Lightmap');
  return [
    s.float(LIGHTMAP_WEIGHT_PARAM, 'Lightmap weight', defaultWeight, {
      min: 0,
      max: 4,
      step: 0.05,
      tooltip: 'Relative texel density of this generator in the lightmap UVs (Tree > Lightmap, export). 1 = the same density as the other generators, 2 = twice the density, 0 = one texel per piece (a leaf gets a single texel). Leaves start at 0; the "Reset lightmap" command restores the defaults.',
    }),
  ];
}
