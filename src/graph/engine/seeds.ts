import { varianceAmount, type VarianceValue, type VarianceSpec } from '@/contracts/variance';
import { valueNoise2 } from '@/core/noise';
import { hashString, mixSeeds, Rng } from '@/core/rng';

/**
 * Seeds. Every node gets its own deterministic stream: `Rng(projectSeed).fork(nodeId).fork(perNodeSeed)`.
 * `fork` hashes the key, so the stream depends only on (project seed, node id, node seed) - NOT on node order,
 * on how many other nodes exist, or on evaluation order.
 */
export function deriveNodeSeed(projectSeed: number, nodeId: string, perNodeSeed = 0): number {
  return new Rng(projectSeed).fork(nodeId).fork(perNodeSeed).seed;
}

/** Cohesion noise runs this many lattice cells per unit of `offset`, so every offset step lands on a new pattern. */
const OFFSET_CELLS = 64;
/** Noise cells per parent length at `scale` 0 and the extra cells gained at `scale` 1. */
const BASE_CELLS = 1;
const SCALE_CELLS = 15;
/** Lattice rows between two parent instances (rows are independent, so every parent gets its own wave). */
const PARENT_ROW_STRIDE = 7;
const GAUSS_CLAMP_SIGMA = 3;

/**
 * An Rng stream tagged with where its instance sits on the parent (`u` along it and the parent's instance index).
 * `fork` keeps the tag, and `fieldSeed` folds only the fork keys into the node-level seed, so every instance of one
 * (node, parameter) pair reads the SAME cohesion noise field.
 */
export class SiteRng extends Rng {
  constructor(
    seed: number,
    readonly u: number,
    readonly parentIndex: number,
    /** Per-(node, parameter) noise seed. */
    readonly fieldSeed: number,
  ) {
    super(seed);
  }

  override fork(key: string | number): SiteRng {
    const child = super.fork(key);
    return new SiteRng(child.seed, this.u, this.parentIndex, mixSeeds(this.fieldSeed, typeof key === 'number' ? key >>> 0 : hashString(key)));
  }
}

/**
 * Tag an instance stream with its position on the parent so cohesive variance can correlate neighbours. `nodeSeed` is the
 * node-level seed (`NodeContext.seed`) - the same for every instance of the node. Call it AFTER forking per-instance keys.
 */
export function atSite(rng: Rng, u: number, parentIndex: number, nodeSeed: number): SiteRng {
  return new SiteRng(rng.seed, u, parentIndex, nodeSeed);
}

/** Truncated normal in [-1, 1]: Box-Muller from `u` and a deterministic second draw derived from it, clamped at 3 sigma. */
export function gaussianUnit(u: number): number {
  const u2 = mixSeeds(Math.floor(u * 4294967296) >>> 0, 0x51ed270b) / 4294967296;
  const z = Math.sqrt(-2 * Math.log(Math.max(u, 1e-12))) * Math.cos(2 * Math.PI * u2);
  return Math.max(-GAUSS_CLAMP_SIGMA, Math.min(GAUSS_CLAMP_SIGMA, z)) / GAUSS_CLAMP_SIGMA;
}

/** Smooth noise in [-1, 1] over (u, parent index) for one cohesion field. */
export function cohesionNoise(fieldSeed: number, u: number, parentIndex: number, scale: number, offset: number): number {
  return valueNoise2(fieldSeed, u * (BASE_CELLS + SCALE_CELLS * scale) + offset * OFFSET_CELLS, parentIndex * PARENT_ROW_STRIDE);
}

/**
 * The unit random value (-1..1) of one instance: `draw` (one RNG number in [0,1)) shaped by the distribution and blended
 * with the cohesion noise when `rng` knows its site. Pure: the same inputs always give the same output.
 */
export function varianceUnit(draw: number, spec: Pick<VarianceSpec, 'distribution' | 'cohesion' | 'scale' | 'offset'>, site?: SiteRng): number {
  const random = spec.distribution === 'gaussian' ? gaussianUnit(draw) : draw * 2 - 1;
  if (!(spec.cohesion > 0) || !site) return random;
  const noise = cohesionNoise(site.fieldSeed, site.u, site.parentIndex, spec.scale, spec.offset);
  return random + (noise - random) * spec.cohesion;
}

/**
 * Variance sampling ("+/-" button). `variance` is the stored form (number = uniform amount): the result is `value`
 * shifted by a random amount in +/-`amount` x `span`, where `span` defaults to |value| (relative variance). Always
 * consumes exactly one random number, so toggling variance does not shift the rest of the stream. Distribution and
 * cohesion apply when `variance` is an object; cohesion needs an `rng` made by `atSite`.
 */
export function sampleVariance(rng: Rng, value: number, variance: VarianceValue | undefined, span?: number): number {
  const draw = rng.next();
  const amount = varianceAmount(variance);
  if (!amount) return value;
  const unit = typeof variance === 'object' ? varianceUnit(draw, { distribution: variance.distribution ?? 'uniform', cohesion: variance.cohesion ?? 0, scale: variance.scale ?? 0.25, offset: variance.offset ?? 0 }, rng instanceof SiteRng ? rng : undefined) : draw * 2 - 1;
  return value + unit * amount * (span ?? Math.abs(value));
}
