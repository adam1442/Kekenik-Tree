import type { Rng } from '@/core/rng';
import { GOLDEN_ANGLE_RAD, inBounds, record, scaledCount, span, TAU } from './shared';
import type {
  AbsoluteRequest,
  DensityRequest,
  FloodRequest,
  ModeFrame,
  ParentRequest,
  PlacementRecord,
  ProportionalRequest,
  SpreadSettings,
} from './types';

/** Roll of node `idx` for the Absolute-like modes (Align style, Sweep, Jumble). */
function azimuth(frame: ModeFrame, s: SpreadSettings, idx: number, stepPhase: number, slotRng: Rng): number {
  const sector = TAU * s.sweep;
  const basePhase = frame.rollBase + frame.branchPhase;
  const jitter = (slotRng.next() - 0.5) * s.jumble * Math.PI * 1.2;
  switch (s.alignStyle) {
    case 'individual':
      return basePhase + slotRng.next() * sector;
    case 'alternate':
      return basePhase + (idx % 2) * Math.PI * s.sweep + jitter * 0.5;
    case 'opposite': {
      const pair = Math.floor(idx / 2);
      return basePhase + (idx % 2) * Math.PI + pair * (Math.PI * 0.5) + jitter * 0.35;
    }
    case 'spiral':
      return basePhase + idx * GOLDEN_ANGLE_RAD * s.sweep + jitter * 0.4;
    case 'group':
    default:
      return basePhase + stepPhase * s.sweep + jitter;
  }
}

/** Absolute: exactly `number` nodes evenly spread over First..Last (Jumble shakes them). */
export function absolute(frame: ModeFrame, req: AbsoluteRequest): PlacementRecord[] {
  const count = scaledCount(frame, req.number);
  const sp = span(frame);
  const out: PlacementRecord[] = [];
  for (let k = 0; k < count; k++) {
    const slotRng = frame.rng.fork(k);
    const baseS = count === 1 ? 0.5 : k / (count - 1);
    const jitterSpan = count > 1 ? 0.65 / (count - 1) : 0.25;
    const jS = baseS + (slotRng.next() - 0.5) * 2 * req.jumble * jitterSpan;
    const t = frame.attract(frame.first + frame.warp(clamp01(jS)) * sp + frame.positionOffset);
    out.push(record(inBounds(frame, t), azimuth(frame, req, k, k * GOLDEN_ANGLE_RAD, slotRng), k));
  }
  return out;
}

/**
 * Proportional: `frequency` x parent length nodes, scattered at random (one per equal stretch of First..Last, so the
 * result is random but never clumps into one place). Longer parents get more nodes.
 */
export function proportional(frame: ModeFrame, req: ProportionalRequest): PlacementRecord[] {
  const count = scaledCount(frame, req.frequency * frame.parentLength);
  const sp = span(frame);
  const out: PlacementRecord[] = [];
  for (let k = 0; k < count; k++) {
    const slotRng = frame.rng.fork(k);
    let s = (k + slotRng.next()) / count;
    s += (slotRng.next() - 0.5) * req.jumble * (2 / count);
    const t = frame.attract(frame.first + frame.warp(clamp01(s)) * sp + frame.positionOffset);
    out.push(record(inBounds(frame, t), azimuth(frame, req, k, k * GOLDEN_ANGLE_RAD, slotRng), k));
  }
  return out;
}

/** Legacy Density mode: `density` nodes per metre of the First..Last part of the parent. */
export function density(frame: ModeFrame, req: DensityRequest): PlacementRecord[] {
  const sp = span(frame);
  const count = scaledCount(frame, req.density * Math.max(0, frame.parentLength * sp));
  const out: PlacementRecord[] = [];
  for (let k = 0; k < count; k++) {
    const slotRng = frame.rng.fork(k);
    const baseS = count === 1 ? 0.5 : (k + 0.5) / count;
    const jS = baseS + (slotRng.next() - 0.5) * (req.jitter / Math.max(1, count));
    const t = frame.first + frame.warp(clamp01(jS)) * sp + frame.positionOffset;
    out.push(record(inBounds(frame, t), azimuth(frame, req, k, k * GOLDEN_ANGLE_RAD, slotRng), k));
  }
  return out;
}

/** Flood: exactly `number` nodes at random positions along the parent, ordered from the origin to the tip. */
export function flood(frame: ModeFrame, req: FloodRequest): PlacementRecord[] {
  const count = scaledCount(frame, req.number);
  const sp = span(frame);
  const out: PlacementRecord[] = [];
  for (let k = 0; k < count; k++) {
    const slotRng = frame.rng.fork(k);
    const raw = frame.attract(frame.first + frame.warp(slotRng.next()) * sp + frame.positionOffset);
    const roll = frame.rollBase + slotRng.next() * TAU * req.sweep;
    out.push(record(inBounds(frame, raw), roll, 0));
  }
  out.sort((a, b) => a.t - b.t);
  for (let i = 0; i < out.length; i++) (out[i] as PlacementRecord).groupIndex = i;
  return out;
}

/** Parent: exactly `number` nodes, all at the origin of the parent (t = 0), spread evenly around it. */
export function parentOrigin(frame: ModeFrame, req: ParentRequest): PlacementRecord[] {
  const count = scaledCount(frame, req.number);
  const out: PlacementRecord[] = [];
  for (let k = 0; k < count; k++) {
    out.push(record(0, frame.rollBase + frame.branchPhase + (k / count) * TAU * req.sweep, k));
  }
  return out;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
