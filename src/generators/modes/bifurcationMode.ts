import { paritySide, record, scaledCount, span } from './shared';
import type { BifurcationRequest, ModeFrame, PlacementRecord } from './types';

/** Largest lengthwise shift of a node at Spread = 1, as a fraction of the parent length. */
const SPREAD_REACH = 0.1;

/**
 * Bifurcation: nodes where the parent bends, mimicking splits. The `count` strongest bends (turning angle above
 * `threshold`, at least `minSpacing` apart) inside First..Last get one node each, rolled towards the outside of the bend.
 * `spread` shifts a node randomly along the parent. A parent without such a bend gets a few evenly spaced nodes instead,
 * so the mode never produces nothing on a straight parent.
 */
export function bifurcation(frame: ModeFrame, req: BifurcationRequest): PlacementRecord[] {
  const peaks = frame.bends(req.threshold, req.minSpacing);
  const wanted = scaledCount(frame, req.count);
  const out: PlacementRecord[] = [];
  if (peaks.length > 0) {
    const chosen = [...peaks]
      .sort((a, b) => b.curvature - a.curvature)
      .slice(0, wanted)
      .sort((a, b) => a.t - b.t);
    for (let k = 0; k < chosen.length; k++) {
      const pk = chosen[k]!;
      const rng = frame.rng.fork(k);
      const t = pk.t + (rng.next() * 2 - 1) * req.spread * SPREAD_REACH + frame.positionOffset;
      out.push(record(Math.min(frame.last, Math.max(frame.first, t)), frame.rollBase + pk.roll, k, paritySide(0, k)));
    }
    return out;
  }
  const n = Math.min(frame.maxCount, Math.max(1, Math.round(req.count * 0.5 * frame.lodKeep)));
  if (wanted === 0) return out;
  const sp = span(frame);
  for (let k = 0; k < n; k++) {
    const rng = frame.rng.fork(k);
    const s = (k + 0.5) / n;
    const t = frame.first + frame.warp(s) * sp + (rng.next() * 2 - 1) * req.spread * SPREAD_REACH + frame.positionOffset;
    const roll = frame.rollBase + frame.branchPhase + k * Math.PI + 0.4;
    out.push(record(Math.min(frame.last, Math.max(frame.first, t)), roll, k, paritySide(0, k)));
  }
  return out;
}
