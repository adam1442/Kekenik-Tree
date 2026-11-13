import { Rng } from '@/core/rng';

/**
 * Seeds. Every node gets its own deterministic stream: `Rng(projectSeed).fork(nodeId).fork(perNodeSeed)`.
 * `fork` hashes the key, so the stream depends only on (project seed, node id, node seed) - NOT on node order,
 * on how many other nodes exist, or on evaluation order.
 */
export function deriveNodeSeed(projectSeed: number, nodeId: string, perNodeSeed = 0): number {
  return new Rng(projectSeed).fork(nodeId).fork(perNodeSeed).seed;
}

/**
 * Variance sampling ("±" toggle). `variance` is a fraction (0..1): the result is `value` shifted by a uniform random
 * amount in ±`variance` × `span`, where `span` defaults to |value| (relative variance). Always consumes exactly one
 * random number, so toggling variance does not shift the rest of the stream.
 */
export function sampleVariance(rng: Rng, value: number, variance: number, span?: number): number {
  const r = rng.next() * 2 - 1;
  if (!variance) return value;
  return value + r * variance * (span ?? Math.abs(value));
}
