import type { VarianceSpec } from '@/contracts/variance';
import { atSite, varianceUnit } from '@/graph/engine/seeds';
import { Rng } from '@/core/rng';

/** Samples of the strip preview (SpeedTree shows 23 instances along a parent). */
export const PREVIEW_SAMPLES = 23;
/** Fixed seed: the preview is stable while the user drags a slider, so only the settings move the bars. */
const PREVIEW_SEED = 1337;

/**
 * The unit random values (-1..1) 23 neighbouring instances would get with these variance settings, in order along the
 * parent. Uses the engine's own `varianceUnit`, so the preview always matches the generated result.
 */
export function previewStrip(spec: VarianceSpec, count = PREVIEW_SAMPLES): number[] {
  const stream = new Rng(PREVIEW_SEED);
  return Array.from({ length: count }, (_, i) => {
    const site = atSite(stream.fork(i), count > 1 ? i / (count - 1) : 0, 0, PREVIEW_SEED);
    return varianceUnit(site.next(), spec, site);
  });
}

/** Histogram of unit values over `bins` equal bins in [-1, 1], normalised so the tallest bin is 1. */
export function previewHistogram(spec: VarianceSpec, bins = 15, samples = 600): number[] {
  const counts = new Array<number>(bins).fill(0);
  for (const v of previewStrip(spec, samples)) counts[Math.min(bins - 1, Math.floor(((v + 1) / 2) * bins))]! += 1;
  const peak = Math.max(1, ...counts);
  return counts.map((c) => c / peak);
}
